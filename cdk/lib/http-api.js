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
const logical_name_1 = require("./private/logical-name");
const refuse_explicit_name_1 = require("./private/refuse-explicit-name");
const standard_logging_1 = require("./private/standard-logging");
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHttpApi", version: "7.5.0" };
    api;
    stage;
    accessLogGroup;
    domain;
    constructor(scope, id, props) {
        super(scope, id);
        if (props.waf) {
            throw new Error("AppTheoryHttpApi does not support WAFv2 regional WebACL associations for API Gateway v2 HTTP APIs; use AppTheoryRestApi or AppTheoryRestApiRouter for WAF-protected REST stages");
        }
        const configuredStageOpts = props.stage ?? {};
        const stageOpts = effectiveStageOptions(configuredStageOpts, props.namingContext);
        const stageName = stageOpts.stageName ?? "$default";
        if (stageOpts.accessLogFormat !== undefined && !stageOpts.accessLogging) {
            throw new Error("AppTheoryHttpApi: stage.accessLogFormat requires stage.accessLogging");
        }
        const namingContext = props.namingContext;
        const logical = props.logicalName ?? (namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryHttpApi", "apiName", "api_http", logical, props.apiName !== undefined);
        const derivedApiName = namingContext && logical ? namingContext.physicalName("api_http", logical) : undefined;
        const needsExplicitStage = stageName !== "$default"
            || stageOpts.accessLogging
            || stageOpts.throttlingRateLimit !== undefined
            || stageOpts.throttlingBurstLimit !== undefined;
        this.api = new apigwv2.HttpApi(this, "Api", {
            apiName: derivedApiName && !derivedApiName.generated ? derivedApiName.name : props.apiName,
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
        this.configureAccessLogging(stageOpts, stage, namingContext, logical);
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
            this.configureDomain(props.domain, props.namingContext);
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
    configureAccessLogging(stageOpts, stage, namingContext, logical) {
        if (!stageOpts.accessLogging) {
            return;
        }
        const standard = namingContext?.standardLogging === true;
        if (standard && !logical) {
            throw new Error("AppTheoryHttpApi standard logging requires a logical name");
        }
        let logGroup;
        if (stageOpts.accessLogging === true) {
            // The construct-created access-log group is a logging resource: under the
            // standard profile it takes the contract log-source name, and under the
            // legacy profile it keeps today's CloudFormation-generated name and
            // consumes no naming entry (r3, ADV-1312-1).
            logGroup = standard && logical
                ? new logs.LogGroup(this, "AccessLogs", {
                    logGroupName: namingContext.logGroupName(`logs/access/api/${logical}`),
                    retention: (0, standard_logging_1.retentionFor)(namingContext.retentionDays),
                })
                : new logs.LogGroup(this, "AccessLogs", {
                    retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
                });
        }
        else {
            logGroup = stageOpts.accessLogging;
        }
        this.accessLogGroup = logGroup;
        const cfnStage = stage.node.defaultChild;
        cfnStage.accessLogSettings = {
            destinationArn: logGroup.logGroupArn,
            format: stageOpts.accessLogFormat ?? (standard ? (0, standard_logging_1.httpApiAccessLogFormat)() : defaultAccessLogFormat()),
        };
    }
    configureDomain(options, namingContext) {
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
            namingContext,
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
    if (posture === undefined) {
        return new apigwv2.HttpNoneAuthorizer();
    }
    switch (posture) {
        case AppTheoryHttpApiRouteAuthorizer.IAM:
            return new apigwv2Authorizers.HttpIamAuthorizer();
        case AppTheoryHttpApiRouteAuthorizer.NONE:
            return new apigwv2.HttpNoneAuthorizer();
        default:
            throw new Error(`AppTheoryHttpApi: routes authorizer must be AppTheoryHttpApiRouteAuthorizer.IAM or .NONE (got ${JSON.stringify(posture)})`);
    }
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
/**
 * Apply the standard logging profile's default-on access logging. An explicit
 * `accessLogging` value, including `false`, always wins.
 */
function effectiveStageOptions(stage, namingContext) {
    if (namingContext?.standardLogging === true && stage.accessLogging === undefined) {
        return { ...stage, accessLogging: true };
    }
    return stage;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQ0Esc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSxpRUFBa0Y7QUFHbEYsNkNBQWtEO0FBQ2xELGlDQUE0QztBQUU1QywyQ0FBdUQ7QUFtSnZELDRFQUE0RTtBQUM1RSxJQUFZLCtCQUtYO0FBTEQsV0FBWSwrQkFBK0I7SUFDekMsb0NBQW9DO0lBQ3BDLDhDQUFXLENBQUE7SUFDWCx5REFBeUQ7SUFDekQsZ0RBQWEsQ0FBQTtBQUNmLENBQUMsRUFMVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQUsxQztBQTBKRCxNQUFhLGdCQUFpQixTQUFRLHNCQUFTOztJQUM3QixHQUFHLENBQWtCO0lBQ3JCLEtBQUssQ0FBaUI7SUFDdEIsY0FBYyxDQUFrQjtJQUNoQyxNQUFNLENBQXNCO0lBRTVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNkLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUxBQWlMLENBQ2xMLENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxtQkFBbUIsR0FBRyxLQUFLLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUM5QyxNQUFNLFNBQVMsR0FBRyxxQkFBcUIsQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbEYsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFDcEQsSUFBSSxTQUFTLENBQUMs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T0FBTyxFQUFFLEdBQUcsS0FBSyxFQUFFLGFBQWEsRUFBRSxJQUFJLEVBQUUsQ0FBQztJQUMzQyxDQUFDO0lBQ0QsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgdHlwZSAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgaHR0cEFwaUFjY2Vzc0xvZ0Zvcm1hdCwgcmV0ZW50aW9uRm9yIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdGFuZGFyZC1sb2dnaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlBcGlEb21haW4gfSBmcm9tIFwiLi9hcGktZG9tYWluXCI7XG5pbXBvcnQgeyBidWlsZENvcnNQcmVmbGlnaHQgfSBmcm9tIFwiLi9jb3JzXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyB9IGZyb20gXCIuL3JlZ2lvbmFsLXdhZlwiO1xuaW1wb3J0IHsgc2VtYW50aWNSb3V0ZUNvbnN0cnVjdElkIH0gZnJvbSBcIi4vcm91dGUtaWRzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zIHtcbiAgLyoqXG4gICAqIEFsbG93ZWQgb3JpZ2lucy5cbiAgICogQGRlZmF1bHQgW1wiKlwiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dPcmlnaW5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzLlxuICAgKiBAZGVmYXVsdCBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiUEFUQ0hcIiwgXCJIRUFEXCIsIFwiT1BUSU9OU1wiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dNZXRob2RzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFsbG93ZWQgaGVhZGVycy5cbiAgICogQGRlZmF1bHQgW1wiY29udGVudC10eXBlXCIsIFwiYXV0aG9yaXphdGlvblwiLCBcIngtcmVxdWVzdC1pZFwiLCBcIngtdGVuYW50LWlkXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd0hlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogRXhwb3NlZCByZXNwb25zZSBoZWFkZXJzLlxuICAgKiBAZGVmYXVsdCBbXCJ4LXJlcXVlc3QtaWRcIl1cbiAgICovXG4gIHJlYWRvbmx5IGV4cG9zZUhlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogV2hldGhlciBicm93c2VycyBtYXkgc2VuZCBjcmVkZW50aWFscy5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFsbG93Q3JlZGVudGlhbHM/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBCcm93c2VyIHByZWZsaWdodCBjYWNoZSBkdXJhdGlvbi5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24ubWludXRlcygxMClcbiAgICovXG4gIHJlYWRvbmx5IG1heEFnZT86IER1cmF0aW9uO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zIHtcbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gbmFtZSwgZm9yIGV4YW1wbGUgYGFwaS5leGFtcGxlLmNvbWAuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIG9wdGlvbmFsIENOQU1FIHJlY29yZCBjcmVhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAvKipcbiAgICogQVBJIG1hcHBpbmcga2V5IHVuZGVyIHRoZSBjdXN0b20gZG9tYWluLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU1hcHBpbmdLZXk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0YWdlIHRvIG1hcC4gRGVmYXVsdHMgdG8gdGhpcyBjb25zdHJ1Y3QncyBzdGFnZS5cbiAgICogQGRlZmF1bHQgdGhpcy5zdGFnZVxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBhcGlnd3YyLklTdGFnZTtcblxuICAvKipcbiAgICogV2hldGhlciB0byBjcmVhdGUgYSBDTkFNRSB3aGVuIGhvc3RlZFpvbmUgaXMgcHJvdmlkZWQuXG4gICAqIEBkZWZhdWx0IHRydWUgd2hlbiBob3N0ZWRab25lIGlzIHByb3ZpZGVkXG4gICAqL1xuICByZWFkb25seSBjcmVhdGVDbmFtZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENOQU1FIHJlY29yZCBUVEwuXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLnNlY29uZHMoMzAwKVxuICAgKi9cbiAgcmVhZG9ubHkgcmVjb3JkVHRsPzogRHVyYXRpb247XG5cbiAgLyoqXG4gICAqIE11dHVhbCBUTFMgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbj86IGFwaWd3djIuTVRMU0NvbmZpZztcblxuICAvKipcbiAgICogVExTIHNlY3VyaXR5IHBvbGljeS5cbiAgICogQGRlZmF1bHQgVExTIDEuMiB1bmRlciBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQsIG90aGVyd2lzZSB0aGUgQVBJIEdhdGV3YXkgZGVmYXVsdFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlnd3YyLlNlY3VyaXR5UG9saWN5O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMge1xuICAvKipcbiAgICogU3RhZ2UgbmFtZS5cbiAgICogQGRlZmF1bHQgXCIkZGVmYXVsdFwiXG4gICAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEVuYWJsZSBDbG91ZFdhdGNoIGFjY2VzcyBsb2dnaW5nIG9yIHByb3ZpZGUgYSBsb2cgZ3JvdXAuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbiB8IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhbiBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKlxuICAgKiBBUEkgR2F0ZXdheSB2MiBhY2Nlc3MtbG9nIGZvcm1hdC4gRGVmYXVsdHMgdG8gdGhlIEFwcFRoZW9yeSBKU09OIGZvcm1hdC5cbiAgICogVmFsaWQgb25seSB3aGVuIGBhY2Nlc3NMb2dnaW5nYCBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCB0aGUgQXBwVGhlb3J5IEpTT04gYWNjZXNzLWxvZyBmb3JtYXRcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IHN0cmluZztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQGRlcHJlY2F0ZWQgQVBJIEdhdGV3YXkgdjIgSFRUUCBBUEkgc3RhZ2VzIGFyZSBub3Qgc3VwcG9ydGVkIFdBRnYyIHJlZ2lvbmFsXG4gKiBhc3NvY2lhdGlvbiB0YXJnZXRzLiBVc2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHdpdGhcbiAqIEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyBmb3IgV0FGLXByb3RlY3RlZCBSRVNUIEFQSSBzdGFnZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVdhZk9wdGlvbnMgZXh0ZW5kcyBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMge31cblxuLyoqIEdhdGV3YXkgYXV0aG9yaXphdGlvbiBwb3N0dXJlIGZvciBhbiBleHBsaWNpdCBBcHBUaGVvcnlIdHRwQXBpIHJvdXRlLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplciB7XG4gIC8qKiBBV1MgSUFNIChTaWdWNCkgb24gdGhlIHJvdXRlLiAqL1xuICBJQU0gPSBcImlhbVwiLFxuICAvKiogTm8gZ2F0ZXdheSBhdXRob3JpemVyOyB0aGUgcnVudGltZSBvd25zIGFkbWlzc2lvbi4gKi9cbiAgTk9ORSA9IFwibm9uZVwiLFxufVxuXG4vKipcbiAqIE9uZSBleHBsaWNpdCwgc2VtYW50aWNhbGx5IGlkZW50aWZpZWQgcm91dGUgYWRkZWQgYWxvbmdzaWRlIHRoZSBjb25zdHJ1Y3Qnc1xuICogZ3JlZWR5IGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCByb3V0ZXMuXG4gKlxuICogQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSBnaXZlcyBhIGZ1bGwgbWV0aG9kK3BhdGggbWF0Y2ggcHJpb3JpdHkgb3ZlciB0aGVcbiAqIGdyZWVkeSByb3V0ZXMsIHNvIGEgbW9yZSBzcGVjaWZpYyByb3V0ZSB3aXRoIGEgc3RyaWN0ZXIgYXV0aG9yaXplciAoZm9yXG4gKiBleGFtcGxlIGBBV1NfSUFNYCkgd2lucyBmb3IgaXRzIG93biBwYXRoLiBBIHdyb25nLW1ldGhvZCByZXF1ZXN0IG9uIHN1Y2ggYVxuICogcGF0aCBmYWxscyB0aHJvdWdoIHRvIHRoZSBydW50aW1lJ3MgZmFpbC1jbG9zZWQgNDA0LzQwNSB3aGVuIHRoZSBydW50aW1lIGRvZXNcbiAqIG5vdCBkZWNsYXJlIGl0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZU9wdGlvbnMge1xuICAvKiogQWJzb2x1dGUgcm91dGUgcGF0aC4gU2VnbWVudHMgYXJlIGxpdGVyYWxzLCBge3BhcmFtZXRlcn1gLCBvciBge3Byb3h5K31gIHNlZ21lbnRzLiAqL1xuICByZWFkb25seSBwYXRoOiBzdHJpbmc7XG4gIC8qKiBIVFRQIG1ldGhvZHMgd2lyZWQgZm9yIHRoZSByb3V0ZSwgZm9yIGV4YW1wbGUgYFtcIkdFVFwiXWAgb3IgYFtcIkFOWVwiXWAuICovXG4gIHJlYWRvbmx5IG1ldGhvZHM6IHN0cmluZ1tdO1xuICAvKipcbiAgICogR2F0ZXdheSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIHRoZSByb3V0ZS5cbiAgICpcbiAgICogT21pdCBmb3IgYE5PTkVgLiBFdmVyeSBleHBsaWNpdCB2YWx1ZSBvdGhlciB0aGFuIGBJQU1gIG9yIGBOT05FYCDigJQgYW5cbiAgICogdXBwZXJjYXNlIHNwZWxsaW5nLCBhIG1pc3NwZWxsaW5nLCBgbnVsbGAsIGEgbnVtYmVyLCBhbiBvYmplY3QsIG9yIGFueVxuICAgKiB1bmNoZWNrZWQgY29uZmlndXJhdGlvbiB2YWx1ZSDigJQgZmFpbHMgc3ludGhlc2lzIGJlZm9yZSB0aGlzIHJvdXRlIGlzXG4gICAqIGVtaXR0ZWQgaW5zdGVhZCBvZiBzaWxlbnRseSBmYWxsaW5nIGJhY2sgdG8gYE5PTkVgLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLk5PTkVcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXI/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyO1xufVxuXG4vKiogUm91dGUtbGV2ZWwgdGhyb3R0bGluZyBhcHBsaWVkIHRvIG9uZSBBUEkgR2F0ZXdheSByb3V0ZSBrZXkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZVRocm90dGxpbmcge1xuICAvKiogUmVxdWVzdHMgcGVyIHNlY29uZCBmb3IgdGhlIHJvdXRlIGtleS4gQGRlZmF1bHQgdGhlIHN0YWdlIGRlZmF1bHQgKi9cbiAgcmVhZG9ubHkgcmF0ZUxpbWl0PzogbnVtYmVyO1xuICAvKiogQnVyc3QgbGltaXQgZm9yIHRoZSByb3V0ZSBrZXkuIEBkZWZhdWx0IHRoZSBzdGFnZSBkZWZhdWx0ICovXG4gIHJlYWRvbmx5IGJ1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVByb3BzIHtcbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAqXG4gICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSBBUEkgYWNjZXNzIGxvZ2dpbmcgaXMgb24gYnkgZGVmYXVsdCB0byBhXG4gICAqIGxvZyBncm91cCBuYW1lZCBgbG9ncy9hY2Nlc3MvYXBpL3tsb2dpY2FsTmFtZX1gIGNhcnJ5aW5nIHRoZSBjb250cmFjdCdzXG4gICAqIEpTT04gZmllbGQgc2V0LiBQYXNzIGBzdGFnZS5hY2Nlc3NMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dC5cbiAgICpcbiAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBBUEkncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlbiBhXG4gICAqIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciByb3V0ZSBmYW1pbGllcyB0aGF0IHNoYXJlIG9uZVxuICAgKiBMYW1iZGEsIHdoZXJlIHRoZSBwZXItcm91dGUgcGVybWlzc2lvbnMgY2FuIGV4aGF1c3QgdGhlIExhbWJkYSByZXNvdXJjZSBwb2xpY3kgc2l6ZVxuICAgKiBsaW1pdC5cbiAgICpcbiAgICogVGhlIHRyYWRlLW9mZiBpcyBleHBsaWNpdDogdGhlIEFQSS1zY29wZWQgcGVybWlzc2lvbiBhbGxvd3MgZXZlcnkgcm91dGUgb24gdGhhdCBIVFRQIEFQSVxuICAgKiB0byBpbnZva2UgdGhlIGhhbmRsZXIsIG5vdCBvbmx5IHRoZSByb3V0ZXMgdGhpcyBjb25zdHJ1Y3Qgb3ducy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENPUlMgY29uZmlndXJhdGlvbi4gU2V0IHRvIHRydWUgZm9yIEFwcFRoZW9yeSBkZWZhdWx0cy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucztcblxuICAvKipcbiAgICogRXhwbGljaXQsIHNlbWFudGljYWxseSBpZGVudGlmaWVkIHJvdXRlcyBhZGRlZCBhbG9uZ3NpZGUgdGhlIGNvbnN0cnVjdCdzXG4gICAqIGdyZWVkeSBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAgcm91dGVzLlxuICAgKlxuICAgKiBVc2UgdGhpcyB3aGVyZSBhIHN0cmljdGVyIHBlci1wYXRoIGdhdGV3YXkgcG9zdHVyZSAoZm9yIGV4YW1wbGVcbiAgICogYEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIuSUFNYCkgbXVzdCB3aW4gb3ZlciB0aGUgZ3JlZWR5IHJvdXRlczogYVxuICAgKiBmdWxsIG1ldGhvZCtwYXRoIG1hdGNoIG91dHJhbmtzIHRoZSBncmVlZHkgcm91dGUgYnkgQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSxcbiAgICogYW5kIGEgd3JvbmctbWV0aG9kIHJlcXVlc3Qgb24gc3VjaCBhIHBhdGggaXMgZGVuaWVkIGJ5IHRoZSBydW50aW1lIHdpdGggdGhlXG4gICAqIGZhaWwtY2xvc2VkIDQwNC80MDUgZW52ZWxvcGUuXG4gICAqXG4gICAqIFJvdXRlIGNvbnN0cnVjdCBpZHMgYXJlIGRlcml2ZWQgZnJvbSB0aGUgbWV0aG9kIGFuZCBwYXRoLCBzbyBpbnNlcnRpbmcsXG4gICAqIHJlbW92aW5nLCBvciByZW9yZGVyaW5nIGFuIGVudHJ5IG5ldmVyIHJlbmFtZXMgYW4gdW5yZWxhdGVkIHJvdXRlLlxuICAgKlxuICAgKiBBIGRlY2xhcmVkIGBPUFRJT05TYCByb3V0ZSBjb2V4aXN0cyB3aXRoLCBhbmQgY2FuIGJlIHNoYWRvd2VkIGJ5LCB0aGVcbiAgICogQVBJLWxldmVsIENPUlMgY29uZmlndXJhdGlvbiBgY29yc2AgaW5zdGFsbHMuIGBidWlsZENvcnNQcmVmbGlnaHRgIGluY2x1ZGVzXG4gICAqIGBPUFRJT05TYCBpbiBpdHMgZGVmYXVsdCBgYWxsb3dNZXRob2RzYCwgYW5kIHdoaWxlIGBPUFRJT05TYCBpcyBpbiB0aGF0XG4gICAqIGxpc3QgQVBJIEdhdGV3YXkgYW5zd2VycyBtYXRjaGluZyBwcmVmbGlnaHQgcmVxdWVzdHMgaXRzZWxmIGJlZm9yZSB0aGVcbiAgICogcm91dGUgaW50ZWdyYXRpb24gcnVucywgc28gYSBkZWNsYXJlZCBgT1BUSU9OU2Agcm91dGUgb24gdGhlIHNhbWUgcGF0aCBpc1xuICAgKiBuZXZlciByZWFjaGVkLiBTZXR0aW5nIGBjb3JzLmFsbG93TWV0aG9kc2Agd2l0aG91dCBgT1BUSU9OU2AgcmVtb3ZlcyBnYXRld2F5XG4gICAqIHByZWZsaWdodCBoYW5kbGluZyBlbnRpcmVseTsgYSBkZWNsYXJlZCBgT1BUSU9OU2Agcm91dGUgaXMgdGhlbiB0aGUgb25seVxuICAgKiB0aGluZyB0aGF0IGFuc3dlcnMgYSBwcmVmbGlnaHQgcmVxdWVzdCwgYW5kIGl0IGlzIHN1YmplY3QgdG8gdGhhdCByb3V0ZSdzXG4gICAqIG93biBhdXRob3JpemVyLiBEZWNsYXJlIHRoZSBtZXRob2RzIHlvdSBuZWVkIGluIGBjb3JzLmFsbG93TWV0aG9kc2AgcmF0aGVyXG4gICAqIHRoYW4gZGVwZW5kaW5nIG9uIGEgZGVjbGFyZWQgYE9QVElPTlNgIHJvdXRlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlcz86IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZU9wdGlvbnNbXTtcblxuICAvKipcbiAgICogUm91dGUtbGV2ZWwgdGhyb3R0bGluZyBrZXllZCBieSBBUEkgR2F0ZXdheSByb3V0ZSBrZXkgKGZvciBleGFtcGxlXG4gICAqIGBcIkFOWSAve3Byb3h5K31cImApLiBBcHBsaWVkIHRvIHRoZSBzdGFnZSdzIHJvdXRlIHNldHRpbmdzLlxuICAgKlxuICAgKiBFdmVyeSBrZXkgaXMgdmFsaWRhdGVkIGF0IHN5bnRoZXNpcyB0aW1lIGFnYWluc3QgdGhlIHJvdXRlIGtleXMgdGhpc1xuICAgKiBjb25zdHJ1Y3QgZW1pdHMg4oCUIHRoZSBncmVlZHkgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gIHJvdXRlcyBwbHVzIG9uZVxuICAgKiBgPE1FVEhPRD4gPHBhdGg+YCBrZXkgcGVyIGByb3V0ZXNgIGVudHJ5LiBBIGtleSB0aGF0IG1hdGNoZXMgbm8gZW1pdHRlZFxuICAgKiByb3V0ZSBmYWlscyBzeW50aGVzaXMgd2l0aCBhIG5hbWVkIGVycm9yIGxpc3RpbmcgdGhlIGVtaXR0ZWQga2V5cywgcmF0aGVyXG4gICAqIHRoYW4gYmVpbmcgc2lsZW50bHkgaWdub3JlZCBieSBBUEkgR2F0ZXdheS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb3V0ZVNldHRpbmdzPzogeyBbcm91dGVLZXk6IHN0cmluZ106IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZVRocm90dGxpbmcgfTtcblxuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBXaGVuIGBkb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGlzIHNldCwgQXBwVGhlb3J5IGZhaWxzIGNsb3NlZCBhbmRcbiAgICogZGlzYWJsZXMgdGhlIGRlZmF1bHQgYGV4ZWN1dGUtYXBpYCBlbmRwb2ludCBzbyB0aGUgQVBJIGlzIHJlYWNoYWJsZSBvbmx5XG4gICAqIHRocm91Z2ggdGhlIG11dHVhbC1UTFMgY3VzdG9tIGRvbWFpbi4gV2l0aG91dCBtdXR1YWwgVExTIHRoZSBkZWZhdWx0XG4gICAqIGVuZHBvaW50IGtlZXBzIHRoZSBBV1MgZGVmYXVsdCAoZW5hYmxlZCksIHNvIG9yZGluYXJ5IGN1c3RvbSBkb21haW5zIGFyZVxuICAgKiB1bmFmZmVjdGVkLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucztcblxuICAvKipcbiAgICogUmVnaW9uYWwgV0FGIGF0dGFjaG1lbnQgaXMgaW50ZW50aW9uYWxseSB1bmF2YWlsYWJsZSBmb3IgQVBJIEdhdGV3YXkgdjJcbiAgICogSFRUUCBBUElzLiBTdXBwbHlpbmcgdGhpcyBwcm9wIGZhaWxzIGNsb3NlZCBkdXJpbmcgc3ludGhlc2lzIGluc3RlYWQgb2ZcbiAgICogcHJvZHVjaW5nIGFuIHVuc3VwcG9ydGVkIGAvYXBpcy8uLi4vc3RhZ2VzLy4uLmAgV2ViQUNMIGFzc29jaWF0aW9uLlxuICAgKlxuICAgKiBVc2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHdoZW4gYSBXQUYtcHJvdGVjdGVkIEFQSVxuICAgKiBHYXRld2F5IHN0YWdlIGlzIHJlcXVpcmVkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICogQGRlcHJlY2F0ZWQgSFRUUCBBUEkgV0FGIGFzc29jaWF0aW9uIGlzIHVuc3VwcG9ydGVkIGJ5IEFXUyBXQUZ2Mi5cbiAgICovXG4gIHJlYWRvbmx5IHdhZj86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpV2FmT3B0aW9ucztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUh0dHBBcGkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2U7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlIdHRwQXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzLndhZikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeUh0dHBBcGkgZG9lcyBub3Qgc3VwcG9ydCBXQUZ2MiByZWdpb25hbCBXZWJBQ0wgYXNzb2NpYXRpb25zIGZvciBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSXM7IHVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgZm9yIFdBRi1wcm90ZWN0ZWQgUkVTVCBzdGFnZXNcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgY29uZmlndXJlZFN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgIGNvbnN0IHN0YWdlT3B0cyA9IGVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhjb25maWd1cmVkU3RhZ2VPcHRzLCBwcm9wcy5uYW1pbmdDb250ZXh0KTtcbiAgICBjb25zdCBzdGFnZU5hbWUgPSBzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIjtcbiAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ0Zvcm1hdCAhPT0gdW5kZWZpbmVkICYmICFzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEFwaTogc3RhZ2UuYWNjZXNzTG9nRm9ybWF0IHJlcXVpcmVzIHN0YWdlLmFjY2Vzc0xvZ2dpbmdcIik7XG4gICAgfVxuICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAobmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKG5hbWluZ0NvbnRleHQsIFwiQXBwVGhlb3J5SHR0cEFwaVwiLCBcImFwaU5hbWVcIiwgXCJhcGlfaHR0cFwiLCBsb2dpY2FsLCBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpO1xuICAgIGNvbnN0IGRlcml2ZWRBcGlOYW1lID0gbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsID8gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJhcGlfaHR0cFwiLCBsb2dpY2FsKSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBuZWVkc0V4cGxpY2l0U3RhZ2UgPSBzdGFnZU5hbWUgIT09IFwiJGRlZmF1bHRcIlxuICAgICAgfHwgc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmdcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkO1xuXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IGRlcml2ZWRBcGlOYW1lICYmICFkZXJpdmVkQXBpTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkQXBpTmFtZS5uYW1lIDogcHJvcHMuYXBpTmFtZSxcbiAgICAgIGNvcnNQcmVmbGlnaHQ6IGJ1aWxkQ29yc1ByZWZsaWdodChwcm9wcy5jb3JzKSxcbiAgICAgIGNyZWF0ZURlZmF1bHRTdGFnZTogIW5lZWRzRXhwbGljaXRTdGFnZSxcbiAgICAgIGRpc2FibGVFeGVjdXRlQXBpRW5kcG9pbnQ6IHByb3BzLmRvbWFpbj8ubXV0dWFsVGxzQXV0aGVudGljYXRpb24gIT09IHVuZGVmaW5lZCA/IHRydWUgOiB1bmRlZmluZWQsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzdGFnZSA9IG5lZWRzRXhwbGljaXRTdGFnZVxuICAgICAgPyBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICAgICAgc3RhZ2VOYW1lLFxuICAgICAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICAgICAgdGhyb3R0bGU6IChzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgcmF0ZUxpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICB9KVxuICAgICAgOiB0aGlzLmFwaS5kZWZhdWx0U3RhZ2U7XG4gICAgaWYgKCFzdGFnZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEFwaTogZmFpbGVkIHRvIGNyZWF0ZSBBUEkgc3RhZ2VcIik7XG4gICAgfVxuICAgIHRoaXMuc3RhZ2UgPSBzdGFnZTtcbiAgICB0aGlzLmNvbmZpZ3VyZUFjY2Vzc0xvZ2dpbmcoc3RhZ2VPcHRzLCBzdGFnZSwgbmFtaW5nQ29udGV4dCwgbG9naWNhbCk7XG5cbiAgICAvLyBFdmVyeSByb3V0ZSBrZXkgdGhpcyBjb25zdHJ1Y3QgZW1pdHMsIGluIEFQSSBHYXRld2F5IGBNRVRIT0QgcGF0aGAgZm9ybS5cbiAgICAvLyBgcm91dGVTZXR0aW5nc2AgaXMgdmFsaWRhdGVkIGFnYWluc3QgdGhpcyBzZXQgc28gYSB0eXBvIGlzIGEgbmFtZWRcbiAgICAvLyBzeW50aGVzaXMgZXJyb3IgaW5zdGVhZCBvZiBzaWxlbnRseSBpZ25vcmVkIHN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAgY29uc3QgZW1pdHRlZFJvdXRlS2V5cyA9IG5ldyBTZXQoW1wiQU5ZIC9cIiwgXCJBTlkgL3twcm94eSt9XCJdKTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBcIi9cIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuQU5ZXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJSb290XCIsIHByb3BzLmhhbmRsZXIsIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL3twcm94eSt9XCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWV0sXG4gICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiUHJveHlcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBleHBsaWNpdFJvdXRlcyA9IHByb3BzLnJvdXRlcyA/PyBbXTtcbiAgICBpZiAoZXhwbGljaXRSb3V0ZXMubGVuZ3RoID4gMCkge1xuICAgICAgdGhpcy5hZGRFeHBsaWNpdFJvdXRlcyhleHBsaWNpdFJvdXRlcywgcHJvcHMuaGFuZGxlciwgcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLCBlbWl0dGVkUm91dGVLZXlzKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLnJvdXRlU2V0dGluZ3MgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlndXJlUm91dGVTZXR0aW5ncyhzdGFnZSwgcHJvcHMucm91dGVTZXR0aW5ncywgZW1pdHRlZFJvdXRlS2V5cyk7XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgdGhpcy5jb25maWd1cmVEb21haW4ocHJvcHMuZG9tYWluLCBwcm9wcy5uYW1pbmdDb250ZXh0KTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFkZEV4cGxpY2l0Um91dGVzKFxuICAgIHJvdXRlczogQXBwVGhlb3J5SHR0cEFwaVJvdXRlT3B0aW9uc1tdLFxuICAgIHJvdXRlSGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBib29sZWFuLFxuICAgIGVtaXR0ZWRSb3V0ZUtleXM6IFNldDxzdHJpbmc+LFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIkV4cGxpY2l0XCIsIHJvdXRlSGFuZGxlciwge1xuICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlLFxuICAgIH0pO1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IHJvdXRlIG9mIHJvdXRlcykge1xuICAgICAgY29uc3Qgcm91dGVQYXRoID0gbm9ybWFsaXplRXhwbGljaXRSb3V0ZVBhdGgocm91dGUucGF0aCk7XG4gICAgICBjb25zdCBjb25maWd1cmVkTWV0aG9kcyA9IHJvdXRlLm1ldGhvZHMgPz8gW107XG4gICAgICBpZiAoY29uZmlndXJlZE1ldGhvZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIGVudHJ5IGZvciAke0pTT04uc3RyaW5naWZ5KHJvdXRlUGF0aCl9IHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBtZXRob2RgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCByYXdNZXRob2Qgb2YgY29uZmlndXJlZE1ldGhvZHMpIHtcbiAgICAgICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKHJhd01ldGhvZCkudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgIGlmICghRVhQTElDSVRfUk9VVEVfTUVUSE9EUy5oYXMobWV0aG9kKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgbWV0aG9kIG11c3QgYmUgb25lIG9mICR7Wy4uLkVYUExJQ0lUX1JPVVRFX01FVEhPRFNdLmpvaW4oXCIsIFwiKX0gKGdvdCAke0pTT04uc3RyaW5naWZ5KHJhd01ldGhvZCl9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByb3V0ZUlkID0gc2VtYW50aWNSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZCwgcm91dGVQYXRoKTtcbiAgICAgICAgaWYgKHNlZW4uaGFzKHJvdXRlSWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBjb250YWlucyB0aGUgZHVwbGljYXRlIHJvdXRlICR7bWV0aG9kfSAke3JvdXRlUGF0aH1gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgc2Vlbi5hZGQocm91dGVJZCk7XG4gICAgICAgIGVtaXR0ZWRSb3V0ZUtleXMuYWRkKGAke21ldGhvZH0gJHtyb3V0ZVBhdGh9YCk7XG4gICAgICAgIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCByb3V0ZUlkLCB7XG4gICAgICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocm91dGVQYXRoLCBtZXRob2QgYXMgYXBpZ3d2Mi5IdHRwTWV0aG9kKSxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICBhdXRob3JpemVyOiBleHBsaWNpdFJvdXRlQXV0aG9yaXplcihyb3V0ZS5hdXRob3JpemVyKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVBY2Nlc3NMb2dnaW5nKFxuICAgIHN0YWdlT3B0czogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucyxcbiAgICBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UsXG4gICAgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQsXG4gICAgbG9naWNhbD86IHN0cmluZyxcbiAgKTogdm9pZCB7XG4gICAgaWYgKCFzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YW5kYXJkID0gbmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlO1xuICAgIGlmIChzdGFuZGFyZCAmJiAhbG9naWNhbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEFwaSBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgbG9naWNhbCBuYW1lXCIpO1xuICAgIH1cbiAgICBsZXQgbG9nR3JvdXA6IGxvZ3MuSUxvZ0dyb3VwO1xuICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZSkge1xuICAgICAgLy8gVGhlIGNvbnN0cnVjdC1jcmVhdGVkIGFjY2Vzcy1sb2cgZ3JvdXAgaXMgYSBsb2dnaW5nIHJlc291cmNlOiB1bmRlciB0aGVcbiAgICAgIC8vIHN0YW5kYXJkIHByb2ZpbGUgaXQgdGFrZXMgdGhlIGNvbnRyYWN0IGxvZy1zb3VyY2UgbmFtZSwgYW5kIHVuZGVyIHRoZVxuICAgICAgLy8gbGVnYWN5IHByb2ZpbGUgaXQga2VlcHMgdG9kYXkncyBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZSBhbmRcbiAgICAgIC8vIGNvbnN1bWVzIG5vIG5hbWluZyBlbnRyeSAocjMsIEFEVi0xMzEyLTEpLlxuICAgICAgbG9nR3JvdXAgPSBzdGFuZGFyZCAmJiBsb2dpY2FsXG4gICAgICAgID8gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogbmFtaW5nQ29udGV4dCEubG9nR3JvdXBOYW1lKGBsb2dzL2FjY2Vzcy9hcGkvJHtsb2dpY2FsfWApLFxuICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IobmFtaW5nQ29udGV4dCEucmV0ZW50aW9uRGF5cyksXG4gICAgICAgICAgfSlcbiAgICAgICAgOiBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGxvZ0dyb3VwID0gc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmc7XG4gICAgfVxuICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgZm9ybWF0OiBzdGFnZU9wdHMuYWNjZXNzTG9nRm9ybWF0ID8/IChzdGFuZGFyZCA/IGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQoKSA6IGRlZmF1bHRBY2Nlc3NMb2dGb3JtYXQoKSksXG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgY29uZmlndXJlRG9tYWluKG9wdGlvbnM6IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zLCBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCk6IHZvaWQge1xuICAgIGNvbnN0IGNlcnRpZmljYXRlID0gb3B0aW9ucy5jZXJ0aWZpY2F0ZSA/PyAob3B0aW9ucy5jZXJ0aWZpY2F0ZUFyblxuICAgICAgPyBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0aWZpY2F0ZVwiLCBvcHRpb25zLmNlcnRpZmljYXRlQXJuKVxuICAgICAgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGkgZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBkb21haW4gPSBuZXcgQXBwVGhlb3J5QXBpRG9tYWluKHRoaXMsIFwiRG9tYWluXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IG9wdGlvbnMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZTogb3B0aW9ucy5zdGFnZSA/PyB0aGlzLnN0YWdlLFxuICAgICAgaG9zdGVkWm9uZTogb3B0aW9ucy5ob3N0ZWRab25lLFxuICAgICAgYXBpTWFwcGluZ0tleTogb3B0aW9ucy5hcGlNYXBwaW5nS2V5LFxuICAgICAgY3JlYXRlQ25hbWU6IG9wdGlvbnMuY3JlYXRlQ25hbWUsXG4gICAgICByZWNvcmRUdGw6IG9wdGlvbnMucmVjb3JkVHRsLFxuICAgICAgbXV0dWFsVGxzQXV0aGVudGljYXRpb246IG9wdGlvbnMubXV0dWFsVGxzQXV0aGVudGljYXRpb24sXG4gICAgICBzZWN1cml0eVBvbGljeTogb3B0aW9ucy5zZWN1cml0eVBvbGljeSxcbiAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW4/OiBBcHBUaGVvcnlBcGlEb21haW4gfSkuZG9tYWluID0gZG9tYWluO1xuICB9XG59XG5cbmNvbnN0IEVYUExJQ0lUX1JPVVRFX01FVEhPRFMgPSBuZXcgU2V0KFtcbiAgXCJBTllcIixcbiAgXCJERUxFVEVcIixcbiAgXCJHRVRcIixcbiAgXCJIRUFEXCIsXG4gIFwiT1BUSU9OU1wiLFxuICBcIlBBVENIXCIsXG4gIFwiUE9TVFwiLFxuICBcIlBVVFwiLFxuXSk7XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUV4cGxpY2l0Um91dGVQYXRoKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByb3V0ZVBhdGggPSBTdHJpbmcodmFsdWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAocm91dGVQYXRoID09PSBcIlwiIHx8ICFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikgfHwgKHJvdXRlUGF0aC5sZW5ndGggPiAxICYmIHJvdXRlUGF0aC5lbmRzV2l0aChcIi9cIikpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBwYXRoIG11c3QgYmUgYW4gYWJzb2x1dGUgcGF0aCB3aXRoIG5vIHRyYWlsaW5nIHNsYXNoIChnb3QgJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9KWAsXG4gICAgKTtcbiAgfVxuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygcm91dGVQYXRoLnNsaWNlKDEpLnNwbGl0KFwiL1wiKSkge1xuICAgIGlmIChzZWdtZW50ID09PSBcIlwiIHx8IHNlZ21lbnQgPT09IFwiLlwiIHx8IHNlZ21lbnQgPT09IFwiLi5cIikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIHBhdGggbXVzdCBub3QgY29udGFpbiBlbXB0eSBvciBkb3Qgc2VnbWVudHMgKGdvdCAke0pTT04uc3RyaW5naWZ5KHZhbHVlKX0pYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiByb3V0ZVBhdGg7XG59XG5cbmZ1bmN0aW9uIGV4cGxpY2l0Um91dGVBdXRob3JpemVyKHBvc3R1cmU/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIGlmIChwb3N0dXJlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gIH1cbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLklBTTpcbiAgICAgIHJldHVybiBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBJYW1BdXRob3JpemVyKCk7XG4gICAgY2FzZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLk5PTkU6XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBhdXRob3JpemVyIG11c3QgYmUgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5JQU0gb3IgLk5PTkUgKGdvdCAke0pTT04uc3RyaW5naWZ5KHBvc3R1cmUpfSlgLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb25maWd1cmVSb3V0ZVNldHRpbmdzKFxuICBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UsXG4gIHNldHRpbmdzOiB7IFtyb3V0ZUtleTogc3RyaW5nXTogQXBwVGhlb3J5SHR0cEFwaVJvdXRlVGhyb3R0bGluZyB9LFxuICBlbWl0dGVkUm91dGVLZXlzOiBTZXQ8c3RyaW5nPixcbik6IHZvaWQge1xuICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gIGNvbnN0IG1hcHBlZDogeyBbcm91dGVLZXk6IHN0cmluZ106IHsgW3Byb3BlcnR5OiBzdHJpbmddOiBudW1iZXIgfSB9ID0ge307XG4gIGZvciAoY29uc3QgW3JvdXRlS2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MpKSB7XG4gICAgaWYgKCFlbWl0dGVkUm91dGVLZXlzLmhhcyhyb3V0ZUtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XSBkb2VzIG5vdCBtYXRjaCBhbnkgcm91dGUgdGhpcyBjb25zdHJ1Y3QgZW1pdHMgKGVtaXR0ZWQ6ICR7Wy4uLmVtaXR0ZWRSb3V0ZUtleXNdLnNvcnQoKS5tYXAoKGtleSkgPT4gSlNPTi5zdHJpbmdpZnkoa2V5KSkuam9pbihcIiwgXCIpfSlgLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcmF0ZUxpbWl0ID0gdmFsdWUucmF0ZUxpbWl0O1xuICAgIGNvbnN0IGJ1cnN0TGltaXQgPSB2YWx1ZS5idXJzdExpbWl0O1xuICAgIGlmIChyYXRlTGltaXQgPT09IHVuZGVmaW5lZCAmJiBidXJzdExpbWl0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XSByZXF1aXJlcyByYXRlTGltaXQgb3IgYnVyc3RMaW1pdGAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgJiYgKCFOdW1iZXIuaXNGaW5pdGUocmF0ZUxpbWl0KSB8fCByYXRlTGltaXQgPD0gMCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XS5yYXRlTGltaXQgbXVzdCBiZSBhIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKGJ1cnN0TGltaXQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0Zpbml0ZShidXJzdExpbWl0KSB8fCBidXJzdExpbWl0IDw9IDApKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0uYnVyc3RMaW1pdCBtdXN0IGJlIGEgcG9zaXRpdmUgZmluaXRlIG51bWJlcmAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBlbnRyeTogeyBbcHJvcGVydHk6IHN0cmluZ106IG51bWJlciB9ID0ge307XG4gICAgaWYgKHJhdGVMaW1pdCAhPT0gdW5kZWZpbmVkKSBlbnRyeVtcIlRocm90dGxpbmdSYXRlTGltaXRcIl0gPSByYXRlTGltaXQ7XG4gICAgaWYgKGJ1cnN0TGltaXQgIT09IHVuZGVmaW5lZCkgZW50cnlbXCJUaHJvdHRsaW5nQnVyc3RMaW1pdFwiXSA9IGJ1cnN0TGltaXQ7XG4gICAgbWFwcGVkW3JvdXRlS2V5XSA9IGVudHJ5O1xuICB9XG4gIGNmblN0YWdlLnJvdXRlU2V0dGluZ3MgPSBtYXBwZWQ7XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHRBY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG4vKipcbiAqIEFwcGx5IHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUncyBkZWZhdWx0LW9uIGFjY2VzcyBsb2dnaW5nLiBBbiBleHBsaWNpdFxuICogYGFjY2Vzc0xvZ2dpbmdgIHZhbHVlLCBpbmNsdWRpbmcgYGZhbHNlYCwgYWx3YXlzIHdpbnMuXG4gKi9cbmZ1bmN0aW9uIGVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhcbiAgc3RhZ2U6IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMsXG4gIG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuKTogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucyB7XG4gIGlmIChuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgc3RhZ2UuYWNjZXNzTG9nZ2luZyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHsgLi4uc3RhZ2UsIGFjY2Vzc0xvZ2dpbmc6IHRydWUgfTtcbiAgfVxuICByZXR1cm4gc3RhZ2U7XG59XG4iXX0=