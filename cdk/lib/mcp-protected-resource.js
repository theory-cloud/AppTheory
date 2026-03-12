"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpProtectedResource = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigw = require("aws-cdk-lib/aws-apigateway");
const constructs_1 = require("constructs");
/**
 * Adds `/.well-known/oauth-protected-resource` metadata (RFC9728) to a REST API.
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
        const wellKnown = router.api.root.getResource(".well-known") ?? router.api.root.addResource(".well-known");
        const endpoint = wellKnown.getResource("oauth-protected-resource")
            ?? wellKnown.addResource("oauth-protected-resource");
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
AppTheoryMcpProtectedResource[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResource", version: "0.18.0-rc" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXByb3RlY3RlZC1yZXNvdXJjZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1wcm90ZWN0ZWQtcmVzb3VyY2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBb0M7QUFDcEMsb0RBQW9EO0FBQ3BELDJDQUF1QztBQWlDdkM7O0dBRUc7QUFDSCxNQUFhLDZCQUE4QixTQUFRLHNCQUFTO0lBQzFELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBeUM7UUFDakYsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUMsTUFBTSxDQUFDO1FBQzVCLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO1FBQ3JELE1BQU0sb0JBQW9CLEdBQUcsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLElBQUksRUFBRSxDQUFDO2FBQzVELEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQzthQUNsQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUM7UUFFL0IsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ1osTUFBTSxJQUFJLEtBQUssQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO1FBQ3ZFLENBQUM7UUFDRCxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDZCxNQUFNLElBQUksS0FBSyxDQUFDLHFEQUFxRCxDQUFDLENBQUM7UUFDekUsQ0FBQztRQUNELElBQUksb0JBQW9CLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQ3RDLE1BQU0sSUFBSSxLQUFLLENBQUMsaUVBQWlFLENBQUMsQ0FBQztRQUNyRixDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDLGFBQWEsQ0FBQyxJQUFJLE1BQU0sQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUMzRyxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsV0FBVyxDQUFDLDBCQUEwQixDQUFDO2VBQzdELFNBQVMsQ0FBQyxXQUFXLENBQUMsMEJBQTBCLENBQUMsQ0FBQztRQUV2RCxNQUFNLElBQUksR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxZQUFZLENBQUM7WUFDdkMsUUFBUTtZQUNSLHFCQUFxQixFQUFFLG9CQUFvQjtTQUM1QyxDQUFDLENBQUM7UUFFSCxRQUFRLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLEtBQUssQ0FBQyxlQUFlLENBQUM7WUFDbEQsZ0JBQWdCLEVBQUUsRUFBRSxrQkFBa0IsRUFBRSx1QkFBdUIsRUFBRTtZQUNqRSxtQkFBbUIsRUFBRSxLQUFLLENBQUMsbUJBQW1CLENBQUMsYUFBYTtZQUM1RCxvQkFBb0IsRUFBRTtnQkFDcEI7b0JBQ0UsVUFBVSxFQUFFLEtBQUs7b0JBQ2pCLGlCQUFpQixFQUFFO3dCQUNqQixrQkFBa0IsRUFBRSxJQUFJO3FCQUN6QjtvQkFDRCxrQkFBa0IsRUFBRTt3QkFDbEIscUNBQXFDLEVBQUUsbUNBQW1DO3FCQUMzRTtpQkFDRjthQUNGO1NBQ0YsQ0FBQyxFQUFFO1lBQ0YsZUFBZSxFQUFFO2dCQUNmO29CQUNFLFVBQVUsRUFBRSxLQUFLO29CQUNqQixrQkFBa0IsRUFBRTt3QkFDbEIscUNBQXFDLEVBQUUsSUFBSTtxQkFDNUM7aUJBQ0Y7YUFDRjtTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7O0FBckRILHNFQXNEQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFN0YWNrIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlndyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgfSBmcm9tIFwiLi9yZXN0LWFwaS1yb3V0ZXJcIjtcblxuLyoqXG4gKiBQcm9wcyBmb3IgQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2UuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgYWRkcyB0aGUgUkZDOTcyOCBwcm90ZWN0ZWQgcmVzb3VyY2UgbWV0YWRhdGEgZW5kcG9pbnQgcmVxdWlyZWRcbiAqIGJ5IE1DUCBhdXRoICgyMDI1LTA2LTE4KTpcbiAqIC0gR0VUIGAvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlYFxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlUHJvcHMge1xuICAvKipcbiAgICogVGhlIFJFU1QgQVBJIHJvdXRlciB0byBhdHRhY2ggdGhlIHdlbGwta25vd24gZW5kcG9pbnQgdG8uXG4gICAqL1xuICByZWFkb25seSByb3V0ZXI6IEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBjYW5vbmljYWwgcHJvdGVjdGVkIHJlc291cmNlIGlkZW50aWZpZXIuXG4gICAqXG4gICAqIEZvciBDbGF1ZGUgUmVtb3RlIE1DUCB0aGlzIHNob3VsZCBiZSB5b3VyIE1DUCBlbmRwb2ludCBVUkwgKGluY2x1ZGluZyBgL21jcGApLFxuICAgKiBlLmcuIGBodHRwczovL21jcC5leGFtcGxlLmNvbS9tY3BgLlxuICAgKi9cbiAgcmVhZG9ubHkgcmVzb3VyY2U6IHN0cmluZztcblxuICAvKipcbiAgICogT25lIG9yIG1vcmUgT0F1dGggQXV0aG9yaXphdGlvbiBTZXJ2ZXIgaXNzdWVyL2Jhc2UgVVJMcy5cbiAgICpcbiAgICogQXV0aGVvcnkgc2hvdWxkIGJlIHRoZSBmaXJzdCAoYW5kIHVzdWFsbHkgb25seSkgZW50cnkuXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemF0aW9uU2VydmVyczogc3RyaW5nW107XG59XG5cbi8qKlxuICogQWRkcyBgLy53ZWxsLWtub3duL29hdXRoLXByb3RlY3RlZC1yZXNvdXJjZWAgbWV0YWRhdGEgKFJGQzk3MjgpIHRvIGEgUkVTVCBBUEkuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHJvdXRlciA9IHByb3BzLnJvdXRlcjtcbiAgICBjb25zdCByZXNvdXJjZSA9IFN0cmluZyhwcm9wcy5yZXNvdXJjZSA/PyBcIlwiKS50cmltKCk7XG4gICAgY29uc3QgYXV0aG9yaXphdGlvblNlcnZlcnMgPSAocHJvcHMuYXV0aG9yaXphdGlvblNlcnZlcnMgPz8gW10pXG4gICAgICAubWFwKChzKSA9PiBTdHJpbmcocyA/PyBcIlwiKS50cmltKCkpXG4gICAgICAuZmlsdGVyKChzKSA9PiBzLmxlbmd0aCA+IDApO1xuXG4gICAgaWYgKCFyb3V0ZXIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlOiByb3V0ZXIgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuICAgIGlmICghcmVzb3VyY2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlOiByZXNvdXJjZSBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG4gICAgaWYgKGF1dGhvcml6YXRpb25TZXJ2ZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2U6IGF1dGhvcml6YXRpb25TZXJ2ZXJzIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IHdlbGxLbm93biA9IHJvdXRlci5hcGkucm9vdC5nZXRSZXNvdXJjZShcIi53ZWxsLWtub3duXCIpID8/IHJvdXRlci5hcGkucm9vdC5hZGRSZXNvdXJjZShcIi53ZWxsLWtub3duXCIpO1xuICAgIGNvbnN0IGVuZHBvaW50ID0gd2VsbEtub3duLmdldFJlc291cmNlKFwib2F1dGgtcHJvdGVjdGVkLXJlc291cmNlXCIpXG4gICAgICA/PyB3ZWxsS25vd24uYWRkUmVzb3VyY2UoXCJvYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2VcIik7XG5cbiAgICBjb25zdCBib2R5ID0gU3RhY2sub2YodGhpcykudG9Kc29uU3RyaW5nKHtcbiAgICAgIHJlc291cmNlLFxuICAgICAgYXV0aG9yaXphdGlvbl9zZXJ2ZXJzOiBhdXRob3JpemF0aW9uU2VydmVycyxcbiAgICB9KTtcblxuICAgIGVuZHBvaW50LmFkZE1ldGhvZChcIkdFVFwiLCBuZXcgYXBpZ3cuTW9ja0ludGVncmF0aW9uKHtcbiAgICAgIHJlcXVlc3RUZW1wbGF0ZXM6IHsgXCJhcHBsaWNhdGlvbi9qc29uXCI6IFwie1xcXCJzdGF0dXNDb2RlXFxcIjogMjAwfVwiIH0sXG4gICAgICBwYXNzdGhyb3VnaEJlaGF2aW9yOiBhcGlndy5QYXNzdGhyb3VnaEJlaGF2aW9yLldIRU5fTk9fTUFUQ0gsXG4gICAgICBpbnRlZ3JhdGlvblJlc3BvbnNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICByZXNwb25zZVRlbXBsYXRlczoge1xuICAgICAgICAgICAgXCJhcHBsaWNhdGlvbi9qc29uXCI6IGJvZHksXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5Db250ZW50LVR5cGVcIjogXCInYXBwbGljYXRpb24vanNvbjsgY2hhcnNldD11dGYtOCdcIixcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KSwge1xuICAgICAgbWV0aG9kUmVzcG9uc2VzOiBbXG4gICAgICAgIHtcbiAgICAgICAgICBzdGF0dXNDb2RlOiBcIjIwMFwiLFxuICAgICAgICAgIHJlc3BvbnNlUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgXCJtZXRob2QucmVzcG9uc2UuaGVhZGVyLkNvbnRlbnQtVHlwZVwiOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgIH0pO1xuICB9XG59XG5cbiJdfQ==