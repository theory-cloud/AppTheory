import { createRequire } from "node:module";

// The Lambda Node.js runtime ships AWS SDK for JavaScript v3 under
// /var/runtime/node_modules. ESM resolution does not consult NODE_PATH, so the
// handler resolves the runtime's copy explicitly; the same path exists in a
// deployed function.
// https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html
const runtimeRequire = createRequire("/var/runtime/node_modules/index.js");
const { DynamoDBClient, GetItemCommand, PutItemCommand } = runtimeRequire("@aws-sdk/client-dynamodb");

/**
 * General API handler (catch-all).
 *
 * Handles all requests that don't match specific routes.
 * Demonstrates the multi-Lambda routing capability.
 */
const ddb = new DynamoDBClient({});

export const handler = async (event) => {
    const tableName = process.env.TABLE_NAME || "unknown";
    const queueUrl = process.env.QUEUE_URL || "unknown";

    const method = event.httpMethod || event.requestContext?.httpMethod || "UNKNOWN";
    const path = event.path || event.rawPath || "/";

    // A small real-SDK item store. The local --data-dir row writes an item in
    // one run and reads it back through this handler in a second run.
    const item = path.match(/^\/items\/([^/]+)$/);
    if (item && (method === "PUT" || method === "GET")) {
        const key = { pk: { S: `item-${decodeURIComponent(item[1])}` }, sk: { S: "v1" } };
        if (method === "PUT") {
            let value = "";
            try {
                value = JSON.parse(event.body || "{}").value ?? "";
            } catch {
                return {
                    statusCode: 400,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ error: "Body must be JSON with a value" }),
                };
            }
            await ddb.send(new PutItemCommand({
                TableName: tableName,
                Item: { ...key, value: { S: String(value) } },
            }));
            return {
                statusCode: 200,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: item[1], value: String(value), tableName }),
            };
        }
        const stored = await ddb.send(new GetItemCommand({ TableName: tableName, Key: key }));
        if (!stored.Item) {
            return {
                statusCode: 404,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ error: "Item not found", id: item[1] }),
            };
        }
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                id: item[1],
                value: stored.Item.value?.S ?? null,
                tableName,
            }),
        };
    }

    const response = {
        message: "Lesser parity API handler",
        method,
        path,
        environment: {
            tableName,
            queueUrl,
        },
        timestamp: new Date().toISOString(),
        requestId: event.requestContext?.requestId || "unknown",
    };

    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify(response),
    };
};
