import { KMSClient, DecryptCommand, EncryptCommand } from "@aws-sdk/client-kms";

const kms = new KMSClient({});

/**
 * Lambda handler demonstrating KMS encryption/decryption
 */
export async function handler(event: unknown): Promise<{ statusCode: number; body: string }> {
    console.log("Event received:", JSON.stringify(event, null, 2));

    const dataKeyArn = process.env.DATA_KEY_ARN;
    if (!dataKeyArn) {
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "DATA_KEY_ARN not configured" }),
        };
    }

    // Demonstrate encryption
    const plaintext = "Hello, secret world!";
    const encryptResponse = await kms.send(
        new EncryptCommand({
            KeyId: dataKeyArn,
            Plaintext: Buffer.from(plaintext),
        }),
    );

    // Demonstrate decryption
    const decryptResponse = await kms.send(
        new DecryptCommand({
            CiphertextBlob: encryptResponse.CiphertextBlob,
        }),
    );

    const decrypted = new TextDecoder().decode(decryptResponse.Plaintext);

    return {
        statusCode: 200,
        body: JSON.stringify({
            message: "KMS encryption/decryption successful",
            original: plaintext,
            decrypted: decrypted,
            match: plaintext === decrypted,
        }),
    };
}
