/**
 * General API handler - catch-all for unmatched routes.
 */
export async function handler(event) {
    const { httpMethod, path, pathParameters } = event;

    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        body: JSON.stringify({
            message: "API catch-all handler",
            method: httpMethod,
            path: path,
            pathParameters: pathParameters || {},
            timestamp: new Date().toISOString(),
        }),
    };
}
