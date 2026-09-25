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
exports.AppTheoryHttpIngestionEndpoint = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigwv2Authorizers = __importStar(require("aws-cdk-lib/aws-apigatewayv2-authorizers"));
const apigwv2Integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const constructs_1 = require("constructs");
const string_utils_1 = require("./private/string-utils");
/**
 * Authenticated HTTPS ingestion endpoint backed by Lambda.
 *
 * This construct is intended for server-to-server submission paths where callers
 * authenticate with a shared secret key via a Lambda request authorizer.
 */
class AppTheoryHttpIngestionEndpoint extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHttpIngestionEndpoint", version: "4.4.2-rc" };
    api;
    routeAuthorizer;
    endpoint;
    stage;
    accessLogGroup;
    domainName;
    apiMapping;
    cnameRecord;
    constructor(scope, id, props) {
        super(scope, id);
        const endpointPath = normalizeEndpointPath(props.endpointPath ?? "/ingest");
        const authorizerHeaderName = normalizeHeaderName(props.authorizerHeaderName ?? "Authorization");
        const stageOpts = props.stage ?? {};
        const stageName = stageOpts.stageName ?? "$default";
        const needsExplicitStage = stageName !== "$default"
            || stageOpts.accessLogging
            || stageOpts.throttlingRateLimit !== undefined
            || stageOpts.throttlingBurstLimit !== undefined;
        this.api = new apigwv2.HttpApi(this, "Api", {
            apiName: props.apiName,
            createDefaultStage: !needsExplicitStage,
        });
        let stage;
        if (needsExplicitStage) {
            stage = new apigwv2.HttpStage(this, "Stage", {
                httpApi: this.api,
                stageName,
                autoDeploy: true,
                throttle: (stageOpts.throttlingRateLimit !== undefined || stageOpts.throttlingBurstLimit !== undefined)
                    ? {
                        rateLimit: stageOpts.throttlingRateLimit,
                        burstLimit: stageOpts.throttlingBurstLimit,
                    }
                    : undefined,
            });
            if (stageOpts.accessLogging) {
                const logGroup = new logs.LogGroup(this, "AccessLogs", {
                    retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
                });
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
        }
        else {
            stage = this.api.defaultStage;
        }
        if (!stage) {
            throw new Error("AppTheoryHttpIngestionEndpoint: failed to create API stage");
        }
        this.stage = stage;
        this.routeAuthorizer = new apigwv2Authorizers.HttpLambdaAuthorizer("Authorizer", props.authorizer, {
            authorizerName: props.authorizerName,
            identitySource: [`$request.header.${authorizerHeaderName}`],
            resultsCacheTtl: props.authorizerCacheTtl ?? aws_cdk_lib_1.Duration.seconds(0),
            responseTypes: [apigwv2Authorizers.HttpLambdaResponseType.SIMPLE],
        });
        this.api.addRoutes({
            path: endpointPath,
            methods: [apigwv2.HttpMethod.POST],
            integration: new apigwv2Integrations.HttpLambdaIntegration("IngestionHandler", props.handler, {
                payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
                scopePermissionToRoute: props.scopePermissionToRoute ?? true,
            }),
            authorizer: this.routeAuthorizer,
        });
        if (props.domain) {
            this.setupCustomDomain(props.domain);
            this.endpoint = joinUrlParts(`https://${props.domain.domainName}`, props.domain.basePath, endpointPath);
        }
        else {
            const baseUrl = stageName === "$default"
                ? this.api.apiEndpoint
                : `${this.api.apiEndpoint}/${stageName}`;
            this.endpoint = joinUrlParts(baseUrl, endpointPath);
        }
    }
    setupCustomDomain(domainOpts) {
        const certificate = domainOpts.certificate ?? (domainOpts.certificateArn
            ? acm.Certificate.fromCertificateArn(this, "ImportedCert", domainOpts.certificateArn)
            : undefined);
        if (!certificate) {
            throw new Error("AppTheoryHttpIngestionEndpoint: domain requires either certificate or certificateArn");
        }
        const domainName = new apigwv2.DomainName(this, "DomainName", {
            domainName: domainOpts.domainName,
            certificate,
        });
        this.domainName = domainName;
        const apiMapping = new apigwv2.ApiMapping(this, "ApiMapping", {
            api: this.api,
            domainName,
            stage: this.stage,
            apiMappingKey: normalizeBasePath(domainOpts.basePath),
        });
        this.apiMapping = apiMapping;
        if (domainOpts.hostedZone) {
            const recordName = toRoute53RecordName(domainOpts.domainName, domainOpts.hostedZone);
            const record = new route53.CnameRecord(this, "CnameRecord", {
                zone: domainOpts.hostedZone,
                recordName,
                domainName: domainName.regionalDomainName,
            });
            this.cnameRecord = record;
        }
    }
}
exports.AppTheoryHttpIngestionEndpoint = AppTheoryHttpIngestionEndpoint;
function normalizeEndpointPath(path) {
    const trimmed = String(path ?? "").trim();
    if (!trimmed) {
        throw new Error("AppTheoryHttpIngestionEndpoint: endpointPath is required");
    }
    const normalized = (0, string_utils_1.collapseRepeatedChar)((0, string_utils_1.trimRepeatedChar)(trimmed, "/"), "/");
    return normalized ? `/${normalized}` : "/";
}
function normalizeHeaderName(headerName) {
    const trimmed = String(headerName ?? "").trim();
    if (!trimmed) {
        throw new Error("AppTheoryHttpIngestionEndpoint: authorizerHeaderName is required");
    }
    return trimmed;
}
function normalizeBasePath(basePath) {
    const trimmed = (0, string_utils_1.trimRepeatedChar)(String(basePath ?? "").trim(), "/");
    return trimmed || undefined;
}
function joinUrlParts(baseUrl, ...parts) {
    let out = (0, string_utils_1.trimRepeatedCharEnd)(String(baseUrl ?? ""), "/");
    for (const part of parts) {
        const normalized = (0, string_utils_1.trimRepeatedChar)(String(part ?? "").trim(), "/");
        if (!normalized)
            continue;
        out = `${out}/${normalized}`;
    }
    return out;
}
function toRoute53RecordName(domainName, zone) {
    const fqdn = String(domainName ?? "").trim().replace(/\.$/, "");
    const zoneName = String(zone.zoneName ?? "").trim().replace(/\.$/, "");
    if (!zoneName)
        return fqdn;
    if (fqdn === zoneName)
        return "";
    const suffix = `.${zoneName}`;
    if (fqdn.endsWith(suffix)) {
        return fqdn.slice(0, -suffix.length);
    }
    return fqdn;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1pbmdlc3Rpb24tZW5kcG9pbnQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWluZ2VzdGlvbi1lbmRwb2ludC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXVDO0FBQ3ZDLHdFQUEwRDtBQUMxRCxzRUFBd0Q7QUFDeEQsNkZBQStFO0FBQy9FLCtGQUFpRjtBQUVqRiwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELDJDQUF1QztBQUV2Qyx5REFBcUc7QUEwSXJHOzs7OztHQUtHO0FBQ0gsTUFBYSw4QkFBK0IsU0FBUSxzQkFBUzs7SUFDM0MsR0FBRyxDQUFrQjtJQUNyQixlQUFlLENBQTBDO0lBQ3pELFFBQVEsQ0FBUztJQUNqQixLQUFLLENBQWlCO0lBQ3RCLGNBQWMsQ0FBa0I7SUFDaEMsVUFBVSxDQUFzQjtJQUNoQyxVQUFVLENBQXNCO0lBQ2hDLFdBQVcsQ0FBdUI7SUFFbEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUEwQztRQUNsRixLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sWUFBWSxHQUFHLHFCQUFxQixDQUFDLEtBQUssQ0FBQyxZQUFZLElBQUksU0FBUyxDQUFDLENBQUM7UUFDNUUsTUFBTSxvQkFBb0IsR0FBRyxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLElBQUksZUFBZSxDQUFDLENBQUM7UUFDaEcsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDcEMsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFFcEQsTUFBTSxrQkFBa0IsR0FBRyxTQUFTLEtBQUssVUFBVTtlQUM5QyxTQUFTLENBQUMsYUFBYTtlQUN2QixTQUFTLENBQUMsbUJBQW1CLEtBQUssU0FBUztlQUMzQyxTQUFTLENBQUMsb0JBQW9CLEtB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QztRQUNwRSxJQUFJLENBQUMsVUFBVTtZQUFFLFNBQVM7UUFDMUIsR0FBRyxHQUFHLEdBQUcsR0FBRyxJQUFJLFVBQVUsRUFBRSxDQUFDO0lBQy9CLENBQUM7SUFDRCxPQUFPLEdBQUcsQ0FBQztBQUNiLENBQUM7QUFFRCxTQUFTLG1CQUFtQixDQUFDLFVBQWtCLEVBQUUsSUFBeUI7SUFDeEUsTUFBTSxJQUFJLEdBQUcsTUFBTSxDQUFDLFVBQVUsSUFBSSxFQUFFLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0lBQ2hFLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsUUFBUSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDdkUsSUFBSSxDQUFDLFFBQVE7UUFBRSxPQUFPLElBQUksQ0FBQztJQUMzQixJQUFJLElBQUksS0FBSyxRQUFRO1FBQUUsT0FBTyxFQUFFLENBQUM7SUFDakMsTUFBTSxNQUFNLEdBQUcsSUFBSSxRQUFRLEVBQUUsQ0FBQztJQUM5QixJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztRQUMxQixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0lBQ3ZDLENBQUM7SUFDRCxPQUFPLElBQUksQ0FBQztBQUNkLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBjb2xsYXBzZVJlcGVhdGVkQ2hhciwgdHJpbVJlcGVhdGVkQ2hhciwgdHJpbVJlcGVhdGVkQ2hhckVuZCB9IGZyb20gXCIuL3ByaXZhdGUvc3RyaW5nLXV0aWxzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50RG9tYWluT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBUaGUgY3VzdG9tIGRvbWFpbiBuYW1lIChmb3IgZXhhbXBsZSBgaW5nZXN0LmV4YW1wbGUuY29tYCkuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi5cbiAgICogUHJvdmlkZSBlaXRoZXIgYGNlcnRpZmljYXRlYCBvciBgY2VydGlmaWNhdGVBcm5gLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKlxuICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLlxuICAgKiBQcm92aWRlIGVpdGhlciBgY2VydGlmaWNhdGVgIG9yIGBjZXJ0aWZpY2F0ZUFybmAuXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgYXV0b21hdGljIEROUyByZWNvcmQgY3JlYXRpb24uXG4gICAqIElmIHByb3ZpZGVkLCBhIENOQU1FIHJlY29yZCB3aWxsIGJlIGNyZWF0ZWQgcG9pbnRpbmcgdG8gdGhlIEFQSSBHYXRld2F5IGRvbWFpbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQVBJIG1hcHBpbmcga2V5IHVuZGVyIHRoZSBjdXN0b20gZG9tYWluLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGJhc2VQYXRoPzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBJbmdlc3Rpb25FbmRwb2ludFN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgZm9yIHRoZSBzdGFnZS5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogT25seSBhcHBsaWVzIHdoZW4gYWNjZXNzTG9nZ2luZyBpcyB0cnVlLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0IGZvciB0aGUgc3RhZ2UuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50UHJvcHMge1xuICAvKipcbiAgICogTGFtYmRhIGZ1bmN0aW9uIHRoYXQgaGFuZGxlcyB0aGUgaW5nZXN0aW9uIHJlcXVlc3QuXG4gICAqL1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRoZSBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb24gc2hvdWxkIGJlIHNjb3BlZCB0byB0aGUgaW5nZXN0aW9uIHJvdXRlLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBpbnN0ZWFkIG9mIG9uZVxuICAgKiBwZXJtaXNzaW9uIHNjb3BlZCB0byB0aGUgaW5nZXN0aW9uIHBhdGguIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSB3aGVuIHRoZSBpbmdlc3Rpb25cbiAgICogTGFtYmRhIGlzIHNoYXJlZCB3aXRoIG90aGVyIHJvdXRlcyBvbiB0aGUgc2FtZSBIVFRQIEFQSSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9uc1xuICAgKiBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlIHBvbGljeSBzaXplIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgaGFuZGxlciwgbm90IG9ubHkgdGhlIGluZ2VzdGlvbiByb3V0ZSB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogTGFtYmRhIHJlcXVlc3QgYXV0aG9yaXplciB1c2VkIGZvciBzZWNyZXQta2V5IHZhbGlkYXRpb24uXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBUEkgbmFtZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBIVFRQUyBwYXRoIGV4cG9zZWQgYnkgdGhlIGVuZHBvaW50LlxuICAgKiBAZGVmYXVsdCBcIi9pbmdlc3RcIlxuICAgKi9cbiAgcmVhZG9ubHkgZW5kcG9pbnRQYXRoPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBIZWFkZXIgdXNlZCBhcyB0aGUgaWRlbnRpdHkgc291cmNlIGZvciBzZWNyZXQta2V5IGF1dGhvcml6YXRpb24uXG4gICAqIFRoaXMgZGVmYXVsdHMgdG8gYEF1dGhvcml6YXRpb25gIHRvIG1pcnJvciB0aGUgYmFja29mZmljZS1hcGktYXV0aG9yaXplciBwYXR0ZXJuLlxuICAgKiBAZGVmYXVsdCBcIkF1dGhvcml6YXRpb25cIlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckhlYWRlck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZyaWVuZGx5IGF1dGhvcml6ZXIgbmFtZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGFtYmRhIGF1dGhvcml6ZXIgcmVzdWx0IGNhY2hlIFRUTC5cbiAgICogRGVmYXVsdHMgdG8gZGlzYWJsZWQgdG8gbWF0Y2ggdGhlIHVwc3RyZWFtIGJhY2tvZmZpY2UtYXBpLWF1dGhvcml6ZXIgYmVoYXZpb3IuXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLnNlY29uZHMoMClcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJDYWNoZVR0bD86IER1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBjdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50RG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogT3B0aW9uYWwgc3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeUh0dHBJbmdlc3Rpb25FbmRwb2ludFN0YWdlT3B0aW9ucztcbn1cblxuLyoqXG4gKiBBdXRoZW50aWNhdGVkIEhUVFBTIGluZ2VzdGlvbiBlbmRwb2ludCBiYWNrZWQgYnkgTGFtYmRhLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGlzIGludGVuZGVkIGZvciBzZXJ2ZXItdG8tc2VydmVyIHN1Ym1pc3Npb24gcGF0aHMgd2hlcmUgY2FsbGVyc1xuICogYXV0aGVudGljYXRlIHdpdGggYSBzaGFyZWQgc2VjcmV0IGtleSB2aWEgYSBMYW1iZGEgcmVxdWVzdCBhdXRob3JpemVyLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50IGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVBdXRob3JpemVyOiBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXI7XG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWU7XG4gIHB1YmxpYyByZWFkb25seSBhcGlNYXBwaW5nPzogYXBpZ3d2Mi5BcGlNYXBwaW5nO1xuICBwdWJsaWMgcmVhZG9ubHkgY25hbWVSZWNvcmQ/OiByb3V0ZTUzLkNuYW1lUmVjb3JkO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlIdHRwSW5nZXN0aW9uRW5kcG9pbnRQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBlbmRwb2ludFBhdGggPSBub3JtYWxpemVFbmRwb2ludFBhdGgocHJvcHMuZW5kcG9pbnRQYXRoID8/IFwiL2luZ2VzdFwiKTtcbiAgICBjb25zdCBhdXRob3JpemVySGVhZGVyTmFtZSA9IG5vcm1hbGl6ZUhlYWRlck5hbWUocHJvcHMuYXV0aG9yaXplckhlYWRlck5hbWUgPz8gXCJBdXRob3JpemF0aW9uXCIpO1xuICAgIGNvbnN0IHN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgIGNvbnN0IHN0YWdlTmFtZSA9IHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiO1xuXG4gICAgY29uc3QgbmVlZHNFeHBsaWNpdFN0YWdlID0gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlLFxuICAgIH0pO1xuXG4gICAgbGV0IHN0YWdlOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZDtcbiAgICBpZiAobmVlZHNFeHBsaWNpdFN0YWdlKSB7XG4gICAgICBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgdGhyb3R0bGU6IChzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgICB9XG4gICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICB9KTtcblxuICAgICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgICAgfSk7XG4gICAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICAgIGZvcm1hdDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgICAgICAgICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICAgICAgICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgICAgICAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICAgICAgICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgICAgICAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgICAgICAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgICAgICAgICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICAgICAgICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgICAgICAgICB9KSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgc3RhZ2UgPSB0aGlzLmFwaS5kZWZhdWx0U3RhZ2U7XG4gICAgfVxuXG4gICAgaWYgKCFzdGFnZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50OiBmYWlsZWQgdG8gY3JlYXRlIEFQSSBzdGFnZVwiKTtcbiAgICB9XG4gICAgdGhpcy5zdGFnZSA9IHN0YWdlO1xuXG4gICAgdGhpcy5yb3V0ZUF1dGhvcml6ZXIgPSBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFBdXRob3JpemVyKFwiQXV0aG9yaXplclwiLCBwcm9wcy5hdXRob3JpemVyLCB7XG4gICAgICBhdXRob3JpemVyTmFtZTogcHJvcHMuYXV0aG9yaXplck5hbWUsXG4gICAgICBpZGVudGl0eVNvdXJjZTogW2AkcmVxdWVzdC5oZWFkZXIuJHthdXRob3JpemVySGVhZGVyTmFtZX1gXSxcbiAgICAgIHJlc3VsdHNDYWNoZVR0bDogcHJvcHMuYXV0aG9yaXplckNhY2hlVHRsID8/IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICByZXNwb25zZVR5cGVzOiBbYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFSZXNwb25zZVR5cGUuU0lNUExFXSxcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBlbmRwb2ludFBhdGgsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1RdLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIkluZ2VzdGlvbkhhbmRsZXJcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSksXG4gICAgICBhdXRob3JpemVyOiB0aGlzLnJvdXRlQXV0aG9yaXplcixcbiAgICB9KTtcblxuICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgIHRoaXMuc2V0dXBDdXN0b21Eb21haW4ocHJvcHMuZG9tYWluKTtcbiAgICAgIHRoaXMuZW5kcG9pbnQgPSBqb2luVXJsUGFydHMoXG4gICAgICAgIGBodHRwczovLyR7cHJvcHMuZG9tYWluLmRvbWFpbk5hbWV9YCxcbiAgICAgICAgcHJvcHMuZG9tYWluLmJhc2VQYXRoLFxuICAgICAgICBlbmRwb2ludFBhdGgsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBiYXNlVXJsID0gc3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgICAgPyB0aGlzLmFwaS5hcGlFbmRwb2ludFxuICAgICAgICA6IGAke3RoaXMuYXBpLmFwaUVuZHBvaW50fS8ke3N0YWdlTmFtZX1gO1xuICAgICAgdGhpcy5lbmRwb2ludCA9IGpvaW5VcmxQYXJ0cyhiYXNlVXJsLCBlbmRwb2ludFBhdGgpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgc2V0dXBDdXN0b21Eb21haW4oZG9tYWluT3B0czogQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50RG9tYWluT3B0aW9ucyk6IHZvaWQge1xuICAgIGNvbnN0IGNlcnRpZmljYXRlID0gZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZSA/PyAoZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZUFyblxuICAgICAgPyBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0XCIsIGRvbWFpbk9wdHMuY2VydGlmaWNhdGVBcm4pIGFzIGFjbS5JQ2VydGlmaWNhdGVcbiAgICAgIDogdW5kZWZpbmVkKTtcblxuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBJbmdlc3Rpb25FbmRwb2ludDogZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBkb21haW5OYW1lID0gbmV3IGFwaWd3djIuRG9tYWluTmFtZSh0aGlzLCBcIkRvbWFpbk5hbWVcIiwge1xuICAgICAgZG9tYWluTmFtZTogZG9tYWluT3B0cy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lIH0pLmRvbWFpbk5hbWUgPSBkb21haW5OYW1lO1xuXG4gICAgY29uc3QgYXBpTWFwcGluZyA9IG5ldyBhcGlnd3YyLkFwaU1hcHBpbmcodGhpcywgXCJBcGlNYXBwaW5nXCIsIHtcbiAgICAgIGFwaTogdGhpcy5hcGksXG4gICAgICBkb21haW5OYW1lLFxuICAgICAgc3RhZ2U6IHRoaXMuc3RhZ2UsXG4gICAgICBhcGlNYXBwaW5nS2V5OiBub3JtYWxpemVCYXNlUGF0aChkb21haW5PcHRzLmJhc2VQYXRoKSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGFwaU1hcHBpbmc/OiBhcGlnd3YyLkFwaU1hcHBpbmcgfSkuYXBpTWFwcGluZyA9IGFwaU1hcHBpbmc7XG5cbiAgICBpZiAoZG9tYWluT3B0cy5ob3N0ZWRab25lKSB7XG4gICAgICBjb25zdCByZWNvcmROYW1lID0gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5PcHRzLmRvbWFpbk5hbWUsIGRvbWFpbk9wdHMuaG9zdGVkWm9uZSk7XG4gICAgICBjb25zdCByZWNvcmQgPSBuZXcgcm91dGU1My5DbmFtZVJlY29yZCh0aGlzLCBcIkNuYW1lUmVjb3JkXCIsIHtcbiAgICAgICAgem9uZTogZG9tYWluT3B0cy5ob3N0ZWRab25lLFxuICAgICAgICByZWNvcmROYW1lLFxuICAgICAgICBkb21haW5OYW1lOiBkb21haW5OYW1lLnJlZ2lvbmFsRG9tYWluTmFtZSxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBjbmFtZVJlY29yZD86IHJvdXRlNTMuQ25hbWVSZWNvcmQgfSkuY25hbWVSZWNvcmQgPSByZWNvcmQ7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUVuZHBvaW50UGF0aChwYXRoOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gU3RyaW5nKHBhdGggPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwSW5nZXN0aW9uRW5kcG9pbnQ6IGVuZHBvaW50UGF0aCBpcyByZXF1aXJlZFwiKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gY29sbGFwc2VSZXBlYXRlZENoYXIodHJpbVJlcGVhdGVkQ2hhcih0cmltbWVkLCBcIi9cIiksIFwiL1wiKTtcbiAgcmV0dXJuIG5vcm1hbGl6ZWQgPyBgLyR7bm9ybWFsaXplZH1gIDogXCIvXCI7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUhlYWRlck5hbWUoaGVhZGVyTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IFN0cmluZyhoZWFkZXJOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50OiBhdXRob3JpemVySGVhZGVyTmFtZSBpcyByZXF1aXJlZFwiKTtcbiAgfVxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQmFzZVBhdGgoYmFzZVBhdGg/OiBzdHJpbmcpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBjb25zdCB0cmltbWVkID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcoYmFzZVBhdGggPz8gXCJcIikudHJpbSgpLCBcIi9cIik7XG4gIHJldHVybiB0cmltbWVkIHx8IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gam9pblVybFBhcnRzKGJhc2VVcmw6IHN0cmluZywgLi4ucGFydHM6IEFycmF5PHN0cmluZyB8IHVuZGVmaW5lZD4pOiBzdHJpbmcge1xuICBsZXQgb3V0ID0gdHJpbVJlcGVhdGVkQ2hhckVuZChTdHJpbmcoYmFzZVVybCA/PyBcIlwiKSwgXCIvXCIpO1xuICBmb3IgKGNvbnN0IHBhcnQgb2YgcGFydHMpIHtcbiAgICBjb25zdCBub3JtYWxpemVkID0gdHJpbVJlcGVhdGVkQ2hhcihTdHJpbmcocGFydCA/PyBcIlwiKS50cmltKCksIFwiL1wiKTtcbiAgICBpZiAoIW5vcm1hbGl6ZWQpIGNvbnRpbnVlO1xuICAgIG91dCA9IGAke291dH0vJHtub3JtYWxpemVkfWA7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuZnVuY3Rpb24gdG9Sb3V0ZTUzUmVjb3JkTmFtZShkb21haW5OYW1lOiBzdHJpbmcsIHpvbmU6IHJvdXRlNTMuSUhvc3RlZFpvbmUpOiBzdHJpbmcge1xuICBjb25zdCBmcWRuID0gU3RyaW5nKGRvbWFpbk5hbWUgPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoL1xcLiQvLCBcIlwiKTtcbiAgY29uc3Qgem9uZU5hbWUgPSBTdHJpbmcoem9uZS56b25lTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBpZiAoIXpvbmVOYW1lKSByZXR1cm4gZnFkbjtcbiAgaWYgKGZxZG4gPT09IHpvbmVOYW1lKSByZXR1cm4gXCJcIjtcbiAgY29uc3Qgc3VmZml4ID0gYC4ke3pvbmVOYW1lfWA7XG4gIGlmIChmcWRuLmVuZHNXaXRoKHN1ZmZpeCkpIHtcbiAgICByZXR1cm4gZnFkbi5zbGljZSgwLCAtc3VmZml4Lmxlbmd0aCk7XG4gIH1cbiAgcmV0dXJuIGZxZG47XG59XG4iXX0=