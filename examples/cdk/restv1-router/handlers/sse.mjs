/**
 * SSE streaming handler - demonstrates response streaming.
 * This handler streams events over time using Server-Sent Events format.
 */
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
    const stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        },
    });

    // Send events over 10 seconds
    for (let i = 1; i <= 10; i++) {
        stream.write(`data: Event ${i} at ${new Date().toISOString()}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    stream.write(`data: [DONE]\n\n`);
    stream.end();
});
