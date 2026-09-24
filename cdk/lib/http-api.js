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
exports.AppTheoryHttpApi = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigwv2Integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const constructs_1 = require("constructs");
const api_domain_1 = require("./api-domain");
class AppTheoryHttpApi extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHttpApi", version: "4.4.0-rc" };
    api;
    stage;
    accessLogGroup;
    domain;
    constructor(scope, id, props) {
        super(scope, id);
        if (props.waf) {
            throw new Error("AppTheoryHttpApi does not support WAFv2 regional WebACL associations for API Gateway v2 HTTP APIs; use AppTheoryRestApi or AppTheoryRestApiRouter for WAF-protected REST stages");
        }
        const stageOpts = props.stage ?? {};
        const stageName = stageOpts.stageName ?? "$default";
        const needsExplicitStage = stageName !== "$default"
            || stageOpts.accessLogging
            || stageOpts.throttlingRateLimit !== undefined
            || stageOpts.throttlingBurstLimit !== undefined;
        this.api = new apigwv2.HttpApi(this, "Api", {
            apiName: props.apiName,
            corsPreflight: buildCorsPreflight(props.cors),
            createDefaultStage: !needsExplicitStage,
        });
        const stage = needsExplicitStage
            ? new apigwv2.HttpStage(this, "Stage", {
                httpApi: this.api,
                stageName,
                autoDeploy: true,
                throttle: (stageOpts.throttlingRateLimit !== undefined || stageOpts.throttlingBurstLimit !== undefined)
                    ? {
                        rateLimit: stageOpts.throttlingRateLimit,
                        burstLimit: stageOpts.throttlingBurstLimit,
                    }
                    : undefined,
            })
            : this.api.defaultStage;
        if (!stage) {
            throw new Error("AppTheoryHttpApi: failed to create API stage");
        }
        this.stage = stage;
        this.configureAccessLogging(stageOpts, stage);
        this.api.addRoutes({
            path: "/",
            methods: [apigwv2.HttpMethod.ANY],
            integration: new apigwv2Integrations.HttpLambdaIntegration("Root", props.handler, {
                payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
            }),
        });
        this.api.addRoutes({
            path: "/{proxy+}",
            methods: [apigwv2.HttpMethod.ANY],
            integration: new apigwv2Integrations.HttpLambdaIntegration("Proxy", props.handler, {
                payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
            }),
        });
        if (props.domain) {
            this.configureDomain(props.domain);
        }
    }
    configureAccessLogging(stageOpts, stage) {
        if (!stageOpts.accessLogging) {
            return;
        }
        const logGroup = stageOpts.accessLogging === true
            ? new logs.LogGroup(this, "AccessLogs", {
                retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
            })
            : stageOpts.accessLogging;
        this.accessLogGroup = logGroup;
        const cfnStage = stage.node.defaultChild;
        cfnStage.accessLogSettings = {
            destinationArn: logGroup.logGroupArn,
            format: JSON.stringify({
                requestId: "$context.requestId",
                ip: "$context.identity.sourceIp",
                requestTime: "$context.requestTime",
                httpMethod: "$context.httpMethod",
                routeKey: "$context.routeKey",
                status: "$context.status",
                protocol: "$context.protocol",
                responseLength: "$context.responseLength",
                integrationLatency: "$context.integrationLatency",
            }),
        };
    }
    configureDomain(options) {
        const certificate = options.certificate ?? (options.certificateArn
            ? acm.Certificate.fromCertificateArn(this, "ImportedCertificate", options.certificateArn)
            : undefined);
        if (!certificate) {
            throw new Error("AppTheoryHttpApi domain requires either certificate or certificateArn");
        }
        const domain = new api_domain_1.AppTheoryApiDomain(this, "Domain", {
            domainName: options.domainName,
            certificate,
            httpApi: this.api,
            stage: options.stage ?? this.stage,
            hostedZone: options.hostedZone,
            apiMappingKey: options.apiMappingKey,
            createCname: options.createCname,
            recordTtl: options.recordTtl,
            mutualTlsAuthentication: options.mutualTlsAuthentication,
            securityPolicy: options.securityPolicy,
        });
        this.domain = domain;
    }
}
exports.AppTheoryHttpApi = AppTheoryHttpApi;
function buildCorsPreflight(input) {
    if (!input) {
        return undefined;
    }
    const options = input === true ? {} : input;
    return {
        allowOrigins: options.allowOrigins ?? ["*"],
        allowMethods: (options.allowMethods ?? ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
            .map((method) => String(method).trim().toUpperCase())
            .filter((method) => method),
        allowHeaders: options.allowHeaders ?? ["content-type", "authorization", "x-request-id", "x-tenant-id"],
        exposeHeaders: options.exposeHeaders ?? ["x-request-id"],
        allowCredentials: options.allowCredentials ?? false,
        maxAge: options.maxAge ?? aws_cdk_lib_1.Duration.minutes(10),
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXVDO0FBQ3ZDLHNFQUF3RDtBQUN4RCwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMsNkNBQWtEO0FBK0tsRCxNQUFhLGdCQUFpQixTQUFRLHNCQUFTOztJQUM3QixHQUFHLENBQWtCO0lBQ3JCLEtBQUssQ0FBaUI7SUFDdEIsY0FBYyxDQUFrQjtJQUNoQyxNQUFNLENBQXNCO0lBRTVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNkLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUxBQWlMLENBQ2xMLENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDcEMsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFDcEQsTUFBTSxrQkFBa0IsR0FBRyxTQUFTLEtBQUssVUFBVTtlQUM5QyxTQUFTLENBQUMsYUFBYTtlQUN2QixTQUFTLENBQUMsbUJBQW1CLEtBQUssU0FBUztlQUMzQyxTQUFTLENBQUMsb0JBQW9CLEtBQUssU0FBUyxDQUFDO1FBRWxELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDMUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO1lBQ3RCLGFBQWEsRUFBRSxrQkFBa0IsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDO1lBQzdDLGtCQUFrQixFQUFFLENBQUMsa0JBQWtCO1NBQ3hDLENBQUMsQ0FBQztRQUVILE1BQU0sS0FBSyxHQUFHLGtCQUFrQjtZQUM5QixDQUFDLENBQUMsSUFBSSxPQUFPLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7Z0JBQ25DLE9BQU8sRUFBRSxJQUFJLENBQUMsR0FBRztnQkFDakIsU0FBUztnQkFDVCxVQUFVLEVBQUUsSUFBSTtnQkFDaEIsUUFBUSxFQUFFLENBQUMsU0FBUyxDQUFDLG1CQUFtQixLQUFLLFNBQVMsSUFBSSxTQUFTLENBQUMsb0JBQW9CLEtBQUssU0FBUyxDQUFDO29CQUNyRyxDQUFDLENBQUM7d0JBQ0UsU0FBUyxFQUFFLFNBQVMsQ0FBQyxtQkFBbUI7d0JBQ3hDLFVBQVUsRUFBRSxTQUFTLENBQUMsb0JBQW9CO3FCQUMzQztvQkFDSCxDQUFDLENBQUMsU0FBUzthQUNkLENBQUM7WUFDSixDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxZQUFZLENBQUM7UUFDMUIsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ1gsTUFBTSxJQUFJLEtBQUssQ0FBQyw4Q0FBOEMsQ0FBQyxDQUFDO1FBQ2xFLENBQUM7UUFDRCxJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztRQUNuQixJQUFJLENBQUMsc0JBQXNCLENBQUMsU0FBUyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRTlDLElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDO1lBQ2pCLElBQUksRUFBRSxHQUFHO1lBQ1QsT0FBTyxFQUFFLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7WUFDakMsV0FBVyxFQUFFLElBQUksbUJBQW1CLENBQUMscUJBQXFCLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxPQUFPLEVBQUU7Z0JBQ2hGLG9CQUFvQixFQUFFLE9BQU8sQ0FBQyxvQkFBb0IsQ0FBQyxXQUFXO2FBQy9ELENBQUM7U0FDSCxDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQztZQUNqQixJQUFJLEVBQUUsV0FBVztZQUNqQixPQUFPLEVBQUUsQ0FBQyxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQztZQUNqQyxXQUFXLEVBQUUsSUFBSSxtQkFBbUIsQ0FBQyxxQkFBcUIsQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU8sRUFBRTtnQkFDakYsb0JBQW9CLEVBQUUsT0FBTyxDQUFDLG9CQUFvQixDQUFDLFdBQVc7YUFDL0QsQ0FBQztTQUNILENBQUMsQ0FBQztRQUVILElBQUksS0FBSyxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ2pCLElBQUksQ0FBQyxlQUFlLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3JDLENBQUM7SUFDSCxDQUFDO0lBRU8sc0JBQXNCLENBQUMsU0FBdUMsRUFBRSxLQUFxQjtRQUMzRixJQUFJLENBQUMsU0FBUyxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQzdCLE9BQU87UUFDVCxDQUFDO1FBRUQsTUFBTSxRQUFRLEdBQUcsU0FBUyxDQUFDLGFBQWEsS0FBSyxJQUFJO1lBQy9DLENBQUMsQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtnQkFDcEMsU0FBUyxFQUFFLFNBQVMsQ0FBQyxrQkFBa0IsSUFBSSxJQUFJLENBQUMsYUFBYSxDQUFDLFNBQVM7YUFDeEUsQ0FBQztZQUNKLENBQUMsQ0FBQyxTQUFTLENBQUMsYUFBYSxDQUFDO1FBQzNCLElBQTRDLENBQUMsY0FBYyxHQUFHLFFBQVEsQ0FBQztRQUV4RSxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLFlBQWdDLENBQUM7UUFDN0QsUUFBUSxDQUFDLGlCQUFpQixHQUFHO1lBQzNCLGNBQWMsRUFBRSxRQUFRLENBQUMsV0FBVztZQUNwQyxNQUFNLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDckIsU0FBUyxFQUFFLG9CQUFvQjtnQkFDL0IsRUFBRSxFQUFFLDRCQUE0QjtnQkFDaEMsV0FBVyxFQUFFLHNCQUFzQjtnQkFDbkMsVUFBVSxFQUFFLHFCQUFxQjtnQkFDakMsUUFBUSxFQUFFLG1CQUFtQjtnQkFDN0IsTUFBTSxFQUFFLGlCQUFpQjtnQkFDekIsUUFBUSxFQUFFLG1CQUFtQjtnQkFDN0IsY0FBYyxFQUFFLHlCQUF5QjtnQkFDekMsa0JBQWtCLEVBQUUsNkJBQTZCO2FBQ2xELENBQUM7U0FDSCxDQUFDO0lBQ0osQ0FBQztJQUVPLGVBQWUsQ0FBQyxPQUFzQztRQUM1RCxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMsV0FBVyxJQUFJLENBQUMsT0FBTyxDQUFDLGNBQWM7WUFDaEUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsa0JBQWtCLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFLE9BQU8sQ0FBQyxjQUFjLENBQUM7WUFDekYsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQ2YsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ2pCLE1BQU0sSUFBSSxLQUFLLENBQUMsdUVBQXVFLENBQUMsQ0FBQztRQUMzRixDQUFDO1FBRUQsTUFBTSxNQUFNLEdBQUcsSUFBSSwrQkFBa0IsQ0FBQyxJQUFJLEVBQUUsUUFBUSxFQUFFO1lBQ3BELFVBQVUsRUFBRSxPQUFPLENBQUMsVUFBVTtZQUM5QixXQUFXO1lBQ1gsT0FBTyxFQUFFLElBQUksQ0FBQyxHQUFHO1lBQ2pCLEtBQUssRUFBRSxPQUFPLENBQUMsS0FBSyxJQUFJLElBQUksQ0FBQyxLQUFLO1lBQ2xDLFVBQVUsRUFBRSxPQUFPLENBQUMsVUFBVTtZQUM5QixhQUFhLEVBQUUsT0FBTyxDQUFDLGFBQWE7WUFDcEMsV0FBVyxFQUFFLE9BQU8sQ0FBQyxXQUFXO1lBQ2hDLFNBQVMsRUFBRSxPQUFPLENBQUMsU0FBUztZQUM1Qix1QkFBdUIsRUFBRSxPQUFPLENBQUMsdUJBQXVCO1lBQ3hELGNBQWMsRUFBRSxPQUFPLENBQUMsY0FBYztTQUN2QyxDQUFDLENBQUM7UUFDRixJQUF3QyxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7SUFDNUQsQ0FBQzs7QUF0SEgsNENBdUhDO0FBRUQsU0FBUyxrQkFBa0IsQ0FBQyxLQUE2QztJQUN2RSxJQUFJLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDWCxPQUFPLFNBQVMsQ0FBQztJQUNuQixDQUFDO0lBQ0QsTUFBTSxPQUFPLEdBQUcsS0FBSyxLQUFLLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7SUFDNUMsT0FBTztRQUNMLFlBQVksRUFBRSxPQUFPLENBQUMsWUFBWSxJQUFJLENBQUMsR0FBRyxDQUFDO1FBQzNDLFlBQVksRUFBRSxDQUFDLE9BQU8sQ0FBQyxZQUFZLElBQUksQ0FBQyxLQUFLLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxRQUFRLEVBQUUsT0FBTyxFQUFFLE1BQU0sRUFBRSxTQUFTLENBQUMsQ0FBQzthQUNqRyxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQzthQUNwRCxNQUFNLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRSxDQUFDLE1BQU0sQ0FBNkI7UUFDekQsWUFBWSxFQUFFLE9BQU8sQ0FBQyxZQUFZLElBQUksQ0FBQyxjQUFjLEVBQUUsZUFBZSxFQUFFLGNBQWMsRUFBRSxhQUFhLENBQUM7UUFDdEcsYUFBYSxFQUFFLE9BQU8sQ0FBQyxhQUFhLElBQUksQ0FBQyxjQUFjLENBQUM7UUFDeEQsZ0JBQWdCLEVBQUUsT0FBTyxDQUFDLGdCQUFnQixJQUFJLEtBQUs7UUFDbkQsTUFBTSxFQUFFLE9BQU8sQ0FBQyxNQUFNLElBQUksc0JBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO0tBQy9DLENBQUM7QUFDSixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHR5cGUgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5QXBpRG9tYWluIH0gZnJvbSBcIi4vYXBpLWRvbWFpblwiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMgfSBmcm9tIFwiLi9yZWdpb25hbC13YWZcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnMge1xuICAvKipcbiAgICogQWxsb3dlZCBvcmlnaW5zLlxuICAgKiBAZGVmYXVsdCBbXCIqXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd09yaWdpbnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWxsb3dlZCBIVFRQIG1ldGhvZHMuXG4gICAqIEBkZWZhdWx0IFtcIkdFVFwiLCBcIlBPU1RcIiwgXCJQVVRcIiwgXCJERUxFVEVcIiwgXCJQQVRDSFwiLCBcIkhFQURcIiwgXCJPUFRJT05TXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd01ldGhvZHM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWxsb3dlZCBoZWFkZXJzLlxuICAgKiBAZGVmYXVsdCBbXCJjb250ZW50LXR5cGVcIiwgXCJhdXRob3JpemF0aW9uXCIsIFwieC1yZXF1ZXN0LWlkXCIsIFwieC10ZW5hbnQtaWRcIl1cbiAgICovXG4gIHJlYWRvbmx5IGFsbG93SGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBFeHBvc2VkIHJlc3BvbnNlIGhlYWRlcnMuXG4gICAqIEBkZWZhdWx0IFtcIngtcmVxdWVzdC1pZFwiXVxuICAgKi9cbiAgcmVhZG9ubHkgZXhwb3NlSGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGJyb3dzZXJzIG1heSBzZW5kIGNyZWRlbnRpYWxzLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dDcmVkZW50aWFscz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEJyb3dzZXIgcHJlZmxpZ2h0IGNhY2hlIGR1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5taW51dGVzKDEwKVxuICAgKi9cbiAgcmVhZG9ubHkgbWF4QWdlPzogRHVyYXRpb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnMge1xuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBuYW1lLCBmb3IgZXhhbXBsZSBgYXBpLmV4YW1wbGUuY29tYC5cbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLlxuICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKipcbiAgICogQUNNIGNlcnRpZmljYXRlIEFSTi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3Igb3B0aW9uYWwgQ05BTUUgcmVjb3JkIGNyZWF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gIC8qKlxuICAgKiBBUEkgbWFwcGluZyBrZXkgdW5kZXIgdGhlIGN1c3RvbSBkb21haW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXBpTWFwcGluZ0tleT86IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgdG8gbWFwLiBEZWZhdWx0cyB0byB0aGlzIGNvbnN0cnVjdCdzIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB0aGlzLnN0YWdlXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhIENOQU1FIHdoZW4gaG9zdGVkWm9uZSBpcyBwcm92aWRlZC5cbiAgICogQGRlZmF1bHQgdHJ1ZSB3aGVuIGhvc3RlZFpvbmUgaXMgcHJvdmlkZWRcbiAgICovXG4gIHJlYWRvbmx5IGNyZWF0ZUNuYW1lPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQ05BTUUgcmVjb3JkIFRUTC5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24uc2Vjb25kcygzMDApXG4gICAqL1xuICByZWFkb25seSByZWNvcmRUdGw/OiBEdXJhdGlvbjtcblxuICAvKipcbiAgICogTXV0dWFsIFRMUyBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uPzogYXBpZ3d2Mi5NVExTQ29uZmlnO1xuXG4gIC8qKlxuICAgKiBUTFMgc2VjdXJpdHkgcG9saWN5LlxuICAgKiBAZGVmYXVsdCBBUEkgR2F0ZXdheSBkZWZhdWx0XG4gICAqL1xuICByZWFkb25seSBzZWN1cml0eVBvbGljeT86IGFwaWd3djIuU2VjdXJpdHlQb2xpY3k7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgb3IgcHJvdmlkZSBhIGxvZyBncm91cC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuIHwgbG9ncy5JTG9nR3JvdXA7XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGFuIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIEBkZXByZWNhdGVkIEFQSSBHYXRld2F5IHYyIEhUVFAgQVBJIHN0YWdlcyBhcmUgbm90IHN1cHBvcnRlZCBXQUZ2MiByZWdpb25hbFxuICogYXNzb2NpYXRpb24gdGFyZ2V0cy4gVXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciB3aXRoXG4gKiBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMgZm9yIFdBRi1wcm90ZWN0ZWQgUkVTVCBBUEkgc3RhZ2VzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlXYWZPcHRpb25zIGV4dGVuZHMgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIHt9XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVByb3BzIHtcbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcbiAgLyoqXG4gICAqIENPUlMgY29uZmlndXJhdGlvbi4gU2V0IHRvIHRydWUgZm9yIEFwcFRoZW9yeSBkZWZhdWx0cy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucztcblxuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucztcblxuICAvKipcbiAgICogUmVnaW9uYWwgV0FGIGF0dGFjaG1lbnQgaXMgaW50ZW50aW9uYWxseSB1bmF2YWlsYWJsZSBmb3IgQVBJIEdhdGV3YXkgdjJcbiAgICogSFRUUCBBUElzLiBTdXBwbHlpbmcgdGhpcyBwcm9wIGZhaWxzIGNsb3NlZCBkdXJpbmcgc3ludGhlc2lzIGluc3RlYWQgb2ZcbiAgICogcHJvZHVjaW5nIGFuIHVuc3VwcG9ydGVkIGAvYXBpcy8uLi4vc3RhZ2VzLy4uLmAgV2ViQUNMIGFzc29jaWF0aW9uLlxuICAgKlxuICAgKiBVc2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHdoZW4gYSBXQUYtcHJvdGVjdGVkIEFQSVxuICAgKiBHYXRld2F5IHN0YWdlIGlzIHJlcXVpcmVkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICogQGRlcHJlY2F0ZWQgSFRUUCBBUEkgV0FGIGFzc29jaWF0aW9uIGlzIHVuc3VwcG9ydGVkIGJ5IEFXUyBXQUZ2Mi5cbiAgICovXG4gIHJlYWRvbmx5IHdhZj86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpV2FmT3B0aW9ucztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUh0dHBBcGkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2U7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlIdHRwQXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzLndhZikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeUh0dHBBcGkgZG9lcyBub3Qgc3VwcG9ydCBXQUZ2MiByZWdpb25hbCBXZWJBQ0wgYXNzb2NpYXRpb25zIGZvciBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSXM7IHVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgZm9yIFdBRi1wcm90ZWN0ZWQgUkVTVCBzdGFnZXNcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCI7XG4gICAgY29uc3QgbmVlZHNFeHBsaWNpdFN0YWdlID0gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY29yc1ByZWZsaWdodDogYnVpbGRDb3JzUHJlZmxpZ2h0KHByb3BzLmNvcnMpLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhZ2UgPSBuZWVkc0V4cGxpY2l0U3RhZ2VcbiAgICAgID8gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICAgIHRocm90dGxlOiAoc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgfSlcbiAgICAgIDogdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIGlmICghc3RhZ2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGk6IGZhaWxlZCB0byBjcmVhdGUgQVBJIHN0YWdlXCIpO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlID0gc3RhZ2U7XG4gICAgdGhpcy5jb25maWd1cmVBY2Nlc3NMb2dnaW5nKHN0YWdlT3B0cywgc3RhZ2UpO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL1wiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5BTlldLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIlJvb3RcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL3twcm94eSt9XCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWV0sXG4gICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiUHJveHlcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgdGhpcy5jb25maWd1cmVEb21haW4ocHJvcHMuZG9tYWluKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZUFjY2Vzc0xvZ2dpbmcoc3RhZ2VPcHRzOiBBcHBUaGVvcnlIdHRwQXBpU3RhZ2VPcHRpb25zLCBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UpOiB2b2lkIHtcbiAgICBpZiAoIXN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZVxuICAgICAgPyBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICB9KVxuICAgICAgOiBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICBjZm5TdGFnZS5hY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgIGZvcm1hdDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgICAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgICAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgICAgIH0pLFxuICAgIH07XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZURvbWFpbihvcHRpb25zOiBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucyk6IHZvaWQge1xuICAgIGNvbnN0IGNlcnRpZmljYXRlID0gb3B0aW9ucy5jZXJ0aWZpY2F0ZSA/PyAob3B0aW9ucy5jZXJ0aWZpY2F0ZUFyblxuICAgICAgPyBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0aWZpY2F0ZVwiLCBvcHRpb25zLmNlcnRpZmljYXRlQXJuKVxuICAgICAgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGkgZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBkb21haW4gPSBuZXcgQXBwVGhlb3J5QXBpRG9tYWluKHRoaXMsIFwiRG9tYWluXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IG9wdGlvbnMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZTogb3B0aW9ucy5zdGFnZSA/PyB0aGlzLnN0YWdlLFxuICAgICAgaG9zdGVkWm9uZTogb3B0aW9ucy5ob3N0ZWRab25lLFxuICAgICAgYXBpTWFwcGluZ0tleTogb3B0aW9ucy5hcGlNYXBwaW5nS2V5LFxuICAgICAgY3JlYXRlQ25hbWU6IG9wdGlvbnMuY3JlYXRlQ25hbWUsXG4gICAgICByZWNvcmRUdGw6IG9wdGlvbnMucmVjb3JkVHRsLFxuICAgICAgbXV0dWFsVGxzQXV0aGVudGljYXRpb246IG9wdGlvbnMubXV0dWFsVGxzQXV0aGVudGljYXRpb24sXG4gICAgICBzZWN1cml0eVBvbGljeTogb3B0aW9ucy5zZWN1cml0eVBvbGljeSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbj86IEFwcFRoZW9yeUFwaURvbWFpbiB9KS5kb21haW4gPSBkb21haW47XG4gIH1cbn1cblxuZnVuY3Rpb24gYnVpbGRDb3JzUHJlZmxpZ2h0KGlucHV0PzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucyk6IGFwaWd3djIuQ29yc1ByZWZsaWdodE9wdGlvbnMgfCB1bmRlZmluZWQge1xuICBpZiAoIWlucHV0KSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBjb25zdCBvcHRpb25zID0gaW5wdXQgPT09IHRydWUgPyB7fSA6IGlucHV0O1xuICByZXR1cm4ge1xuICAgIGFsbG93T3JpZ2luczogb3B0aW9ucy5hbGxvd09yaWdpbnMgPz8gW1wiKlwiXSxcbiAgICBhbGxvd01ldGhvZHM6IChvcHRpb25zLmFsbG93TWV0aG9kcyA/PyBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiUEFUQ0hcIiwgXCJIRUFEXCIsIFwiT1BUSU9OU1wiXSlcbiAgICAgIC5tYXAoKG1ldGhvZCkgPT4gU3RyaW5nKG1ldGhvZCkudHJpbSgpLnRvVXBwZXJDYXNlKCkpXG4gICAgICAuZmlsdGVyKChtZXRob2QpID0+IG1ldGhvZCkgYXMgYXBpZ3d2Mi5Db3JzSHR0cE1ldGhvZFtdLFxuICAgIGFsbG93SGVhZGVyczogb3B0aW9ucy5hbGxvd0hlYWRlcnMgPz8gW1wiY29udGVudC10eXBlXCIsIFwiYXV0aG9yaXphdGlvblwiLCBcIngtcmVxdWVzdC1pZFwiLCBcIngtdGVuYW50LWlkXCJdLFxuICAgIGV4cG9zZUhlYWRlcnM6IG9wdGlvbnMuZXhwb3NlSGVhZGVycyA/PyBbXCJ4LXJlcXVlc3QtaWRcIl0sXG4gICAgYWxsb3dDcmVkZW50aWFsczogb3B0aW9ucy5hbGxvd0NyZWRlbnRpYWxzID8/IGZhbHNlLFxuICAgIG1heEFnZTogb3B0aW9ucy5tYXhBZ2UgPz8gRHVyYXRpb24ubWludXRlcygxMCksXG4gIH07XG59XG4iXX0=