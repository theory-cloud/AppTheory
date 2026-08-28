"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpProtectedResource = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigw = require("aws-cdk-lib/aws-apigateway");
const constructs_1 = require("constructs");
const string_utils_1 = require("./private/string-utils");
/**
 * Adds path-scoped `/.well-known/oauth-protected-resource/...` metadata (RFC9728) to a REST API.
 */
class AppTheoryMcpProtectedResource extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const router = props.router;
        const resource = String(props.resource ?? "").trim();
        const authorizationServers = (props.authorizationServers ?? [])
            .map((s) => String(s ?? "").trim())
            .filter((s) => s.length > 0);
        if (!router) {
            throw new Error("AppTheoryMcpProtectedResource: router is required");
        }
        if (!resource) {
            throw new Error("AppTheoryMcpProtectedResource: resource is required");
        }
        if (authorizationServers.length === 0) {
            throw new Error("AppTheoryMcpProtectedResource: authorizationServers is required");
        }
        const endpoint = ensureResourcePath(router.api.root, props.metadataPath === undefined
            ? metadataPathFromResourceURL(resource)
            : normalizeMetadataPath(props.metadataPath));
        const body = aws_cdk_lib_1.Stack.of(this).toJsonString({
            resource,
            authorization_servers: authorizationServers,
        });
        endpoint.addMethod("GET", new apigw.MockIntegration({
            requestTemplates: { "application/json": "{\"statusCode\": 200}" },
            passthroughBehavior: apigw.PassthroughBehavior.WHEN_NO_MATCH,
            integrationResponses: [
                {
                    statusCode: "200",
                    responseTemplates: {
                        "application/json": body,
                    },
                    responseParameters: {
                        "method.response.header.Content-Type": "'application/json; charset=utf-8'",
                    },
                },
            ],
        }), {
            methodResponses: [
                {
                    statusCode: "200",
                    responseParameters: {
                        "method.response.header.Content-Type": true,
                    },
                },
            ],
        });
    }
}
exports.AppTheoryMcpProtectedResource = AppTheoryMcpProtectedResource;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMcpProtectedResource[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResource", version: "4.2.1-rc" };
function metadataPathFromResourceURL(resource) {
    let parsed;
    try {
        parsed = new URL(resource);
    }
    catch {
        throw new Error("AppTheoryMcpProtectedResource: resource must be an absolute URL");
    }
    const resourcePath = decodeURIComponent(parsed.pathname || "");
    return `/.well-known/oauth-protected-resource${resourcePath}`;
}
function normalizeMetadataPath(metadataPath) {
    if (aws_cdk_lib_1.Token.isUnresolved(metadataPath)) {
        throw new Error("AppTheoryMcpProtectedResource: metadataPath must be a synthesis-time literal path");
    }
    const normalized = String(metadataPath ?? "").trim();
    if (!normalized.startsWith("/")
        || normalized === "/"
        || normalized.endsWith("/")
        || normalized.includes("//")
        || /[?#{}]/.test(normalized)) {
        throw new Error("AppTheoryMcpProtectedResource: metadataPath must be a literal absolute route path");
    }
    return normalized;
}
function ensureResourcePath(root, path) {
    let current = root;
    const trimmed = (0, string_utils_1.trimRepeatedChar)(String(path ?? "").trim(), "/");
    if (!trimmed) {
        return current;
    }
    for (const segment of trimmed.split("/")) {
        current = current.getResource(segment) ?? current.addResource(segment);
    }
    return current;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXByb3RlY3RlZC1yZXNvdXJjZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1wcm90ZWN0ZWQtcmVzb3VyY2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBMkM7QUFDM0Msb0RBQW9EO0FBQ3BELDJDQUF1QztBQUV2Qyx5REFBMEQ7QUFpRDFEOztHQUVHO0FBQ0gsTUFBYSw2QkFBOEIsU0FBUSxzQkFBUztJQUMxRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXlDO1FBQ2pGLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQztRQUM1QixNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNyRCxNQUFNLG9CQUFvQixHQUFHLENBQUMsS0FBSyxDQUFDLG9CQUFvQixJQUFJLEVBQUUsQ0FBQzthQUM1RCxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7YUFDbEMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBRS9CLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNaLE1BQU0sSUFBSSxLQUFLLENBQUMsbURBQW1ELENBQUMsQ0FBQztRQUN2RSxDQUFDO1FBQ0QsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2QsTUFBTSxJQUFJLEtBQUssQ0FBQyxxREFBcUQsQ0FBQyxDQUFDO1FBQ3pFLENBQUM7UUFDRCxJQUFJLG9CQUFvQixDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUN0QyxNQUFNLElBQUksS0FBSyxDQUFDLGlFQUFpRSxD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QUVELEtBQUssTUFBTSxPQUFPLElBQUksT0FBTyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3pDLE9BQU8sR0FBRyxPQUFPLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxJQUFJLE9BQU8sQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDekUsQ0FBQztJQUVELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5pbXBvcnQgeyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIH0gZnJvbSBcIi4vcmVzdC1hcGktcm91dGVyXCI7XG5cbi8qKlxuICogUHJvcHMgZm9yIEFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGFkZHMgdGhlIFJGQzk3MjggcHJvdGVjdGVkIHJlc291cmNlIG1ldGFkYXRhIGVuZHBvaW50IHJlcXVpcmVkXG4gKiBieSBNQ1AgYXV0aCAoMjAyNS0wNi0xOCk6XG4gKiAtIEdFVCBgLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZS8uLi5yZXNvdXJjZSBwYXRoLi4uYFxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlUHJvcHMge1xuICAvKipcbiAgICogVGhlIFJFU1QgQVBJIHJvdXRlciB0byBhdHRhY2ggdGhlIHdlbGwta25vd24gZW5kcG9pbnQgdG8uXG4gICAqL1xuICByZWFkb25seSByb3V0ZXI6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBjYW5vbmljYWwgcHJvdGVjdGVkIHJlc291cmNlIGlkZW50aWZpZXIuXG4gICAqXG4gICogRm9yIENsYXVkZSBSZW1vdGUgTUNQIHRoaXMgc2hvdWxkIGJlIHlvdXIgTUNQIGVuZHBvaW50IFVSTCAoaW5jbHVkaW5nIGAvbWNwYCksXG4gICogZS5nLiBgaHR0cHM6Ly9tY3AuZXhhbXBsZS5jb20vbWNwYC5cbiAgICpcbiAgICogQGRlcHJlY2F0ZWQgVXNlIEFwcFRoZW9yeU1jcFNlcnZlciB3aXRoIHJ1bnRpbWUtc2VydmVkIGRpc2NvdmVyeS4gVGhpc1xuICAgKiBVUkwtdmFsdWVkIGNvbXBhdGliaWxpdHkgcHJvcCBpcyByZXRhaW5lZCBmb3IgZXhpc3Rpbmcgc3RhdGljIGRvY3VtZW50cy5cbiAgICovXG4gIHJlYWRvbmx5IHJlc291cmNlOiBzdHJpbmc7XG5cbiAgLyoqXG4gICogT25lIG9yIG1vcmUgT0F1dGggQXV0aG9yaXphdGlvbiBTZXJ2ZXIgaXNzdWVyL2Jhc2UgVVJMcy5cbiAgKlxuICAqIEF1dGhlb3J5IHNob3VsZCBiZSB0aGUgZmlyc3QgKGFuZCB1c3VhbGx5IG9ubHkpIGVudHJ5LlxuICAgKlxuICAgKiBAZGVwcmVjYXRlZCBVc2UgQXBwVGhlb3J5TWNwU2VydmVyIGF1dGhvcml6YXRpb25TZXJ2ZXJJc3N1ZXIgYW5kIGp3a3NVcmlcbiAgICogcHJvcHMgd2l0aCB0aGUgR28gcnVudGltZSBkaXNjb3ZlcnkgaGVscGVyLlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXphdGlvblNlcnZlcnM6IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBFeHBsaWNpdCBsaXRlcmFsIHJvdXRlIHBhdGggZm9yIHRoZSBzZWNvbmRhcnkgc3ludGgtdGltZS1zdGF0aWMgZG9jdW1lbnQuXG4gICAqXG4gICAqIFdoZW4gb21pdHRlZCwgdGhlIHBhdGggaXMgZGVyaXZlZCBmcm9tIGEgbGl0ZXJhbCBgcmVzb3VyY2VgIFVSTCBmb3IgZnVsbFxuICAgKiBiYWNrd2FyZHMgY29tcGF0aWJpbGl0eS4gU2V0IHRoaXMgb25seSB3aGVuIGEgc3RhdGljIG1vY2sgaW50ZWdyYXRpb24gaXNcbiAgICogZ2VudWluZWx5IHJlcXVpcmVkOyBuYW1lc3BhY2UgYXBwbGljYXRpb25zIHNob3VsZCB1c2UgQXBwVGhlb3J5TWNwU2VydmVyXG4gICAqIGFuZCBydW50aW1lLXNlcnZlZCBkaXNjb3ZlcnkgaW5zdGVhZC5cbiAgICogQGRlZmF1bHQgZGVyaXZlZCBmcm9tIHJlc291cmNlXG4gICAqL1xuICByZWFkb25seSBtZXRhZGF0YVBhdGg/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQWRkcyBwYXRoLXNjb3BlZCBgLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZS8uLi5gIG1ldGFkYXRhIChSRkM5NzI4KSB0byBhIFJFU1QgQVBJLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2UgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2VQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCByb3V0ZXIgPSBwcm9wcy5yb3V0ZXI7XG4gICAgY29uc3QgcmVzb3VyY2UgPSBTdHJpbmcocHJvcHMucmVzb3VyY2UgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IGF1dGhvcml6YXRpb25TZXJ2ZXJzID0gKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJzID8/IFtdKVxuICAgICAgLm1hcCgocykgPT4gU3RyaW5nKHMgPz8gXCJcIikudHJpbSgpKVxuICAgICAgLmZpbHRlcigocykgPT4gcy5sZW5ndGggPiAwKTtcblxuICAgIGlmICghcm91dGVyKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZTogcm91dGVyIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cbiAgICBpZiAoIXJlc291cmNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZTogcmVzb3VyY2UgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuICAgIGlmIChhdXRob3JpemF0aW9uU2VydmVycy5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlOiBhdXRob3JpemF0aW9uU2VydmVycyBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBlbmRwb2ludCA9IGVuc3VyZVJlc291cmNlUGF0aChcbiAgICAgIHJvdXRlci5hcGkucm9vdCxcbiAgICAgIHByb3BzLm1ldGFkYXRhUGF0aCA9PT0gdW5kZWZpbmVkXG4gICAgICAgID8gbWV0YWRhdGFQYXRoRnJvbVJlc291cmNlVVJMKHJlc291cmNlKVxuICAgICAgICA6IG5vcm1hbGl6ZU1ldGFkYXRhUGF0aChwcm9wcy5tZXRhZGF0YVBhdGgpLFxuICAgICk7XG5cbiAgICBjb25zdCBib2R5ID0gU3RhY2sub2YodGhpcykudG9Kc29uU3RyaW5nKHtcbiAgICAgIHJlc291cmNlLFxuICAgICAgYXV0aG9yaXphdGlvbl9zZXJ2ZXJzOiBhdXRob3JpemF0aW9uU2VydmVycyxcbiAgICB9KTtcblxuICAgIGVuZHBvaW50LmFkZE1ldGhvZChcIkdFVFwiLCBuZXcgYXBpZ3cuTW9ja0ludGVncmF0aW9uKHtcbiAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IHsgXCJhcHBsaWNhdGlvbi9qc29uXCI6IFwie1xcXCJzdGF0dXNDb2RlXFxcIjogMjAwfVwiIH0sXG4gICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yLldIRU5fTk9fTUFUQ0gsXG4gICAgICBpbnRlZ3JhdGlvblJlc3BvbnNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICByZXNwb25zZVRlbXBsYXRlczoge1xuICAgICAgICAgICAgXCJhcHBsaWNhdGlvbi9qc29uXCI6IGJvZHksXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5Db250ZW50LVR5cGVcIjogXCInYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCdcIixcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KSwge1xuICAgICAgbWV0aG9kUmVzcG9uc2VzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkNvbnRlbnQtVHlwZVwiOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuICB9XG59XG5cbmZ1bmN0aW9uIG1ldGFkYXRhUGF0aEZyb21SZXNvdXJjZVVSTChyZXNvdXJjZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IHBhcnNlZDogVVJMO1xuICB0cnkge1xuICAgIHBhcnNlZCA9IG5ldyBVUkwocmVzb3VyY2UpO1xuICB9IGNhdGNoIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZTogcmVzb3VyY2UgbXVzdCBiZSBhbiBhYnNvbHV0ZSBVUkxcIik7XG4gIH1cblxuICBjb25zdCByZXNvdXJjZVBhdGggPSBkZWNvZGVVUklDb21wb25lbnQocGFyc2VkLnBhdGhuYW1lIHx8IFwiXCIpO1xuICByZXR1cm4gYC8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2Uke3Jlc291cmNlUGF0aH1gO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVNZXRhZGF0YVBhdGgobWV0YWRhdGFQYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKG1ldGFkYXRhUGF0aCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZTogbWV0YWRhdGFQYXRoIG11c3QgYmUgYSBzeW50aGVzaXMtdGltZSBsaXRlcmFsIHBhdGhcIik7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyhtZXRhZGF0YVBhdGggPz8gXCJcIikudHJpbSgpO1xuICBpZiAoXG4gICAgIW5vcm1hbGl6ZWQuc3RhcnRzV2l0aChcIi9cIilcbiAgICB8fCBub3JtYWxpemVkID09PSBcIi9cIlxuICAgIHx8IG5vcm1hbGl6ZWQuZW5kc1dpdGgoXCIvXCIpXG4gICAgfHwgbm9ybWFsaXplZC5pbmNsdWRlcyhcIi8vXCIpXG4gICAgfHwgL1s/I3t9XS8udGVzdChub3JtYWxpemVkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZTogbWV0YWRhdGFQYXRoIG11c3QgYmUgYSBsaXRlcmFsIGFic29sdXRlIHJvdXRlIHBhdGhcIik7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZVJlc291cmNlUGF0aChyb290OiBhcGlndy5JUmVzb3VyY2UsIHBhdGg6IHN0cmluZyk6IGFwaWd3LklSZXNvdXJjZSB7XG4gIGxldCBjdXJyZW50ID0gcm9vdDtcbiAgY29uc3QgdHJpbW1lZCA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKHBhdGggPz8gXCJcIikudHJpbSgpLCBcIi9cIik7XG4gIGlmICghdHJpbW1lZCkge1xuICAgIHJldHVybiBjdXJyZW50O1xuICB9XG5cbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHRyaW1tZWQuc3BsaXQoXCIvXCIpKSB7XG4gICAgY3VycmVudCA9IGN1cnJlbnQuZ2V0UmVzb3VyY2Uoc2VnbWVudCkgPz8gY3VycmVudC5hZGRSZXNvdXJjZShzZWdtZW50KTtcbiAgfVxuXG4gIHJldHVybiBjdXJyZW50O1xufVxuIl19