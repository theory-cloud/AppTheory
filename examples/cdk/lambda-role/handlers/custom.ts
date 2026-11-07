import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
    // deleteBatch=1 sends one DeleteObjects request with AWS's maximum of 1000
    // keys: 999 at the maximum key length of exactly 1024 bytes plus the short
    // recorded key, so the serialized body is about 1.05 MiB: above the runner's
    // S3 front buffer and a shape v7.0.0 forwarded to s3proxy. Each generated
    // key is 4 x 250-byte segments + 4 separating slashes + a 20-byte suffix
    // (12 bytes + 8 digits) = 1024 bytes. The segments are short because
    // s3proxy's filesystem store maps each segment to a file name.
    // https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
    // https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html
    if (query.deleteBatch === "1") {
        const segment = "k".repeat(250);
        const objects = Array.from({ length: 1000 }, (_, index) => ({
            Key: index === 0
                ? (query.key ?? "batch/object")
                : `${segment}/${segment}/${segment}/${segment}/${"k".repeat(12)}${String(index).padStart(8, "0")}`,
        }));
        try {
            const deleted = await s3.send(
                new DeleteObjectsCommand({
                    Bucket: bucketName,
                    Delete: { Objects: objects },
                }),
            );
            return {
                statusCode: 200,
                body: JSON.stringify({
                    deleteBatch: {
                        requested: objects.length,
                        deleted: deleted.Deleted?.length ?? 0,
                        errors: deleted.Errors?.length ?? 0,
                    },
                }),
            };
        } catch (error) {
            return {
                statusCode: 500,
                body: JSON.stringify({
                    deleteBatch: { requested: objects.length },
                    error: error instanceof Error ? error.message : String(error),
                }),
            };
        }
    }
    if (query.key && (query.read === "1" || query.write === "1")) {
        // sse=1 writes and reads the object with SSE-S3 (AES256), the form the
        // runner's S3 front serves because s3proxy's filesystem store refuses
        // every server-side-encryption header.
        const sse = query.sse === "1";
        if (query.write === "1") {
            const put = await s3.send(
                new PutObjectCommand({
                    Bucket: bucketName,
                    Key: query.key,
                    Body: query.value ?? "",
                    ContentType: "text/plain",
                    ...(sse ? { ServerSideEncryption: "AES256" as const } : {}),
                }),
            );
            return {
                statusCode: 200,
                body: JSON.stringify({
                    s3Object: {
                        bucket: bucketName,
                        key: query.key,
                        value: query.value ?? "",
                        serverSideEncryption: put.ServerSideEncryption,
                    },
                }),
            };
        }
        try {
            const head = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: query.key }));
            const stored = await s3.send(new GetObjectCommand({ Bucket: bucketName, Key: query.key }));
            const content = await stored.Body?.transformToString();
            return {
                statusCode: 200,
                body: JSON.stringify({
                    s3Object: {
                        bucket: bucketName,
                        key: query.key,
                        content,
                        headServerSideEncryption: head.ServerSideEncryption,
                        getServerSideEncryption: stored.ServerSideEncryption,
                    },
                }),
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

    // Secrets Manager: a literal SecretString, a keyed GenerateSecretString
    // secret, and a bare GenerateSecretString secret (the generated password is
    // the whole secret string), all read at runtime through GetSecretValue.
    const literalSecret = await readSecret(process.env.SECRET_ARN ?? "");
    const generatedSecret = await readSecret(process.env.GENERATED_SECRET_ARN ?? "");
    const bareSecret = await secrets.send(
        new GetSecretValueCommand({ SecretId: process.env.BARE_SECRET_ARN ?? "" }),
    );
    const bareValue = bareSecret.SecretString ?? "";
    let bareSecretIsJSON = false;
    try {
        JSON.parse(bareValue);
        bareSecretIsJSON = true;
    } catch {
        bareSecretIsJSON = false;
    }

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
                bareSecretLength: bareValue.length,
                bareSecretJson: bareSecretIsJSON,
                bareSecretPunctuation: /[^A-Za-z0-9]/.test(bareValue),
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
