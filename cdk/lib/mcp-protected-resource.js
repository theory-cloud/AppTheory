"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMcpProtectedResource = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigw = __importStar(require("aws-cdk-lib/aws-apigateway"));
const constructs_1 = require("constructs");
const string_utils_1 = require("./private/string-utils");
/**
 * Adds path-scoped `/.well-known/oauth-protected-resource/...` metadata (RFC9728) to a REST API.
 */
class AppTheoryMcpProtectedResource extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMcpProtectedResource", version: "4.3.0-rc" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWNwLXByb3RlY3RlZC1yZXNvdXJjZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1jcC1wcm90ZWN0ZWQtcmVzb3VyY2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUEyQztBQUMzQyxrRUFBb0Q7QUFDcEQsMkNBQXVDO0FBRXZDLHlEQUEwRDtBQWlEMUQ7O0dBRUc7QUFDSCxNQUFhLDZCQUE4QixTQUFRLHNCQUFTOztJQUMxRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXlDO1FBQ2pGLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxNQUFNLEdBQUcsS0FBSyxDQUFDLE1BQU0sQ0FBQztRQUM1QixNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFFBQVEsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUNyRCxNQUFNLG9CQUFvQixHQUFHLENBQUMsS0FBSyxDQUFDLG9CQUFvQixJQUFJLEVBQUUsQ0FBQzthQUM1RCxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7YUFDbEMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBRS9CLElBQUksQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNaLE1BQU0sSUFBSSxLQUFLLENBQUMsbURBQW1ELENBQUMsQ0FBQztRQUN2RSxDQUFDO1FBQ0QsSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2QsTUFBTSxJQUFJLEtBQUssQ0FBQyxxREFBcUQsQ0FBQyxDQUFDO1FBQ3pFLENBQUM7UUFDRCxJQUFJLG9CQUFvQixDQUFDLE1BQU0sS0FBSyxDQUFDLEVBQUUsQ0FBQztZ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QUNiLE9BQU8sT0FBTyxDQUFDO0lBQ2pCLENBQUM7SUFFRCxLQUFLLE1BQU0sT0FBTyxJQUFJLE9BQU8sQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztRQUN6QyxPQUFPLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxPQUFPLENBQUMsSUFBSSxPQUFPLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQ3pFLENBQUM7SUFFRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlndyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IHRyaW1SZXBlYXRlZENoYXIgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuaW1wb3J0IHsgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciB9IGZyb20gXCIuL3Jlc3QtYXBpLXJvdXRlclwiO1xuXG4vKipcbiAqIFByb3BzIGZvciBBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZS5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBhZGRzIHRoZSBSRkM5NzI4IHByb3RlY3RlZCByZXNvdXJjZSBtZXRhZGF0YSBlbmRwb2ludCByZXF1aXJlZFxuICogYnkgTUNQIGF1dGggKDIwMjUtMDYtMTgpOlxuICogLSBHRVQgYC8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2UvLi4ucmVzb3VyY2UgcGF0aC4uLmBcbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZVByb3BzIHtcbiAgLyoqXG4gICAqIFRoZSBSRVNUIEFQSSByb3V0ZXIgdG8gYXR0YWNoIHRoZSB3ZWxsLWtub3duIGVuZHBvaW50IHRvLlxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVyOiBBcHBUaGVvcnlSZXN0QXBpUm91dGVyO1xuXG4gIC8qKlxuICAgKiBUaGUgY2Fub25pY2FsIHByb3RlY3RlZCByZXNvdXJjZSBpZGVudGlmaWVyLlxuICAgKlxuICAqIEZvciBDbGF1ZGUgUmVtb3RlIE1DUCB0aGlzIHNob3VsZCBiZSB5b3VyIE1DUCBlbmRwb2ludCBVUkwgKGluY2x1ZGluZyBgL21jcGApLFxuICAqIGUuZy4gYGh0dHBzOi8vbWNwLmV4YW1wbGUuY29tL21jcGAuXG4gICAqXG4gICAqIEBkZXByZWNhdGVkIFVzZSBBcHBUaGVvcnlNY3BTZXJ2ZXIgd2l0aCBydW50aW1lLXNlcnZlZCBkaXNjb3ZlcnkuIFRoaXNcbiAgICogVVJMLXZhbHVlZCBjb21wYXRpYmlsaXR5IHByb3AgaXMgcmV0YWluZWQgZm9yIGV4aXN0aW5nIHN0YXRpYyBkb2N1bWVudHMuXG4gICAqL1xuICByZWFkb25seSByZXNvdXJjZTogc3RyaW5nO1xuXG4gIC8qKlxuICAqIE9uZSBvciBtb3JlIE9BdXRoIEF1dGhvcml6YXRpb24gU2VydmVyIGlzc3Vlci9iYXNlIFVSTHMuXG4gICpcbiAgKiBBdXRoZW9yeSBzaG91bGQgYmUgdGhlIGZpcnN0IChhbmQgdXN1YWxseSBvbmx5KSBlbnRyeS5cbiAgICpcbiAgICogQGRlcHJlY2F0ZWQgVXNlIEFwcFRoZW9yeU1jcFNlcnZlciBhdXRob3JpemF0aW9uU2VydmVySXNzdWVyIGFuZCBqd2tzVXJpXG4gICAqIHByb3BzIHdpdGggdGhlIEdvIHJ1bnRpbWUgZGlzY292ZXJ5IGhlbHBlci5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6YXRpb25TZXJ2ZXJzOiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogRXhwbGljaXQgbGl0ZXJhbCByb3V0ZSBwYXRoIGZvciB0aGUgc2Vjb25kYXJ5IHN5bnRoLXRpbWUtc3RhdGljIGRvY3VtZW50LlxuICAgKlxuICAgKiBXaGVuIG9taXR0ZWQsIHRoZSBwYXRoIGlzIGRlcml2ZWQgZnJvbSBhIGxpdGVyYWwgYHJlc291cmNlYCBVUkwgZm9yIGZ1bGxcbiAgICogYmFja3dhcmRzIGNvbXBhdGliaWxpdHkuIFNldCB0aGlzIG9ubHkgd2hlbiBhIHN0YXRpYyBtb2NrIGludGVncmF0aW9uIGlzXG4gICAqIGdlbnVpbmVseSByZXF1aXJlZDsgbmFtZXNwYWNlIGFwcGxpY2F0aW9ucyBzaG91bGQgdXNlIEFwcFRoZW9yeU1jcFNlcnZlclxuICAgKiBhbmQgcnVudGltZS1zZXJ2ZWQgZGlzY292ZXJ5IGluc3RlYWQuXG4gICAqIEBkZWZhdWx0IGRlcml2ZWQgZnJvbSByZXNvdXJjZVxuICAgKi9cbiAgcmVhZG9ubHkgbWV0YWRhdGFQYXRoPzogc3RyaW5nO1xufVxuXG4vKipcbiAqIEFkZHMgcGF0aC1zY29wZWQgYC8ud2VsbC1rbm93bi9vYXV0aC1wcm90ZWN0ZWQtcmVzb3VyY2UvLi4uYCBtZXRhZGF0YSAoUkZDOTcyOCkgdG8gYSBSRVNUIEFQSS5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1jcFByb3RlY3RlZFJlc291cmNlUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3Qgcm91dGVyID0gcHJvcHMucm91dGVyO1xuICAgIGNvbnN0IHJlc291cmNlID0gU3RyaW5nKHByb3BzLnJlc291cmNlID8/IFwiXCIpLnRyaW0oKTtcbiAgICBjb25zdCBhdXRob3JpemF0aW9uU2VydmVycyA9IChwcm9wcy5hdXRob3JpemF0aW9uU2VydmVycyA/PyBbXSlcbiAgICAgIC5tYXAoKHMpID0+IFN0cmluZyhzID8/IFwiXCIpLnRyaW0oKSlcbiAgICAgIC5maWx0ZXIoKHMpID0+IHMubGVuZ3RoID4gMCk7XG5cbiAgICBpZiAoIXJvdXRlcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2U6IHJvdXRlciBpcyByZXF1aXJlZFwiKTtcbiAgICB9XG4gICAgaWYgKCFyZXNvdXJjZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2U6IHJlc291cmNlIGlzIHJlcXVpcmVkXCIpO1xuICAgIH1cbiAgICBpZiAoYXV0aG9yaXphdGlvblNlcnZlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNY3BQcm90ZWN0ZWRSZXNvdXJjZTogYXV0aG9yaXphdGlvblNlcnZlcnMgaXMgcmVxdWlyZWRcIik7XG4gICAgfVxuXG4gICAgY29uc3QgZW5kcG9pbnQgPSBlbnN1cmVSZXNvdXJjZVBhdGgoXG4gICAgICByb3V0ZXIuYXBpLnJvb3QsXG4gICAgICBwcm9wcy5tZXRhZGF0YVBhdGggPT09IHVuZGVmaW5lZFxuICAgICAgICA/IG1ldGFkYXRhUGF0aEZyb21SZXNvdXJjZVVSTChyZXNvdXJjZSlcbiAgICAgICAgOiBub3JtYWxpemVNZXRhZGF0YVBhdGgocHJvcHMubWV0YWRhdGFQYXRoKSxcbiAgICApO1xuXG4gICAgY29uc3QgYm9keSA9IFN0YWNrLm9mKHRoaXMpLnRvSnNvblN0cmluZyh7XG4gICAgICByZXNvdXJjZSxcbiAgICAgIGF1dGhvcml6YXRpb25fc2VydmVyczogYXV0aG9yaXphdGlvblNlcnZlcnMsXG4gICAgfSk7XG5cbiAgICBlbmRwb2ludC5hZGRNZXRob2QoXCJHRVRcIiwgbmV3IGFwaWd3Lk1vY2tJbnRlZ3JhdGlvbih7XG4gICAgICByZXF1ZXN0VGVtcGxhdGVzOiB7IFwiYXBwbGljYXRpb24vanNvblwiOiBcIntcXFwic3RhdHVzQ29kZVxcXCI6IDIwMH1cIiB9LFxuICAgICAgcGFzc3Rocm91Z2hCZWhhdmlvcjogYXBpZ3cuUGFzc3Rocm91Z2hCZWhhdmlvci5XSEVOX05PX01BVENILFxuICAgICAgaW50ZWdyYXRpb25SZXNwb25zZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIHN0YXR1c0NvZGU6IFwiMjAwXCIsXG4gICAgICAgICAgcmVzcG9uc2VUZW1wbGF0ZXM6IHtcbiAgICAgICAgICAgIFwiYXBwbGljYXRpb24vanNvblwiOiBib2R5LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcmVzcG9uc2VQYXJhbWV0ZXJzOiB7XG4gICAgICAgICAgICBcIm1ldGhvZC5yZXNwb25zZS5oZWFkZXIuQ29udGVudC1UeXBlXCI6IFwiJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnXCIsXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgfSksIHtcbiAgICAgIG1ldGhvZFJlc3BvbnNlczogW1xuICAgICAgICB7XG4gICAgICAgICAgc3RhdHVzQ29kZTogXCIyMDBcIixcbiAgICAgICAgICByZXNwb25zZVBhcmFtZXRlcnM6IHtcbiAgICAgICAgICAgIFwibWV0aG9kLnJlc3BvbnNlLmhlYWRlci5Db250ZW50LVR5cGVcIjogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBtZXRhZGF0YVBhdGhGcm9tUmVzb3VyY2VVUkwocmVzb3VyY2U6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBwYXJzZWQ6IFVSTDtcbiAgdHJ5IHtcbiAgICBwYXJzZWQgPSBuZXcgVVJMKHJlc291cmNlKTtcbiAgfSBjYXRjaCB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2U6IHJlc291cmNlIG11c3QgYmUgYW4gYWJzb2x1dGUgVVJMXCIpO1xuICB9XG5cbiAgY29uc3QgcmVzb3VyY2VQYXRoID0gZGVjb2RlVVJJQ29tcG9uZW50KHBhcnNlZC5wYXRobmFtZSB8fCBcIlwiKTtcbiAgcmV0dXJuIGAvLndlbGwta25vd24vb2F1dGgtcHJvdGVjdGVkLXJlc291cmNlJHtyZXNvdXJjZVBhdGh9YDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTWV0YWRhdGFQYXRoKG1ldGFkYXRhUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZChtZXRhZGF0YVBhdGgpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2U6IG1ldGFkYXRhUGF0aCBtdXN0IGJlIGEgc3ludGhlc2lzLXRpbWUgbGl0ZXJhbCBwYXRoXCIpO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcobWV0YWRhdGFQYXRoID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKFxuICAgICFub3JtYWxpemVkLnN0YXJ0c1dpdGgoXCIvXCIpXG4gICAgfHwgbm9ybWFsaXplZCA9PT0gXCIvXCJcbiAgICB8fCBub3JtYWxpemVkLmVuZHNXaXRoKFwiL1wiKVxuICAgIHx8IG5vcm1hbGl6ZWQuaW5jbHVkZXMoXCIvL1wiKVxuICAgIHx8IC9bPyN7fV0vLnRlc3Qobm9ybWFsaXplZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWNwUHJvdGVjdGVkUmVzb3VyY2U6IG1ldGFkYXRhUGF0aCBtdXN0IGJlIGEgbGl0ZXJhbCBhYnNvbHV0ZSByb3V0ZSBwYXRoXCIpO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBlbnN1cmVSZXNvdXJjZVBhdGgocm9vdDogYXBpZ3cuSVJlc291cmNlLCBwYXRoOiBzdHJpbmcpOiBhcGlndy5JUmVzb3VyY2Uge1xuICBsZXQgY3VycmVudCA9IHJvb3Q7XG4gIGNvbnN0IHRyaW1tZWQgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhwYXRoID8/IFwiXCIpLnRyaW0oKSwgXCIvXCIpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICByZXR1cm4gY3VycmVudDtcbiAgfVxuXG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiB0cmltbWVkLnNwbGl0KFwiL1wiKSkge1xuICAgIGN1cnJlbnQgPSBjdXJyZW50LmdldFJlc291cmNlKHNlZ21lbnQpID8/IGN1cnJlbnQuYWRkUmVzb3VyY2Uoc2VnbWVudCk7XG4gIH1cblxuICByZXR1cm4gY3VycmVudDtcbn1cbiJdfQ==