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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHttpApi", version: "6.0.0-rc" };
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
            disableExecuteApiEndpoint: props.domain?.mutualTlsAuthentication !== undefined ? true : undefined,
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
                scopePermissionToRoute: props.scopePermissionToRoute ?? true,
            }),
        });
        this.api.addRoutes({
            path: "/{proxy+}",
            methods: [apigwv2.HttpMethod.ANY],
            integration: new apigwv2Integrations.HttpLambdaIntegration("Proxy", props.handler, {
                payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
                scopePermissionToRoute: props.scopePermissionToRoute ?? true,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXVDO0FBQ3ZDLHNFQUF3RDtBQUN4RCwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMsNkNBQWtEO0FBcU1sRCxNQUFhLGdCQUFpQixTQUFRLHNCQUFTOztJQUM3QixHQUFHLENBQWtCO0lBQ3JCLEtBQUssQ0FBaUI7SUFDdEIsY0FBYyxDQUFrQjtJQUNoQyxNQUFNLENBQXNCO0lBRTVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNkLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUxBQWlMLENBQ2xMLENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDcEMsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFDcEQsTUFBTSxrQkFBa0IsR0FBRyxTQUFTLEtBQUssVUFBVTtlQUM5QyxTQUFTLENBQUMsYUFBYTtlQUN2QixTQUFTLENBQUMsbUJBQW1CLEtBQUssU0FBUztlQUMzQyxTQUFTLENBQUMsb0JBQW9CLEtBQUssU0FBUyxDQUFDO1FBRWxELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDMUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO1lBQ3RCLGFBQWEsRUFBRSxrQkFBa0IsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDO1lBQzdDLGtCQUFrQixFQUFFLENBQUMsa0JB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QUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztLQUMvQyxDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB0eXBlICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUFwaURvbWFpbiB9IGZyb20gXCIuL2FwaS1kb21haW5cIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zIHtcbiAgLyoqXG4gICAqIEFsbG93ZWQgb3JpZ2lucy5cbiAgICogQGRlZmF1bHQgW1wiKlwiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dPcmlnaW5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzLlxuICAgKiBAZGVmYXVsdCBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiUEFUQ0hcIiwgXCJIRUFEXCIsIFwiT1BUSU9OU1wiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dNZXRob2RzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFsbG93ZWQgaGVhZGVycy5cbiAgICogQGRlZmF1bHQgW1wiY29udGVudC10eXBlXCIsIFwiYXV0aG9yaXphdGlvblwiLCBcIngtcmVxdWVzdC1pZFwiLCBcIngtdGVuYW50LWlkXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd0hlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogRXhwb3NlZCByZXNwb25zZSBoZWFkZXJzLlxuICAgKiBAZGVmYXVsdCBbXCJ4LXJlcXVlc3QtaWRcIl1cbiAgICovXG4gIHJlYWRvbmx5IGV4cG9zZUhlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogV2hldGhlciBicm93c2VycyBtYXkgc2VuZCBjcmVkZW50aWFscy5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFsbG93Q3JlZGVudGlhbHM/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBCcm93c2VyIHByZWZsaWdodCBjYWNoZSBkdXJhdGlvbi5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24ubWludXRlcygxMClcbiAgICovXG4gIHJlYWRvbmx5IG1heEFnZT86IER1cmF0aW9uO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zIHtcbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gbmFtZSwgZm9yIGV4YW1wbGUgYGFwaS5leGFtcGxlLmNvbWAuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIG9wdGlvbmFsIENOQU1FIHJlY29yZCBjcmVhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAvKipcbiAgICogQVBJIG1hcHBpbmcga2V5IHVuZGVyIHRoZSBjdXN0b20gZG9tYWluLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU1hcHBpbmdLZXk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0YWdlIHRvIG1hcC4gRGVmYXVsdHMgdG8gdGhpcyBjb25zdHJ1Y3QncyBzdGFnZS5cbiAgICogQGRlZmF1bHQgdGhpcy5zdGFnZVxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBhcGlnd3YyLklTdGFnZTtcblxuICAvKipcbiAgICogV2hldGhlciB0byBjcmVhdGUgYSBDTkFNRSB3aGVuIGhvc3RlZFpvbmUgaXMgcHJvdmlkZWQuXG4gICAqIEBkZWZhdWx0IHRydWUgd2hlbiBob3N0ZWRab25lIGlzIHByb3ZpZGVkXG4gICAqL1xuICByZWFkb25seSBjcmVhdGVDbmFtZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENOQU1FIHJlY29yZCBUVEwuXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLnNlY29uZHMoMzAwKVxuICAgKi9cbiAgcmVhZG9ubHkgcmVjb3JkVHRsPzogRHVyYXRpb247XG5cbiAgLyoqXG4gICAqIE11dHVhbCBUTFMgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbj86IGFwaWd3djIuTVRMU0NvbmZpZztcblxuICAvKipcbiAgICogVExTIHNlY3VyaXR5IHBvbGljeS5cbiAgICogQGRlZmF1bHQgQVBJIEdhdGV3YXkgZGVmYXVsdFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlnd3YyLlNlY3VyaXR5UG9saWN5O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMge1xuICAvKipcbiAgICogU3RhZ2UgbmFtZS5cbiAgICogQGRlZmF1bHQgXCIkZGVmYXVsdFwiXG4gICAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEVuYWJsZSBDbG91ZFdhdGNoIGFjY2VzcyBsb2dnaW5nIG9yIHByb3ZpZGUgYSBsb2cgZ3JvdXAuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbiB8IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhbiBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIHJhdGUgbGltaXQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBAZGVwcmVjYXRlZCBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSSBzdGFnZXMgYXJlIG5vdCBzdXBwb3J0ZWQgV0FGdjIgcmVnaW9uYWxcbiAqIGFzc29jaWF0aW9uIHRhcmdldHMuIFVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgd2l0aFxuICogQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIGZvciBXQUYtcHJvdGVjdGVkIFJFU1QgQVBJIHN0YWdlcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpV2FmT3B0aW9ucyBleHRlbmRzIEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyB7fVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciByb3V0ZSBmYW1pbGllcyB0aGF0IHNoYXJlIG9uZVxuICAgKiBMYW1iZGEsIHdoZXJlIHRoZSBwZXItcm91dGUgcGVybWlzc2lvbnMgY2FuIGV4aGF1c3QgdGhlIExhbWJkYSByZXNvdXJjZSBwb2xpY3kgc2l6ZVxuICAgKiBsaW1pdC5cbiAgICpcbiAgICogVGhlIHRyYWRlLW9mZiBpcyBleHBsaWNpdDogdGhlIEFQSS1zY29wZWQgcGVybWlzc2lvbiBhbGxvd3MgZXZlcnkgcm91dGUgb24gdGhhdCBIVFRQIEFQSVxuICAgKiB0byBpbnZva2UgdGhlIGhhbmRsZXIsIG5vdCBvbmx5IHRoZSByb3V0ZXMgdGhpcyBjb25zdHJ1Y3Qgb3ducy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENPUlMgY29uZmlndXJhdGlvbi4gU2V0IHRvIHRydWUgZm9yIEFwcFRoZW9yeSBkZWZhdWx0cy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucztcblxuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBXaGVuIGBkb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGlzIHNldCwgQXBwVGhlb3J5IGZhaWxzIGNsb3NlZCBhbmRcbiAgICogZGlzYWJsZXMgdGhlIGRlZmF1bHQgYGV4ZWN1dGUtYXBpYCBlbmRwb2ludCBzbyB0aGUgQVBJIGlzIHJlYWNoYWJsZSBvbmx5XG4gICAqIHRocm91Z2ggdGhlIG11dHVhbC1UTFMgY3VzdG9tIGRvbWFpbi4gV2l0aG91dCBtdXR1YWwgVExTIHRoZSBkZWZhdWx0XG4gICAqIGVuZHBvaW50IGtlZXBzIHRoZSBBV1MgZGVmYXVsdCAoZW5hYmxlZCksIHNvIG9yZGluYXJ5IGN1c3RvbSBkb21haW5zIGFyZVxuICAgKiB1bmFmZmVjdGVkLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucztcblxuICAvKipcbiAgICogUmVnaW9uYWwgV0FGIGF0dGFjaG1lbnQgaXMgaW50ZW50aW9uYWxseSB1bmF2YWlsYWJsZSBmb3IgQVBJIEdhdGV3YXkgdjJcbiAgICogSFRUUCBBUElzLiBTdXBwbHlpbmcgdGhpcyBwcm9wIGZhaWxzIGNsb3NlZCBkdXJpbmcgc3ludGhlc2lzIGluc3RlYWQgb2ZcbiAgICogcHJvZHVjaW5nIGFuIHVuc3VwcG9ydGVkIGAvYXBpcy8uLi4vc3RhZ2VzLy4uLmAgV2ViQUNMIGFzc29jaWF0aW9uLlxuICAgKlxuICAgKiBVc2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHdoZW4gYSBXQUYtcHJvdGVjdGVkIEFQSVxuICAgKiBHYXRld2F5IHN0YWdlIGlzIHJlcXVpcmVkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICogQGRlcHJlY2F0ZWQgSFRUUCBBUEkgV0FGIGFzc29jaWF0aW9uIGlzIHVuc3VwcG9ydGVkIGJ5IEFXUyBXQUZ2Mi5cbiAgICovXG4gIHJlYWRvbmx5IHdhZj86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpV2FmT3B0aW9ucztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUh0dHBBcGkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2U7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlIdHRwQXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzLndhZikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeUh0dHBBcGkgZG9lcyBub3Qgc3VwcG9ydCBXQUZ2MiByZWdpb25hbCBXZWJBQ0wgYXNzb2NpYXRpb25zIGZvciBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSXM7IHVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgZm9yIFdBRi1wcm90ZWN0ZWQgUkVTVCBzdGFnZXNcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCI7XG4gICAgY29uc3QgbmVlZHNFeHBsaWNpdFN0YWdlID0gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY29yc1ByZWZsaWdodDogYnVpbGRDb3JzUHJlZmxpZ2h0KHByb3BzLmNvcnMpLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlLFxuICAgICAgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludDogcHJvcHMuZG9tYWluPy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbiAhPT0gdW5kZWZpbmVkID8gdHJ1ZSA6IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0YWdlID0gbmVlZHNFeHBsaWNpdFN0YWdlXG4gICAgICA/IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgICB0aHJvdHRsZTogKHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIH0pXG4gICAgICA6IHRoaXMuYXBpLmRlZmF1bHRTdGFnZTtcbiAgICBpZiAoIXN0YWdlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpOiBmYWlsZWQgdG8gY3JlYXRlIEFQSSBzdGFnZVwiKTtcbiAgICB9XG4gICAgdGhpcy5zdGFnZSA9IHN0YWdlO1xuICAgIHRoaXMuY29uZmlndXJlQWNjZXNzTG9nZ2luZyhzdGFnZU9wdHMsIHN0YWdlKTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBcIi9cIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuQU5ZXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJSb290XCIsIHByb3BzLmhhbmRsZXIsIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL3twcm94eSt9XCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWV0sXG4gICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiUHJveHlcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICB0aGlzLmNvbmZpZ3VyZURvbWFpbihwcm9wcy5kb21haW4pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY29uZmlndXJlQWNjZXNzTG9nZ2luZyhzdGFnZU9wdHM6IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMsIHN0YWdlOiBhcGlnd3YyLklTdGFnZSk6IHZvaWQge1xuICAgIGlmICghc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBsb2dHcm91cCA9IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlXG4gICAgICA/IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgIH0pXG4gICAgICA6IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nO1xuICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgZm9ybWF0OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICAgICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICAgICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICAgICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICAgICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICAgICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICAgICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICAgICAgfSksXG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgY29uZmlndXJlRG9tYWluKG9wdGlvbnM6IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRpZmljYXRlXCIsIG9wdGlvbnMuY2VydGlmaWNhdGVBcm4pXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEFwaSBkb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGRvbWFpbiA9IG5ldyBBcHBUaGVvcnlBcGlEb21haW4odGhpcywgXCJEb21haW5cIiwge1xuICAgICAgZG9tYWluTmFtZTogb3B0aW9ucy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHN0YWdlOiBvcHRpb25zLnN0YWdlID8/IHRoaXMuc3RhZ2UsXG4gICAgICBob3N0ZWRab25lOiBvcHRpb25zLmhvc3RlZFpvbmUsXG4gICAgICBhcGlNYXBwaW5nS2V5OiBvcHRpb25zLmFwaU1hcHBpbmdLZXksXG4gICAgICBjcmVhdGVDbmFtZTogb3B0aW9ucy5jcmVhdGVDbmFtZSxcbiAgICAgIHJlY29yZFR0bDogb3B0aW9ucy5yZWNvcmRUdGwsXG4gICAgICBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbjogb3B0aW9ucy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICAgIHNlY3VyaXR5UG9saWN5OiBvcHRpb25zLnNlY3VyaXR5UG9saWN5LFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluIH0pLmRvbWFpbiA9IGRvbWFpbjtcbiAgfVxufVxuXG5mdW5jdGlvbiBidWlsZENvcnNQcmVmbGlnaHQoaW5wdXQ/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zKTogYXBpZ3d2Mi5Db3JzUHJlZmxpZ2h0T3B0aW9ucyB8IHVuZGVmaW5lZCB7XG4gIGlmICghaW5wdXQpIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG4gIGNvbnN0IG9wdGlvbnMgPSBpbnB1dCA9PT0gdHJ1ZSA/IHt9IDogaW5wdXQ7XG4gIHJldHVybiB7XG4gICAgYWxsb3dPcmlnaW5zOiBvcHRpb25zLmFsbG93T3JpZ2lucyA/PyBbXCIqXCJdLFxuICAgIGFsbG93TWV0aG9kczogKG9wdGlvbnMuYWxsb3dNZXRob2RzID8/IFtcIkdFVFwiLCBcIlBPU1RcIiwgXCJQVVRcIiwgXCJERUxFVEVcIiwgXCJQQVRDSFwiLCBcIkhFQURcIiwgXCJPUFRJT05TXCJdKVxuICAgICAgLm1hcCgobWV0aG9kKSA9PiBTdHJpbmcobWV0aG9kKS50cmltKCkudG9VcHBlckNhc2UoKSlcbiAgICAgIC5maWx0ZXIoKG1ldGhvZCkgPT4gbWV0aG9kKSBhcyBhcGlnd3YyLkNvcnNIdHRwTWV0aG9kW10sXG4gICAgYWxsb3dIZWFkZXJzOiBvcHRpb25zLmFsbG93SGVhZGVycyA/PyBbXCJjb250ZW50LXR5cGVcIiwgXCJhdXRob3JpemF0aW9uXCIsIFwieC1yZXF1ZXN0LWlkXCIsIFwieC10ZW5hbnQtaWRcIl0sXG4gICAgZXhwb3NlSGVhZGVyczogb3B0aW9ucy5leHBvc2VIZWFkZXJzID8/IFtcIngtcmVxdWVzdC1pZFwiXSxcbiAgICBhbGxvd0NyZWRlbnRpYWxzOiBvcHRpb25zLmFsbG93Q3JlZGVudGlhbHMgPz8gZmFsc2UsXG4gICAgbWF4QWdlOiBvcHRpb25zLm1heEFnZSA/PyBEdXJhdGlvbi5taW51dGVzKDEwKSxcbiAgfTtcbn1cbiJdfQ==