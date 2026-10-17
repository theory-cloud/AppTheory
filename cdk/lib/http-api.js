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
exports.AppTheoryHttpApi = exports.AppTheoryHttpApiRouteAuthorizer = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigwv2Authorizers = __importStar(require("aws-cdk-lib/aws-apigatewayv2-authorizers"));
const apigwv2Integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const constructs_1 = require("constructs");
const api_domain_1 = require("./api-domain");
const cors_1 = require("./cors");
const route_ids_1 = require("./route-ids");
/** Gateway authorization posture for an explicit AppTheoryHttpApi route. */
var AppTheoryHttpApiRouteAuthorizer;
(function (AppTheoryHttpApiRouteAuthorizer) {
    /** AWS IAM (SigV4) on the route. */
    AppTheoryHttpApiRouteAuthorizer["IAM"] = "iam";
    /** No gateway authorizer; the runtime owns admission. */
    AppTheoryHttpApiRouteAuthorizer["NONE"] = "none";
})(AppTheoryHttpApiRouteAuthorizer || (exports.AppTheoryHttpApiRouteAuthorizer = AppTheoryHttpApiRouteAuthorizer = {}));
class AppTheoryHttpApi extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHttpApi", version: "6.2.0" };
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
        if (stageOpts.accessLogFormat !== undefined && !stageOpts.accessLogging) {
            throw new Error("AppTheoryHttpApi: stage.accessLogFormat requires stage.accessLogging");
        }
        const needsExplicitStage = stageName !== "$default"
            || stageOpts.accessLogging
            || stageOpts.throttlingRateLimit !== undefined
            || stageOpts.throttlingBurstLimit !== undefined;
        this.api = new apigwv2.HttpApi(this, "Api", {
            apiName: props.apiName,
            corsPreflight: (0, cors_1.buildCorsPreflight)(props.cors),
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
        // Every route key this construct emits, in API Gateway `METHOD path` form.
        // `routeSettings` is validated against this set so a typo is a named
        // synthesis error instead of silently ignored stage configuration.
        const emittedRouteKeys = new Set(["ANY /", "ANY /{proxy+}"]);
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
        const explicitRoutes = props.routes ?? [];
        if (explicitRoutes.length > 0) {
            this.addExplicitRoutes(explicitRoutes, props.handler, props.scopePermissionToRoute ?? true, emittedRouteKeys);
        }
        if (props.routeSettings !== undefined) {
            configureRouteSettings(stage, props.routeSettings, emittedRouteKeys);
        }
        if (props.domain) {
            this.configureDomain(props.domain);
        }
    }
    addExplicitRoutes(routes, routeHandler, scopePermissionToRoute, emittedRouteKeys) {
        const integration = new apigwv2Integrations.HttpLambdaIntegration("Explicit", routeHandler, {
            payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
            scopePermissionToRoute,
        });
        const seen = new Set();
        for (const route of routes) {
            const routePath = normalizeExplicitRoutePath(route.path);
            const configuredMethods = route.methods ?? [];
            if (configuredMethods.length === 0) {
                throw new Error(`AppTheoryHttpApi: routes entry for ${JSON.stringify(routePath)} requires at least one method`);
            }
            for (const rawMethod of configuredMethods) {
                const method = String(rawMethod).trim().toUpperCase();
                if (!EXPLICIT_ROUTE_METHODS.has(method)) {
                    throw new Error(`AppTheoryHttpApi: routes method must be one of ${[...EXPLICIT_ROUTE_METHODS].join(", ")} (got ${JSON.stringify(rawMethod)})`);
                }
                const routeId = (0, route_ids_1.semanticRouteConstructId)(method, routePath);
                if (seen.has(routeId)) {
                    throw new Error(`AppTheoryHttpApi: routes contains the duplicate route ${method} ${routePath}`);
                }
                seen.add(routeId);
                emittedRouteKeys.add(`${method} ${routePath}`);
                new apigwv2.HttpRoute(this, routeId, {
                    httpApi: this.api,
                    routeKey: apigwv2.HttpRouteKey.with(routePath, method),
                    integration,
                    authorizer: explicitRouteAuthorizer(route.authorizer),
                });
            }
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
            format: stageOpts.accessLogFormat ?? defaultAccessLogFormat(),
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
const EXPLICIT_ROUTE_METHODS = new Set([
    "ANY",
    "DELETE",
    "GET",
    "HEAD",
    "OPTIONS",
    "PATCH",
    "POST",
    "PUT",
]);
function normalizeExplicitRoutePath(value) {
    const routePath = String(value ?? "").trim();
    if (routePath === "" || !routePath.startsWith("/") || (routePath.length > 1 && routePath.endsWith("/"))) {
        throw new Error(`AppTheoryHttpApi: routes path must be an absolute path with no trailing slash (got ${JSON.stringify(value)})`);
    }
    for (const segment of routePath.slice(1).split("/")) {
        if (segment === "" || segment === "." || segment === "..") {
            throw new Error(`AppTheoryHttpApi: routes path must not contain empty or dot segments (got ${JSON.stringify(value)})`);
        }
    }
    return routePath;
}
function explicitRouteAuthorizer(posture) {
    return posture === AppTheoryHttpApiRouteAuthorizer.IAM
        ? new apigwv2Authorizers.HttpIamAuthorizer()
        : new apigwv2.HttpNoneAuthorizer();
}
function configureRouteSettings(stage, settings, emittedRouteKeys) {
    const cfnStage = stage.node.defaultChild;
    const mapped = {};
    for (const [routeKey, value] of Object.entries(settings)) {
        if (!emittedRouteKeys.has(routeKey)) {
            throw new Error(`AppTheoryHttpApi: routeSettings[${JSON.stringify(routeKey)}] does not match any route this construct emits (emitted: ${[...emittedRouteKeys].sort().map((key) => JSON.stringify(key)).join(", ")})`);
        }
        const rateLimit = value.rateLimit;
        const burstLimit = value.burstLimit;
        if (rateLimit === undefined && burstLimit === undefined) {
            throw new Error(`AppTheoryHttpApi: routeSettings[${JSON.stringify(routeKey)}] requires rateLimit or burstLimit`);
        }
        if (rateLimit !== undefined && (!Number.isFinite(rateLimit) || rateLimit <= 0)) {
            throw new Error(`AppTheoryHttpApi: routeSettings[${JSON.stringify(routeKey)}].rateLimit must be a positive finite number`);
        }
        if (burstLimit !== undefined && (!Number.isFinite(burstLimit) || burstLimit <= 0)) {
            throw new Error(`AppTheoryHttpApi: routeSettings[${JSON.stringify(routeKey)}].burstLimit must be a positive finite number`);
        }
        const entry = {};
        if (rateLimit !== undefined)
            entry["ThrottlingRateLimit"] = rateLimit;
        if (burstLimit !== undefined)
            entry["ThrottlingBurstLimit"] = burstLimit;
        mapped[routeKey] = entry;
    }
    cfnStage.routeSettings = mapped;
}
function defaultAccessLogFormat() {
    return JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        routeKey: "$context.routeKey",
        status: "$context.status",
        protocol: "$context.protocol",
        responseLength: "$context.responseLength",
        integrationLatency: "$context.integrationLatency",
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQ0Esc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMsNkNBQWtEO0FBQ2xELGlDQUE0QztBQUU1QywyQ0FBdUQ7QUFtSnZELDRFQUE0RTtBQUM1RSxJQUFZLCtCQUtYO0FBTEQsV0FBWSwrQkFBK0I7SUFDekMsb0NBQW9DO0lBQ3BDLDhDQUFXLENBQUE7SUFDWCx5REFBeUQ7SUFDekQsZ0RBQWEsQ0FBQTtBQUNmLENBQUMsRUFMVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQUsxQztBQWdJRCxNQUFhLGdCQUFpQixTQUFRLHNCQUFTOztJQUM3QixHQUFHLENBQWtCO0lBQ3JCLEtBQUssQ0FBaUI7SUFDdEIsY0FBYyxDQUFrQjtJQUNoQyxNQUFNLENBQXNCO0lBRTVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNkLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUxBQWlMLENBQ2xMLENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDcEMsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFDcEQsSUFBSSxTQUFTLENBQUMsZUFBZSxLQUFLLFNBQVMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUN4RSxNQUFNLElBQUksS0FBSyxDQUFDLHNFQUFzRSxDQUFDLENBQUM7UUFDMUYsQ0FBQztRQUNELE1B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QyxTQUFTLENBQUM7UUFDcEIsU0FBUyxFQUFFLG9CQUFvQjtRQUMvQixFQUFFLEVBQUUsNEJBQTRCO1FBQ2hDLFdBQVcsRUFBRSxzQkFBc0I7UUFDbkMsVUFBVSxFQUFFLHFCQUFxQjtRQUNqQyxRQUFRLEVBQUUsbUJBQW1CO1FBQzdCLE1BQU0sRUFBRSxpQkFBaUI7UUFDekIsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixjQUFjLEVBQUUseUJBQXlCO1FBQ3pDLGtCQUFrQixFQUFFLDZCQUE2QjtLQUNsRCxDQUFDLENBQUM7QUFDTCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgdHlwZSAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlBcGlEb21haW4gfSBmcm9tIFwiLi9hcGktZG9tYWluXCI7XG5pbXBvcnQgeyBidWlsZENvcnNQcmVmbGlnaHQgfSBmcm9tIFwiLi9jb3JzXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyB9IGZyb20gXCIuL3JlZ2lvbmFsLXdhZlwiO1xuaW1wb3J0IHsgc2VtYW50aWNSb3V0ZUNvbnN0cnVjdElkIH0gZnJvbSBcIi4vcm91dGUtaWRzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zIHtcbiAgLyoqXG4gICAqIEFsbG93ZWQgb3JpZ2lucy5cbiAgICogQGRlZmF1bHQgW1wiKlwiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dPcmlnaW5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzLlxuICAgKiBAZGVmYXVsdCBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiUEFUQ0hcIiwgXCJIRUFEXCIsIFwiT1BUSU9OU1wiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dNZXRob2RzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFsbG93ZWQgaGVhZGVycy5cbiAgICogQGRlZmF1bHQgW1wiY29udGVudC10eXBlXCIsIFwiYXV0aG9yaXphdGlvblwiLCBcIngtcmVxdWVzdC1pZFwiLCBcIngtdGVuYW50LWlkXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd0hlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogRXhwb3NlZCByZXNwb25zZSBoZWFkZXJzLlxuICAgKiBAZGVmYXVsdCBbXCJ4LXJlcXVlc3QtaWRcIl1cbiAgICovXG4gIHJlYWRvbmx5IGV4cG9zZUhlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogV2hldGhlciBicm93c2VycyBtYXkgc2VuZCBjcmVkZW50aWFscy5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFsbG93Q3JlZGVudGlhbHM/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBCcm93c2VyIHByZWZsaWdodCBjYWNoZSBkdXJhdGlvbi5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24ubWludXRlcygxMClcbiAgICovXG4gIHJlYWRvbmx5IG1heEFnZT86IER1cmF0aW9uO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zIHtcbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gbmFtZSwgZm9yIGV4YW1wbGUgYGFwaS5leGFtcGxlLmNvbWAuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIG9wdGlvbmFsIENOQU1FIHJlY29yZCBjcmVhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAvKipcbiAgICogQVBJIG1hcHBpbmcga2V5IHVuZGVyIHRoZSBjdXN0b20gZG9tYWluLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU1hcHBpbmdLZXk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0YWdlIHRvIG1hcC4gRGVmYXVsdHMgdG8gdGhpcyBjb25zdHJ1Y3QncyBzdGFnZS5cbiAgICogQGRlZmF1bHQgdGhpcy5zdGFnZVxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBhcGlnd3YyLklTdGFnZTtcblxuICAvKipcbiAgICogV2hldGhlciB0byBjcmVhdGUgYSBDTkFNRSB3aGVuIGhvc3RlZFpvbmUgaXMgcHJvdmlkZWQuXG4gICAqIEBkZWZhdWx0IHRydWUgd2hlbiBob3N0ZWRab25lIGlzIHByb3ZpZGVkXG4gICAqL1xuICByZWFkb25seSBjcmVhdGVDbmFtZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENOQU1FIHJlY29yZCBUVEwuXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLnNlY29uZHMoMzAwKVxuICAgKi9cbiAgcmVhZG9ubHkgcmVjb3JkVHRsPzogRHVyYXRpb247XG5cbiAgLyoqXG4gICAqIE11dHVhbCBUTFMgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbj86IGFwaWd3djIuTVRMU0NvbmZpZztcblxuICAvKipcbiAgICogVExTIHNlY3VyaXR5IHBvbGljeS5cbiAgICogQGRlZmF1bHQgQVBJIEdhdGV3YXkgZGVmYXVsdFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlnd3YyLlNlY3VyaXR5UG9saWN5O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMge1xuICAvKipcbiAgICogU3RhZ2UgbmFtZS5cbiAgICogQGRlZmF1bHQgXCIkZGVmYXVsdFwiXG4gICAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEVuYWJsZSBDbG91ZFdhdGNoIGFjY2VzcyBsb2dnaW5nIG9yIHByb3ZpZGUgYSBsb2cgZ3JvdXAuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbiB8IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhbiBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKlxuICAgKiBBUEkgR2F0ZXdheSB2MiBhY2Nlc3MtbG9nIGZvcm1hdC4gRGVmYXVsdHMgdG8gdGhlIEFwcFRoZW9yeSBKU09OIGZvcm1hdC5cbiAgICogVmFsaWQgb25seSB3aGVuIGBhY2Nlc3NMb2dnaW5nYCBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCB0aGUgQXBwVGhlb3J5IEpTT04gYWNjZXNzLWxvZyBmb3JtYXRcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IHN0cmluZztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQGRlcHJlY2F0ZWQgQVBJIEdhdGV3YXkgdjIgSFRUUCBBUEkgc3RhZ2VzIGFyZSBub3Qgc3VwcG9ydGVkIFdBRnYyIHJlZ2lvbmFsXG4gKiBhc3NvY2lhdGlvbiB0YXJnZXRzLiBVc2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHdpdGhcbiAqIEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyBmb3IgV0FGLXByb3RlY3RlZCBSRVNUIEFQSSBzdGFnZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVdhZk9wdGlvbnMgZXh0ZW5kcyBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMge31cblxuLyoqIEdhdGV3YXkgYXV0aG9yaXphdGlvbiBwb3N0dXJlIGZvciBhbiBleHBsaWNpdCBBcHBUaGVvcnlIdHRwQXBpIHJvdXRlLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplciB7XG4gIC8qKiBBV1MgSUFNIChTaWdWNCkgb24gdGhlIHJvdXRlLiAqL1xuICBJQU0gPSBcImlhbVwiLFxuICAvKiogTm8gZ2F0ZXdheSBhdXRob3JpemVyOyB0aGUgcnVudGltZSBvd25zIGFkbWlzc2lvbi4gKi9cbiAgTk9ORSA9IFwibm9uZVwiLFxufVxuXG4vKipcbiAqIE9uZSBleHBsaWNpdCwgc2VtYW50aWNhbGx5IGlkZW50aWZpZWQgcm91dGUgYWRkZWQgYWxvbmdzaWRlIHRoZSBjb25zdHJ1Y3Qnc1xuICogZ3JlZWR5IGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCByb3V0ZXMuXG4gKlxuICogQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSBnaXZlcyBhIGZ1bGwgbWV0aG9kK3BhdGggbWF0Y2ggcHJpb3JpdHkgb3ZlciB0aGVcbiAqIGdyZWVkeSByb3V0ZXMsIHNvIGEgbW9yZSBzcGVjaWZpYyByb3V0ZSB3aXRoIGEgc3RyaWN0ZXIgYXV0aG9yaXplciAoZm9yXG4gKiBleGFtcGxlIGBBV1NfSUFNYCkgd2lucyBmb3IgaXRzIG93biBwYXRoLiBBIHdyb25nLW1ldGhvZCByZXF1ZXN0IG9uIHN1Y2ggYVxuICogcGF0aCBmYWxscyB0aHJvdWdoIHRvIHRoZSBydW50aW1lJ3MgZmFpbC1jbG9zZWQgNDA0LzQwNSB3aGVuIHRoZSBydW50aW1lIGRvZXNcbiAqIG5vdCBkZWNsYXJlIGl0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZU9wdGlvbnMge1xuICAvKiogQWJzb2x1dGUgcm91dGUgcGF0aC4gU2VnbWVudHMgYXJlIGxpdGVyYWxzLCBge3BhcmFtZXRlcn1gLCBvciBge3Byb3h5K31gIHNlZ21lbnRzLiAqL1xuICByZWFkb25seSBwYXRoOiBzdHJpbmc7XG4gIC8qKiBIVFRQIG1ldGhvZHMgd2lyZWQgZm9yIHRoZSByb3V0ZSwgZm9yIGV4YW1wbGUgYFtcIkdFVFwiXWAgb3IgYFtcIkFOWVwiXWAuICovXG4gIHJlYWRvbmx5IG1ldGhvZHM6IHN0cmluZ1tdO1xuICAvKipcbiAgICogR2F0ZXdheSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIHRoZSByb3V0ZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5OT05FXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyPzogQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplcjtcbn1cblxuLyoqIFJvdXRlLWxldmVsIHRocm90dGxpbmcgYXBwbGllZCB0byBvbmUgQVBJIEdhdGV3YXkgcm91dGUga2V5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVUaHJvdHRsaW5nIHtcbiAgLyoqIFJlcXVlc3RzIHBlciBzZWNvbmQgZm9yIHRoZSByb3V0ZSBrZXkuIEBkZWZhdWx0IHRoZSBzdGFnZSBkZWZhdWx0ICovXG4gIHJlYWRvbmx5IHJhdGVMaW1pdD86IG51bWJlcjtcbiAgLyoqIEJ1cnN0IGxpbWl0IGZvciB0aGUgcm91dGUga2V5LiBAZGVmYXVsdCB0aGUgc3RhZ2UgZGVmYXVsdCAqL1xuICByZWFkb25seSBidXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciByb3V0ZSBmYW1pbGllcyB0aGF0IHNoYXJlIG9uZVxuICAgKiBMYW1iZGEsIHdoZXJlIHRoZSBwZXItcm91dGUgcGVybWlzc2lvbnMgY2FuIGV4aGF1c3QgdGhlIExhbWJkYSByZXNvdXJjZSBwb2xpY3kgc2l6ZVxuICAgKiBsaW1pdC5cbiAgICpcbiAgICogVGhlIHRyYWRlLW9mZiBpcyBleHBsaWNpdDogdGhlIEFQSS1zY29wZWQgcGVybWlzc2lvbiBhbGxvd3MgZXZlcnkgcm91dGUgb24gdGhhdCBIVFRQIEFQSVxuICAgKiB0byBpbnZva2UgdGhlIGhhbmRsZXIsIG5vdCBvbmx5IHRoZSByb3V0ZXMgdGhpcyBjb25zdHJ1Y3Qgb3ducy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENPUlMgY29uZmlndXJhdGlvbi4gU2V0IHRvIHRydWUgZm9yIEFwcFRoZW9yeSBkZWZhdWx0cy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucztcblxuICAvKipcbiAgICogRXhwbGljaXQsIHNlbWFudGljYWxseSBpZGVudGlmaWVkIHJvdXRlcyBhZGRlZCBhbG9uZ3NpZGUgdGhlIGNvbnN0cnVjdCdzXG4gICAqIGdyZWVkeSBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAgcm91dGVzLlxuICAgKlxuICAgKiBVc2UgdGhpcyB3aGVyZSBhIHN0cmljdGVyIHBlci1wYXRoIGdhdGV3YXkgcG9zdHVyZSAoZm9yIGV4YW1wbGVcbiAgICogYEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIuSUFNYCkgbXVzdCB3aW4gb3ZlciB0aGUgZ3JlZWR5IHJvdXRlczogYVxuICAgKiBmdWxsIG1ldGhvZCtwYXRoIG1hdGNoIG91dHJhbmtzIHRoZSBncmVlZHkgcm91dGUgYnkgQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSxcbiAgICogYW5kIGEgd3JvbmctbWV0aG9kIHJlcXVlc3Qgb24gc3VjaCBhIHBhdGggaXMgZGVuaWVkIGJ5IHRoZSBydW50aW1lIHdpdGggdGhlXG4gICAqIGZhaWwtY2xvc2VkIDQwNC80MDUgZW52ZWxvcGUuXG4gICAqXG4gICAqIFJvdXRlIGNvbnN0cnVjdCBpZHMgYXJlIGRlcml2ZWQgZnJvbSB0aGUgbWV0aG9kIGFuZCBwYXRoLCBzbyBpbnNlcnRpbmcsXG4gICAqIHJlbW92aW5nLCBvciByZW9yZGVyaW5nIGFuIGVudHJ5IG5ldmVyIHJlbmFtZXMgYW4gdW5yZWxhdGVkIHJvdXRlLlxuICAgKlxuICAgKiBBIGRlY2xhcmVkIGBPUFRJT05TYCByb3V0ZSBjb2V4aXN0cyB3aXRoLCBhbmQgY2FuIGJlIHNoYWRvd2VkIGJ5LCB0aGVcbiAgICogQVBJLWxldmVsIENPUlMgY29uZmlndXJhdGlvbiBgY29yc2AgaW5zdGFsbHMuIGBidWlsZENvcnNQcmVmbGlnaHRgIGluY2x1ZGVzXG4gICAqIGBPUFRJT05TYCBpbiBpdHMgZGVmYXVsdCBgYWxsb3dNZXRob2RzYCwgYW5kIHdoaWxlIGBPUFRJT05TYCBpcyBpbiB0aGF0XG4gICAqIGxpc3QgQVBJIEdhdGV3YXkgYW5zd2VycyBtYXRjaGluZyBwcmVmbGlnaHQgcmVxdWVzdHMgaXRzZWxmIGJlZm9yZSB0aGVcbiAgICogcm91dGUgaW50ZWdyYXRpb24gcnVucywgc28gYSBkZWNsYXJlZCBgT1BUSU9OU2Agcm91dGUgb24gdGhlIHNhbWUgcGF0aCBpc1xuICAgKiBuZXZlciByZWFjaGVkLiBTZXR0aW5nIGBjb3JzLmFsbG93TWV0aG9kc2Agd2l0aG91dCBgT1BUSU9OU2AgcmVtb3ZlcyBnYXRld2F5XG4gICAqIHByZWZsaWdodCBoYW5kbGluZyBlbnRpcmVseTsgYSBkZWNsYXJlZCBgT1BUSU9OU2Agcm91dGUgaXMgdGhlbiB0aGUgb25seVxuICAgKiB0aGluZyB0aGF0IGFuc3dlcnMgYSBwcmVmbGlnaHQgcmVxdWVzdCwgYW5kIGl0IGlzIHN1YmplY3QgdG8gdGhhdCByb3V0ZSdzXG4gICAqIG93biBhdXRob3JpemVyLiBEZWNsYXJlIHRoZSBtZXRob2RzIHlvdSBuZWVkIGluIGBjb3JzLmFsbG93TWV0aG9kc2AgcmF0aGVyXG4gICAqIHRoYW4gZGVwZW5kaW5nIG9uIGEgZGVjbGFyZWQgYE9QVElPTlNgIHJvdXRlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlcz86IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZU9wdGlvbnNbXTtcblxuICAvKipcbiAgICogUm91dGUtbGV2ZWwgdGhyb3R0bGluZyBrZXllZCBieSBBUEkgR2F0ZXdheSByb3V0ZSBrZXkgKGZvciBleGFtcGxlXG4gICAqIGBcIkFOWSAve3Byb3h5K31cImApLiBBcHBsaWVkIHRvIHRoZSBzdGFnZSdzIHJvdXRlIHNldHRpbmdzLlxuICAgKlxuICAgKiBFdmVyeSBrZXkgaXMgdmFsaWRhdGVkIGF0IHN5bnRoZXNpcyB0aW1lIGFnYWluc3QgdGhlIHJvdXRlIGtleXMgdGhpc1xuICAgKiBjb25zdHJ1Y3QgZW1pdHMg4oCUIHRoZSBncmVlZHkgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gIHJvdXRlcyBwbHVzIG9uZVxuICAgKiBgPE1FVEhPRD4gPHBhdGg+YCBrZXkgcGVyIGByb3V0ZXNgIGVudHJ5LiBBIGtleSB0aGF0IG1hdGNoZXMgbm8gZW1pdHRlZFxuICAgKiByb3V0ZSBmYWlscyBzeW50aGVzaXMgd2l0aCBhIG5hbWVkIGVycm9yIGxpc3RpbmcgdGhlIGVtaXR0ZWQga2V5cywgcmF0aGVyXG4gICAqIHRoYW4gYmVpbmcgc2lsZW50bHkgaWdub3JlZCBieSBBUEkgR2F0ZXdheS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb3V0ZVNldHRpbmdzPzogeyBbcm91dGVLZXk6IHN0cmluZ106IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZVRocm90dGxpbmcgfTtcblxuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBXaGVuIGBkb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGlzIHNldCwgQXBwVGhlb3J5IGZhaWxzIGNsb3NlZCBhbmRcbiAgICogZGlzYWJsZXMgdGhlIGRlZmF1bHQgYGV4ZWN1dGUtYXBpYCBlbmRwb2ludCBzbyB0aGUgQVBJIGlzIHJlYWNoYWJsZSBvbmx5XG4gICAqIHRocm91Z2ggdGhlIG11dHVhbC1UTFMgY3VzdG9tIGRvbWFpbi4gV2l0aG91dCBtdXR1YWwgVExTIHRoZSBkZWZhdWx0XG4gICAqIGVuZHBvaW50IGtlZXBzIHRoZSBBV1MgZGVmYXVsdCAoZW5hYmxlZCksIHNvIG9yZGluYXJ5IGN1c3RvbSBkb21haW5zIGFyZVxuICAgKiB1bmFmZmVjdGVkLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucztcblxuICAvKipcbiAgICogUmVnaW9uYWwgV0FGIGF0dGFjaG1lbnQgaXMgaW50ZW50aW9uYWxseSB1bmF2YWlsYWJsZSBmb3IgQVBJIEdhdGV3YXkgdjJcbiAgICogSFRUUCBBUElzLiBTdXBwbHlpbmcgdGhpcyBwcm9wIGZhaWxzIGNsb3NlZCBkdXJpbmcgc3ludGhlc2lzIGluc3RlYWQgb2ZcbiAgICogcHJvZHVjaW5nIGFuIHVuc3VwcG9ydGVkIGAvYXBpcy8uLi4vc3RhZ2VzLy4uLmAgV2ViQUNMIGFzc29jaWF0aW9uLlxuICAgKlxuICAgKiBVc2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHdoZW4gYSBXQUYtcHJvdGVjdGVkIEFQSVxuICAgKiBHYXRld2F5IHN0YWdlIGlzIHJlcXVpcmVkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICogQGRlcHJlY2F0ZWQgSFRUUCBBUEkgV0FGIGFzc29jaWF0aW9uIGlzIHVuc3VwcG9ydGVkIGJ5IEFXUyBXQUZ2Mi5cbiAgICovXG4gIHJlYWRvbmx5IHdhZj86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpV2FmT3B0aW9ucztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUh0dHBBcGkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2U7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlIdHRwQXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzLndhZikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeUh0dHBBcGkgZG9lcyBub3Qgc3VwcG9ydCBXQUZ2MiByZWdpb25hbCBXZWJBQ0wgYXNzb2NpYXRpb25zIGZvciBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSXM7IHVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgZm9yIFdBRi1wcm90ZWN0ZWQgUkVTVCBzdGFnZXNcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCI7XG4gICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQgIT09IHVuZGVmaW5lZCAmJiAhc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGk6IHN0YWdlLmFjY2Vzc0xvZ0Zvcm1hdCByZXF1aXJlcyBzdGFnZS5hY2Nlc3NMb2dnaW5nXCIpO1xuICAgIH1cbiAgICBjb25zdCBuZWVkc0V4cGxpY2l0U3RhZ2UgPSBzdGFnZU5hbWUgIT09IFwiJGRlZmF1bHRcIlxuICAgICAgfHwgc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmdcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkO1xuXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgICBjb3JzUHJlZmxpZ2h0OiBidWlsZENvcnNQcmVmbGlnaHQocHJvcHMuY29ycyksXG4gICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6ICFuZWVkc0V4cGxpY2l0U3RhZ2UsXG4gICAgICBkaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50OiBwcm9wcy5kb21haW4/Lm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uICE9PSB1bmRlZmluZWQgPyB0cnVlIDogdW5kZWZpbmVkLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhZ2UgPSBuZWVkc0V4cGxpY2l0U3RhZ2VcbiAgICAgID8gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICAgIHRocm90dGxlOiAoc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgfSlcbiAgICAgIDogdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIGlmICghc3RhZ2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGk6IGZhaWxlZCB0byBjcmVhdGUgQVBJIHN0YWdlXCIpO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlID0gc3RhZ2U7XG4gICAgdGhpcy5jb25maWd1cmVBY2Nlc3NMb2dnaW5nKHN0YWdlT3B0cywgc3RhZ2UpO1xuXG4gICAgLy8gRXZlcnkgcm91dGUga2V5IHRoaXMgY29uc3RydWN0IGVtaXRzLCBpbiBBUEkgR2F0ZXdheSBgTUVUSE9EIHBhdGhgIGZvcm0uXG4gICAgLy8gYHJvdXRlU2V0dGluZ3NgIGlzIHZhbGlkYXRlZCBhZ2FpbnN0IHRoaXMgc2V0IHNvIGEgdHlwbyBpcyBhIG5hbWVkXG4gICAgLy8gc3ludGhlc2lzIGVycm9yIGluc3RlYWQgb2Ygc2lsZW50bHkgaWdub3JlZCBzdGFnZSBjb25maWd1cmF0aW9uLlxuICAgIGNvbnN0IGVtaXR0ZWRSb3V0ZUtleXMgPSBuZXcgU2V0KFtcIkFOWSAvXCIsIFwiQU5ZIC97cHJveHkrfVwiXSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIvXCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWV0sXG4gICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiUm9vdFwiLCBwcm9wcy5oYW5kbGVyLCB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBcIi97cHJveHkrfVwiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5BTlldLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIlByb3h5XCIsIHByb3BzLmhhbmRsZXIsIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZXhwbGljaXRSb3V0ZXMgPSBwcm9wcy5yb3V0ZXMgPz8gW107XG4gICAgaWYgKGV4cGxpY2l0Um91dGVzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRoaXMuYWRkRXhwbGljaXRSb3V0ZXMoZXhwbGljaXRSb3V0ZXMsIHByb3BzLmhhbmRsZXIsIHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSwgZW1pdHRlZFJvdXRlS2V5cyk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5yb3V0ZVNldHRpbmdzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbmZpZ3VyZVJvdXRlU2V0dGluZ3Moc3RhZ2UsIHByb3BzLnJvdXRlU2V0dGluZ3MsIGVtaXR0ZWRSb3V0ZUtleXMpO1xuICAgIH1cblxuICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgIHRoaXMuY29uZmlndXJlRG9tYWluKHByb3BzLmRvbWFpbik7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhZGRFeHBsaWNpdFJvdXRlcyhcbiAgICByb3V0ZXM6IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZU9wdGlvbnNbXSxcbiAgICByb3V0ZUhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogYm9vbGVhbixcbiAgICBlbWl0dGVkUm91dGVLZXlzOiBTZXQ8c3RyaW5nPixcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJFeHBsaWNpdFwiLCByb3V0ZUhhbmRsZXIsIHtcbiAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSxcbiAgICB9KTtcbiAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCByb3V0ZSBvZiByb3V0ZXMpIHtcbiAgICAgIGNvbnN0IHJvdXRlUGF0aCA9IG5vcm1hbGl6ZUV4cGxpY2l0Um91dGVQYXRoKHJvdXRlLnBhdGgpO1xuICAgICAgY29uc3QgY29uZmlndXJlZE1ldGhvZHMgPSByb3V0ZS5tZXRob2RzID8/IFtdO1xuICAgICAgaWYgKGNvbmZpZ3VyZWRNZXRob2RzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBlbnRyeSBmb3IgJHtKU09OLnN0cmluZ2lmeShyb3V0ZVBhdGgpfSByZXF1aXJlcyBhdCBsZWFzdCBvbmUgbWV0aG9kYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgcmF3TWV0aG9kIG9mIGNvbmZpZ3VyZWRNZXRob2RzKSB7XG4gICAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhyYXdNZXRob2QpLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICBpZiAoIUVYUExJQ0lUX1JPVVRFX01FVEhPRFMuaGFzKG1ldGhvZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIG1ldGhvZCBtdXN0IGJlIG9uZSBvZiAke1suLi5FWFBMSUNJVF9ST1VURV9NRVRIT0RTXS5qb2luKFwiLCBcIil9IChnb3QgJHtKU09OLnN0cmluZ2lmeShyYXdNZXRob2QpfSlgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgcm91dGVJZCA9IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZChtZXRob2QsIHJvdXRlUGF0aCk7XG4gICAgICAgIGlmIChzZWVuLmhhcyhyb3V0ZUlkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgY29udGFpbnMgdGhlIGR1cGxpY2F0ZSByb3V0ZSAke21ldGhvZH0gJHtyb3V0ZVBhdGh9YCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHNlZW4uYWRkKHJvdXRlSWQpO1xuICAgICAgICBlbWl0dGVkUm91dGVLZXlzLmFkZChgJHttZXRob2R9ICR7cm91dGVQYXRofWApO1xuICAgICAgICBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgcm91dGVJZCwge1xuICAgICAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgIHJvdXRlS2V5OiBhcGlnd3YyLkh0dHBSb3V0ZUtleS53aXRoKHJvdXRlUGF0aCwgbWV0aG9kIGFzIGFwaWd3djIuSHR0cE1ldGhvZCksXG4gICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgYXV0aG9yaXplcjogZXhwbGljaXRSb3V0ZUF1dGhvcml6ZXIocm91dGUuYXV0aG9yaXplciksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY29uZmlndXJlQWNjZXNzTG9nZ2luZyhzdGFnZU9wdHM6IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMsIHN0YWdlOiBhcGlnd3YyLklTdGFnZSk6IHZvaWQge1xuICAgIGlmICghc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBsb2dHcm91cCA9IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlXG4gICAgICA/IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgIH0pXG4gICAgICA6IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nO1xuICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgZm9ybWF0OiBzdGFnZU9wdHMuYWNjZXNzTG9nRm9ybWF0ID8/IGRlZmF1bHRBY2Nlc3NMb2dGb3JtYXQoKSxcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVEb21haW4ob3B0aW9uczogQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnMpOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG9wdGlvbnMuY2VydGlmaWNhdGUgPz8gKG9wdGlvbnMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydGlmaWNhdGVcIiwgb3B0aW9ucy5jZXJ0aWZpY2F0ZUFybilcbiAgICAgIDogdW5kZWZpbmVkKTtcbiAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpIGRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIik7XG4gICAgfVxuXG4gICAgY29uc3QgZG9tYWluID0gbmV3IEFwcFRoZW9yeUFwaURvbWFpbih0aGlzLCBcIkRvbWFpblwiLCB7XG4gICAgICBkb21haW5OYW1lOiBvcHRpb25zLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgc3RhZ2U6IG9wdGlvbnMuc3RhZ2UgPz8gdGhpcy5zdGFnZSxcbiAgICAgIGhvc3RlZFpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgIGFwaU1hcHBpbmdLZXk6IG9wdGlvbnMuYXBpTWFwcGluZ0tleSxcbiAgICAgIGNyZWF0ZUNuYW1lOiBvcHRpb25zLmNyZWF0ZUNuYW1lLFxuICAgICAgcmVjb3JkVHRsOiBvcHRpb25zLnJlY29yZFR0bCxcbiAgICAgIG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uOiBvcHRpb25zLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uLFxuICAgICAgc2VjdXJpdHlQb2xpY3k6IG9wdGlvbnMuc2VjdXJpdHlQb2xpY3ksXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW4/OiBBcHBUaGVvcnlBcGlEb21haW4gfSkuZG9tYWluID0gZG9tYWluO1xuICB9XG59XG5cbmNvbnN0IEVYUExJQ0lUX1JPVVRFX01FVEhPRFMgPSBuZXcgU2V0KFtcbiAgXCJBTllcIixcbiAgXCJERUxFVEVcIixcbiAgXCJHRVRcIixcbiAgXCJIRUFEXCIsXG4gIFwiT1BUSU9OU1wiLFxuICBcIlBBVENIXCIsXG4gIFwiUE9TVFwiLFxuICBcIlBVVFwiLFxuXSk7XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUV4cGxpY2l0Um91dGVQYXRoKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByb3V0ZVBhdGggPSBTdHJpbmcodmFsdWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAocm91dGVQYXRoID09PSBcIlwiIHx8ICFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikgfHwgKHJvdXRlUGF0aC5sZW5ndGggPiAxICYmIHJvdXRlUGF0aC5lbmRzV2l0aChcIi9cIikpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBwYXRoIG11c3QgYmUgYW4gYWJzb2x1dGUgcGF0aCB3aXRoIG5vIHRyYWlsaW5nIHNsYXNoIChnb3QgJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9KWAsXG4gICAgKTtcbiAgfVxuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygcm91dGVQYXRoLnNsaWNlKDEpLnNwbGl0KFwiL1wiKSkge1xuICAgIGlmIChzZWdtZW50ID09PSBcIlwiIHx8IHNlZ21lbnQgPT09IFwiLlwiIHx8IHNlZ21lbnQgPT09IFwiLi5cIikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIHBhdGggbXVzdCBub3QgY29udGFpbiBlbXB0eSBvciBkb3Qgc2VnbWVudHMgKGdvdCAke0pTT04uc3RyaW5naWZ5KHZhbHVlKX0pYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiByb3V0ZVBhdGg7XG59XG5cbmZ1bmN0aW9uIGV4cGxpY2l0Um91dGVBdXRob3JpemVyKHBvc3R1cmU/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIHJldHVybiBwb3N0dXJlID09PSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLklBTVxuICAgID8gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSWFtQXV0aG9yaXplcigpXG4gICAgOiBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbn1cblxuZnVuY3Rpb24gY29uZmlndXJlUm91dGVTZXR0aW5ncyhcbiAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICBzZXR0aW5nczogeyBbcm91dGVLZXk6IHN0cmluZ106IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZVRocm90dGxpbmcgfSxcbiAgZW1pdHRlZFJvdXRlS2V5czogU2V0PHN0cmluZz4sXG4pOiB2b2lkIHtcbiAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICBjb25zdCBtYXBwZWQ6IHsgW3JvdXRlS2V5OiBzdHJpbmddOiB7IFtwcm9wZXJ0eTogc3RyaW5nXTogbnVtYmVyIH0gfSA9IHt9O1xuICBmb3IgKGNvbnN0IFtyb3V0ZUtleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHNldHRpbmdzKSkge1xuICAgIGlmICghZW1pdHRlZFJvdXRlS2V5cy5oYXMocm91dGVLZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0gZG9lcyBub3QgbWF0Y2ggYW55IHJvdXRlIHRoaXMgY29uc3RydWN0IGVtaXRzIChlbWl0dGVkOiAke1suLi5lbWl0dGVkUm91dGVLZXlzXS5zb3J0KCkubWFwKChrZXkpID0+IEpTT04uc3RyaW5naWZ5KGtleSkpLmpvaW4oXCIsIFwiKX0pYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHJhdGVMaW1pdCA9IHZhbHVlLnJhdGVMaW1pdDtcbiAgICBjb25zdCBidXJzdExpbWl0ID0gdmFsdWUuYnVyc3RMaW1pdDtcbiAgICBpZiAocmF0ZUxpbWl0ID09PSB1bmRlZmluZWQgJiYgYnVyc3RMaW1pdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0gcmVxdWlyZXMgcmF0ZUxpbWl0IG9yIGJ1cnN0TGltaXRgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJhdGVMaW1pdCAhPT0gdW5kZWZpbmVkICYmICghTnVtYmVyLmlzRmluaXRlKHJhdGVMaW1pdCkgfHwgcmF0ZUxpbWl0IDw9IDApKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0ucmF0ZUxpbWl0IG11c3QgYmUgYSBwb3NpdGl2ZSBmaW5pdGUgbnVtYmVyYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChidXJzdExpbWl0ICE9PSB1bmRlZmluZWQgJiYgKCFOdW1iZXIuaXNGaW5pdGUoYnVyc3RMaW1pdCkgfHwgYnVyc3RMaW1pdCA8PSAwKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVTZXR0aW5nc1ske0pTT04uc3RyaW5naWZ5KHJvdXRlS2V5KX1dLmJ1cnN0TGltaXQgbXVzdCBiZSBhIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJgLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZW50cnk6IHsgW3Byb3BlcnR5OiBzdHJpbmddOiBudW1iZXIgfSA9IHt9O1xuICAgIGlmIChyYXRlTGltaXQgIT09IHVuZGVmaW5lZCkgZW50cnlbXCJUaHJvdHRsaW5nUmF0ZUxpbWl0XCJdID0gcmF0ZUxpbWl0O1xuICAgIGlmIChidXJzdExpbWl0ICE9PSB1bmRlZmluZWQpIGVudHJ5W1wiVGhyb3R0bGluZ0J1cnN0TGltaXRcIl0gPSBidXJzdExpbWl0O1xuICAgIG1hcHBlZFtyb3V0ZUtleV0gPSBlbnRyeTtcbiAgfVxuICBjZm5TdGFnZS5yb3V0ZVNldHRpbmdzID0gbWFwcGVkO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0QWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICB9KTtcbn1cbiJdfQ==