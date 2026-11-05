/**
 * Lambda authorizer that returns an IAM policy for the REST TOKEN, REST REQUEST
 * and HTTP API (payload format 1.0) authorizer shapes.
 *
 * The function counts its own invocations and returns the count in the
 * authorizer context. That is how the harness proves a cached policy was reused
 * without invoking the authorizer: the handler echoes the context it received.
 *
 * The token/header value selects the outcome: "allow" allows, "deny" returns a
 * Deny policy, "unauthorized" throws the documented Unauthorized error, and
 * "invalid" returns a response that is not a policy (the documented 500).
 *
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html
 */

let invocations = 0;

type Effect = "Allow" | "Deny";

function policy(effect: Effect, resource: string, context: Record<string, string>) {
    return {
        principalId: "local-user",
        policyDocument: {
            Version: "2012-10-17",
            Statement: [
                {
                    Action: "execute-api:Invoke",
                    Effect: effect,
                    Resource: resource,
                },
            ],
        },
        context,
    };
}

function header(event: any, name: string): string {
    const headers = event?.headers ?? {};
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) {
            return String(value);
        }
    }
    return "";
}

export const handler = async (event: any) => {
    invocations += 1;
    const context = { invocation: String(invocations), role: "local-role", tenant: "t-1" };
    const methodArn = event?.methodArn ?? event?.routeArn ?? "";
    const token = event?.type === "TOKEN" ? String(event?.authorizationToken ?? "") : header(event, "Authorization");
    const tenant = header(event, "X-Tenant");
    const scope = String((event?.queryStringParameters ?? {})["scope"] ?? "");

    if (event?.type === "TOKEN") {
        if (token === "deny") {
            return policy("Deny", methodArn, context);
        }
        if (token === "unauthorized") {
            throw new Error("Unauthorized");
        }
        if (token === "invalid") {
            return { statusCode: 500, body: "not a policy" };
        }
        return policy("Allow", methodArn, context);
    }

    if (tenant === "deny" || scope === "deny" || token === "deny") {
        return policy("Deny", methodArn, context);
    }
    if (tenant === "unauthorized" || token === "unauthorized") {
        throw new Error("Unauthorized");
    }
    if (tenant === "invalid" || token === "invalid") {
        return { statusCode: 500, body: "not a policy" };
    }
    return policy("Allow", methodArn, context);
};
