/**
 * General API handler (catch-all).
 *
 * Handles all requests that don't match specific routes.
 * Demonstrates the multi-Lambda routing capability.
 */
export const handler = async (event) => {
    const tableName = process.env.TABLE_NAME || "unknown";
    const queueUrl = process.env.QUEUE_URL || "unknown";

    const method = event.httpMethod || event.requestContext?.httpMethod || "UNKNOWN";
    const path = event.path || event.rawPath || "/";

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
