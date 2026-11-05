/**
 * The Node handler set for the Runtime API conformance suite.
 *
 * `handler` is a buffered handler; `stream` is a response-streaming handler
 * wrapped with awslambda.streamifyResponse, as the response-streaming page
 * documents:
 * https://docs.aws.amazon.com/lambda/latest/dg/config-rs-write-functions.html
 */
export const handler = async (event) => {
    switch (event.case) {
        case "proxy":
            return {
                statusCode: 201,
                headers: { "content-type": "text/plain; charset=utf-8", "x-case": "proxy" },
                cookies: ["a=1", "b=2"],
                body: "node proxy body",
            };
        case "error":
            throw new Error("node handler error");
        case "timeout":
            await new Promise((resolve) => setTimeout(resolve, 3000));
            return { ok: true };
        default:
            return { ok: true, case: event.case, runtime: "node" };
    }
};

export const stream = awslambda.streamifyResponse(async (event, responseStream) => {
    const stream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: { "content-type": "text/event-stream" },
    });
    stream.write("node-1\n");
    await new Promise((resolve) => setTimeout(resolve, 400));
    stream.write("node-2\n");
    stream.end();
});
