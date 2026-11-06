/**
 * WebSocket $connect REQUEST authorizer.
 *
 * API Gateway invokes it during the handshake with the documented WebSocket
 * authorizer event, whose methodArn ends in /$connect. The response is an IAM
 * policy the runner matches narrowly against that method ARN; Allow lets the
 * connection proceed, Deny refuses it with 401:
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-websocket-api-lambda-auth.html
 */
const ALLOWED = "local-allow";

export const handler = async (event) => {
    const header = String(event?.headers?.authorization ?? "");
    const token = header.replace(/^Bearer\s+/i, "").trim();
    const allow = token === ALLOWED;
    return {
        principalId: allow ? "local-user" : "anonymous",
        policyDocument: {
            Version: "2012-10-17",
            Statement: [
                {
                    Action: "execute-api:Invoke",
                    Effect: allow ? "Allow" : "Deny",
                    Resource: event?.methodArn ?? "*",
                },
            ],
        },
        context: { tenant: "demo", tier: "local" },
    };
};
