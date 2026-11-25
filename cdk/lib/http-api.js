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
        if (namingContext && logical) {
            // Contract section 11.4: declare the resource carrying the composed name.
            namingContext.declareName("api_http", logical, this.api);
        }
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
            if (standard && logical && namingContext) {
                // Contract section 11.4: declare the resource carrying the log-source name.
                namingContext.declareName("log_group", `logs/access/api/${logical}`, logGroup);
            }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQ0Esc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSxpRUFBa0Y7QUFHbEYsNkNBQWtEO0FBQ2xELGlDQUE0QztBQUU1QywyQ0FBdUQ7QUFtSnZELDRFQUE0RTtBQUM1RSxJQUFZLCtCQUtYO0FBTEQsV0FBWSwrQkFBK0I7SUFDekMsb0NBQW9DO0lBQ3BDLDhDQUFXLENBQUE7SUFDWCx5REFBeUQ7SUFDekQsZ0RBQWEsQ0FBQTtBQUNmLENBQUMsRUFMVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQUsxQztBQTBKRCxNQUFhLGdCQUFpQixTQUFRLHNCQUFTOztJQUM3QixHQUFHLENBQWtCO0lBQ3JCLEtBQUssQ0FBaUI7SUFDdEIsY0FBYyxDQUFrQjtJQUNoQyxNQUFNLENBQXNCO0lBRTVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNkLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUxBQWlMLENBQ2xMLENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxtQkFBbUIsR0FBRyxLQUFLLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUM5QyxNQUFNLFNBQVMsR0FBRyxxQkFBcUIsQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbEYsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFDcEQsSUFBSSxTQUFTLENBQUMsZUFBZSxLQUFLLFNBQVMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUN4RSxNQUFNLElBQUksS0FBSyxDQUFDLHNFQUFzRSxDQUFDLENBQUM7UUFDMUYsQ0FBQztRQUNELE1BQU0sYUFBYSxHQUFHLEtBQUssQ0FBQyxhQUFhLENBQUM7UUFDMUMsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsSUFBQSxpQ0FBa0IsRUFBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDNUYsSUFBQSx5Q0FBa0IsRUFBQyxhQUFhLEVBQUUsa0JBQWtCLEVBQUUsU0FBUyxFQUFFLFVBQVUsRUFBRSxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU8sS0FBSyxTQUFTLENBQUMsQ0FBQztRQUNuSCxNQUFNLGNBQWMsR0FBRyxhQUFhLElBQUksT0FBTyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsWUFBWSxDQUFDLFVBQVUsRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1FBQzlHLE1BQU0sa0JBQWtCLEdBQUcsU0FBUyxLQUFLLFVBQVU7ZUFDOUMsU0FBUyxDQUFDLGFBQWE7ZUFDdkIsU0FBUyxDQUFDLG1CQUFtQixLQUFLLFNBQVM7ZUFDM0MsU0FBUyxDQUFDLG9CQUFvQixLQUFLLFNBQVMsQ0FBQztRQUVsRCxJQUFJLENBQUMsR0FBRyxHQUFHLElBQUksT0FBTyxDQUFDLE9BQU8sQ0FBQyxJQUFJLEVBQUUsS0FBSyxFQUFFO1lBQzFDLE9BQU8sRUFBRSxjQUFjLElBQUksQ0FBQyxjQUFjLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTztZQUMxRixhQUFhLEVBQUUsSUFBQSx5QkFBa0IsRUFBQyxLQUFLLENBQUMsSUFBSSxDQUFDO1lBQzdDLGtCQUFrQixFQUFFLENBQUMsa0JBQWtCO1lBQ3ZDLHlCQUF5QixFQUFFLEtBQUssQ0FBQyxNQUFNLEVBQUUsdUJBQXVCLEtBQUssU0FBUyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFNBQVM7U0FDbEcsQ0FBQyxDQUFDO1FBQ0gsSUFBSSxhQUFhLElBQUksT0FBTyxFQUFFLENBQUM7WUFDN0IsMEVBQTBFO1lBQzFFLGFBQWEsQ0FBQyxXQUFXLENBQUMsVUFBVSxFQUFFLE9BQU8sRUFBRSxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDM0QsQ0FBQztRQUVELE1BQU0sS0FBSyxHQUFHLGtCQUFrQjtZQUM5QixDQUFDLENBQUMsSUFBSSxPQUFPLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7Z0JBQ25DLE9BQU8sRUFBRSxJQUFJLENBQUMsR0FBRztnQkFDakIsU0FBUztnQkFDVCxVQUFVLEVBQUUsSUFBSTtnQkFDaEIsUUFBUSxFQUFFLENBQUMsU0FBUyxDQUFDLG1CQUFtQixLQUFLLFNBQVMsSUFBSSxTQUFTLENBQUMsb0JBQW9CLEtBQUssU0FBUyxDQUFDO29CQUNyRyxDQUFDLENBQUM7d0JBQ0UsU0FBUyxFQUFFLFNBQVMsQ0FBQyxtQkFBbUI7d0JBQ3hDLFVBQVUsRUFBRSxTQUFTLENBQUMsb0JBQW9CO3FCQUMzQztvQkFDSCxDQUFDLENBQUMsU0FBUzthQUNkLENBQUM7WUFDSixDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxZQUFZLENBQUM7UUFDMUIsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1lBQ1gsTUFBTSxJQUFJLEtBQUssQ0FBQyw4Q0FBOEMsQ0FBQyxDQUFDO1FBQ2xFLENBQUM7UUFDRCxJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztRQUNuQixJQUFJLENBQUMsc0JBQXNCLENBQUMsU0FBUyxFQUFFLEtBQUssRUFBRSxhQUFhLEVBQUUsT0FBTyxDQUFDLENBQUM7UUFFdEUsMkVBQTJFO1FBQzNFLHFFQUFxRTtRQUNyRSxtRUFBbUU7UUFDbkUsTUFBTSxnQkFBZ0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLE9BQU8sRUFBRSxlQUFlLENBQUMsQ0FBQyxDQUFDO1FBRTdELElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDO1lBQ2pCLElBQUksRUFBRSxHQUFHO1lBQ1QsT0FBTyxFQUFFLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7WUFDakMsV0FBVyxFQUFFLElBQUksbUJBQW1CLENBQUMscUJBQXFCLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxPQUFPLEVBQUU7Z0JBQ2hGLG9CQUFvQixFQUFFLE9BQU8sQ0FBQyxvQkFBb0IsQ0FBQyxXQUFXO2dCQUM5RCxzQkFBc0IsRUFBRSxLQUFLLENBQUMsc0JBQXNCLElBQUksSUFBSTthQUM3RCxDQUFDO1NBQ0gsQ0FBQyxDQUFDO1FBRUgsSUFBSSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUM7WUFDakIsSUFBSSxFQUFFLFdBQVc7WUFDakIsT0FBTyxFQUFFLENBQUMsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUM7WUFDakMsV0FBVyxFQUFFLElBQUksbUJBQW1CLENBQUMscUJBQXFCLENBQUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPLEVBQUU7Z0JBQ2pGLG9CQUFvQixFQUFFLE9BQU8sQ0FBQyxvQkFBb0IsQ0FBQyxXQUFXO2dCQUM5RCxzQkFBc0IsRUFBRSxLQUFLLENBQUMsc0JBQXNCLElBQUksSUFBSTthQUM3RCxDQUFDO1NBQ0gsQ0FBQyxDQUFDO1FBRUgsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLE1BQU0sSUFBSSxFQUFFLENBQUM7UUFDMUMsSUFBSSxjQUFjLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzlCLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxjQUFjLEVBQUUsS0FBSyxDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUMsc0JBQXNCLElBQUksSUFBSSxFQUFFLGdCQUFnQixDQUFDLENBQUM7UUFDaEgsQ0FBQztRQUNELElBQUksS0FBSyxDQUFDLGFBQWEsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUN0QyxzQkFBc0IsQ0FBQyxLQUFLLEVBQUUsS0FBSyxDQUFDLGFBQWEsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO1FBQ3ZFLENBQUM7UUFFRCxJQUFJLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUNqQixJQUFJLENBQUMsZUFBZSxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQzFELENBQUM7SUFDSCxDQUFDO0lBRU8saUJBQWlCLENBQ3ZCLE1BQXNDLEVBQ3RDLFlBQThCLEVBQzlCLHNCQUErQixFQUMvQixnQkFBNkI7UUFFN0IsTUFBTSxXQUFXLEdBQUcsSUFBSSxtQkFBbUIsQ0FBQyxxQkFBcUIsQ0FBQyxVQUFVLEVBQUUsWUFBWSxFQUFFO1lBQzFGLG9CQUFvQixFQUFFLE9BQU8sQ0FBQyxvQkFBb0IsQ0FBQyxXQUFXO1lBQzlELHNCQUFzQjtTQUN2QixDQUFDLENBQUM7UUFDSCxNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsRUFBVSxDQUFDO1FBQy9CLEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxFQUFFLENBQUM7WUFDM0IsTUFBTSxTQUFTLEdBQUcsMEJBQTBCLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQ3pELE1BQU0saUJBQWlCLEdBQUcsS0FBSyxDQUFDLE9BQU8sSUFBSSxFQUFFLENBQUM7WUFDOUMsSUFBSSxpQkFBaUIsQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQ25DLE1BQU0sSUFBSSxLQUFLLENBQ2Isc0NBQXNDLElBQUksQ0FBQyxTQUFTLENBQUMsU0FBUyxDQUFDLCtCQUErQixDQUMvRixDQUFDO1lBQ0osQ0FBQztZQUNELEtBQUssTUFBTSxTQUFTLElBQUksaUJBQWlCLEVBQUUsQ0FBQztnQkFDMUMsTUFBTSxNQUFNLEdBQUcsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO2dCQUN0RCxJQUFJLENBQUMsc0JBQXNCLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7b0JBQ3hDLE1BQU0sSUFBSSxLQUFLLENBQ2Isa0RBQWtELENBQUMsR0FBRyxzQkFBc0IsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxJQUFJLENBQUMsU0FBUyxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQzlILENBQUM7Z0JBQ0osQ0FBQztnQkFDRCxNQUFNLE9BQU8sR0FBRyxJQUFBLG9DQUF3QixFQUFDLE1BQU0sRUFBRSxTQUFTLENBQUMsQ0FBQztnQkFDNUQsSUFBSSxJQUFJLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7b0JBQ3RCLE1BQU0sSUFBSSxLQUFLLENBQ2IseURBQXlELE1BQU0sSUFBSSxTQUFTLEVBQUUsQ0FDL0UsQ0FBQztnQkFDSixDQUFDO2dCQUNELElBQUksQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLENBQUM7Z0JBQ2xCLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxHQUFHLE1BQU0sSUFBSSxTQUFTLEVBQUUsQ0FBQyxDQUFDO2dCQUMvQyxJQUFJLE9BQU8sQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtvQkFDbkMsT0FBTyxFQUFFLElBQUksQ0FBQyxHQUFHO29CQUNqQixRQUFRLEVBQUUsT0FBTyxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsU0FBUyxFQUFFLE1BQTRCLENBQUM7b0JBQzVFLFdBQVc7b0JBQ1gsVUFBVSxFQUFFLHVCQUF1QixDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUM7aUJBQ3RELENBQUMsQ0FBQztZQUNMLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUVPLHNCQUFzQixDQUM1QixTQUF1QyxFQUN2QyxLQUFxQixFQUNyQixhQUFzQyxFQUN0QyxPQUFnQjtRQUVoQixJQUFJLENBQUMsU0FBUyxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQzdCLE9BQU87UUFDVCxDQUFDO1FBRUQsTUFBTSxRQUFRLEdBQUcsYUFBYSxFQUFFLGVBQWUsS0FBSyxJQUFJLENBQUM7UUFDekQsSUFBSSxRQUFRLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUN6QixNQUFNLElBQUksS0FBSyxDQUFDLDJEQUEyRCxDQUFDLENBQUM7UUFDL0UsQ0FBQztRQUNELElBQUksUUFBd0IsQ0FBQztRQUM3QixJQUFJLFNBQVMsQ0FBQyxhQUFhLEtBQUssSUFBSSxFQUFFLENBQUM7WUFDckMsMEVBQTBFO1lBQzFFLHdFQUF3RTtZQUN4RSxvRUFBb0U7WUFDcEUsNkNBQTZDO1lBQzdDLFFBQVEsR0FBRyxRQUFRLElBQUksT0FBTztnQkFDNUIsQ0FBQyxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO29CQUNwQyxZQUFZLEVBQUUsYUFBYyxDQUFDLFlBQVksQ0FBQyxtQkFBbUIsT0FBTyxFQUFFLENBQUM7b0JBQ3ZFLFNBQVMsRUFBRSxJQUFBLCtCQUFZLEVBQUMsYUFBYyxDQUFDLGFBQWEsQ0FBQztpQkFDdEQsQ0FBQztnQkFDSixDQUFDLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxZQUFZLEVBQUU7b0JBQ3BDLFNBQVMsRUFBRSxTQUFTLENBQUMsa0JBQWtCLElBQUksSUFBSSxDQUFDLGFBQWEsQ0FBQyxTQUFTO2lCQUN4RSxDQUFDLENBQUM7WUFDUCxJQUFJLFFBQVEsSUFBSSxPQUFPLElBQUksYUFBYSxFQUFFLENBQUM7Z0JBQ3pDLDRFQUE0RTtnQkFDNUUsYUFBYSxDQUFDLFdBQVcsQ0FBQyxXQUFXLEVBQUUsbUJBQW1CLE9BQU8sRUFBRSxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQ2pGLENBQUM7UUFDSCxDQUFDO2FBQU0sQ0FBQztZQUNOLFFBQVEsR0FBRyxTQUFTLENBQUMsYUFBYSxDQUFDO1FBQ3JDLENBQUM7UUFDQSxJQUE0QyxDQUFDLGNBQWMsR0FBRyxRQUFRLENBQUM7UUFFeEUsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxZQUFnQyxDQUFDO1FBQzdELFFBQVEsQ0FBQyxpQkFBaUIsR0FBRztZQUMzQixjQUFjLEVBQUUsUUFBUSxDQUFDLFdBQVc7WUFDcEMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxlQUFlLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUEseUNBQXNCLEdBQUUsQ0FBQyxDQUFDLENBQUMsc0JBQXNCLEVBQUUsQ0FBQztTQUN0RyxDQUFDO0lBQ0osQ0FBQztJQUVPLGVBQWUsQ0FBQyxPQUFzQyxFQUFFLGFBQXNDO1FBQ3BHLE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxXQUFXLElBQUksQ0FBQyxPQUFPLENBQUMsY0FBYztZQUNoRSxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUUsT0FBTyxDQUFDLGNBQWMsQ0FBQztZQUN6RixDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDZixJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7WUFDakIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1RUFBdUUsQ0FBQyxDQUFDO1FBQzNGLENBQUM7UUFFRCxNQUFNLE1BQU0sR0FBRyxJQUFJLCtCQUFrQixDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDcEQsVUFBVSxFQUFFLE9BQU8sQ0FBQyxVQUFVO1lBQzlCLFdBQVc7WUFDWCxPQUFPLEVBQUUsSUFBSSxDQUFDLEdBQUc7WUFDakIsS0FBSyxFQUFFLE9BQU8sQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUs7WUFDbEMsVUFBVSxFQUFFLE9BQU8sQ0FBQyxVQUFVO1lBQzlCLGFBQWEsRUFBRSxPQUFPLENBQUMsYUFBYTtZQUNwQyxXQUFXLEVBQUUsT0FBTyxDQUFDLFdBQVc7WUFDaEMsU0FBUyxFQUFFLE9BQU8sQ0FBQyxTQUFTO1lBQzVCLHVCQUF1QixFQUFFLE9BQU8sQ0FBQyx1QkFBdUI7WUFDeEQsY0FBYyxFQUFFLE9BQU8sQ0FBQyxjQUFjO1lBQ3RDLGFBQWE7U0FDZCxDQUFDLENBQUM7UUFDRixJQUF3QyxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7SUFDNUQsQ0FBQzs7QUE5TUgsNENBK01DO0FBRUQsTUFBTSxzQkFBc0IsR0FBRyxJQUFJLEdBQUcsQ0FBQztJQUNyQyxLQUFLO0lBQ0wsUUFBUTtJQUNSLEtBQUs7SUFDTCxNQUFNO0lBQ04sU0FBUztJQUNULE9BQU87SUFDUCxNQUFNO0lBQ04sS0FBSztDQUNOLENBQUMsQ0FBQztBQUVILFNBQVMsMEJBQTBCLENBQUMsS0FBYTtJQUMvQyxNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzdDLElBQUksU0FBUyxLQUFLLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxTQUFTLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUN4RyxNQUFNLElBQUksS0FBSyxDQUNiLHNGQUFzRixJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQy9HLENBQUM7SUFDSixDQUFDO0lBQ0QsS0FBSyxNQUFNLE9BQU8sSUFBSSxTQUFTLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3BELElBQUksT0FBTyxLQUFLLEVBQUUsSUFBSSxPQUFPLEtBQUssR0FBRyxJQUFJLE9BQU8sS0FBSyxJQUFJLEVBQUUsQ0FBQztZQUMxRCxNQUFNLElBQUksS0FBSyxDQUNiLDZFQUE2RSxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQ3RHLENBQUM7UUFDSixDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFFRCxTQUFTLHVCQUF1QixDQUFDLE9BQXlDO0lBQ3hFLElBQUksT0FBTyxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzFCLE9BQU8sSUFBSSxPQUFPLENBQUMsa0JBQWtCLEVBQUUsQ0FBQztJQUMxQyxDQUFDO0lBQ0QsUUFBUSxPQUFPLEVBQUUsQ0FBQztRQUNoQixLQUFLLCtCQUErQixDQUFDLEdBQUc7WUFDdEMsT0FBTyxJQUFJLGtCQUFrQixDQUFDLGlCQUFpQixFQUFFLENBQUM7UUFDcEQsS0FBSywrQkFBK0IsQ0FBQyxJQUFJO1lBQ3ZDLE9BQU8sSUFBSSxPQUFPLENBQUMsa0JBQWtCLEVBQUUsQ0FBQztRQUMxQztZQUNFLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUdBQWlHLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FDNUgsQ0FBQztJQUNOLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUyxzQkFBc0IsQ0FDN0IsS0FBcUIsRUFDckIsUUFBaUUsRUFDakUsZ0JBQTZCO0lBRTdCLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBZ0MsQ0FBQztJQUM3RCxNQUFNLE1BQU0sR0FBMkQsRUFBRSxDQUFDO0lBQzFFLEtBQUssTUFBTSxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7UUFDekQsSUFBSSxDQUFDLGdCQUFnQixDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO1lBQ3BDLE1BQU0sSUFBSSxLQUFLLENBQ2IsbUNBQW1DLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLDZEQUE2RCxDQUFDLEdBQUcsZ0JBQWdCLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FDck0sQ0FBQztRQUNKLENBQUM7UUFDRCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsU0FBUyxDQUFDO1FBQ2xDLE1BQU0sVUFBVSxHQUFHLEtBQUssQ0FBQyxVQUFVLENBQUM7UUFDcEMsSUFBSSxTQUFTLEtBQUssU0FBUyxJQUFJLFVBQVUsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUN4RCxNQUFNLElBQUksS0FBSyxDQUNiLG1DQUFtQyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxvQ0FBb0MsQ0FDaEcsQ0FBQztRQUNKLENBQUM7UUFDRCxJQUFJLFNBQVMsS0FBSyxTQUFTLElBQUksQ0FBQyxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLElBQUksU0FBUyxJQUFJLENBQUMsQ0FBQyxFQUFFLENBQUM7WUFDL0UsTUFBTSxJQUFJLEtBQUssQ0FDYixtQ0FBbUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsOENBQThDLENBQzFHLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxVQUFVLEtBQUssU0FBUyxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFVBQVUsQ0FBQyxJQUFJLFVBQVUsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQ2xGLE1BQU0sSUFBSSxLQUFLLENBQ2IsbUNBQW1DLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLCtDQUErQyxDQUMzRyxDQUFDO1FBQ0osQ0FBQztRQUNELE1BQU0sS0FBSyxHQUFtQyxFQUFFLENBQUM7UUFDakQsSUFBSSxTQUFTLEtBQUssU0FBUztZQUFFLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxHQUFHLFNBQVMsQ0FBQztRQUN0RSxJQUFJLFVBQVUsS0FBSyxTQUFTO1lBQUUsS0FBSyxDQUFDLHNCQUFzQixDQUFDLEdBQUcsVUFBVSxDQUFDO1FBQ3pFLE1BQU0sQ0FBQyxRQUFRLENBQUMsR0FBRyxLQUFLLENBQUM7SUFDM0IsQ0FBQztJQUNELFFBQVEsQ0FBQyxhQUFhLEdBQUcsTUFBTSxDQUFDO0FBQ2xDLENBQUM7QUFFRCxTQUFTLHNCQUFzQjtJQUM3QixPQUFPLElBQUksQ0FBQyxTQUFTLENBQUM7UUFDcEIsU0FBUyxFQUFFLG9CQUFvQjtRQUMvQixFQUFFLEVBQUUsNEJBQTRCO1FBQ2hDLFdBQVcsRUFBRSxzQkFBc0I7UUFDbkMsVUFBVSxFQUFFLHFCQUFxQjtRQUNqQyxRQUFRLEVBQUUsbUJBQW1CO1FBQzdCLE1BQU0sRUFBRSxpQkFBaUI7UUFDekIsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixjQUFjLEVBQUUseUJBQXlCO1FBQ3pDLGtCQUFrQixFQUFFLDZCQUE2QjtLQUNsRCxDQUFDLENBQUM7QUFDTCxDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsU0FBUyxxQkFBcUIsQ0FDNUIsS0FBbUMsRUFDbkMsYUFBc0M7SUFFdEMsSUFBSSxhQUFhLEVBQUUsZUFBZSxLQUFLLElBQUksSUFBSSxLQUFLLENBQUMsYUFBYSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQ2pGLE9BQU8sRUFBRSxHQUFHLEtBQUssRUFBRSxhQUFhLEVBQUUsSUFBSSxFQUFFLENBQUM7SUFDM0MsQ0FBQztJQUNELE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHR5cGUgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgZGVmYXVsdExvZ2ljYWxOYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2dpY2FsLW5hbWVcIjtcbmltcG9ydCB7IHJlZnVzZUV4cGxpY2l0TmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvcmVmdXNlLWV4cGxpY2l0LW5hbWVcIjtcbmltcG9ydCB7IGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQsIHJldGVudGlvbkZvciB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5QXBpRG9tYWluIH0gZnJvbSBcIi4vYXBpLWRvbWFpblwiO1xuaW1wb3J0IHsgYnVpbGRDb3JzUHJlZmxpZ2h0IH0gZnJvbSBcIi4vY29yc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMgfSBmcm9tIFwiLi9yZWdpb25hbC13YWZcIjtcbmltcG9ydCB7IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZCB9IGZyb20gXCIuL3JvdXRlLWlkc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBBbGxvd2VkIG9yaWdpbnMuXG4gICAqIEBkZWZhdWx0IFtcIipcIl1cbiAgICovXG4gIHJlYWRvbmx5IGFsbG93T3JpZ2lucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBbGxvd2VkIEhUVFAgbWV0aG9kcy5cbiAgICogQGRlZmF1bHQgW1wiR0VUXCIsIFwiUE9TVFwiLCBcIlBVVFwiLCBcIkRFTEVURVwiLCBcIlBBVENIXCIsIFwiSEVBRFwiLCBcIk9QVElPTlNcIl1cbiAgICovXG4gIHJlYWRvbmx5IGFsbG93TWV0aG9kcz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBbGxvd2VkIGhlYWRlcnMuXG4gICAqIEBkZWZhdWx0IFtcImNvbnRlbnQtdHlwZVwiLCBcImF1dGhvcml6YXRpb25cIiwgXCJ4LXJlcXVlc3QtaWRcIiwgXCJ4LXRlbmFudC1pZFwiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEV4cG9zZWQgcmVzcG9uc2UgaGVhZGVycy5cbiAgICogQGRlZmF1bHQgW1wieC1yZXF1ZXN0LWlkXCJdXG4gICAqL1xuICByZWFkb25seSBleHBvc2VIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgYnJvd3NlcnMgbWF5IHNlbmQgY3JlZGVudGlhbHMuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhbGxvd0NyZWRlbnRpYWxzPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQnJvd3NlciBwcmVmbGlnaHQgY2FjaGUgZHVyYXRpb24uXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLm1pbnV0ZXMoMTApXG4gICAqL1xuICByZWFkb25seSBtYXhBZ2U/OiBEdXJhdGlvbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBDdXN0b20gZG9tYWluIG5hbWUsIGZvciBleGFtcGxlIGBhcGkuZXhhbXBsZS5jb21gLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIHRoZSBkb21haW4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKlxuICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLlxuICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBvcHRpb25hbCBDTkFNRSByZWNvcmQgY3JlYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgLyoqXG4gICAqIEFQSSBtYXBwaW5nIGtleSB1bmRlciB0aGUgY3VzdG9tIGRvbWFpbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhcGlNYXBwaW5nS2V5Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSB0byBtYXAuIERlZmF1bHRzIHRvIHRoaXMgY29uc3RydWN0J3Mgc3RhZ2UuXG4gICAqIEBkZWZhdWx0IHRoaXMuc3RhZ2VcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogYXBpZ3d2Mi5JU3RhZ2U7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gY3JlYXRlIGEgQ05BTUUgd2hlbiBob3N0ZWRab25lIGlzIHByb3ZpZGVkLlxuICAgKiBAZGVmYXVsdCB0cnVlIHdoZW4gaG9zdGVkWm9uZSBpcyBwcm92aWRlZFxuICAgKi9cbiAgcmVhZG9ubHkgY3JlYXRlQ25hbWU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBDTkFNRSByZWNvcmQgVFRMLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5zZWNvbmRzKDMwMClcbiAgICovXG4gIHJlYWRvbmx5IHJlY29yZFR0bD86IER1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBNdXR1YWwgVExTIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbXV0dWFsVGxzQXV0aGVudGljYXRpb24/OiBhcGlnd3YyLk1UTFNDb25maWc7XG5cbiAgLyoqXG4gICAqIFRMUyBzZWN1cml0eSBwb2xpY3kuXG4gICAqIEBkZWZhdWx0IFRMUyAxLjIgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0LCBvdGhlcndpc2UgdGhlIEFQSSBHYXRld2F5IGRlZmF1bHRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3VyaXR5UG9saWN5PzogYXBpZ3d2Mi5TZWN1cml0eVBvbGljeTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpU3RhZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUuXG4gICAqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBvciBwcm92aWRlIGEgbG9nIGdyb3VwLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW4gfCBsb2dzLklMb2dHcm91cDtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3IgYW4gYXV0by1jcmVhdGVkIGFjY2VzcyBsb2cgZ3JvdXAuXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKipcbiAgICogQVBJIEdhdGV3YXkgdjIgYWNjZXNzLWxvZyBmb3JtYXQuIERlZmF1bHRzIHRvIHRoZSBBcHBUaGVvcnkgSlNPTiBmb3JtYXQuXG4gICAqIFZhbGlkIG9ubHkgd2hlbiBgYWNjZXNzTG9nZ2luZ2AgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgdGhlIEFwcFRoZW9yeSBKU09OIGFjY2Vzcy1sb2cgZm9ybWF0XG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dGb3JtYXQ/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIEBkZXByZWNhdGVkIEFQSSBHYXRld2F5IHYyIEhUVFAgQVBJIHN0YWdlcyBhcmUgbm90IHN1cHBvcnRlZCBXQUZ2MiByZWdpb25hbFxuICogYXNzb2NpYXRpb24gdGFyZ2V0cy4gVXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciB3aXRoXG4gKiBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMgZm9yIFdBRi1wcm90ZWN0ZWQgUkVTVCBBUEkgc3RhZ2VzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlXYWZPcHRpb25zIGV4dGVuZHMgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIHt9XG5cbi8qKiBHYXRld2F5IGF1dGhvcml6YXRpb24gcG9zdHVyZSBmb3IgYW4gZXhwbGljaXQgQXBwVGhlb3J5SHR0cEFwaSByb3V0ZS4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIge1xuICAvKiogQVdTIElBTSAoU2lnVjQpIG9uIHRoZSByb3V0ZS4gKi9cbiAgSUFNID0gXCJpYW1cIixcbiAgLyoqIE5vIGdhdGV3YXkgYXV0aG9yaXplcjsgdGhlIHJ1bnRpbWUgb3ducyBhZG1pc3Npb24uICovXG4gIE5PTkUgPSBcIm5vbmVcIixcbn1cblxuLyoqXG4gKiBPbmUgZXhwbGljaXQsIHNlbWFudGljYWxseSBpZGVudGlmaWVkIHJvdXRlIGFkZGVkIGFsb25nc2lkZSB0aGUgY29uc3RydWN0J3NcbiAqIGdyZWVkeSBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAgcm91dGVzLlxuICpcbiAqIEFQSSBHYXRld2F5IHByZWNlZGVuY2UgZ2l2ZXMgYSBmdWxsIG1ldGhvZCtwYXRoIG1hdGNoIHByaW9yaXR5IG92ZXIgdGhlXG4gKiBncmVlZHkgcm91dGVzLCBzbyBhIG1vcmUgc3BlY2lmaWMgcm91dGUgd2l0aCBhIHN0cmljdGVyIGF1dGhvcml6ZXIgKGZvclxuICogZXhhbXBsZSBgQVdTX0lBTWApIHdpbnMgZm9yIGl0cyBvd24gcGF0aC4gQSB3cm9uZy1tZXRob2QgcmVxdWVzdCBvbiBzdWNoIGFcbiAqIHBhdGggZmFsbHMgdGhyb3VnaCB0byB0aGUgcnVudGltZSdzIGZhaWwtY2xvc2VkIDQwNC80MDUgd2hlbiB0aGUgcnVudGltZSBkb2VzXG4gKiBub3QgZGVjbGFyZSBpdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zIHtcbiAgLyoqIEFic29sdXRlIHJvdXRlIHBhdGguIFNlZ21lbnRzIGFyZSBsaXRlcmFscywgYHtwYXJhbWV0ZXJ9YCwgb3IgYHtwcm94eSt9YCBzZWdtZW50cy4gKi9cbiAgcmVhZG9ubHkgcGF0aDogc3RyaW5nO1xuICAvKiogSFRUUCBtZXRob2RzIHdpcmVkIGZvciB0aGUgcm91dGUsIGZvciBleGFtcGxlIGBbXCJHRVRcIl1gIG9yIGBbXCJBTllcIl1gLiAqL1xuICByZWFkb25seSBtZXRob2RzOiBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIEdhdGV3YXkgYXV0aG9yaXphdGlvbiBwb3N0dXJlIGZvciB0aGUgcm91dGUuXG4gICAqXG4gICAqIE9taXQgZm9yIGBOT05FYC4gRXZlcnkgZXhwbGljaXQgdmFsdWUgb3RoZXIgdGhhbiBgSUFNYCBvciBgTk9ORWAg4oCUIGFuXG4gICAqIHVwcGVyY2FzZSBzcGVsbGluZywgYSBtaXNzcGVsbGluZywgYG51bGxgLCBhIG51bWJlciwgYW4gb2JqZWN0LCBvciBhbnlcbiAgICogdW5jaGVja2VkIGNvbmZpZ3VyYXRpb24gdmFsdWUg4oCUIGZhaWxzIHN5bnRoZXNpcyBiZWZvcmUgdGhpcyByb3V0ZSBpc1xuICAgKiBlbWl0dGVkIGluc3RlYWQgb2Ygc2lsZW50bHkgZmFsbGluZyBiYWNrIHRvIGBOT05FYC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5OT05FXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyPzogQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplcjtcbn1cblxuLyoqIFJvdXRlLWxldmVsIHRocm90dGxpbmcgYXBwbGllZCB0byBvbmUgQVBJIEdhdGV3YXkgcm91dGUga2V5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVUaHJvdHRsaW5nIHtcbiAgLyoqIFJlcXVlc3RzIHBlciBzZWNvbmQgZm9yIHRoZSByb3V0ZSBrZXkuIEBkZWZhdWx0IHRoZSBzdGFnZSBkZWZhdWx0ICovXG4gIHJlYWRvbmx5IHJhdGVMaW1pdD86IG51bWJlcjtcbiAgLyoqIEJ1cnN0IGxpbWl0IGZvciB0aGUgcm91dGUga2V5LiBAZGVmYXVsdCB0aGUgc3RhZ2UgZGVmYXVsdCAqL1xuICByZWFkb25seSBidXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgKlxuICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgQVBJIGFjY2VzcyBsb2dnaW5nIGlzIG9uIGJ5IGRlZmF1bHQgdG8gYVxuICAgKiBsb2cgZ3JvdXAgbmFtZWQgYGxvZ3MvYWNjZXNzL2FwaS97bG9naWNhbE5hbWV9YCBjYXJyeWluZyB0aGUgY29udHJhY3Qnc1xuICAgKiBKU09OIGZpZWxkIHNldC4gUGFzcyBgc3RhZ2UuYWNjZXNzTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQuXG4gICAqXG4gICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkIHdoZW4gYVxuICAgKiBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuICAvKipcbiAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBIVFRQIEFQSSB2MiByb3V0ZXMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgcm91dGUuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3Igcm91dGUgZmFtaWxpZXMgdGhhdCBzaGFyZSBvbmVcbiAgICogTGFtYmRhLCB3aGVyZSB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2UgcG9saWN5IHNpemVcbiAgICogbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBoYW5kbGVyLCBub3Qgb25seSB0aGUgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBDT1JTIGNvbmZpZ3VyYXRpb24uIFNldCB0byB0cnVlIGZvciBBcHBUaGVvcnkgZGVmYXVsdHMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgY29ycz86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0LCBzZW1hbnRpY2FsbHkgaWRlbnRpZmllZCByb3V0ZXMgYWRkZWQgYWxvbmdzaWRlIHRoZSBjb25zdHJ1Y3Qnc1xuICAgKiBncmVlZHkgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gIHJvdXRlcy5cbiAgICpcbiAgICogVXNlIHRoaXMgd2hlcmUgYSBzdHJpY3RlciBwZXItcGF0aCBnYXRld2F5IHBvc3R1cmUgKGZvciBleGFtcGxlXG4gICAqIGBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLklBTWApIG11c3Qgd2luIG92ZXIgdGhlIGdyZWVkeSByb3V0ZXM6IGFcbiAgICogZnVsbCBtZXRob2QrcGF0aCBtYXRjaCBvdXRyYW5rcyB0aGUgZ3JlZWR5IHJvdXRlIGJ5IEFQSSBHYXRld2F5IHByZWNlZGVuY2UsXG4gICAqIGFuZCBhIHdyb25nLW1ldGhvZCByZXF1ZXN0IG9uIHN1Y2ggYSBwYXRoIGlzIGRlbmllZCBieSB0aGUgcnVudGltZSB3aXRoIHRoZVxuICAgKiBmYWlsLWNsb3NlZCA0MDQvNDA1IGVudmVsb3BlLlxuICAgKlxuICAgKiBSb3V0ZSBjb25zdHJ1Y3QgaWRzIGFyZSBkZXJpdmVkIGZyb20gdGhlIG1ldGhvZCBhbmQgcGF0aCwgc28gaW5zZXJ0aW5nLFxuICAgKiByZW1vdmluZywgb3IgcmVvcmRlcmluZyBhbiBlbnRyeSBuZXZlciByZW5hbWVzIGFuIHVucmVsYXRlZCByb3V0ZS5cbiAgICpcbiAgICogQSBkZWNsYXJlZCBgT1BUSU9OU2Agcm91dGUgY29leGlzdHMgd2l0aCwgYW5kIGNhbiBiZSBzaGFkb3dlZCBieSwgdGhlXG4gICAqIEFQSS1sZXZlbCBDT1JTIGNvbmZpZ3VyYXRpb24gYGNvcnNgIGluc3RhbGxzLiBgYnVpbGRDb3JzUHJlZmxpZ2h0YCBpbmNsdWRlc1xuICAgKiBgT1BUSU9OU2AgaW4gaXRzIGRlZmF1bHQgYGFsbG93TWV0aG9kc2AsIGFuZCB3aGlsZSBgT1BUSU9OU2AgaXMgaW4gdGhhdFxuICAgKiBsaXN0IEFQSSBHYXRld2F5IGFuc3dlcnMgbWF0Y2hpbmcgcHJlZmxpZ2h0IHJlcXVlc3RzIGl0c2VsZiBiZWZvcmUgdGhlXG4gICAqIHJvdXRlIGludGVncmF0aW9uIHJ1bnMsIHNvIGEgZGVjbGFyZWQgYE9QVElPTlNgIHJvdXRlIG9uIHRoZSBzYW1lIHBhdGggaXNcbiAgICogbmV2ZXIgcmVhY2hlZC4gU2V0dGluZyBgY29ycy5hbGxvd01ldGhvZHNgIHdpdGhvdXQgYE9QVElPTlNgIHJlbW92ZXMgZ2F0ZXdheVxuICAgKiBwcmVmbGlnaHQgaGFuZGxpbmcgZW50aXJlbHk7IGEgZGVjbGFyZWQgYE9QVElPTlNgIHJvdXRlIGlzIHRoZW4gdGhlIG9ubHlcbiAgICogdGhpbmcgdGhhdCBhbnN3ZXJzIGEgcHJlZmxpZ2h0IHJlcXVlc3QsIGFuZCBpdCBpcyBzdWJqZWN0IHRvIHRoYXQgcm91dGUnc1xuICAgKiBvd24gYXV0aG9yaXplci4gRGVjbGFyZSB0aGUgbWV0aG9kcyB5b3UgbmVlZCBpbiBgY29ycy5hbGxvd01ldGhvZHNgIHJhdGhlclxuICAgKiB0aGFuIGRlcGVuZGluZyBvbiBhIGRlY2xhcmVkIGBPUFRJT05TYCByb3V0ZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb3V0ZXM/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zW107XG5cbiAgLyoqXG4gICAqIFJvdXRlLWxldmVsIHRocm90dGxpbmcga2V5ZWQgYnkgQVBJIEdhdGV3YXkgcm91dGUga2V5IChmb3IgZXhhbXBsZVxuICAgKiBgXCJBTlkgL3twcm94eSt9XCJgKS4gQXBwbGllZCB0byB0aGUgc3RhZ2UncyByb3V0ZSBzZXR0aW5ncy5cbiAgICpcbiAgICogRXZlcnkga2V5IGlzIHZhbGlkYXRlZCBhdCBzeW50aGVzaXMgdGltZSBhZ2FpbnN0IHRoZSByb3V0ZSBrZXlzIHRoaXNcbiAgICogY29uc3RydWN0IGVtaXRzIOKAlCB0aGUgZ3JlZWR5IGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCByb3V0ZXMgcGx1cyBvbmVcbiAgICogYDxNRVRIT0Q+IDxwYXRoPmAga2V5IHBlciBgcm91dGVzYCBlbnRyeS4gQSBrZXkgdGhhdCBtYXRjaGVzIG5vIGVtaXR0ZWRcbiAgICogcm91dGUgZmFpbHMgc3ludGhlc2lzIHdpdGggYSBuYW1lZCBlcnJvciBsaXN0aW5nIHRoZSBlbWl0dGVkIGtleXMsIHJhdGhlclxuICAgKiB0aGFuIGJlaW5nIHNpbGVudGx5IGlnbm9yZWQgYnkgQVBJIEdhdGV3YXkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVTZXR0aW5ncz86IHsgW3JvdXRlS2V5OiBzdHJpbmddOiBBcHBUaGVvcnlIdHRwQXBpUm91dGVUaHJvdHRsaW5nIH07XG5cbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICpcbiAgICogV2hlbiBgZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBpcyBzZXQsIEFwcFRoZW9yeSBmYWlscyBjbG9zZWQgYW5kXG4gICAqIGRpc2FibGVzIHRoZSBkZWZhdWx0IGBleGVjdXRlLWFwaWAgZW5kcG9pbnQgc28gdGhlIEFQSSBpcyByZWFjaGFibGUgb25seVxuICAgKiB0aHJvdWdoIHRoZSBtdXR1YWwtVExTIGN1c3RvbSBkb21haW4uIFdpdGhvdXQgbXV0dWFsIFRMUyB0aGUgZGVmYXVsdFxuICAgKiBlbmRwb2ludCBrZWVwcyB0aGUgQVdTIGRlZmF1bHQgKGVuYWJsZWQpLCBzbyBvcmRpbmFyeSBjdXN0b20gZG9tYWlucyBhcmVcbiAgICogdW5hZmZlY3RlZC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFJlZ2lvbmFsIFdBRiBhdHRhY2htZW50IGlzIGludGVudGlvbmFsbHkgdW5hdmFpbGFibGUgZm9yIEFQSSBHYXRld2F5IHYyXG4gICAqIEhUVFAgQVBJcy4gU3VwcGx5aW5nIHRoaXMgcHJvcCBmYWlscyBjbG9zZWQgZHVyaW5nIHN5bnRoZXNpcyBpbnN0ZWFkIG9mXG4gICAqIHByb2R1Y2luZyBhbiB1bnN1cHBvcnRlZCBgL2FwaXMvLi4uL3N0YWdlcy8uLi5gIFdlYkFDTCBhc3NvY2lhdGlvbi5cbiAgICpcbiAgICogVXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciB3aGVuIGEgV0FGLXByb3RlY3RlZCBBUElcbiAgICogR2F0ZXdheSBzdGFnZSBpcyByZXF1aXJlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqIEBkZXByZWNhdGVkIEhUVFAgQVBJIFdBRiBhc3NvY2lhdGlvbiBpcyB1bnN1cHBvcnRlZCBieSBBV1MgV0FGdjIuXG4gICAqL1xuICByZWFkb25seSB3YWY/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaVdhZk9wdGlvbnM7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlIdHRwQXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUFwaURvbWFpbjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5SHR0cEFwaVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcy53YWYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlIdHRwQXBpIGRvZXMgbm90IHN1cHBvcnQgV0FGdjIgcmVnaW9uYWwgV2ViQUNMIGFzc29jaWF0aW9ucyBmb3IgQVBJIEdhdGV3YXkgdjIgSFRUUCBBUElzOyB1c2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGZvciBXQUYtcHJvdGVjdGVkIFJFU1Qgc3RhZ2VzXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGNvbmZpZ3VyZWRTdGFnZU9wdHMgPSBwcm9wcy5zdGFnZSA/PyB7fTtcbiAgICBjb25zdCBzdGFnZU9wdHMgPSBlZmZlY3RpdmVTdGFnZU9wdGlvbnMoY29uZmlndXJlZFN0YWdlT3B0cywgcHJvcHMubmFtaW5nQ29udGV4dCk7XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCI7XG4gICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQgIT09IHVuZGVmaW5lZCAmJiAhc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGk6IHN0YWdlLmFjY2Vzc0xvZ0Zvcm1hdCByZXF1aXJlcyBzdGFnZS5hY2Nlc3NMb2dnaW5nXCIpO1xuICAgIH1cbiAgICBjb25zdCBuYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeUh0dHBBcGlcIiwgXCJhcGlOYW1lXCIsIFwiYXBpX2h0dHBcIiwgbG9naWNhbCwgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICBjb25zdCBkZXJpdmVkQXBpTmFtZSA9IG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCA/IG5hbWluZ0NvbnRleHQucGh5c2ljYWxOYW1lKFwiYXBpX2h0dHBcIiwgbG9naWNhbCkgOiB1bmRlZmluZWQ7XG4gICAgY29uc3QgbmVlZHNFeHBsaWNpdFN0YWdlID0gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBkZXJpdmVkQXBpTmFtZSAmJiAhZGVyaXZlZEFwaU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZEFwaU5hbWUubmFtZSA6IHByb3BzLmFwaU5hbWUsXG4gICAgICBjb3JzUHJlZmxpZ2h0OiBidWlsZENvcnNQcmVmbGlnaHQocHJvcHMuY29ycyksXG4gICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6ICFuZWVkc0V4cGxpY2l0U3RhZ2UsXG4gICAgICBkaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50OiBwcm9wcy5kb21haW4/Lm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uICE9PSB1bmRlZmluZWQgPyB0cnVlIDogdW5kZWZpbmVkLFxuICAgIH0pO1xuICAgIGlmIChuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwpIHtcbiAgICAgIC8vIENvbnRyYWN0IHNlY3Rpb24gMTEuNDogZGVjbGFyZSB0aGUgcmVzb3VyY2UgY2FycnlpbmcgdGhlIGNvbXBvc2VkIG5hbWUuXG4gICAgICBuYW1pbmdDb250ZXh0LmRlY2xhcmVOYW1lKFwiYXBpX2h0dHBcIiwgbG9naWNhbCwgdGhpcy5hcGkpO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YWdlID0gbmVlZHNFeHBsaWNpdFN0YWdlXG4gICAgICA/IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgICB0aHJvdHRsZTogKHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIH0pXG4gICAgICA6IHRoaXMuYXBpLmRlZmF1bHRTdGFnZTtcbiAgICBpZiAoIXN0YWdlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpOiBmYWlsZWQgdG8gY3JlYXRlIEFQSSBzdGFnZVwiKTtcbiAgICB9XG4gICAgdGhpcy5zdGFnZSA9IHN0YWdlO1xuICAgIHRoaXMuY29uZmlndXJlQWNjZXNzTG9nZ2luZyhzdGFnZU9wdHMsIHN0YWdlLCBuYW1pbmdDb250ZXh0LCBsb2dpY2FsKTtcblxuICAgIC8vIEV2ZXJ5IHJvdXRlIGtleSB0aGlzIGNvbnN0cnVjdCBlbWl0cywgaW4gQVBJIEdhdGV3YXkgYE1FVEhPRCBwYXRoYCBmb3JtLlxuICAgIC8vIGByb3V0ZVNldHRpbmdzYCBpcyB2YWxpZGF0ZWQgYWdhaW5zdCB0aGlzIHNldCBzbyBhIHR5cG8gaXMgYSBuYW1lZFxuICAgIC8vIHN5bnRoZXNpcyBlcnJvciBpbnN0ZWFkIG9mIHNpbGVudGx5IGlnbm9yZWQgc3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICBjb25zdCBlbWl0dGVkUm91dGVLZXlzID0gbmV3IFNldChbXCJBTlkgL1wiLCBcIkFOWSAve3Byb3h5K31cIl0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL1wiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5BTlldLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIlJvb3RcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIve3Byb3h5K31cIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuQU5ZXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJQcm94eVwiLCBwcm9wcy5oYW5kbGVyLCB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGV4cGxpY2l0Um91dGVzID0gcHJvcHMucm91dGVzID8/IFtdO1xuICAgIGlmIChleHBsaWNpdFJvdXRlcy5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLmFkZEV4cGxpY2l0Um91dGVzKGV4cGxpY2l0Um91dGVzLCBwcm9wcy5oYW5kbGVyLCBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsIGVtaXR0ZWRSb3V0ZUtleXMpO1xuICAgIH1cbiAgICBpZiAocHJvcHMucm91dGVTZXR0aW5ncyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25maWd1cmVSb3V0ZVNldHRpbmdzKHN0YWdlLCBwcm9wcy5yb3V0ZVNldHRpbmdzLCBlbWl0dGVkUm91dGVLZXlzKTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICB0aGlzLmNvbmZpZ3VyZURvbWFpbihwcm9wcy5kb21haW4sIHByb3BzLm5hbWluZ0NvbnRleHQpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWRkRXhwbGljaXRSb3V0ZXMoXG4gICAgcm91dGVzOiBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zW10sXG4gICAgcm91dGVIYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IGJvb2xlYW4sXG4gICAgZW1pdHRlZFJvdXRlS2V5czogU2V0PHN0cmluZz4sXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiRXhwbGljaXRcIiwgcm91dGVIYW5kbGVyLCB7XG4gICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGUsXG4gICAgfSk7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2Ygcm91dGVzKSB7XG4gICAgICBjb25zdCByb3V0ZVBhdGggPSBub3JtYWxpemVFeHBsaWNpdFJvdXRlUGF0aChyb3V0ZS5wYXRoKTtcbiAgICAgIGNvbnN0IGNvbmZpZ3VyZWRNZXRob2RzID0gcm91dGUubWV0aG9kcyA/PyBbXTtcbiAgICAgIGlmIChjb25maWd1cmVkTWV0aG9kcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgZW50cnkgZm9yICR7SlNPTi5zdHJpbmdpZnkocm91dGVQYXRoKX0gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIG1ldGhvZGAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IHJhd01ldGhvZCBvZiBjb25maWd1cmVkTWV0aG9kcykge1xuICAgICAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcocmF3TWV0aG9kKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgICAgICAgaWYgKCFFWFBMSUNJVF9ST1VURV9NRVRIT0RTLmhhcyhtZXRob2QpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBtZXRob2QgbXVzdCBiZSBvbmUgb2YgJHtbLi4uRVhQTElDSVRfUk9VVEVfTUVUSE9EU10uam9pbihcIiwgXCIpfSAoZ290ICR7SlNPTi5zdHJpbmdpZnkocmF3TWV0aG9kKX0pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJvdXRlSWQgPSBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQobWV0aG9kLCByb3V0ZVBhdGgpO1xuICAgICAgICBpZiAoc2Vlbi5oYXMocm91dGVJZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIGNvbnRhaW5zIHRoZSBkdXBsaWNhdGUgcm91dGUgJHttZXRob2R9ICR7cm91dGVQYXRofWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBzZWVuLmFkZChyb3V0ZUlkKTtcbiAgICAgICAgZW1pdHRlZFJvdXRlS2V5cy5hZGQoYCR7bWV0aG9kfSAke3JvdXRlUGF0aH1gKTtcbiAgICAgICAgbmV3IGFwaWd3djIuSHR0cFJvdXRlKHRoaXMsIHJvdXRlSWQsIHtcbiAgICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChyb3V0ZVBhdGgsIG1ldGhvZCBhcyBhcGlnd3YyLkh0dHBNZXRob2QpLFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIGF1dGhvcml6ZXI6IGV4cGxpY2l0Um91dGVBdXRob3JpemVyKHJvdXRlLmF1dGhvcml6ZXIpLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZUFjY2Vzc0xvZ2dpbmcoXG4gICAgc3RhZ2VPcHRzOiBBcHBUaGVvcnlIdHRwQXBpU3RhZ2VPcHRpb25zLFxuICAgIHN0YWdlOiBhcGlnd3YyLklTdGFnZSxcbiAgICBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCxcbiAgICBsb2dpY2FsPzogc3RyaW5nLFxuICApOiB2b2lkIHtcbiAgICBpZiAoIXN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhbmRhcmQgPSBuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWU7XG4gICAgaWYgKHN0YW5kYXJkICYmICFsb2dpY2FsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpIHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSBsb2dpY2FsIG5hbWVcIik7XG4gICAgfVxuICAgIGxldCBsb2dHcm91cDogbG9ncy5JTG9nR3JvdXA7XG4gICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlKSB7XG4gICAgICAvLyBUaGUgY29uc3RydWN0LWNyZWF0ZWQgYWNjZXNzLWxvZyBncm91cCBpcyBhIGxvZ2dpbmcgcmVzb3VyY2U6IHVuZGVyIHRoZVxuICAgICAgLy8gc3RhbmRhcmQgcHJvZmlsZSBpdCB0YWtlcyB0aGUgY29udHJhY3QgbG9nLXNvdXJjZSBuYW1lLCBhbmQgdW5kZXIgdGhlXG4gICAgICAvLyBsZWdhY3kgcHJvZmlsZSBpdCBrZWVwcyB0b2RheSdzIENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZCBuYW1lIGFuZFxuICAgICAgLy8gY29uc3VtZXMgbm8gbmFtaW5nIGVudHJ5IChyMywgQURWLTEzMTItMSkuXG4gICAgICBsb2dHcm91cCA9IHN0YW5kYXJkICYmIGxvZ2ljYWxcbiAgICAgICAgPyBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBuYW1pbmdDb250ZXh0IS5sb2dHcm91cE5hbWUoYGxvZ3MvYWNjZXNzL2FwaS8ke2xvZ2ljYWx9YCksXG4gICAgICAgICAgICByZXRlbnRpb246IHJldGVudGlvbkZvcihuYW1pbmdDb250ZXh0IS5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgICAgICB9KTtcbiAgICAgIGlmIChzdGFuZGFyZCAmJiBsb2dpY2FsICYmIG5hbWluZ0NvbnRleHQpIHtcbiAgICAgICAgLy8gQ29udHJhY3Qgc2VjdGlvbiAxMS40OiBkZWNsYXJlIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbG9nLXNvdXJjZSBuYW1lLlxuICAgICAgICBuYW1pbmdDb250ZXh0LmRlY2xhcmVOYW1lKFwibG9nX2dyb3VwXCIsIGBsb2dzL2FjY2Vzcy9hcGkvJHtsb2dpY2FsfWAsIGxvZ0dyb3VwKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgbG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICB9XG4gICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICBmb3JtYXQ6IHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQgPz8gKHN0YW5kYXJkID8gaHR0cEFwaUFjY2Vzc0xvZ0Zvcm1hdCgpIDogZGVmYXVsdEFjY2Vzc0xvZ0Zvcm1hdCgpKSxcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVEb21haW4ob3B0aW9uczogQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnMsIG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0KTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRpZmljYXRlXCIsIG9wdGlvbnMuY2VydGlmaWNhdGVBcm4pXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEFwaSBkb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGRvbWFpbiA9IG5ldyBBcHBUaGVvcnlBcGlEb21haW4odGhpcywgXCJEb21haW5cIiwge1xuICAgICAgZG9tYWluTmFtZTogb3B0aW9ucy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHN0YWdlOiBvcHRpb25zLnN0YWdlID8/IHRoaXMuc3RhZ2UsXG4gICAgICBob3N0ZWRab25lOiBvcHRpb25zLmhvc3RlZFpvbmUsXG4gICAgICBhcGlNYXBwaW5nS2V5OiBvcHRpb25zLmFwaU1hcHBpbmdLZXksXG4gICAgICBjcmVhdGVDbmFtZTogb3B0aW9ucy5jcmVhdGVDbmFtZSxcbiAgICAgIHJlY29yZFR0bDogb3B0aW9ucy5yZWNvcmRUdGwsXG4gICAgICBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbjogb3B0aW9ucy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICAgIHNlY3VyaXR5UG9saWN5OiBvcHRpb25zLnNlY3VyaXR5UG9saWN5LFxuICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbj86IEFwcFRoZW9yeUFwaURvbWFpbiB9KS5kb21haW4gPSBkb21haW47XG4gIH1cbn1cblxuY29uc3QgRVhQTElDSVRfUk9VVEVfTUVUSE9EUyA9IG5ldyBTZXQoW1xuICBcIkFOWVwiLFxuICBcIkRFTEVURVwiLFxuICBcIkdFVFwiLFxuICBcIkhFQURcIixcbiAgXCJPUFRJT05TXCIsXG4gIFwiUEFUQ0hcIixcbiAgXCJQT1NUXCIsXG4gIFwiUFVUXCIsXG5dKTtcblxuZnVuY3Rpb24gbm9ybWFsaXplRXhwbGljaXRSb3V0ZVBhdGgodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKS50cmltKCk7XG4gIGlmIChyb3V0ZVBhdGggPT09IFwiXCIgfHwgIXJvdXRlUGF0aC5zdGFydHNXaXRoKFwiL1wiKSB8fCAocm91dGVQYXRoLmxlbmd0aCA+IDEgJiYgcm91dGVQYXRoLmVuZHNXaXRoKFwiL1wiKSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIHBhdGggbXVzdCBiZSBhbiBhYnNvbHV0ZSBwYXRoIHdpdGggbm8gdHJhaWxpbmcgc2xhc2ggKGdvdCAke0pTT04uc3RyaW5naWZ5KHZhbHVlKX0pYCxcbiAgICApO1xuICB9XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiByb3V0ZVBhdGguc2xpY2UoMSkuc3BsaXQoXCIvXCIpKSB7XG4gICAgaWYgKHNlZ21lbnQgPT09IFwiXCIgfHwgc2VnbWVudCA9PT0gXCIuXCIgfHwgc2VnbWVudCA9PT0gXCIuLlwiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgcGF0aCBtdXN0IG5vdCBjb250YWluIGVtcHR5IG9yIGRvdCBzZWdtZW50cyAoZ290ICR7SlNPTi5zdHJpbmdpZnkodmFsdWUpfSlgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvdXRlUGF0aDtcbn1cblxuZnVuY3Rpb24gZXhwbGljaXRSb3V0ZUF1dGhvcml6ZXIocG9zdHVyZT86IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIpOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyIHtcbiAgaWYgKHBvc3R1cmUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbiAgfVxuICBzd2l0Y2ggKHBvc3R1cmUpIHtcbiAgICBjYXNlIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIuSUFNOlxuICAgICAgcmV0dXJuIG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cElhbUF1dGhvcml6ZXIoKTtcbiAgICBjYXNlIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIuTk9ORTpcbiAgICAgIHJldHVybiBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIGF1dGhvcml6ZXIgbXVzdCBiZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLklBTSBvciAuTk9ORSAoZ290ICR7SlNPTi5zdHJpbmdpZnkocG9zdHVyZSl9KWAsXG4gICAgICApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNvbmZpZ3VyZVJvdXRlU2V0dGluZ3MoXG4gIHN0YWdlOiBhcGlnd3YyLklTdGFnZSxcbiAgc2V0dGluZ3M6IHsgW3JvdXRlS2V5OiBzdHJpbmddOiBBcHBUaGVvcnlIdHRwQXBpUm91dGVUaHJvdHRsaW5nIH0sXG4gIGVtaXR0ZWRSb3V0ZUtleXM6IFNldDxzdHJpbmc+LFxuKTogdm9pZCB7XG4gIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgY29uc3QgbWFwcGVkOiB7IFtyb3V0ZUtleTogc3RyaW5nXTogeyBbcHJvcGVydHk6IHN0cmluZ106IG51bWJlciB9IH0gPSB7fTtcbiAgZm9yIChjb25zdCBbcm91dGVLZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhzZXR0aW5ncykpIHtcbiAgICBpZiAoIWVtaXR0ZWRSb3V0ZUtleXMuaGFzKHJvdXRlS2V5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVTZXR0aW5nc1ske0pTT04uc3RyaW5naWZ5KHJvdXRlS2V5KX1dIGRvZXMgbm90IG1hdGNoIGFueSByb3V0ZSB0aGlzIGNvbnN0cnVjdCBlbWl0cyAoZW1pdHRlZDogJHtbLi4uZW1pdHRlZFJvdXRlS2V5c10uc29ydCgpLm1hcCgoa2V5KSA9PiBKU09OLnN0cmluZ2lmeShrZXkpKS5qb2luKFwiLCBcIil9KWAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCByYXRlTGltaXQgPSB2YWx1ZS5yYXRlTGltaXQ7XG4gICAgY29uc3QgYnVyc3RMaW1pdCA9IHZhbHVlLmJ1cnN0TGltaXQ7XG4gICAgaWYgKHJhdGVMaW1pdCA9PT0gdW5kZWZpbmVkICYmIGJ1cnN0TGltaXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVTZXR0aW5nc1ske0pTT04uc3RyaW5naWZ5KHJvdXRlS2V5KX1dIHJlcXVpcmVzIHJhdGVMaW1pdCBvciBidXJzdExpbWl0YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChyYXRlTGltaXQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0Zpbml0ZShyYXRlTGltaXQpIHx8IHJhdGVMaW1pdCA8PSAwKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVTZXR0aW5nc1ske0pTT04uc3RyaW5naWZ5KHJvdXRlS2V5KX1dLnJhdGVMaW1pdCBtdXN0IGJlIGEgcG9zaXRpdmUgZmluaXRlIG51bWJlcmAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoYnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkICYmICghTnVtYmVyLmlzRmluaXRlKGJ1cnN0TGltaXQpIHx8IGJ1cnN0TGltaXQgPD0gMCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XS5idXJzdExpbWl0IG11c3QgYmUgYSBwb3NpdGl2ZSBmaW5pdGUgbnVtYmVyYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGVudHJ5OiB7IFtwcm9wZXJ0eTogc3RyaW5nXTogbnVtYmVyIH0gPSB7fTtcbiAgICBpZiAocmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQpIGVudHJ5W1wiVGhyb3R0bGluZ1JhdGVMaW1pdFwiXSA9IHJhdGVMaW1pdDtcbiAgICBpZiAoYnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKSBlbnRyeVtcIlRocm90dGxpbmdCdXJzdExpbWl0XCJdID0gYnVyc3RMaW1pdDtcbiAgICBtYXBwZWRbcm91dGVLZXldID0gZW50cnk7XG4gIH1cbiAgY2ZuU3RhZ2Uucm91dGVTZXR0aW5ncyA9IG1hcHBlZDtcbn1cblxuZnVuY3Rpb24gZGVmYXVsdEFjY2Vzc0xvZ0Zvcm1hdCgpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgfSk7XG59XG5cbi8qKlxuICogQXBwbHkgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSdzIGRlZmF1bHQtb24gYWNjZXNzIGxvZ2dpbmcuIEFuIGV4cGxpY2l0XG4gKiBgYWNjZXNzTG9nZ2luZ2AgdmFsdWUsIGluY2x1ZGluZyBgZmFsc2VgLCBhbHdheXMgd2lucy5cbiAqL1xuZnVuY3Rpb24gZWZmZWN0aXZlU3RhZ2VPcHRpb25zKFxuICBzdGFnZTogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucyxcbiAgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQsXG4pOiBBcHBUaGVvcnlIdHRwQXBpU3RhZ2VPcHRpb25zIHtcbiAgaWYgKG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBzdGFnZS5hY2Nlc3NMb2dnaW5nID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4geyAuLi5zdGFnZSwgYWNjZXNzTG9nZ2luZzogdHJ1ZSB9O1xuICB9XG4gIHJldHVybiBzdGFnZTtcbn1cbiJdfQ==