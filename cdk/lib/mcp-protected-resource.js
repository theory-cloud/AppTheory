"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpProtectedResource = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigw = require("aws-cdk-lib/aws-apigateway");
const constructs_1 = require("constructs");
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
AppTheoryMcpProtectedResource[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResource", version: "0.19.0-rc" };
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
    const trimmed = String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!trimmed) {
        return current;
    }
    for (const segment of trimmed.split("/")) {
        current = current.getResource(segment) ?? current.addResource(segment);
    }
    return current;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXByb3RlY3RlZC1yZXNvdXJjZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1wcm90ZWN0ZWQtcmVzb3VyY2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBb0M7QUFDcEMsb0RBQW9EO0FBQ3BELDJDQUF1QztBQWlDdkM7O0dBRUc7QUFDSCxNQUFhLDZCQUE4QixTQUFRLHNCQUFTO0lBQzFELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUM7UUFDakYsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDO1FBQzVCLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3JELE1BQU0sb0JBQW9CLEdBQUcsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLElBQUksRUFBRSxDQUFDO2FBQzVELEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQzthQUNsQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFFL0IsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ1osTUFBTSxJQUFJLEtBQUssQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO1FBQ3ZFLENBQUM7UUFDRCxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLHFEQUFxRCxDQUFDLENBQUM7UUFDekUsQ0FBQztRQUNELElBQUksb0JBQW9CLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3RDLE1BQU0sSUFBSSxLQUFLLENBQUMsaUVBQWlFLENBQUMsQ0FBQztRQUNyRixDQUFDO1FBRUQsTUFBTSxRQUFRLEdBQUcsa0JBQWtCLENBQ2pDLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUNmLDJCQUEyQixDQUFDLFFBQVEsQ0FBQyxDQUN0QyxDQUFDO1FBRUYsTUFBTSxJQUFJLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLENBQUMsWUFBWSxDQUFDO1lBQ3ZDLFFBQVE7WUFDUixxQkFBcUIsRUFBRSxvQkFBb0I7U0FDNUMsQ0FBQyxDQUFDO1FBRUgsUUFBUSxDQUFDLFNBQVMsQ0FBQyxLQUFLLEVBQUUsSUFBSSxLQUFLLENBQUMsZUFBZSxDQUFDO1lBQ2xELGdCQUFnQixFQUFFLEVBQUUsa0JBQWtCLEVBQUUsdUJBQXVCLEVBQUU7WUFDakUsbUJBQW1CLEVBQUUsS0FBSyxDQUFDLG1CQUFtQixDQUFDLGFBQWE7WUFDNUQsb0JBQW9CLEVBQUU7Z0JBQ3BCO29CQUNFLFVBQVUsRUFBRSxLQUFLO29CQUNqQixpQkFBaUIsRUFBRTt3QkFDakIsa0JBQWtCLEVBQUUsSUFBSTtxQkFDekI7b0JBQ0Qsa0JBQWtCLEVBQUU7d0JBQ2xCLHFDQUFxQyxFQUFFLG1DQUFtQztxQkFDM0U7aUJBQ0Y7YUFDRjtTQUNGLENBQUMsRUFBRTtZQUNGLGVBQWUsRUFBRTtnQkFDZjtvQkFDRSxVQUFVLEVBQUUsS0FBSztvQkFDakIsa0JBQWtCLEVBQUU7d0JBQ2xCLHFDQUFxQyxFQUFFLElBQUk7cUJBQzVDO2lCQUNGO2FBQ0Y7U0FDRixDQUFDLENBQUM7SUFDTCxDQUFDOztBQXRESCxzRUF1REM7OztBQUVELFNBQVMsMkJBQTJCLENBQUMsUUFBZ0I7SUFDbkQsSUFBSSxNQUFXLENBQUM7SUFDaEIsSUFBSSxDQUFDO1FBQ0gsTUFBTSxHQUFHLElBQUksR0FBRyxDQUFDLFFBQVEsQ0FBQyxDQUFDO0lBQzdCLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxNQUFNLElBQUksS0FBSyxDQUFDLGlFQUFpRSxDQUFDLENBQUM7SUFDckYsQ0FBQztJQUVELE1BQU0sWUFBWSxHQUFHLGtCQUFrQixDQUFDLE1BQU0sQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLENBQUM7SUFDL0QsT0FBTyx3Q0FBd0MsWUFBWSxFQUFFLENBQUM7QUFDaEUsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsSUFBcUIsRUFBRSxJQUFZO0lBQzdELElBQUksT0FBTyxHQUFHLElBQUksQ0FBQztJQUNuQixNQUFNLE9BQU8sR0FBRyxNQUFNLENBQUMsSUFBSSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sRUFBRSxFQUFFLENBQUMsQ0FBQztJQUNsRixJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDYixPQUFPLE9BQU8sQ0FBQztJQUNqQixDQUFDO0lBRUQsS0FBSyxNQUFNLE9BQU8sSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDekMsT0FBTyxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQUMsT0FBTyxDQUFDLElBQUksT0FBTyxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUN6RSxDQUFDO0lBRUQsT0FBTyxPQUFPLENBQUM7QUFDakIsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFN0YWNrIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlndyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgfSBmcm9tIFwiLi9yZXN0LWFwaS1yb3V0ZXJcIjtcblxuLyoqXG4gKiBQcm9wcyBmb3IgQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2UuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgYWRkcyB0aGUgUkZDOTcyOCBwcm90ZWN0ZWQgcmVzb3VyY2UgbWV0YWRhdGEgZW5kcG9pbnQgcmVxdWlyZWRcbiAqIGJ5IE1DUCBhdXRoICgyMDI1LTA2LTE4KTpcbiAqIC0gR0VUIGAvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlLy4uLnJlc291cmNlIHBhdGguLi5gXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2VQcm9wcyB7XG4gIC8qKlxuICAgKiBUaGUgUkVTVCBBUEkgcm91dGVyIHRvIGF0dGFjaCB0aGUgd2VsbC1rbm93biBlbmRwb2ludCB0by5cbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlcjogQXBwVGhlb3J5UmVzdEFwaVJvdXRlcjtcblxuICAvKipcbiAgICogVGhlIGNhbm9uaWNhbCBwcm90ZWN0ZWQgcmVzb3VyY2UgaWRlbnRpZmllci5cbiAgICpcbiAgICogRm9yIENsYXVkZSBSZW1vdGUgTUNQIHRoaXMgc2hvdWxkIGJlIHlvdXIgTUNQIGVuZHBvaW50IFVSTCAoaW5jbHVkaW5nIGAvbWNwYCksXG4gICAqIGUuZy4gYGh0dHBzOi8vbWNwLmV4YW1wbGUuY29tL21jcGAuXG4gICAqL1xuICByZWFkb25seSByZXNvdXJjZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPbmUgb3IgbW9yZSBPQXV0aCBBdXRob3JpemF0aW9uIFNlcnZlciBpc3N1ZXIvYmFzZSBVUkxzLlxuICAgKlxuICAgKiBBdXRoZW9yeSBzaG91bGQgYmUgdGhlIGZpcnN0IChhbmQgdXN1YWxseSBvbmx5KSBlbnRyeS5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TZXJ2ZXJzOiBzdHJpbmdbXTtcbn1cblxuLyoqXG4gKiBBZGRzIHBhdGgtc2NvcGVkIGAvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlLy4uLmAgbWV0YWRhdGEgKFJGQzk3MjgpIHRvIGEgUkVTVCBBUEkuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHJvdXRlciA9IHByb3BzLnJvdXRlcjtcbiAgICBjb25zdCByZXNvdXJjZSA9IFN0cmluZyhwcm9wcy5yZXNvdXJjZSA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgYXV0aG9yaXphdGlvblNlcnZlcnMgPSAocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcnMgPz8gW10pXG4gICAgICAubWFwKChzKSA9PiBTdHJpbmcocyA/PyBcIlwiKS50cmltKCkpXG4gICAgICAuZmlsdGVyKChzKSA9PiBzLmxlbmd0aCA+IDApO1xuXG4gICAgaWYgKCFyb3V0ZXIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlOiByb3V0ZXIgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuICAgIGlmICghcmVzb3VyY2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlOiByZXNvdXJjZSBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG4gICAgaWYgKGF1dGhvcml6YXRpb25TZXJ2ZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2U6IGF1dGhvcml6YXRpb25TZXJ2ZXJzIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGVuZHBvaW50ID0gZW5zdXJlUmVzb3VyY2VQYXRoKFxuICAgICAgcm91dGVyLmFwaS5yb290LFxuICAgICAgbWV0YWRhdGFQYXRoRnJvbVJlc291cmNlVVJMKHJlc291cmNlKSxcbiAgICApO1xuXG4gICAgY29uc3QgYm9keSA9IFN0YWNrLm9mKHRoaXMpLnRvSnNvblN0cmluZyh7XG4gICAgICByZXNvdXJjZSxcbiAgICAgIGF1dGhvcml6YXRpb25fc2VydmVyczogYXV0aG9yaXphdGlvblNlcnZlcnMsXG4gICAgfSk7XG5cbiAgICBlbmRwb2ludC5hZGRNZXRob2QoXCJHRVRcIiwgbmV3IGFwaWd3Lk1vY2tJbnRlZ3JhdGlvbih7XG4gICAgICByZXF1ZXN0VGVtcGxhdGVzOiB7IFwiYXBwbGljYXRpb24vanNvblwiOiBcIntcXFwic3RhdHVzQ29kZVxcXCI6IDIwMH1cIiB9LFxuICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvci5XSEVOX05PX01BVENILFxuICAgICAgaW50ZWdyYXRpb25SZXNwb25zZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgcmVzcG9uc2VUZW1wbGF0ZXM6IHtcbiAgICAgICAgICAgIFwiYXBwbGljYXRpb24vanNvblwiOiBib2R5LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQ29udGVudC1UeXBlXCI6IFwiJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSksIHtcbiAgICAgIG1ldGhvZFJlc3BvbnNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5Db250ZW50LVR5cGVcIjogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBtZXRhZGF0YVBhdGhGcm9tUmVzb3VyY2VVUkwocmVzb3VyY2U6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBwYXJzZWQ6IFVSTDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKHJlc291cmNlKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2U6IHJlc291cmNlIG11c3QgYmUgYW4gYWJzb2x1dGUgVVJMXCIpO1xuICB9XG5cbiAgY29uc3QgcmVzb3VyY2VQYXRoID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnNlZC5wYXRobmFtZSB8fCBcIlwiKTtcbiAgcmV0dXJuIGAvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlJHtyZXNvdXJjZVBhdGh9YDtcbn1cblxuZnVuY3Rpb24gZW5zdXJlUmVzb3VyY2VQYXRoKHJvb3Q6IGFwaWd3LklSZXNvdXJjZSwgcGF0aDogc3RyaW5nKTogYXBpZ3cuSVJlc291cmNlIHtcbiAgbGV0IGN1cnJlbnQgPSByb290O1xuICBjb25zdCB0cmltbWVkID0gU3RyaW5nKHBhdGggPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL15cXC8rLywgXCJcIikucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgaWYgKCF0cmltbWVkKSB7XG4gICAgcmV0dXJuIGN1cnJlbnQ7XG4gIH1cblxuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2YgdHJpbW1lZC5zcGxpdChcIi9cIikpIHtcbiAgICBjdXJyZW50ID0gY3VycmVudC5nZXRSZXNvdXJjZShzZWdtZW50KSA/PyBjdXJyZW50LmFkZFJlc291cmNlKHNlZ21lbnQpO1xuICB9XG5cbiAgcmV0dXJuIGN1cnJlbnQ7XG59XG4iXX0=