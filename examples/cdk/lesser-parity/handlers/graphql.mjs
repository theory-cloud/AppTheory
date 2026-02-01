/**
 * GraphQL API handler.
 *
 * Demonstrates a dedicated Lambda integration for a specific API route.
 */
export const handler = async (event) => {
    const tableName = process.env.TABLE_NAME || "unknown";

    // Parse the GraphQL query from the request body
    let query = "unknown";
    let operationName = "unknown";

    try {
        const body = JSON.parse(event.body || "{}");
        query = body.query || "no query provided";
        operationName = body.operationName || "anonymous";
    } catch {
        // Ignore parse errors
    }

    // Mock GraphQL response
    const response = {
        data: {
            __typename: "Query",
            _meta: {
                handler: "lesser-parity-graphql",
                tableName,
                operationName,
                timestamp: new Date().toISOString(),
            },
        },
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
