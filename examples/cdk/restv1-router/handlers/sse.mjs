/**
 * SSE streaming handler - demonstrates response streaming.
 * This handler streams events over time using Server-Sent Events format.
 */
export async function handler(event) {
    const responseStream = awslambda.HttpResponseStream.from(
        awslambda.response,
        {
            statusCode: 200,
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
            },
        }
    );

    // Send events over 10 seconds
    for (let i = 1; i <= 10; i++) {
        responseStream.write(`data: Event ${i} at ${new Date().toISOString()}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    responseStream.write(`data: [DONE]\n\n`);
    responseStream.end();
}
