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
        const endpoint = ensureResourcePath(router.api.root, metadataPathFromResourceURL(resource));
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
AppTheoryMcpProtectedResource[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResource", version: "0.24.6" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXByb3RlY3RlZC1yZXNvdXJjZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1wcm90ZWN0ZWQtcmVzb3VyY2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBb0M7QUFDcEMsb0RBQW9EO0FBQ3BELDJDQUF1QztBQUV2Qyx5REFBMEQ7QUFnQzFEOztHQUVHO0FBQ0gsTUFBYSw2QkFBOEIsU0FBUSxzQkFBUztJQUMxRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXlDO1FBQ2pGLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQztRQUM1QixNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNyRCxNQUFNLG9CQUFvQixHQUFHLENBQUMsS0FBSyxDQUFDLG9CQUFvQixJQUFJLEVBQUUsQ0FBQzthQUM1RCxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7YUFDbEMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBRS9CLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNaLE1BQU0sSUFBSSxLQUFLLENBQUMsbURBQW1ELENBQUMsQ0FBQztRQUN2RSxDQUFDO1FBQ0QsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2QsTUFBTSxJQUFJLEtBQUssQ0FBQyxxREFBcUQsQ0FBQyxDQUFDO1FBQ3pFLENBQUM7UUFDRCxJQUFJLG9CQUFvQixDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUN0QyxNQUFNLElBQUksS0FBSyxDQUFDLGlFQUFpRSxDQUFDLENBQUM7UUFDckYsQ0FBQztRQUVELE1BQU0sUUFBUSxHQUFHLGtCQUFrQixDQUNqQyxNQUFNLENBQUMsR0FBRyxDQUFDLElBQUksRUFDZiwyQkFBMkIsQ0FBQyxRQUFRLENBQUMsQ0FDdEMsQ0FBQztRQUVGLE1BQU0sSUFBSSxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLFlBQVksQ0FBQztZQUN2QyxRQUFRO1lBQ1IscUJBQXFCLEVBQUUsb0JBQW9CO1NBQzVDLENBQUMsQ0FBQztRQUVILFFBQVEsQ0FBQyxTQUFTLENBQUMsS0FBSyxFQUFFLElBQUksS0FBSyxDQUFDLGVBQWUsQ0FBQztZQUNsRCxnQkFBZ0IsRUFBRSxFQUFFLGtCQUFrQixFQUFFLHVCQUF1QixFQUFFO1lBQ2pFLG1CQUFtQixFQUFFLEtBQUssQ0FBQyxtQkFBbUIsQ0FBQyxhQUFhO1lBQzVELG9CQUFvQixFQUFFO2dCQUNwQjtvQkFDRSxVQUFVLEVBQUUsS0FBSztvQkFDakIsaUJBQWlCLEVBQUU7d0JBQ2pCLGtCQUFrQixFQUFFLElBQUk7cUJBQ3pCO29CQUNELGtCQUFrQixFQUFFO3dCQUNsQixxQ0FBcUMsRUFBRSxtQ0FBbUM7cUJBQzNFO2lCQUNGO2FBQ0Y7U0FDRixDQUFDLEVBQUU7WUFDRixlQUFlLEVBQUU7Z0JBQ2Y7b0JBQ0UsVUFBVSxFQUFFLEtBQUs7b0JBQ2pCLGtCQUFrQixFQUFFO3dCQUNsQixxQ0FBcUMsRUFBRSxJQUFJO3FCQUM1QztpQkFDRjthQUNGO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQzs7QUF0REgsc0VBdURDOzs7QUFFRCxTQUFTLDJCQUEyQixDQUFDLFFBQWdCO0lBQ25ELElBQUksTUFBVyxDQUFDO0lBQ2hCLElBQUksQ0FBQztRQUNILE1BQU0sR0FBRyxJQUFJLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUM3QixDQUFDO0lBQUMsTUFBTSxDQUFDO1FBQ1AsTUFBTSxJQUFJLEtBQUssQ0FBQyxpRUFBaUUsQ0FBQyxDQUFDO0lBQ3JGLENBQUM7SUFFRCxNQUFNLFlBQVksR0FBRyxrQkFBa0IsQ0FBQyxNQUFNLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQy9ELE9BQU8sd0NBQXdDLFlBQVksRUFBRSxDQUFDO0FBQ2hFLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLElBQXFCLEVBQUUsSUFBWTtJQUM3RCxJQUFJLE9BQU8sR0FBRyxJQUFJLENBQUM7SUFDbkIsTUFBTSxPQUFPLEdBQUcsSUFBQSwrQkFBZ0IsRUFBQyxNQUFNLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLEdBQUcsQ0FBQyxDQUFDO0lBQ2pFLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztRQUNiLE9BQU8sT0FBTyxDQUFDO0lBQ2pCLENBQUM7SUFFRCxLQUFLLE1BQU0sT0FBTyxJQUFJLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUN6QyxPQUFPLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsSUFBSSxPQUFPLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3pFLENBQUM7SUFFRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RhY2sgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5pbXBvcnQgeyBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIH0gZnJvbSBcIi4vcmVzdC1hcGktcm91dGVyXCI7XG5cbi8qKlxuICogUHJvcHMgZm9yIEFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGFkZHMgdGhlIFJGQzk3MjggcHJvdGVjdGVkIHJlc291cmNlIG1ldGFkYXRhIGVuZHBvaW50IHJlcXVpcmVkXG4gKiBieSBNQ1AgYXV0aCAoMjAyNS0wNi0xOCk6XG4gKiAtIEdFVCBgLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZS8uLi5yZXNvdXJjZSBwYXRoLi4uYFxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlUHJvcHMge1xuICAvKipcbiAgICogVGhlIFJFU1QgQVBJIHJvdXRlciB0byBhdHRhY2ggdGhlIHdlbGwta25vd24gZW5kcG9pbnQgdG8uXG4gICAqL1xuICByZWFkb25seSByb3V0ZXI6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBjYW5vbmljYWwgcHJvdGVjdGVkIHJlc291cmNlIGlkZW50aWZpZXIuXG4gICAqXG4gICAqIEZvciBDbGF1ZGUgUmVtb3RlIE1DUCB0aGlzIHNob3VsZCBiZSB5b3VyIE1DUCBlbmRwb2ludCBVUkwgKGluY2x1ZGluZyBgL21jcGApLFxuICAgKiBlLmcuIGBodHRwczovL21jcC5leGFtcGxlLmNvbS9tY3BgLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzb3VyY2U6IHN0cmluZztcblxuICAvKipcbiAgICogT25lIG9yIG1vcmUgT0F1dGggQXV0aG9yaXphdGlvbiBTZXJ2ZXIgaXNzdWVyL2Jhc2UgVVJMcy5cbiAgICpcbiAgICogQXV0aGVvcnkgc2hvdWxkIGJlIHRoZSBmaXJzdCAoYW5kIHVzdWFsbHkgb25seSkgZW50cnkuXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2VydmVyczogc3RyaW5nW107XG59XG5cbi8qKlxuICogQWRkcyBwYXRoLXNjb3BlZCBgLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZS8uLi5gIG1ldGFkYXRhIChSRkM5NzI4KSB0byBhIFJFU1QgQVBJLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2UgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2VQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCByb3V0ZXIgPSBwcm9wcy5yb3V0ZXI7XG4gICAgY29uc3QgcmVzb3VyY2UgPSBTdHJpbmcocHJvcHMucmVzb3VyY2UgPz8gXCJcIikudHJpbSgpO1xuICAgIGNvbnN0IGF1dGhvcml6YXRpb25TZXJ2ZXJzID0gKHByb3BzLmF1dGhvcml6YXRpb25TZXJ2ZXJzID8/IFtdKVxuICAgICAgLm1hcCgocykgPT4gU3RyaW5nKHMgPz8gXCJcIikudHJpbSgpKVxuICAgICAgLmZpbHRlcigocykgPT4gcy5sZW5ndGggPiAwKTtcblxuICAgIGlmICghcm91dGVyKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZTogcm91dGVyIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cbiAgICBpZiAoIXJlc291cmNlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZTogcmVzb3VyY2UgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuICAgIGlmIChhdXRob3JpemF0aW9uU2VydmVycy5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlOiBhdXRob3JpemF0aW9uU2VydmVycyBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBlbmRwb2ludCA9IGVuc3VyZVJlc291cmNlUGF0aChcbiAgICAgIHJvdXRlci5hcGkucm9vdCxcbiAgICAgIG1ldGFkYXRhUGF0aEZyb21SZXNvdXJjZVVSTChyZXNvdXJjZSksXG4gICAgKTtcblxuICAgIGNvbnN0IGJvZHkgPSBTdGFjay5vZih0aGlzKS50b0pzb25TdHJpbmcoe1xuICAgICAgcmVzb3VyY2UsXG4gICAgICBhdXRob3JpemF0aW9uX3NlcnZlcnM6IGF1dGhvcml6YXRpb25TZXJ2ZXJzLFxuICAgIH0pO1xuXG4gICAgZW5kcG9pbnQuYWRkTWV0aG9kKFwiR0VUXCIsIG5ldyBhcGlndy5Nb2NrSW50ZWdyYXRpb24oe1xuICAgICAgcmVxdWVzdFRlbXBsYXRlczogeyBcImFwcGxpY2F0aW9uL2pzb25cIjogXCJ7XFxcInN0YXR1c0NvZGVcXFwiOiAyMDB9XCIgfSxcbiAgICAgIHBhc3N0aHJvdWdoQmVoYXZpb3I6IGFwaWd3LlBhc3N0aHJvdWdoQmVoYXZpb3IuV0hFTl9OT19NQVRDSCxcbiAgICAgIGludGVncmF0aW9uUmVzcG9uc2VzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgIHJlc3BvbnNlVGVtcGxhdGVzOiB7XG4gICAgICAgICAgICBcImFwcGxpY2F0aW9uL2pzb25cIjogYm9keSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkNvbnRlbnQtVHlwZVwiOiBcIidhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04J1wiLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pLCB7XG4gICAgICBtZXRob2RSZXNwb25zZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQ29udGVudC1UeXBlXCI6IHRydWUsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbWV0YWRhdGFQYXRoRnJvbVJlc291cmNlVVJMKHJlc291cmNlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBsZXQgcGFyc2VkOiBVUkw7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTChyZXNvdXJjZSk7XG4gIH0gY2F0Y2gge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlOiByZXNvdXJjZSBtdXN0IGJlIGFuIGFic29sdXRlIFVSTFwiKTtcbiAgfVxuXG4gIGNvbnN0IHJlc291cmNlUGF0aCA9IGRlY29kZVVSSUNvbXBvbmVudChwYXJzZWQucGF0aG5hbWUgfHwgXCJcIik7XG4gIHJldHVybiBgLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZSR7cmVzb3VyY2VQYXRofWA7XG59XG5cbmZ1bmN0aW9uIGVuc3VyZVJlc291cmNlUGF0aChyb290OiBhcGlndy5JUmVzb3VyY2UsIHBhdGg6IHN0cmluZyk6IGFwaWd3LklSZXNvdXJjZSB7XG4gIGxldCBjdXJyZW50ID0gcm9vdDtcbiAgY29uc3QgdHJpbW1lZCA9IHRyaW1SZXBlYXRlZENoYXIoU3RyaW5nKHBhdGggPz8gXCJcIikudHJpbSgpLCBcIi9cIik7XG4gIGlmICghdHJpbW1lZCkge1xuICAgIHJldHVybiBjdXJyZW50O1xuICB9XG5cbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHRyaW1tZWQuc3BsaXQoXCIvXCIpKSB7XG4gICAgY3VycmVudCA9IGN1cnJlbnQuZ2V0UmVzb3VyY2Uoc2VnbWVudCkgPz8gY3VycmVudC5hZGRSZXNvdXJjZShzZWdtZW50KTtcbiAgfVxuXG4gIHJldHVybiBjdXJyZW50O1xufVxuIl19