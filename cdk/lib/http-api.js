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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHttpApi", version: "7.4.0" };
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
            const contractLogical = standard && logical ? `logs/access/api/${logical}` : undefined;
            const contractName = namingContext && logical ? (0, standard_logging_1.accessLogGroupName)(namingContext, `logs/access/api/${logical}`) : undefined;
            logGroup = contractLogical
                ? new logs.LogGroup(this, "AccessLogs", {
                    logGroupName: contractName,
                    retention: (0, standard_logging_1.retentionFor)(namingContext.retentionDays),
                })
                : contractName !== undefined
                    ? new logs.LogGroup(this, "AccessLogs", {
                        logGroupName: contractName,
                        retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQ0Esc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSxpRUFBc0c7QUFHdEcsNkNBQWtEO0FBQ2xELGlDQUE0QztBQUU1QywyQ0FBdUQ7QUFtSnZELDRFQUE0RTtBQUM1RSxJQUFZLCtCQUtYO0FBTEQsV0FBWSwrQkFBK0I7SUFDekMsb0NBQW9DO0lBQ3BDLDhDQUFXLENBQUE7SUFDWCx5REFBeUQ7SUFDekQsZ0RBQWEsQ0FBQTtBQUNmLENBQUMsRUFMVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQUsxQztBQTBKRCxNQUFhLGdCQUFpQixTQUFRLHNCQUFTOztJQUM3QixHQUFHLENBQWtCO0lBQ3JCLEtBQUssQ0FBaUI7SUFDdEIsY0FBYyxDQUFrQjtJQUNoQyxNQUFNLENBQXNCO0lBRTVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNkLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUxBQWlMLENBQ2xMLENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxtQkFBbUIsR0FBRyxLQUFLLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUM5QyxNQUFNLFNBQVMsR0FBRyxxQkFBcUIsQ0FBQyxtQkFBbUIsRUFBRSxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbEYsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFDcEQsSUFBSSxTQUFTLENBQUMs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USxFQUFFLG1CQUFtQjtRQUM3QixNQUFNLEVBQUUsaUJBQWlCO1FBQ3pCLFFBQVEsRUFBRSxtQkFBbUI7UUFDN0IsY0FBYyxFQUFFLHlCQUF5QjtRQUN6QyxrQkFBa0IsRUFBRSw2QkFBNkI7S0FDbEQsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQVMscUJBQXFCLENBQzVCLEtBQW1DLEVBQ25DLGFBQXNDO0lBRXRDLElBQUksYUFBYSxFQUFFLGVBQWUsS0FBSyxJQUFJLElBQUksS0FBSyxDQUFDLGFBQWEsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNqRixPQUFPLEVBQUUsR0FBRyxLQUFLLEVBQUUsYUFBYSxFQUFFLElBQUksRUFBRSxDQUFDO0lBQzNDLENBQUM7SUFDRCxPQUFPLEtBQUssQ0FBQztBQUNmLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB0eXBlICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5pbXBvcnQgeyBhY2Nlc3NMb2dHcm91cE5hbWUsIGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQsIHJldGVudGlvbkZvciB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5QXBpRG9tYWluIH0gZnJvbSBcIi4vYXBpLWRvbWFpblwiO1xuaW1wb3J0IHsgYnVpbGRDb3JzUHJlZmxpZ2h0IH0gZnJvbSBcIi4vY29yc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMgfSBmcm9tIFwiLi9yZWdpb25hbC13YWZcIjtcbmltcG9ydCB7IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZCB9IGZyb20gXCIuL3JvdXRlLWlkc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBBbGxvd2VkIG9yaWdpbnMuXG4gICAqIEBkZWZhdWx0IFtcIipcIl1cbiAgICovXG4gIHJlYWRvbmx5IGFsbG93T3JpZ2lucz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBbGxvd2VkIEhUVFAgbWV0aG9kcy5cbiAgICogQGRlZmF1bHQgW1wiR0VUXCIsIFwiUE9TVFwiLCBcIlBVVFwiLCBcIkRFTEVURVwiLCBcIlBBVENIXCIsIFwiSEVBRFwiLCBcIk9QVElPTlNcIl1cbiAgICovXG4gIHJlYWRvbmx5IGFsbG93TWV0aG9kcz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBBbGxvd2VkIGhlYWRlcnMuXG4gICAqIEBkZWZhdWx0IFtcImNvbnRlbnQtdHlwZVwiLCBcImF1dGhvcml6YXRpb25cIiwgXCJ4LXJlcXVlc3QtaWRcIiwgXCJ4LXRlbmFudC1pZFwiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEV4cG9zZWQgcmVzcG9uc2UgaGVhZGVycy5cbiAgICogQGRlZmF1bHQgW1wieC1yZXF1ZXN0LWlkXCJdXG4gICAqL1xuICByZWFkb25seSBleHBvc2VIZWFkZXJzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgYnJvd3NlcnMgbWF5IHNlbmQgY3JlZGVudGlhbHMuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhbGxvd0NyZWRlbnRpYWxzPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQnJvd3NlciBwcmVmbGlnaHQgY2FjaGUgZHVyYXRpb24uXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLm1pbnV0ZXMoMTApXG4gICAqL1xuICByZWFkb25seSBtYXhBZ2U/OiBEdXJhdGlvbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBDdXN0b20gZG9tYWluIG5hbWUsIGZvciBleGFtcGxlIGBhcGkuZXhhbXBsZS5jb21gLlxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIHRoZSBkb21haW4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gIC8qKlxuICAgKiBBQ00gY2VydGlmaWNhdGUgQVJOLlxuICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBvcHRpb25hbCBDTkFNRSByZWNvcmQgY3JlYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgLyoqXG4gICAqIEFQSSBtYXBwaW5nIGtleSB1bmRlciB0aGUgY3VzdG9tIGRvbWFpbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhcGlNYXBwaW5nS2V5Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBTdGFnZSB0byBtYXAuIERlZmF1bHRzIHRvIHRoaXMgY29uc3RydWN0J3Mgc3RhZ2UuXG4gICAqIEBkZWZhdWx0IHRoaXMuc3RhZ2VcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogYXBpZ3d2Mi5JU3RhZ2U7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgdG8gY3JlYXRlIGEgQ05BTUUgd2hlbiBob3N0ZWRab25lIGlzIHByb3ZpZGVkLlxuICAgKiBAZGVmYXVsdCB0cnVlIHdoZW4gaG9zdGVkWm9uZSBpcyBwcm92aWRlZFxuICAgKi9cbiAgcmVhZG9ubHkgY3JlYXRlQ25hbWU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBDTkFNRSByZWNvcmQgVFRMLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5zZWNvbmRzKDMwMClcbiAgICovXG4gIHJlYWRvbmx5IHJlY29yZFR0bD86IER1cmF0aW9uO1xuXG4gIC8qKlxuICAgKiBNdXR1YWwgVExTIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbXV0dWFsVGxzQXV0aGVudGljYXRpb24/OiBhcGlnd3YyLk1UTFNDb25maWc7XG5cbiAgLyoqXG4gICAqIFRMUyBzZWN1cml0eSBwb2xpY3kuXG4gICAqIEBkZWZhdWx0IEFQSSBHYXRld2F5IGRlZmF1bHRcbiAgICovXG4gIHJlYWRvbmx5IHNlY3VyaXR5UG9saWN5PzogYXBpZ3d2Mi5TZWN1cml0eVBvbGljeTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpU3RhZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUuXG4gICAqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBvciBwcm92aWRlIGEgbG9nIGdyb3VwLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW4gfCBsb2dzLklMb2dHcm91cDtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3IgYW4gYXV0by1jcmVhdGVkIGFjY2VzcyBsb2cgZ3JvdXAuXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKipcbiAgICogQVBJIEdhdGV3YXkgdjIgYWNjZXNzLWxvZyBmb3JtYXQuIERlZmF1bHRzIHRvIHRoZSBBcHBUaGVvcnkgSlNPTiBmb3JtYXQuXG4gICAqIFZhbGlkIG9ubHkgd2hlbiBgYWNjZXNzTG9nZ2luZ2AgaXMgZW5hYmxlZC5cbiAgICogQGRlZmF1bHQgdGhlIEFwcFRoZW9yeSBKU09OIGFjY2Vzcy1sb2cgZm9ybWF0XG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dGb3JtYXQ/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIEBkZXByZWNhdGVkIEFQSSBHYXRld2F5IHYyIEhUVFAgQVBJIHN0YWdlcyBhcmUgbm90IHN1cHBvcnRlZCBXQUZ2MiByZWdpb25hbFxuICogYXNzb2NpYXRpb24gdGFyZ2V0cy4gVXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciB3aXRoXG4gKiBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMgZm9yIFdBRi1wcm90ZWN0ZWQgUkVTVCBBUEkgc3RhZ2VzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlXYWZPcHRpb25zIGV4dGVuZHMgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIHt9XG5cbi8qKiBHYXRld2F5IGF1dGhvcml6YXRpb24gcG9zdHVyZSBmb3IgYW4gZXhwbGljaXQgQXBwVGhlb3J5SHR0cEFwaSByb3V0ZS4gKi9cbmV4cG9ydCBlbnVtIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIge1xuICAvKiogQVdTIElBTSAoU2lnVjQpIG9uIHRoZSByb3V0ZS4gKi9cbiAgSUFNID0gXCJpYW1cIixcbiAgLyoqIE5vIGdhdGV3YXkgYXV0aG9yaXplcjsgdGhlIHJ1bnRpbWUgb3ducyBhZG1pc3Npb24uICovXG4gIE5PTkUgPSBcIm5vbmVcIixcbn1cblxuLyoqXG4gKiBPbmUgZXhwbGljaXQsIHNlbWFudGljYWxseSBpZGVudGlmaWVkIHJvdXRlIGFkZGVkIGFsb25nc2lkZSB0aGUgY29uc3RydWN0J3NcbiAqIGdyZWVkeSBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAgcm91dGVzLlxuICpcbiAqIEFQSSBHYXRld2F5IHByZWNlZGVuY2UgZ2l2ZXMgYSBmdWxsIG1ldGhvZCtwYXRoIG1hdGNoIHByaW9yaXR5IG92ZXIgdGhlXG4gKiBncmVlZHkgcm91dGVzLCBzbyBhIG1vcmUgc3BlY2lmaWMgcm91dGUgd2l0aCBhIHN0cmljdGVyIGF1dGhvcml6ZXIgKGZvclxuICogZXhhbXBsZSBgQVdTX0lBTWApIHdpbnMgZm9yIGl0cyBvd24gcGF0aC4gQSB3cm9uZy1tZXRob2QgcmVxdWVzdCBvbiBzdWNoIGFcbiAqIHBhdGggZmFsbHMgdGhyb3VnaCB0byB0aGUgcnVudGltZSdzIGZhaWwtY2xvc2VkIDQwNC80MDUgd2hlbiB0aGUgcnVudGltZSBkb2VzXG4gKiBub3QgZGVjbGFyZSBpdC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zIHtcbiAgLyoqIEFic29sdXRlIHJvdXRlIHBhdGguIFNlZ21lbnRzIGFyZSBsaXRlcmFscywgYHtwYXJhbWV0ZXJ9YCwgb3IgYHtwcm94eSt9YCBzZWdtZW50cy4gKi9cbiAgcmVhZG9ubHkgcGF0aDogc3RyaW5nO1xuICAvKiogSFRUUCBtZXRob2RzIHdpcmVkIGZvciB0aGUgcm91dGUsIGZvciBleGFtcGxlIGBbXCJHRVRcIl1gIG9yIGBbXCJBTllcIl1gLiAqL1xuICByZWFkb25seSBtZXRob2RzOiBzdHJpbmdbXTtcbiAgLyoqXG4gICAqIEdhdGV3YXkgYXV0aG9yaXphdGlvbiBwb3N0dXJlIGZvciB0aGUgcm91dGUuXG4gICAqXG4gICAqIE9taXQgZm9yIGBOT05FYC4gRXZlcnkgZXhwbGljaXQgdmFsdWUgb3RoZXIgdGhhbiBgSUFNYCBvciBgTk9ORWAg4oCUIGFuXG4gICAqIHVwcGVyY2FzZSBzcGVsbGluZywgYSBtaXNzcGVsbGluZywgYG51bGxgLCBhIG51bWJlciwgYW4gb2JqZWN0LCBvciBhbnlcbiAgICogdW5jaGVja2VkIGNvbmZpZ3VyYXRpb24gdmFsdWUg4oCUIGZhaWxzIHN5bnRoZXNpcyBiZWZvcmUgdGhpcyByb3V0ZSBpc1xuICAgKiBlbWl0dGVkIGluc3RlYWQgb2Ygc2lsZW50bHkgZmFsbGluZyBiYWNrIHRvIGBOT05FYC5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5OT05FXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyPzogQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplcjtcbn1cblxuLyoqIFJvdXRlLWxldmVsIHRocm90dGxpbmcgYXBwbGllZCB0byBvbmUgQVBJIEdhdGV3YXkgcm91dGUga2V5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVUaHJvdHRsaW5nIHtcbiAgLyoqIFJlcXVlc3RzIHBlciBzZWNvbmQgZm9yIHRoZSByb3V0ZSBrZXkuIEBkZWZhdWx0IHRoZSBzdGFnZSBkZWZhdWx0ICovXG4gIHJlYWRvbmx5IHJhdGVMaW1pdD86IG51bWJlcjtcbiAgLyoqIEJ1cnN0IGxpbWl0IGZvciB0aGUgcm91dGUga2V5LiBAZGVmYXVsdCB0aGUgc3RhZ2UgZGVmYXVsdCAqL1xuICByZWFkb25seSBidXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgKlxuICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgQVBJIGFjY2VzcyBsb2dnaW5nIGlzIG9uIGJ5IGRlZmF1bHQgdG8gYVxuICAgKiBsb2cgZ3JvdXAgbmFtZWQgYGxvZ3MvYWNjZXNzL2FwaS97bG9naWNhbE5hbWV9YCBjYXJyeWluZyB0aGUgY29udHJhY3Qnc1xuICAgKiBKU09OIGZpZWxkIHNldC4gUGFzcyBgc3RhZ2UuYWNjZXNzTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQuXG4gICAqXG4gICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkIHdoZW4gYVxuICAgKiBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuICAvKipcbiAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBIVFRQIEFQSSB2MiByb3V0ZXMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgcm91dGUuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3Igcm91dGUgZmFtaWxpZXMgdGhhdCBzaGFyZSBvbmVcbiAgICogTGFtYmRhLCB3aGVyZSB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2UgcG9saWN5IHNpemVcbiAgICogbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBoYW5kbGVyLCBub3Qgb25seSB0aGUgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBDT1JTIGNvbmZpZ3VyYXRpb24uIFNldCB0byB0cnVlIGZvciBBcHBUaGVvcnkgZGVmYXVsdHMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgY29ycz86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0LCBzZW1hbnRpY2FsbHkgaWRlbnRpZmllZCByb3V0ZXMgYWRkZWQgYWxvbmdzaWRlIHRoZSBjb25zdHJ1Y3Qnc1xuICAgKiBncmVlZHkgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gIHJvdXRlcy5cbiAgICpcbiAgICogVXNlIHRoaXMgd2hlcmUgYSBzdHJpY3RlciBwZXItcGF0aCBnYXRld2F5IHBvc3R1cmUgKGZvciBleGFtcGxlXG4gICAqIGBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLklBTWApIG11c3Qgd2luIG92ZXIgdGhlIGdyZWVkeSByb3V0ZXM6IGFcbiAgICogZnVsbCBtZXRob2QrcGF0aCBtYXRjaCBvdXRyYW5rcyB0aGUgZ3JlZWR5IHJvdXRlIGJ5IEFQSSBHYXRld2F5IHByZWNlZGVuY2UsXG4gICAqIGFuZCBhIHdyb25nLW1ldGhvZCByZXF1ZXN0IG9uIHN1Y2ggYSBwYXRoIGlzIGRlbmllZCBieSB0aGUgcnVudGltZSB3aXRoIHRoZVxuICAgKiBmYWlsLWNsb3NlZCA0MDQvNDA1IGVudmVsb3BlLlxuICAgKlxuICAgKiBSb3V0ZSBjb25zdHJ1Y3QgaWRzIGFyZSBkZXJpdmVkIGZyb20gdGhlIG1ldGhvZCBhbmQgcGF0aCwgc28gaW5zZXJ0aW5nLFxuICAgKiByZW1vdmluZywgb3IgcmVvcmRlcmluZyBhbiBlbnRyeSBuZXZlciByZW5hbWVzIGFuIHVucmVsYXRlZCByb3V0ZS5cbiAgICpcbiAgICogQSBkZWNsYXJlZCBgT1BUSU9OU2Agcm91dGUgY29leGlzdHMgd2l0aCwgYW5kIGNhbiBiZSBzaGFkb3dlZCBieSwgdGhlXG4gICAqIEFQSS1sZXZlbCBDT1JTIGNvbmZpZ3VyYXRpb24gYGNvcnNgIGluc3RhbGxzLiBgYnVpbGRDb3JzUHJlZmxpZ2h0YCBpbmNsdWRlc1xuICAgKiBgT1BUSU9OU2AgaW4gaXRzIGRlZmF1bHQgYGFsbG93TWV0aG9kc2AsIGFuZCB3aGlsZSBgT1BUSU9OU2AgaXMgaW4gdGhhdFxuICAgKiBsaXN0IEFQSSBHYXRld2F5IGFuc3dlcnMgbWF0Y2hpbmcgcHJlZmxpZ2h0IHJlcXVlc3RzIGl0c2VsZiBiZWZvcmUgdGhlXG4gICAqIHJvdXRlIGludGVncmF0aW9uIHJ1bnMsIHNvIGEgZGVjbGFyZWQgYE9QVElPTlNgIHJvdXRlIG9uIHRoZSBzYW1lIHBhdGggaXNcbiAgICogbmV2ZXIgcmVhY2hlZC4gU2V0dGluZyBgY29ycy5hbGxvd01ldGhvZHNgIHdpdGhvdXQgYE9QVElPTlNgIHJlbW92ZXMgZ2F0ZXdheVxuICAgKiBwcmVmbGlnaHQgaGFuZGxpbmcgZW50aXJlbHk7IGEgZGVjbGFyZWQgYE9QVElPTlNgIHJvdXRlIGlzIHRoZW4gdGhlIG9ubHlcbiAgICogdGhpbmcgdGhhdCBhbnN3ZXJzIGEgcHJlZmxpZ2h0IHJlcXVlc3QsIGFuZCBpdCBpcyBzdWJqZWN0IHRvIHRoYXQgcm91dGUnc1xuICAgKiBvd24gYXV0aG9yaXplci4gRGVjbGFyZSB0aGUgbWV0aG9kcyB5b3UgbmVlZCBpbiBgY29ycy5hbGxvd01ldGhvZHNgIHJhdGhlclxuICAgKiB0aGFuIGRlcGVuZGluZyBvbiBhIGRlY2xhcmVkIGBPUFRJT05TYCByb3V0ZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb3V0ZXM/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zW107XG5cbiAgLyoqXG4gICAqIFJvdXRlLWxldmVsIHRocm90dGxpbmcga2V5ZWQgYnkgQVBJIEdhdGV3YXkgcm91dGUga2V5IChmb3IgZXhhbXBsZVxuICAgKiBgXCJBTlkgL3twcm94eSt9XCJgKS4gQXBwbGllZCB0byB0aGUgc3RhZ2UncyByb3V0ZSBzZXR0aW5ncy5cbiAgICpcbiAgICogRXZlcnkga2V5IGlzIHZhbGlkYXRlZCBhdCBzeW50aGVzaXMgdGltZSBhZ2FpbnN0IHRoZSByb3V0ZSBrZXlzIHRoaXNcbiAgICogY29uc3RydWN0IGVtaXRzIOKAlCB0aGUgZ3JlZWR5IGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCByb3V0ZXMgcGx1cyBvbmVcbiAgICogYDxNRVRIT0Q+IDxwYXRoPmAga2V5IHBlciBgcm91dGVzYCBlbnRyeS4gQSBrZXkgdGhhdCBtYXRjaGVzIG5vIGVtaXR0ZWRcbiAgICogcm91dGUgZmFpbHMgc3ludGhlc2lzIHdpdGggYSBuYW1lZCBlcnJvciBsaXN0aW5nIHRoZSBlbWl0dGVkIGtleXMsIHJhdGhlclxuICAgKiB0aGFuIGJlaW5nIHNpbGVudGx5IGlnbm9yZWQgYnkgQVBJIEdhdGV3YXkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVTZXR0aW5ncz86IHsgW3JvdXRlS2V5OiBzdHJpbmddOiBBcHBUaGVvcnlIdHRwQXBpUm91dGVUaHJvdHRsaW5nIH07XG5cbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICpcbiAgICogV2hlbiBgZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBpcyBzZXQsIEFwcFRoZW9yeSBmYWlscyBjbG9zZWQgYW5kXG4gICAqIGRpc2FibGVzIHRoZSBkZWZhdWx0IGBleGVjdXRlLWFwaWAgZW5kcG9pbnQgc28gdGhlIEFQSSBpcyByZWFjaGFibGUgb25seVxuICAgKiB0aHJvdWdoIHRoZSBtdXR1YWwtVExTIGN1c3RvbSBkb21haW4uIFdpdGhvdXQgbXV0dWFsIFRMUyB0aGUgZGVmYXVsdFxuICAgKiBlbmRwb2ludCBrZWVwcyB0aGUgQVdTIGRlZmF1bHQgKGVuYWJsZWQpLCBzbyBvcmRpbmFyeSBjdXN0b20gZG9tYWlucyBhcmVcbiAgICogdW5hZmZlY3RlZC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFJlZ2lvbmFsIFdBRiBhdHRhY2htZW50IGlzIGludGVudGlvbmFsbHkgdW5hdmFpbGFibGUgZm9yIEFQSSBHYXRld2F5IHYyXG4gICAqIEhUVFAgQVBJcy4gU3VwcGx5aW5nIHRoaXMgcHJvcCBmYWlscyBjbG9zZWQgZHVyaW5nIHN5bnRoZXNpcyBpbnN0ZWFkIG9mXG4gICAqIHByb2R1Y2luZyBhbiB1bnN1cHBvcnRlZCBgL2FwaXMvLi4uL3N0YWdlcy8uLi5gIFdlYkFDTCBhc3NvY2lhdGlvbi5cbiAgICpcbiAgICogVXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciB3aGVuIGEgV0FGLXByb3RlY3RlZCBBUElcbiAgICogR2F0ZXdheSBzdGFnZSBpcyByZXF1aXJlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqIEBkZXByZWNhdGVkIEhUVFAgQVBJIFdBRiBhc3NvY2lhdGlvbiBpcyB1bnN1cHBvcnRlZCBieSBBV1MgV0FGdjIuXG4gICAqL1xuICByZWFkb25seSB3YWY/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaVdhZk9wdGlvbnM7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlIdHRwQXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUFwaURvbWFpbjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5SHR0cEFwaVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcy53YWYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlIdHRwQXBpIGRvZXMgbm90IHN1cHBvcnQgV0FGdjIgcmVnaW9uYWwgV2ViQUNMIGFzc29jaWF0aW9ucyBmb3IgQVBJIEdhdGV3YXkgdjIgSFRUUCBBUElzOyB1c2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGZvciBXQUYtcHJvdGVjdGVkIFJFU1Qgc3RhZ2VzXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IGNvbmZpZ3VyZWRTdGFnZU9wdHMgPSBwcm9wcy5zdGFnZSA/PyB7fTtcbiAgICBjb25zdCBzdGFnZU9wdHMgPSBlZmZlY3RpdmVTdGFnZU9wdGlvbnMoY29uZmlndXJlZFN0YWdlT3B0cywgcHJvcHMubmFtaW5nQ29udGV4dCk7XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCI7XG4gICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQgIT09IHVuZGVmaW5lZCAmJiAhc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGk6IHN0YWdlLmFjY2Vzc0xvZ0Zvcm1hdCByZXF1aXJlcyBzdGFnZS5hY2Nlc3NMb2dnaW5nXCIpO1xuICAgIH1cbiAgICBjb25zdCBuYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeUh0dHBBcGlcIiwgXCJhcGlOYW1lXCIsIFwiYXBpX2h0dHBcIiwgbG9naWNhbCwgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICBjb25zdCBkZXJpdmVkQXBpTmFtZSA9IG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCA/IG5hbWluZ0NvbnRleHQucGh5c2ljYWxOYW1lKFwiYXBpX2h0dHBcIiwgbG9naWNhbCkgOiB1bmRlZmluZWQ7XG4gICAgY29uc3QgbmVlZHNFeHBsaWNpdFN0YWdlID0gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBkZXJpdmVkQXBpTmFtZSAmJiAhZGVyaXZlZEFwaU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZEFwaU5hbWUubmFtZSA6IHByb3BzLmFwaU5hbWUsXG4gICAgICBjb3JzUHJlZmxpZ2h0OiBidWlsZENvcnNQcmVmbGlnaHQocHJvcHMuY29ycyksXG4gICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6ICFuZWVkc0V4cGxpY2l0U3RhZ2UsXG4gICAgICBkaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50OiBwcm9wcy5kb21haW4/Lm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uICE9PSB1bmRlZmluZWQgPyB0cnVlIDogdW5kZWZpbmVkLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhZ2UgPSBuZWVkc0V4cGxpY2l0U3RhZ2VcbiAgICAgID8gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICAgIHRocm90dGxlOiAoc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgfSlcbiAgICAgIDogdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIGlmICghc3RhZ2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGk6IGZhaWxlZCB0byBjcmVhdGUgQVBJIHN0YWdlXCIpO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlID0gc3RhZ2U7XG4gICAgdGhpcy5jb25maWd1cmVBY2Nlc3NMb2dnaW5nKHN0YWdlT3B0cywgc3RhZ2UsIG5hbWluZ0NvbnRleHQsIGxvZ2ljYWwpO1xuXG4gICAgLy8gRXZlcnkgcm91dGUga2V5IHRoaXMgY29uc3RydWN0IGVtaXRzLCBpbiBBUEkgR2F0ZXdheSBgTUVUSE9EIHBhdGhgIGZvcm0uXG4gICAgLy8gYHJvdXRlU2V0dGluZ3NgIGlzIHZhbGlkYXRlZCBhZ2FpbnN0IHRoaXMgc2V0IHNvIGEgdHlwbyBpcyBhIG5hbWVkXG4gICAgLy8gc3ludGhlc2lzIGVycm9yIGluc3RlYWQgb2Ygc2lsZW50bHkgaWdub3JlZCBzdGFnZSBjb25maWd1cmF0aW9uLlxuICAgIGNvbnN0IGVtaXR0ZWRSb3V0ZUtleXMgPSBuZXcgU2V0KFtcIkFOWSAvXCIsIFwiQU5ZIC97cHJveHkrfVwiXSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIvXCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWV0sXG4gICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiUm9vdFwiLCBwcm9wcy5oYW5kbGVyLCB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBcIi97cHJveHkrfVwiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5BTlldLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIlByb3h5XCIsIHByb3BzLmhhbmRsZXIsIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgY29uc3QgZXhwbGljaXRSb3V0ZXMgPSBwcm9wcy5yb3V0ZXMgPz8gW107XG4gICAgaWYgKGV4cGxpY2l0Um91dGVzLmxlbmd0aCA+IDApIHtcbiAgICAgIHRoaXMuYWRkRXhwbGljaXRSb3V0ZXMoZXhwbGljaXRSb3V0ZXMsIHByb3BzLmhhbmRsZXIsIHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSwgZW1pdHRlZFJvdXRlS2V5cyk7XG4gICAgfVxuICAgIGlmIChwcm9wcy5yb3V0ZVNldHRpbmdzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGNvbmZpZ3VyZVJvdXRlU2V0dGluZ3Moc3RhZ2UsIHByb3BzLnJvdXRlU2V0dGluZ3MsIGVtaXR0ZWRSb3V0ZUtleXMpO1xuICAgIH1cblxuICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgIHRoaXMuY29uZmlndXJlRG9tYWluKHByb3BzLmRvbWFpbik7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhZGRFeHBsaWNpdFJvdXRlcyhcbiAgICByb3V0ZXM6IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZU9wdGlvbnNbXSxcbiAgICByb3V0ZUhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb24sXG4gICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogYm9vbGVhbixcbiAgICBlbWl0dGVkUm91dGVLZXlzOiBTZXQ8c3RyaW5nPixcbiAgKTogdm9pZCB7XG4gICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJFeHBsaWNpdFwiLCByb3V0ZUhhbmRsZXIsIHtcbiAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSxcbiAgICB9KTtcbiAgICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgZm9yIChjb25zdCByb3V0ZSBvZiByb3V0ZXMpIHtcbiAgICAgIGNvbnN0IHJvdXRlUGF0aCA9IG5vcm1hbGl6ZUV4cGxpY2l0Um91dGVQYXRoKHJvdXRlLnBhdGgpO1xuICAgICAgY29uc3QgY29uZmlndXJlZE1ldGhvZHMgPSByb3V0ZS5tZXRob2RzID8/IFtdO1xuICAgICAgaWYgKGNvbmZpZ3VyZWRNZXRob2RzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBlbnRyeSBmb3IgJHtKU09OLnN0cmluZ2lmeShyb3V0ZVBhdGgpfSByZXF1aXJlcyBhdCBsZWFzdCBvbmUgbWV0aG9kYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIGZvciAoY29uc3QgcmF3TWV0aG9kIG9mIGNvbmZpZ3VyZWRNZXRob2RzKSB7XG4gICAgICAgIGNvbnN0IG1ldGhvZCA9IFN0cmluZyhyYXdNZXRob2QpLnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICAgICAgICBpZiAoIUVYUExJQ0lUX1JPVVRFX01FVEhPRFMuaGFzKG1ldGhvZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIG1ldGhvZCBtdXN0IGJlIG9uZSBvZiAke1suLi5FWFBMSUNJVF9ST1VURV9NRVRIT0RTXS5qb2luKFwiLCBcIil9IChnb3QgJHtKU09OLnN0cmluZ2lmeShyYXdNZXRob2QpfSlgLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgcm91dGVJZCA9IHNlbWFudGljUm91dGVDb25zdHJ1Y3RJZChtZXRob2QsIHJvdXRlUGF0aCk7XG4gICAgICAgIGlmIChzZWVuLmhhcyhyb3V0ZUlkKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgY29udGFpbnMgdGhlIGR1cGxpY2F0ZSByb3V0ZSAke21ldGhvZH0gJHtyb3V0ZVBhdGh9YCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIHNlZW4uYWRkKHJvdXRlSWQpO1xuICAgICAgICBlbWl0dGVkUm91dGVLZXlzLmFkZChgJHttZXRob2R9ICR7cm91dGVQYXRofWApO1xuICAgICAgICBuZXcgYXBpZ3d2Mi5IdHRwUm91dGUodGhpcywgcm91dGVJZCwge1xuICAgICAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgIHJvdXRlS2V5OiBhcGlnd3YyLkh0dHBSb3V0ZUtleS53aXRoKHJvdXRlUGF0aCwgbWV0aG9kIGFzIGFwaWd3djIuSHR0cE1ldGhvZCksXG4gICAgICAgICAgaW50ZWdyYXRpb24sXG4gICAgICAgICAgYXV0aG9yaXplcjogZXhwbGljaXRSb3V0ZUF1dGhvcml6ZXIocm91dGUuYXV0aG9yaXplciksXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgY29uZmlndXJlQWNjZXNzTG9nZ2luZyhcbiAgICBzdGFnZU9wdHM6IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMsXG4gICAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICAgIG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuICAgIGxvZ2ljYWw/OiBzdHJpbmcsXG4gICk6IHZvaWQge1xuICAgIGlmICghc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFuZGFyZCA9IG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZTtcbiAgICBpZiAoc3RhbmRhcmQgJiYgIWxvZ2ljYWwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGkgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIGxvZ2ljYWwgbmFtZVwiKTtcbiAgICB9XG4gICAgbGV0IGxvZ0dyb3VwOiBsb2dzLklMb2dHcm91cDtcbiAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IHRydWUpIHtcbiAgICAgIGNvbnN0IGNvbnRyYWN0TG9naWNhbCA9IHN0YW5kYXJkICYmIGxvZ2ljYWwgPyBgbG9ncy9hY2Nlc3MvYXBpLyR7bG9naWNhbH1gIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgY29udHJhY3ROYW1lID0gbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsID8gYWNjZXNzTG9nR3JvdXBOYW1lKG5hbWluZ0NvbnRleHQsIGBsb2dzL2FjY2Vzcy9hcGkvJHtsb2dpY2FsfWApIDogdW5kZWZpbmVkO1xuICAgICAgbG9nR3JvdXAgPSBjb250cmFjdExvZ2ljYWxcbiAgICAgICAgPyBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBjb250cmFjdE5hbWUsXG4gICAgICAgICAgICByZXRlbnRpb246IHJldGVudGlvbkZvcihuYW1pbmdDb250ZXh0IS5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IGNvbnRyYWN0TmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgPyBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgICBsb2dHcm91cE5hbWU6IGNvbnRyYWN0TmFtZSxcbiAgICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIDogbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgbG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICB9XG4gICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICBmb3JtYXQ6IHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQgPz8gKHN0YW5kYXJkID8gaHR0cEFwaUFjY2Vzc0xvZ0Zvcm1hdCgpIDogZGVmYXVsdEFjY2Vzc0xvZ0Zvcm1hdCgpKSxcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVEb21haW4ob3B0aW9uczogQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnMpOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG9wdGlvbnMuY2VydGlmaWNhdGUgPz8gKG9wdGlvbnMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydGlmaWNhdGVcIiwgb3B0aW9ucy5jZXJ0aWZpY2F0ZUFybilcbiAgICAgIDogdW5kZWZpbmVkKTtcbiAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpIGRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIik7XG4gICAgfVxuXG4gICAgY29uc3QgZG9tYWluID0gbmV3IEFwcFRoZW9yeUFwaURvbWFpbih0aGlzLCBcIkRvbWFpblwiLCB7XG4gICAgICBkb21haW5OYW1lOiBvcHRpb25zLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgc3RhZ2U6IG9wdGlvbnMuc3RhZ2UgPz8gdGhpcy5zdGFnZSxcbiAgICAgIGhvc3RlZFpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgIGFwaU1hcHBpbmdLZXk6IG9wdGlvbnMuYXBpTWFwcGluZ0tleSxcbiAgICAgIGNyZWF0ZUNuYW1lOiBvcHRpb25zLmNyZWF0ZUNuYW1lLFxuICAgICAgcmVjb3JkVHRsOiBvcHRpb25zLnJlY29yZFR0bCxcbiAgICAgIG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uOiBvcHRpb25zLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uLFxuICAgICAgc2VjdXJpdHlQb2xpY3k6IG9wdGlvbnMuc2VjdXJpdHlQb2xpY3ksXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW4/OiBBcHBUaGVvcnlBcGlEb21haW4gfSkuZG9tYWluID0gZG9tYWluO1xuICB9XG59XG5cbmNvbnN0IEVYUExJQ0lUX1JPVVRFX01FVEhPRFMgPSBuZXcgU2V0KFtcbiAgXCJBTllcIixcbiAgXCJERUxFVEVcIixcbiAgXCJHRVRcIixcbiAgXCJIRUFEXCIsXG4gIFwiT1BUSU9OU1wiLFxuICBcIlBBVENIXCIsXG4gIFwiUE9TVFwiLFxuICBcIlBVVFwiLFxuXSk7XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUV4cGxpY2l0Um91dGVQYXRoKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByb3V0ZVBhdGggPSBTdHJpbmcodmFsdWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAocm91dGVQYXRoID09PSBcIlwiIHx8ICFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikgfHwgKHJvdXRlUGF0aC5sZW5ndGggPiAxICYmIHJvdXRlUGF0aC5lbmRzV2l0aChcIi9cIikpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBwYXRoIG11c3QgYmUgYW4gYWJzb2x1dGUgcGF0aCB3aXRoIG5vIHRyYWlsaW5nIHNsYXNoIChnb3QgJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9KWAsXG4gICAgKTtcbiAgfVxuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygcm91dGVQYXRoLnNsaWNlKDEpLnNwbGl0KFwiL1wiKSkge1xuICAgIGlmIChzZWdtZW50ID09PSBcIlwiIHx8IHNlZ21lbnQgPT09IFwiLlwiIHx8IHNlZ21lbnQgPT09IFwiLi5cIikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIHBhdGggbXVzdCBub3QgY29udGFpbiBlbXB0eSBvciBkb3Qgc2VnbWVudHMgKGdvdCAke0pTT04uc3RyaW5naWZ5KHZhbHVlKX0pYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiByb3V0ZVBhdGg7XG59XG5cbmZ1bmN0aW9uIGV4cGxpY2l0Um91dGVBdXRob3JpemVyKHBvc3R1cmU/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIGlmIChwb3N0dXJlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gIH1cbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLklBTTpcbiAgICAgIHJldHVybiBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBJYW1BdXRob3JpemVyKCk7XG4gICAgY2FzZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLk5PTkU6XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBhdXRob3JpemVyIG11c3QgYmUgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5JQU0gb3IgLk5PTkUgKGdvdCAke0pTT04uc3RyaW5naWZ5KHBvc3R1cmUpfSlgLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb25maWd1cmVSb3V0ZVNldHRpbmdzKFxuICBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UsXG4gIHNldHRpbmdzOiB7IFtyb3V0ZUtleTogc3RyaW5nXTogQXBwVGhlb3J5SHR0cEFwaVJvdXRlVGhyb3R0bGluZyB9LFxuICBlbWl0dGVkUm91dGVLZXlzOiBTZXQ8c3RyaW5nPixcbik6IHZvaWQge1xuICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gIGNvbnN0IG1hcHBlZDogeyBbcm91dGVLZXk6IHN0cmluZ106IHsgW3Byb3BlcnR5OiBzdHJpbmddOiBudW1iZXIgfSB9ID0ge307XG4gIGZvciAoY29uc3QgW3JvdXRlS2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MpKSB7XG4gICAgaWYgKCFlbWl0dGVkUm91dGVLZXlzLmhhcyhyb3V0ZUtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XSBkb2VzIG5vdCBtYXRjaCBhbnkgcm91dGUgdGhpcyBjb25zdHJ1Y3QgZW1pdHMgKGVtaXR0ZWQ6ICR7Wy4uLmVtaXR0ZWRSb3V0ZUtleXNdLnNvcnQoKS5tYXAoKGtleSkgPT4gSlNPTi5zdHJpbmdpZnkoa2V5KSkuam9pbihcIiwgXCIpfSlgLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcmF0ZUxpbWl0ID0gdmFsdWUucmF0ZUxpbWl0O1xuICAgIGNvbnN0IGJ1cnN0TGltaXQgPSB2YWx1ZS5idXJzdExpbWl0O1xuICAgIGlmIChyYXRlTGltaXQgPT09IHVuZGVmaW5lZCAmJiBidXJzdExpbWl0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XSByZXF1aXJlcyByYXRlTGltaXQgb3IgYnVyc3RMaW1pdGAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgJiYgKCFOdW1iZXIuaXNGaW5pdGUocmF0ZUxpbWl0KSB8fCByYXRlTGltaXQgPD0gMCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XS5yYXRlTGltaXQgbXVzdCBiZSBhIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKGJ1cnN0TGltaXQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0Zpbml0ZShidXJzdExpbWl0KSB8fCBidXJzdExpbWl0IDw9IDApKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0uYnVyc3RMaW1pdCBtdXN0IGJlIGEgcG9zaXRpdmUgZmluaXRlIG51bWJlcmAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBlbnRyeTogeyBbcHJvcGVydHk6IHN0cmluZ106IG51bWJlciB9ID0ge307XG4gICAgaWYgKHJhdGVMaW1pdCAhPT0gdW5kZWZpbmVkKSBlbnRyeVtcIlRocm90dGxpbmdSYXRlTGltaXRcIl0gPSByYXRlTGltaXQ7XG4gICAgaWYgKGJ1cnN0TGltaXQgIT09IHVuZGVmaW5lZCkgZW50cnlbXCJUaHJvdHRsaW5nQnVyc3RMaW1pdFwiXSA9IGJ1cnN0TGltaXQ7XG4gICAgbWFwcGVkW3JvdXRlS2V5XSA9IGVudHJ5O1xuICB9XG4gIGNmblN0YWdlLnJvdXRlU2V0dGluZ3MgPSBtYXBwZWQ7XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHRBY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG4vKipcbiAqIEFwcGx5IHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUncyBkZWZhdWx0LW9uIGFjY2VzcyBsb2dnaW5nLiBBbiBleHBsaWNpdFxuICogYGFjY2Vzc0xvZ2dpbmdgIHZhbHVlLCBpbmNsdWRpbmcgYGZhbHNlYCwgYWx3YXlzIHdpbnMuXG4gKi9cbmZ1bmN0aW9uIGVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhcbiAgc3RhZ2U6IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMsXG4gIG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuKTogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucyB7XG4gIGlmIChuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgc3RhZ2UuYWNjZXNzTG9nZ2luZyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHsgLi4uc3RhZ2UsIGFjY2Vzc0xvZ2dpbmc6IHRydWUgfTtcbiAgfVxuICByZXR1cm4gc3RhZ2U7XG59XG4iXX0=