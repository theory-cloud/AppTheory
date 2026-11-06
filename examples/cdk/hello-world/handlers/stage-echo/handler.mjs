/**
 * HTTP API v2 stage-shape probe.
 *
 * Returns the fields the payload-format-2.0 page defines for a named stage:
 * rawPath carries the stage prefix, requestContext.http.path mirrors it, and
 * requestContext.stage names the stage.
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html
 */
export const handler = async (event) => ({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
        rawPath: event.rawPath ?? null,
        path: event.requestContext?.http?.path ?? null,
        stage: event.requestContext?.stage ?? null,
    }),
});
