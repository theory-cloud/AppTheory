import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const s3 = new S3Client({});
const ssm = new SSMClient({});

/**
 * Lambda handler demonstrating S3 and SSM operations with custom permissions
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

    // Try to read SSM parameter (may not exist in demo)
    let ssmValue = "not-configured";
    try {
        const ssmResponse = await ssm.send(
            new GetParameterCommand({
                Name: "/app/demo-parameter",
                WithDecryption: true,
            }),
        );
        ssmValue = ssmResponse.Parameter?.Value ?? "empty";
    } catch {
        // Parameter doesn't exist, that's fine for demo
    }

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: "S3 and SSM operations successful",
            s3Object: {
                bucket: bucketName,
                key: key,
                content: content,
            },
            ssmParameter: ssmValue,
        }),
    };
}
