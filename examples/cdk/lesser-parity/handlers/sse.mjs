/**
 * SSE (Server-Sent Events) streaming handler.
 *
 * Demonstrates the streaming capability of AppTheoryRestApiRouter.
 * This handler sends periodic updates to the client via SSE.
 */
export const handler = async (event) => {
    const headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
    };

    // Generate SSE events
    const events = [];
    const timestamp = Date.now();

    events.push(`data: ${JSON.stringify({ type: "connection", message: "Connected to SSE stream", timestamp })}\n\n`);
    events.push(`data: ${JSON.stringify({ type: "ping", message: "Heartbeat", timestamp: timestamp + 1000 })}\n\n`);
    events.push(`data: ${JSON.stringify({ type: "update", message: "Data update received", timestamp: timestamp + 2000, data: { count: 42 } })}\n\n`);

    return {
        statusCode: 200,
        headers,
        body: events.join(""),
    };
};
