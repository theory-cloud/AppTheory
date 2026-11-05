/**
 * SSE (Server-Sent Events) streaming handler.
 *
 * Demonstrates the streaming capability of AppTheoryRestApiRouter. The REST
 * integration is declared with `streaming: true`, so API Gateway invokes the
 * function with InvokeWithResponseStream and expects the metadata JSON, the
 * 8-null-byte delimiter and then the payload:
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
 *
 * The handler writes each event and waits, so a client observes the first event
 * before the stream ends.
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

    const timestamp = Date.now();
    const events = [
        { type: "connection", message: "Connected to SSE stream", timestamp },
        { type: "ping", message: "Heartbeat", timestamp: timestamp + 1000 },
        { type: "update", message: "Data update received", timestamp: timestamp + 2000, data: { count: 42 } },
    ];

    for (const event of events) {
        stream.write(`data: ${JSON.stringify(event)}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 700));
    }
    stream.end();
});
