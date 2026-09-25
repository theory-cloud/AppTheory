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
exports.AppTheoryRestApi = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const apigw = __importStar(require("aws-cdk-lib/aws-apigateway"));
const constructs_1 = require("constructs");
const rest_api_waf_1 = require("./private/rest-api-waf");
const rest_api_streaming_1 = require("./private/rest-api-streaming");
const string_utils_1 = require("./private/string-utils");
class AppTheoryRestApi extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryRestApi", version: "4.4.1" };
    api;
    webAcl;
    wafAssociation;
    handler;
    allowTestInvoke;
    scopePermissionToMethod;
    constructor(scope, id, props) {
        super(scope, id);
        this.handler = props.handler;
        this.allowTestInvoke = props.allowTestInvoke ?? true;
        this.scopePermissionToMethod = props.scopePermissionToMethod ?? true;
        this.api = new apigw.RestApi(this, "Api", {
            restApiName: props.apiName,
        });
        const defaultIntegration = new apigw.LambdaIntegration(this.handler, {
            proxy: true,
            allowTestInvoke: this.allowTestInvoke,
            scopePermissionToMethod: this.scopePermissionToMethod,
        });
        this.api.root.addMethod("ANY", defaultIntegration);
        this.api.root.addResource("{proxy+}").addMethod("ANY", defaultIntegration);
        if (props.waf) {
            const waf = (0, rest_api_waf_1.configureRestApiRegionalWaf)(this, this.api, this.api.deploymentStage, props.waf, props.apiName ?? "AppTheoryRestApi");
            this.webAcl = waf.webAcl;
            this.wafAssociation = waf.wafAssociation;
        }
    }
    addRoute(path, methods = ["ANY"], options = {}) {
        const resource = resourceForPath(this.api, path);
        const integration = new apigw.LambdaIntegration(this.handler, {
            proxy: true,
            allowTestInvoke: this.allowTestInvoke,
            scopePermissionToMethod: this.scopePermissionToMethod,
            responseTransferMode: options.streaming ? apigw.ResponseTransferMode.STREAM : apigw.ResponseTransferMode.BUFFERED,
        });
        for (const method of methods) {
            const httpMethod = String(method ?? "").trim().toUpperCase();
            if (!httpMethod)
                continue;
            resource.addMethod(httpMethod, integration);
            if (options.streaming) {
                (0, rest_api_streaming_1.markRestApiStageRouteAsStreaming)(this.api.deploymentStage, httpMethod, path);
            }
        }
    }
}
exports.AppTheoryRestApi = AppTheoryRestApi;
function resourceForPath(api, inputPath) {
    let current = api.root;
    const trimmed = (0, string_utils_1.trimRepeatedChar)(String(inputPath ?? "").trim(), "/");
    if (!trimmed)
        return current;
    for (const segment of trimmed.split("/")) {
        const part = String(segment ?? "").trim();
        if (!part)
            continue;
        current = current.getResource(part) ?? current.addResource(part);
    }
    return current;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzdC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZXN0LWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsa0VBQW9EO0FBR3BELDJDQUF1QztBQUV2Qyx5REFBcUU7QUFDckUscUVBQWdGO0FBQ2hGLHlEQUEwRDtBQXlDMUQsTUFBYSxnQkFBaUIsU0FBUSxzQkFBUzs7SUFDN0IsR0FBRyxDQUFnQjtJQUNuQixNQUFNLENBQW1CO0lBQ3pCLGNBQWMsQ0FBOEI7SUFDM0MsT0FBTyxDQUFtQjtJQUMxQixlQUFlLENBQVU7SUFDekIsdUJBQXVCLENBQVU7SUFFbEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE0QjtRQUNwRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxPQUFPLEdBQUcsS0FBSyxDQUFDLE9BQU8sQ0FBQztRQUM3QixJQUFJLENBQUMsZUFBZSxHQUFHLEtBQUssQ0FBQyxlQUFlLElBQUksSUFBSSxDQUFDO1FBQ3JELElBQUksQ0FBQyx1QkFBdUIsR0FBRyxLQUFLLENBQUMsdUJBQXVCLElBQUksSUFBSSxDQUFDO1FBQ3JFLElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDeEMsV0FBVyxFQUFFLEtBQUssQ0FBQyxPQUFPO1NBQzNCLENBQUMsQ0FBQztRQUVILE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxLQUFLLENBQUMsaUJBQWlCLENBQUMsSUFBSSxDQUFDLE9BQU8sRUFBRTtZQUNuRSxLQUFLLEVBQUUsSUFBSTtZQUNYLGVBQWUsRUFBRSxJQUFJLENBQUMsZUFBZTtZQUNyQyx1QkFBdUIsRUFBRSxJQUFJLENBQUMsdUJBQXVCO1NBQ3RELENBQUMsQ0FBQztRQUNILElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNB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YXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyB3YWZ2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXdhZnYyXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBjb25maWd1cmVSZXN0QXBpUmVnaW9uYWxXYWYgfSBmcm9tIFwiLi9wcml2YXRlL3Jlc3QtYXBpLXdhZlwiO1xuaW1wb3J0IHsgbWFya1Jlc3RBcGlTdGFnZVJvdXRlQXNTdHJlYW1pbmcgfSBmcm9tIFwiLi9wcml2YXRlL3Jlc3QtYXBpLXN0cmVhbWluZ1wiO1xuaW1wb3J0IHsgdHJpbVJlcGVhdGVkQ2hhciB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyB9IGZyb20gXCIuL3JlZ2lvbmFsLXdhZlwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBSZWdpb25hbCBXQUYgYXR0YWNobWVudCBmb3IgdGhlIFJFU1QgQVBJIGRlcGxveW1lbnQgc3RhZ2UuIFNldCB0byB0cnVlIGZvclxuICAgKiBhbiBBcHBUaGVvcnktbWFuYWdlZCBXZWJBQ0wsIG9yIHByb3ZpZGUgb3B0aW9ucyB0byByZXVzZSBhbiBleGlzdGluZ1xuICAgKiByZWdpb25hbCBXZWJBQ0wuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgd2FmPzogYm9vbGVhbiB8IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucztcblxuICAvKipcbiAgICogV2hldGhlciBBUEkgR2F0ZXdheSBjb25zb2xlIHRlc3QgaW52b2NhdGlvbnMgc2hvdWxkIGJlIGdyYW50ZWQgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBzdXBwcmVzc2VzIHRoZSBleHRyYSBgdGVzdC1pbnZva2Utc3RhZ2VgIExhbWJkYSBwZXJtaXNzaW9uc1xuICAgKiB0aGF0IENESyBhZGRzIGZvciBlYWNoIFJFU1QgQVBJIG1ldGhvZC4gVGhpcyByZWR1Y2VzIExhbWJkYSByZXNvdXJjZSBwb2xpY3kgc2l6ZSB3aGlsZVxuICAgKiBwcmVzZXJ2aW5nIGRlcGxveWVkLXN0YWdlIGludm9rZSBwZXJtaXNzaW9ucy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBSRVNUIEFQSSBtZXRob2RzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICogb25lIHBlcm1pc3Npb24gcGVyIG1ldGhvZC9wYXRoIHBhaXIuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3IgbGFyZ2UgZnJvbnQtY29udHJvbGxlclxuICAgKiBBUElzIHRoYXQgcm91dGUgbWFueSBSRVNUIHBhdGhzIHRvIHRoZSBzYW1lIExhbWJkYS5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZU9wdGlvbnMge1xuICByZWFkb25seSBzdHJlYW1pbmc/OiBib29sZWFuO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UmVzdEFwaSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3LlJlc3RBcGk7XG4gIHB1YmxpYyByZWFkb25seSB3ZWJBY2w/OiB3YWZ2Mi5DZm5XZWJBQ0w7XG4gIHB1YmxpYyByZWFkb25seSB3YWZBc3NvY2lhdGlvbj86IHdhZnYyLkNmbldlYkFDTEFzc29jaWF0aW9uO1xuICBwcml2YXRlIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHByaXZhdGUgcmVhZG9ubHkgYWxsb3dUZXN0SW52b2tlOiBib29sZWFuO1xuICBwcml2YXRlIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvTWV0aG9kOiBib29sZWFuO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlSZXN0QXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgdGhpcy5oYW5kbGVyID0gcHJvcHMuaGFuZGxlcjtcbiAgICB0aGlzLmFsbG93VGVzdEludm9rZSA9IHByb3BzLmFsbG93VGVzdEludm9rZSA/PyB0cnVlO1xuICAgIHRoaXMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QgPSBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCA/PyB0cnVlO1xuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3LlJlc3RBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgcmVzdEFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBkZWZhdWx0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3cuTGFtYmRhSW50ZWdyYXRpb24odGhpcy5oYW5kbGVyLCB7XG4gICAgICBwcm94eTogdHJ1ZSxcbiAgICAgIGFsbG93VGVzdEludm9rZTogdGhpcy5hbGxvd1Rlc3RJbnZva2UsXG4gICAgICBzY29wZVBlcm1pc3Npb25Ub01ldGhvZDogdGhpcy5zY29wZVBlcm1pc3Npb25Ub01ldGhvZCxcbiAgICB9KTtcbiAgICB0aGlzLmFwaS5yb290LmFkZE1ldGhvZChcIkFOWVwiLCBkZWZhdWx0SW50ZWdyYXRpb24pO1xuICAgIHRoaXMuYXBpLnJvb3QuYWRkUmVzb3VyY2UoXCJ7cHJveHkrfVwiKS5hZGRNZXRob2QoXCJBTllcIiwgZGVmYXVsdEludGVncmF0aW9uKTtcblxuICAgIGlmIChwcm9wcy53YWYpIHtcbiAgICAgIGNvbnN0IHdhZiA9IGNvbmZpZ3VyZVJlc3RBcGlSZWdpb25hbFdhZihcbiAgICAgICAgdGhpcyxcbiAgICAgICAgdGhpcy5hcGksXG4gICAgICAgIHRoaXMuYXBpLmRlcGxveW1lbnRTdGFnZSxcbiAgICAgICAgcHJvcHMud2FmLFxuICAgICAgICBwcm9wcy5hcGlOYW1lID8/IFwiQXBwVGhlb3J5UmVzdEFwaVwiLFxuICAgICAgKTtcbiAgICAgICh0aGlzIGFzIHsgd2ViQWNsPzogd2FmdjIuQ2ZuV2ViQUNMIH0pLndlYkFjbCA9IHdhZi53ZWJBY2w7XG4gICAgICAodGhpcyBhcyB7IHdhZkFzc29jaWF0aW9uPzogd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb24gfSkud2FmQXNzb2NpYXRpb24gPSB3YWYud2FmQXNzb2NpYXRpb247XG4gICAgfVxuICB9XG5cbiAgYWRkUm91dGUocGF0aDogc3RyaW5nLCBtZXRob2RzOiBzdHJpbmdbXSA9IFtcIkFOWVwiXSwgb3B0aW9uczogQXBwVGhlb3J5UmVzdEFwaVJvdXRlT3B0aW9ucyA9IHt9KTogdm9pZCB7XG4gICAgY29uc3QgcmVzb3VyY2UgPSByZXNvdXJjZUZvclBhdGgodGhpcy5hcGksIHBhdGgpO1xuICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3LkxhbWJkYUludGVncmF0aW9uKHRoaXMuaGFuZGxlciwge1xuICAgICAgcHJveHk6IHRydWUsXG4gICAgICBhbGxvd1Rlc3RJbnZva2U6IHRoaXMuYWxsb3dUZXN0SW52b2tlLFxuICAgICAgc2NvcGVQZXJtaXNzaW9uVG9NZXRob2Q6IHRoaXMuc2NvcGVQZXJtaXNzaW9uVG9NZXRob2QsXG4gICAgICByZXNwb25zZVRyYW5zZmVyTW9kZTogb3B0aW9ucy5zdHJlYW1pbmcgPyBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5TVFJFQU0gOiBhcGlndy5SZXNwb25zZVRyYW5zZmVyTW9kZS5CVUZGRVJFRCxcbiAgICB9KTtcbiAgICBmb3IgKGNvbnN0IG1ldGhvZCBvZiBtZXRob2RzKSB7XG4gICAgICBjb25zdCBodHRwTWV0aG9kID0gU3RyaW5nKG1ldGhvZCA/PyBcIlwiKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgICAgIGlmICghaHR0cE1ldGhvZCkgY29udGludWU7XG4gICAgICByZXNvdXJjZS5hZGRNZXRob2QoaHR0cE1ldGhvZCwgaW50ZWdyYXRpb24pO1xuICAgICAgaWYgKG9wdGlvbnMuc3RyZWFtaW5nKSB7XG4gICAgICAgIG1hcmtSZXN0QXBpU3RhZ2VSb3V0ZUFzU3RyZWFtaW5nKHRoaXMuYXBpLmRlcGxveW1lbnRTdGFnZSwgaHR0cE1ldGhvZCwgcGF0aCk7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHJlc291cmNlRm9yUGF0aChhcGk6IGFwaWd3LlJlc3RBcGksIGlucHV0UGF0aDogc3RyaW5nKTogYXBpZ3cuSVJlc291cmNlIHtcbiAgbGV0IGN1cnJlbnQ6IGFwaWd3LklSZXNvdXJjZSA9IGFwaS5yb290O1xuICBjb25zdCB0cmltbWVkID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcoaW5wdXRQYXRoID8/IFwiXCIpLnRyaW0oKSwgXCIvXCIpO1xuICBpZiAoIXRyaW1tZWQpIHJldHVybiBjdXJyZW50O1xuXG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiB0cmltbWVkLnNwbGl0KFwiL1wiKSkge1xuICAgIGNvbnN0IHBhcnQgPSBTdHJpbmcoc2VnbWVudCA/PyBcIlwiKS50cmltKCk7XG4gICAgaWYgKCFwYXJ0KSBjb250aW51ZTtcbiAgICBjdXJyZW50ID0gY3VycmVudC5nZXRSZXNvdXJjZShwYXJ0KSA/PyBjdXJyZW50LmFkZFJlc291cmNlKHBhcnQpO1xuICB9XG4gIHJldHVybiBjdXJyZW50O1xufVxuIl19