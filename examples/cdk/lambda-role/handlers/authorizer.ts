/**
 * Raw API Gateway handler that echoes the authorizer context.
 *
 * The row asserts the documented authorizer values the integration received:
 * an HTTP API JWT authorizer exposes requestContext.authorizer.jwt.claims and
 * .scopes, and a REST API Cognito authorizer exposes
 * requestContext.authorizer.claims.
 *
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html
 */
export const handler = async (event: any) => {
    const requestContext = event?.requestContext ?? {};
    const authorizer = requestContext.authorizer ?? {};
    const jwt = authorizer.jwt ?? {};
    return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            ok: true,
            routeKey: requestContext.routeKey ?? "",
            httpMethod: event?.httpMethod ?? "",
            path: event?.path ?? event?.rawPath ?? "",
            authorizer,
            claims: authorizer.claims ?? jwt.claims ?? {},
            scopes: jwt.scopes ?? [],
        }),
    };
};
