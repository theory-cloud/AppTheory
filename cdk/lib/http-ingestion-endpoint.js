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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHttpIngestionEndpoint", version: "4.4.0-rc" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1pbmdlc3Rpb24tZW5kcG9pbnQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWluZ2VzdGlvbi1lbmRwb2ludC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQXVDO0FBQ3ZDLHdFQUEwRDtBQUMxRCxzRUFBd0Q7QUFDeEQsNkZBQStFO0FBQy9FLCtGQUFpRjtBQUVqRiwyREFBNkM7QUFDN0MsaUVBQW1EO0FBQ25ELDJDQUF1QztBQUV2Qyx5REFBcUc7QUEySHJHOzs7OztHQUtHO0FBQ0gsTUFBYSw4QkFBK0IsU0FBUSxzQkFBUzs7SUFDM0MsR0FBRyxDQUFrQjtJQUNyQixlQUFlLENBQTBDO0lBQ3pELFFBQVEsQ0FBUztJQUNqQixLQUFLLENBQWlCO0lBQ3RCLGNBQWMsQ0FBa0I7SUFDaEMsVUFBVSxDQUFzQjtJQUNoQyxVQUFVLENBQXNCO0lBQ2hDLFdBQVcsQ0FBdUI7SUFFbEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUEwQztRQUNsRixLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sWUFBWSxHQUFHLHFCQUFxQixDQUFDLEtBQUssQ0FBQyxZQUFZLElBQUksU0FBUyxDQUFDLENBQUM7UUFDNUUsTUFBTSxvQkFBb0IsR0FBRyxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLElBQUksZUFBZSxDQUFDLENBQUM7UUFDaEcsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDcEMsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFFcEQsTUFBTSxrQkFBa0IsR0FBRyxTQUFTLEtBQUssVUFBVTtlQUM5QyxTQUFTLENBQUMsYUFBYTtlQUN2QixTQUFTLENBQUMsbUJBQW1CLEtBQUssU0FBUztlQUMzQyxTQUFTLENBQUMsb0JBQW9CLEtB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QUcsR0FBRyxHQUFHLElBQUksVUFBVSxFQUFFLENBQUM7SUFDL0IsQ0FBQztJQUNELE9BQU8sR0FBRyxDQUFDO0FBQ2IsQ0FBQztBQUVELFNBQVMsbUJBQW1CLENBQUMsVUFBa0IsRUFBRSxJQUF5QjtJQUN4RSxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsVUFBVSxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLE9BQU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDaEUsTUFBTSxRQUFRLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQyxRQUFRLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztJQUN2RSxJQUFJLENBQUMsUUFBUTtRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQzNCLElBQUksSUFBSSxLQUFLLFFBQVE7UUFBRSxPQUFPLEVBQUUsQ0FBQztJQUNqQyxNQUFNLE1BQU0sR0FBRyxJQUFJLFFBQVEsRUFBRSxDQUFDO0lBQzlCLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO1FBQzFCLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDdkMsQ0FBQztJQUNELE9BQU8sSUFBSSxDQUFDO0FBQ2QsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IGNvbGxhcHNlUmVwZWF0ZWRDaGFyLCB0cmltUmVwZWF0ZWRDaGFyLCB0cmltUmVwZWF0ZWRDaGFyRW5kIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwSW5nZXN0aW9uRW5kcG9pbnREb21haW5PcHRpb25zIHtcbiAgLyoqXG4gICAqIFRoZSBjdXN0b20gZG9tYWluIG5hbWUgKGZvciBleGFtcGxlIGBpbmdlc3QuZXhhbXBsZS5jb21gKS5cbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLlxuICAgKiBQcm92aWRlIGVpdGhlciBgY2VydGlmaWNhdGVgIG9yIGBjZXJ0aWZpY2F0ZUFybmAuXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGBjZXJ0aWZpY2F0ZWAgb3IgYGNlcnRpZmljYXRlQXJuYC5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBhdXRvbWF0aWMgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICogSWYgcHJvdmlkZWQsIGEgQ05BTUUgcmVjb3JkIHdpbGwgYmUgY3JlYXRlZCBwb2ludGluZyB0byB0aGUgQVBJIEdhdGV3YXkgZG9tYWluLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBUEkgbWFwcGluZyBrZXkgdW5kZXIgdGhlIGN1c3RvbSBkb21haW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYmFzZVBhdGg/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50U3RhZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUuXG4gICAqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUuXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQgZm9yIHRoZSBzdGFnZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwSW5nZXN0aW9uRW5kcG9pbnRQcm9wcyB7XG4gIC8qKlxuICAgKiBMYW1iZGEgZnVuY3Rpb24gdGhhdCBoYW5kbGVzIHRoZSBpbmdlc3Rpb24gcmVxdWVzdC5cbiAgICovXG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIExhbWJkYSByZXF1ZXN0IGF1dGhvcml6ZXIgdXNlZCBmb3Igc2VjcmV0LWtleSB2YWxpZGF0aW9uLlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplcjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQVBJIG5hbWUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogSFRUUFMgcGF0aCBleHBvc2VkIGJ5IHRoZSBlbmRwb2ludC5cbiAgICogQGRlZmF1bHQgXCIvaW5nZXN0XCJcbiAgICovXG4gIHJlYWRvbmx5IGVuZHBvaW50UGF0aD86IHN0cmluZztcblxuICAvKipcbiAgICogSGVhZGVyIHVzZWQgYXMgdGhlIGlkZW50aXR5IHNvdXJjZSBmb3Igc2VjcmV0LWtleSBhdXRob3JpemF0aW9uLlxuICAgKiBUaGlzIGRlZmF1bHRzIHRvIGBBdXRob3JpemF0aW9uYCB0byBtaXJyb3IgdGhlIGJhY2tvZmZpY2UtYXBpLWF1dGhvcml6ZXIgcGF0dGVybi5cbiAgICogQGRlZmF1bHQgXCJBdXRob3JpemF0aW9uXCJcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJIZWFkZXJOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGcmllbmRseSBhdXRob3JpemVyIG5hbWUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExhbWJkYSBhdXRob3JpemVyIHJlc3VsdCBjYWNoZSBUVEwuXG4gICAqIERlZmF1bHRzIHRvIGRpc2FibGVkIHRvIG1hdGNoIHRoZSB1cHN0cmVhbSBiYWNrb2ZmaWNlLWFwaS1hdXRob3JpemVyIGJlaGF2aW9yLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5zZWNvbmRzKDApXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyQ2FjaGVUdGw/OiBEdXJhdGlvbjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgY3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUh0dHBJbmdlc3Rpb25FbmRwb2ludERvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIHN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlIdHRwSW5nZXN0aW9uRW5kcG9pbnRTdGFnZU9wdGlvbnM7XG59XG5cbi8qKlxuICogQXV0aGVudGljYXRlZCBIVFRQUyBpbmdlc3Rpb24gZW5kcG9pbnQgYmFja2VkIGJ5IExhbWJkYS5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBpcyBpbnRlbmRlZCBmb3Igc2VydmVyLXRvLXNlcnZlciBzdWJtaXNzaW9uIHBhdGhzIHdoZXJlIGNhbGxlcnNcbiAqIGF1dGhlbnRpY2F0ZSB3aXRoIGEgc2hhcmVkIHNlY3JldCBrZXkgdmlhIGEgTGFtYmRhIHJlcXVlc3QgYXV0aG9yaXplci5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUh0dHBJbmdlc3Rpb25FbmRwb2ludCBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHJvdXRlQXV0aG9yaXplcjogYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFBdXRob3JpemVyO1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcbiAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlnd3YyLklTdGFnZTtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBkb21haW5OYW1lPzogYXBpZ3d2Mi5Eb21haW5OYW1lO1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZztcbiAgcHVibGljIHJlYWRvbmx5IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50UHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3QgZW5kcG9pbnRQYXRoID0gbm9ybWFsaXplRW5kcG9pbnRQYXRoKHByb3BzLmVuZHBvaW50UGF0aCA/PyBcIi9pbmdlc3RcIik7XG4gICAgY29uc3QgYXV0aG9yaXplckhlYWRlck5hbWUgPSBub3JtYWxpemVIZWFkZXJOYW1lKHByb3BzLmF1dGhvcml6ZXJIZWFkZXJOYW1lID8/IFwiQXV0aG9yaXphdGlvblwiKTtcbiAgICBjb25zdCBzdGFnZU9wdHMgPSBwcm9wcy5zdGFnZSA/PyB7fTtcbiAgICBjb25zdCBzdGFnZU5hbWUgPSBzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIjtcblxuICAgIGNvbnN0IG5lZWRzRXhwbGljaXRTdGFnZSA9IHN0YWdlTmFtZSAhPT0gXCIkZGVmYXVsdFwiXG4gICAgICB8fCBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZ1xuICAgICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZFxuICAgICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQ7XG5cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgYXBpTmFtZTogcHJvcHMuYXBpTmFtZSxcbiAgICAgIGNyZWF0ZURlZmF1bHRTdGFnZTogIW5lZWRzRXhwbGljaXRTdGFnZSxcbiAgICB9KTtcblxuICAgIGxldCBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQ7XG4gICAgaWYgKG5lZWRzRXhwbGljaXRTdGFnZSkge1xuICAgICAgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgIHRocm90dGxlOiAoc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgcmF0ZUxpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgICAgfVxuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSk7XG5cbiAgICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgIH0pO1xuICAgICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgICAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgICBmb3JtYXQ6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICAgICAgICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgICAgICAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgICAgICAgICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgICAgICAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgICAgICAgICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgICAgICAgICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgICAgICAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gICAgICAgICAgfSksXG4gICAgICAgIH07XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHN0YWdlID0gdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIH1cblxuICAgIGlmICghc3RhZ2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBJbmdlc3Rpb25FbmRwb2ludDogZmFpbGVkIHRvIGNyZWF0ZSBBUEkgc3RhZ2VcIik7XG4gICAgfVxuICAgIHRoaXMuc3RhZ2UgPSBzdGFnZTtcblxuICAgIHRoaXMucm91dGVBdXRob3JpemVyID0gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwTGFtYmRhQXV0aG9yaXplcihcIkF1dGhvcml6ZXJcIiwgcHJvcHMuYXV0aG9yaXplciwge1xuICAgICAgYXV0aG9yaXplck5hbWU6IHByb3BzLmF1dGhvcml6ZXJOYW1lLFxuICAgICAgaWRlbnRpdHlTb3VyY2U6IFtgJHJlcXVlc3QuaGVhZGVyLiR7YXV0aG9yaXplckhlYWRlck5hbWV9YF0sXG4gICAgICByZXN1bHRzQ2FjaGVUdGw6IHByb3BzLmF1dGhvcml6ZXJDYWNoZVR0bCA/PyBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgcmVzcG9uc2VUeXBlczogW2FwaWd3djJBdXRob3JpemVycy5IdHRwTGFtYmRhUmVzcG9uc2VUeXBlLlNJTVBMRV0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogZW5kcG9pbnRQYXRoLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5QT1NUXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJJbmdlc3Rpb25IYW5kbGVyXCIsIHByb3BzLmhhbmRsZXIsIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICB9KSxcbiAgICAgIGF1dGhvcml6ZXI6IHRoaXMucm91dGVBdXRob3JpemVyLFxuICAgIH0pO1xuXG4gICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgdGhpcy5zZXR1cEN1c3RvbURvbWFpbihwcm9wcy5kb21haW4pO1xuICAgICAgdGhpcy5lbmRwb2ludCA9IGpvaW5VcmxQYXJ0cyhcbiAgICAgICAgYGh0dHBzOi8vJHtwcm9wcy5kb21haW4uZG9tYWluTmFtZX1gLFxuICAgICAgICBwcm9wcy5kb21haW4uYmFzZVBhdGgsXG4gICAgICAgIGVuZHBvaW50UGF0aCxcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGJhc2VVcmwgPSBzdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgICA/IHRoaXMuYXBpLmFwaUVuZHBvaW50XG4gICAgICAgIDogYCR7dGhpcy5hcGkuYXBpRW5kcG9pbnR9LyR7c3RhZ2VOYW1lfWA7XG4gICAgICB0aGlzLmVuZHBvaW50ID0gam9pblVybFBhcnRzKGJhc2VVcmwsIGVuZHBvaW50UGF0aCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBzZXR1cEN1c3RvbURvbWFpbihkb21haW5PcHRzOiBBcHBUaGVvcnlIdHRwSW5nZXN0aW9uRW5kcG9pbnREb21haW5PcHRpb25zKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBkb21haW5PcHRzLmNlcnRpZmljYXRlID8/IChkb21haW5PcHRzLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRcIiwgZG9tYWluT3B0cy5jZXJ0aWZpY2F0ZUFybikgYXMgYWNtLklDZXJ0aWZpY2F0ZVxuICAgICAgOiB1bmRlZmluZWQpO1xuXG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEluZ2VzdGlvbkVuZHBvaW50OiBkb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBuZXcgYXBpZ3d2Mi5Eb21haW5OYW1lKHRoaXMsIFwiRG9tYWluTmFtZVwiLCB7XG4gICAgICBkb21haW5OYW1lOiBkb21haW5PcHRzLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbk5hbWU/OiBhcGlnd3YyLkRvbWFpbk5hbWUgfSkuZG9tYWluTmFtZSA9IGRvbWFpbk5hbWU7XG5cbiAgICBjb25zdCBhcGlNYXBwaW5nID0gbmV3IGFwaWd3djIuQXBpTWFwcGluZyh0aGlzLCBcIkFwaU1hcHBpbmdcIiwge1xuICAgICAgYXBpOiB0aGlzLmFwaSxcbiAgICAgIGRvbWFpbk5hbWUsXG4gICAgICBzdGFnZTogdGhpcy5zdGFnZSxcbiAgICAgIGFwaU1hcHBpbmdLZXk6IG5vcm1hbGl6ZUJhc2VQYXRoKGRvbWFpbk9wdHMuYmFzZVBhdGgpLFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgYXBpTWFwcGluZz86IGFwaWd3djIuQXBpTWFwcGluZyB9KS5hcGlNYXBwaW5nID0gYXBpTWFwcGluZztcblxuICAgIGlmIChkb21haW5PcHRzLmhvc3RlZFpvbmUpIHtcbiAgICAgIGNvbnN0IHJlY29yZE5hbWUgPSB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk9wdHMuZG9tYWluTmFtZSwgZG9tYWluT3B0cy5ob3N0ZWRab25lKTtcbiAgICAgIGNvbnN0IHJlY29yZCA9IG5ldyByb3V0ZTUzLkNuYW1lUmVjb3JkKHRoaXMsIFwiQ25hbWVSZWNvcmRcIiwge1xuICAgICAgICB6b25lOiBkb21haW5PcHRzLmhvc3RlZFpvbmUsXG4gICAgICAgIHJlY29yZE5hbWUsXG4gICAgICAgIGRvbWFpbk5hbWU6IGRvbWFpbk5hbWUucmVnaW9uYWxEb21haW5OYW1lLFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGNuYW1lUmVjb3JkPzogcm91dGU1My5DbmFtZVJlY29yZCB9KS5jbmFtZVJlY29yZCA9IHJlY29yZDtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplRW5kcG9pbnRQYXRoKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBTdHJpbmcocGF0aCA/PyBcIlwiKS50cmltKCk7XG4gIGlmICghdHJpbW1lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBJbmdlc3Rpb25FbmRwb2ludDogZW5kcG9pbnRQYXRoIGlzIHJlcXVpcmVkXCIpO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBjb2xsYXBzZVJlcGVhdGVkQ2hhcih0cmltUmVwZWF0ZWRDaGFyKHRyaW1tZWQsIFwiL1wiKSwgXCIvXCIpO1xuICByZXR1cm4gbm9ybWFsaXplZCA/IGAvJHtub3JtYWxpemVkfWAgOiBcIi9cIjtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplSGVhZGVyTmFtZShoZWFkZXJOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gU3RyaW5nKGhlYWRlck5hbWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwSW5nZXN0aW9uRW5kcG9pbnQ6IGF1dGhvcml6ZXJIZWFkZXJOYW1lIGlzIHJlcXVpcmVkXCIpO1xuICB9XG4gIHJldHVybiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVCYXNlUGF0aChiYXNlUGF0aD86IHN0cmluZyk6IHN0cmluZyB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHRyaW1tZWQgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhiYXNlUGF0aCA/PyBcIlwiKS50cmltKCksIFwiL1wiKTtcbiAgcmV0dXJuIHRyaW1tZWQgfHwgdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBqb2luVXJsUGFydHMoYmFzZVVybDogc3RyaW5nLCAuLi5wYXJ0czogQXJyYXk8c3RyaW5nIHwgdW5kZWZpbmVkPik6IHN0cmluZyB7XG4gIGxldCBvdXQgPSB0cmltUmVwZWF0ZWRDaGFyRW5kKFN0cmluZyhiYXNlVXJsID8/IFwiXCIpLCBcIi9cIik7XG4gIGZvciAoY29uc3QgcGFydCBvZiBwYXJ0cykge1xuICAgIGNvbnN0IG5vcm1hbGl6ZWQgPSB0cmltUmVwZWF0ZWRDaGFyKFN0cmluZyhwYXJ0ID8/IFwiXCIpLnRyaW0oKSwgXCIvXCIpO1xuICAgIGlmICghbm9ybWFsaXplZCkgY29udGludWU7XG4gICAgb3V0ID0gYCR7b3V0fS8ke25vcm1hbGl6ZWR9YDtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiB0b1JvdXRlNTNSZWNvcmROYW1lKGRvbWFpbk5hbWU6IHN0cmluZywgem9uZTogcm91dGU1My5JSG9zdGVkWm9uZSk6IHN0cmluZyB7XG4gIGNvbnN0IGZxZG4gPSBTdHJpbmcoZG9tYWluTmFtZSA/PyBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwuJC8sIFwiXCIpO1xuICBjb25zdCB6b25lTmFtZSA9IFN0cmluZyh6b25lLnpvbmVOYW1lID8/IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC4kLywgXCJcIik7XG4gIGlmICghem9uZU5hbWUpIHJldHVybiBmcWRuO1xuICBpZiAoZnFkbiA9PT0gem9uZU5hbWUpIHJldHVybiBcIlwiO1xuICBjb25zdCBzdWZmaXggPSBgLiR7em9uZU5hbWV9YDtcbiAgaWYgKGZxZG4uZW5kc1dpdGgoc3VmZml4KSkge1xuICAgIHJldHVybiBmcWRuLnNsaWNlKDAsIC1zdWZmaXgubGVuZ3RoKTtcbiAgfVxuICByZXR1cm4gZnFkbjtcbn1cbiJdfQ==