/**
 * GraphQL handler - handles GraphQL queries and mutations.
 */
export async function handler(event) {
    const body = event.body ? JSON.parse(event.body) : {};
    const { query, variables } = body;

    // Simple mock GraphQL response
    const response = {
        data: {
            message: "GraphQL endpoint mock response",
            query: query || "no query provided",
            timestamp: new Date().toISOString(),
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
}
