import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const s3 = new S3Client({});
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});

interface JsonSecret {
    username?: string;
    password?: string;
}

async function readSecret(secretId: string): Promise<JsonSecret> {
    const response = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
    return JSON.parse(response.SecretString ?? "{}") as JsonSecret;
}

/**
 * Lambda handler demonstrating S3, SSM Parameter Store, Secrets Manager and
 * Cognito user pool operations with custom permissions.
 *
 * The SSM parameter, both secrets and the user pool are created from the CDK
 * definition by the local runner on the pinned moto backend; their Ref and
 * GetAtt values arrive through the function environment.
 */
export async function handler(event: unknown): Promise<{ statusCode: number; body: string }> {
    console.log("Event received:", JSON.stringify(event, null, 2));

    const bucketName = process.env.BUCKET_NAME;
    if (!bucketName) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "BUCKET_NAME not configured" }),
        };
    }

    // A deterministic key/value mode for the local --data-dir row: one run
    // writes an object through this handler, a second run reads it back.
    const query = ((event as { queryStringParameters?: Record<string, string> } | null)?.queryStringParameters ?? {});
    if (query.key && (query.read === "1" || query.write === "1")) {
        if (query.write === "1") {
            await s3.send(
                new PutObjectCommand({
                    Bucket: bucketName,
                    Key: query.key,
                    Body: query.value ?? "",
                    ContentType: "text/plain",
                }),
            );
            return {
                statusCode: 200,
                body: JSON.stringify({ s3Object: { bucket: bucketName, key: query.key, value: query.value ?? "" } }),
            };
        }
        try {
            const stored = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: query.key }));
            const content = await stored.Body?.transformToString();
            return {
                statusCode: 200,
                body: JSON.stringify({ s3Object: { bucket: bucketName, key: query.key, content } }),
            };
        } catch (error) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: "Object not found", key: query.key }),
            };
        }
    }

    // Demonstrate S3 write
    const key = `test-${Date.now()}.json`;
    await s3.send(
        new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: JSON.stringify({ timestamp: new Date().toISOString() }),
            ContentType: "application/json",
        }),
    );

    // Demonstrate S3 read
    const getResponse = await s3.send(
        new GetObjectCommand({
            Bucket: bucketName,
            Key: key,
        }),
    );

    const content = await getResponse.Body?.transformToString();

    // SSM: a String parameter through Ref, its GetAtt Type/Value, a
    // SecureString read with decryption and a StringList.
    const plain = await ssm.send(
        new GetParameterCommand({
            Name: process.env.SSM_PLAIN_NAME,
            WithDecryption: true,
        }),
    );
    const secureValue = await ssm.send(
        new GetParameterCommand({
            Name: process.env.SSM_SECURE_NAME,
            WithDecryption: true,
        }),
    );
    const listValue = await ssm.send(
        new GetParameterCommand({
            Name: process.env.SSM_LIST_NAME,
            WithDecryption: true,
        }),
    );

    // Secrets Manager: a literal SecretString and a GenerateSecretString
    // secret, both read at runtime through GetSecretValue.
    const literalSecret = await readSecret(process.env.SECRET_ARN ?? "");
    const generatedSecret = await readSecret(process.env.GENERATED_SECRET_ARN ?? "");

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: "S3, SSM, Secrets Manager and Cognito operations successful",
            s3Object: {
                bucket: bucketName,
                key: key,
                content: content,
            },
            ssm: {
                plain: plain.Parameter?.Value,
                plainType: plain.Parameter?.Type,
                expectedValue: process.env.SSM_PLAIN_VALUE,
                expectedType: process.env.SSM_PLAIN_TYPE,
                secure: secureValue.Parameter?.Value,
                list: listValue.Parameter?.Value,
            },
            secrets: {
                literalUsername: literalSecret.username,
                literalPassword: literalSecret.password,
                generatedUsername: generatedSecret.username,
                generatedPasswordLength: generatedSecret.password?.length ?? 0,
                generatedPunctuation: /[^A-Za-z0-9]/.test(generatedSecret.password ?? ""),
            },
            cognito: {
                poolId: process.env.COGNITO_POOL_ID,
                clientId: process.env.COGNITO_CLIENT_ID,
                poolArn: process.env.COGNITO_POOL_ARN,
                providerName: process.env.COGNITO_PROVIDER_NAME,
                providerUrl: process.env.COGNITO_PROVIDER_URL,
            },
        }),
    };
}
