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
        const needsExplicitStage = stageName !== "$default"
            || stageOpts.accessLogging
            || stageOpts.throttlingRateLimit !== undefined
            || stageOpts.throttlingBurstLimit !== undefined;
        this.api = new apigwv2.HttpApi(this, "Api", {
            apiName: props.apiName ?? (namingContext && logical
                ? namingContext.physicalName("api_http", logical).name
                : props.apiName),
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
            logGroup = standard && namingContext && logical
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQ0Esc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELGlFQUFrRjtBQUdsRiw2Q0FBa0Q7QUFDbEQsaUNBQTRDO0FBRTVDLDJDQUF1RDtBQW1KdkQsNEVBQTRFO0FBQzVFLElBQVksK0JBS1g7QUFMRCxXQUFZLCtCQUErQjtJQUN6QyxvQ0FBb0M7SUFDcEMsOENBQVcsQ0FBQTtJQUNYLHlEQUF5RDtJQUN6RCxnREFBYSxDQUFBO0FBQ2YsQ0FBQyxFQUxXLCtCQUErQiwrQ0FBL0IsK0JBQStCLFFBSzFDO0FBMEpELE1BQWEsZ0JBQWlCLFNBQVEsc0JBQVM7O0lBQzdCLEdBQUcsQ0FBa0I7SUFDckIsS0FBSyxDQUFpQjtJQUN0QixjQUFjLENBQWtCO0lBQ2hDLE1BQU0sQ0FBc0I7SUFFNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE0QjtRQUNwRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ2QsTUFBTSxJQUFJLEtBQUssQ0FDYixpTEFBaUwsQ0FDbEwsQ0FBQztRQUNKLENBQUM7UUFFRCxNQUFNLG1CQUFtQixHQUFHLEtBQUssQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDO1FBQzlDLE1BQU0sU0FBUyxHQUFHLHFCQUFxQixDQUFDLG1CQUFtQixFQUFFLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNsRixNQUFNLFNBQVMsR0FBRyxTQUFTLENBQUMsU0FBUyxJQUFJLFVBQVUsQ0FBQztRQUNwRCxJQUFJLFNBQVMsQ0FBQyxlQUFlLEtBQUssU0FB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LFNBQVM7WUFBRSxLQUFLLENBQUMscUJBQXFCLENBQUMsR0FBRyxTQUFTLENBQUM7UUFDdEUsSUFBSSxVQUFVLEtBQUssU0FBUztZQUFFLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxHQUFHLFVBQVUsQ0FBQztRQUN6RSxNQUFNLENBQUMsUUFBUSxDQUFDLEdBQUcsS0FBSyxDQUFDO0lBQzNCLENBQUM7SUFDRCxRQUFRLENBQUMsYUFBYSxHQUFHLE1BQU0sQ0FBQztBQUNsQyxDQUFDO0FBRUQsU0FBUyxzQkFBc0I7SUFDN0IsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDO1FBQ3BCLFNBQVMsRUFBRSxvQkFBb0I7UUFDL0IsRUFBRSxFQUFFLDRCQUE0QjtRQUNoQyxXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLFVBQVUsRUFBRSxxQkFBcUI7UUFDakMsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixNQUFNLEVBQUUsaUJBQWlCO1FBQ3pCLFFBQVEsRUFBRSxtQkFBbUI7UUFDN0IsY0FBYyxFQUFFLHlCQUF5QjtRQUN6QyxrQkFBa0IsRUFBRSw2QkFBNkI7S0FDbEQsQ0FBQyxDQUFDO0FBQ0wsQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQVMscUJBQXFCLENBQzVCLEtBQW1DLEVBQ25DLGFBQXNDO0lBRXRDLElBQUksYUFBYSxFQUFFLGVBQWUsS0FBSyxJQUFJLElBQUksS0FBSyxDQUFDLGFBQWEsS0FBSyxTQUFTLEVBQUUsQ0FBQztRQUNqRixPQUFPLEVBQUUsR0FBRyxLQUFLLEVBQUUsYUFBYSxFQUFFLElBQUksRUFBRSxDQUFDO0lBQzNDLENBQUM7SUFDRCxPQUFPLEtBQUssQ0FBQztBQUNmLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB0eXBlICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyBodHRwQXBpQWNjZXNzTG9nRm9ybWF0LCByZXRlbnRpb25Gb3IgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUFwaURvbWFpbiB9IGZyb20gXCIuL2FwaS1kb21haW5cIjtcbmltcG9ydCB7IGJ1aWxkQ29yc1ByZWZsaWdodCB9IGZyb20gXCIuL2NvcnNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5pbXBvcnQgeyBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQgfSBmcm9tIFwiLi9yb3V0ZS1pZHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnMge1xuICAvKipcbiAgICogQWxsb3dlZCBvcmlnaW5zLlxuICAgKiBAZGVmYXVsdCBbXCIqXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd09yaWdpbnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWxsb3dlZCBIVFRQIG1ldGhvZHMuXG4gICAqIEBkZWZhdWx0IFtcIkdFVFwiLCBcIlBPU1RcIiwgXCJQVVRcIiwgXCJERUxFVEVcIiwgXCJQQVRDSFwiLCBcIkhFQURcIiwgXCJPUFRJT05TXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd01ldGhvZHM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWxsb3dlZCBoZWFkZXJzLlxuICAgKiBAZGVmYXVsdCBbXCJjb250ZW50LXR5cGVcIiwgXCJhdXRob3JpemF0aW9uXCIsIFwieC1yZXF1ZXN0LWlkXCIsIFwieC10ZW5hbnQtaWRcIl1cbiAgICovXG4gIHJlYWRvbmx5IGFsbG93SGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBFeHBvc2VkIHJlc3BvbnNlIGhlYWRlcnMuXG4gICAqIEBkZWZhdWx0IFtcIngtcmVxdWVzdC1pZFwiXVxuICAgKi9cbiAgcmVhZG9ubHkgZXhwb3NlSGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGJyb3dzZXJzIG1heSBzZW5kIGNyZWRlbnRpYWxzLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dDcmVkZW50aWFscz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEJyb3dzZXIgcHJlZmxpZ2h0IGNhY2hlIGR1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5taW51dGVzKDEwKVxuICAgKi9cbiAgcmVhZG9ubHkgbWF4QWdlPzogRHVyYXRpb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnMge1xuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBuYW1lLCBmb3IgZXhhbXBsZSBgYXBpLmV4YW1wbGUuY29tYC5cbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLlxuICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKipcbiAgICogQUNNIGNlcnRpZmljYXRlIEFSTi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3Igb3B0aW9uYWwgQ05BTUUgcmVjb3JkIGNyZWF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gIC8qKlxuICAgKiBBUEkgbWFwcGluZyBrZXkgdW5kZXIgdGhlIGN1c3RvbSBkb21haW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXBpTWFwcGluZ0tleT86IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgdG8gbWFwLiBEZWZhdWx0cyB0byB0aGlzIGNvbnN0cnVjdCdzIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB0aGlzLnN0YWdlXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhIENOQU1FIHdoZW4gaG9zdGVkWm9uZSBpcyBwcm92aWRlZC5cbiAgICogQGRlZmF1bHQgdHJ1ZSB3aGVuIGhvc3RlZFpvbmUgaXMgcHJvdmlkZWRcbiAgICovXG4gIHJlYWRvbmx5IGNyZWF0ZUNuYW1lPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQ05BTUUgcmVjb3JkIFRUTC5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24uc2Vjb25kcygzMDApXG4gICAqL1xuICByZWFkb25seSByZWNvcmRUdGw/OiBEdXJhdGlvbjtcblxuICAvKipcbiAgICogTXV0dWFsIFRMUyBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uPzogYXBpZ3d2Mi5NVExTQ29uZmlnO1xuXG4gIC8qKlxuICAgKiBUTFMgc2VjdXJpdHkgcG9saWN5LlxuICAgKiBAZGVmYXVsdCBBUEkgR2F0ZXdheSBkZWZhdWx0XG4gICAqL1xuICByZWFkb25seSBzZWN1cml0eVBvbGljeT86IGFwaWd3djIuU2VjdXJpdHlQb2xpY3k7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgb3IgcHJvdmlkZSBhIGxvZyBncm91cC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuIHwgbG9ncy5JTG9nR3JvdXA7XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGFuIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIEFQSSBHYXRld2F5IHYyIGFjY2Vzcy1sb2cgZm9ybWF0LiBEZWZhdWx0cyB0byB0aGUgQXBwVGhlb3J5IEpTT04gZm9ybWF0LlxuICAgKiBWYWxpZCBvbmx5IHdoZW4gYGFjY2Vzc0xvZ2dpbmdgIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IHRoZSBBcHBUaGVvcnkgSlNPTiBhY2Nlc3MtbG9nIGZvcm1hdFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIHJhdGUgbGltaXQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBAZGVwcmVjYXRlZCBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSSBzdGFnZXMgYXJlIG5vdCBzdXBwb3J0ZWQgV0FGdjIgcmVnaW9uYWxcbiAqIGFzc29jaWF0aW9uIHRhcmdldHMuIFVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgd2l0aFxuICogQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIGZvciBXQUYtcHJvdGVjdGVkIFJFU1QgQVBJIHN0YWdlcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpV2FmT3B0aW9ucyBleHRlbmRzIEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyB7fVxuXG4vKiogR2F0ZXdheSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIGFuIGV4cGxpY2l0IEFwcFRoZW9yeUh0dHBBcGkgcm91dGUuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyIHtcbiAgLyoqIEFXUyBJQU0gKFNpZ1Y0KSBvbiB0aGUgcm91dGUuICovXG4gIElBTSA9IFwiaWFtXCIsXG4gIC8qKiBObyBnYXRld2F5IGF1dGhvcml6ZXI7IHRoZSBydW50aW1lIG93bnMgYWRtaXNzaW9uLiAqL1xuICBOT05FID0gXCJub25lXCIsXG59XG5cbi8qKlxuICogT25lIGV4cGxpY2l0LCBzZW1hbnRpY2FsbHkgaWRlbnRpZmllZCByb3V0ZSBhZGRlZCBhbG9uZ3NpZGUgdGhlIGNvbnN0cnVjdCdzXG4gKiBncmVlZHkgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gIHJvdXRlcy5cbiAqXG4gKiBBUEkgR2F0ZXdheSBwcmVjZWRlbmNlIGdpdmVzIGEgZnVsbCBtZXRob2QrcGF0aCBtYXRjaCBwcmlvcml0eSBvdmVyIHRoZVxuICogZ3JlZWR5IHJvdXRlcywgc28gYSBtb3JlIHNwZWNpZmljIHJvdXRlIHdpdGggYSBzdHJpY3RlciBhdXRob3JpemVyIChmb3JcbiAqIGV4YW1wbGUgYEFXU19JQU1gKSB3aW5zIGZvciBpdHMgb3duIHBhdGguIEEgd3JvbmctbWV0aG9kIHJlcXVlc3Qgb24gc3VjaCBhXG4gKiBwYXRoIGZhbGxzIHRocm91Z2ggdG8gdGhlIHJ1bnRpbWUncyBmYWlsLWNsb3NlZCA0MDQvNDA1IHdoZW4gdGhlIHJ1bnRpbWUgZG9lc1xuICogbm90IGRlY2xhcmUgaXQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVJvdXRlT3B0aW9ucyB7XG4gIC8qKiBBYnNvbHV0ZSByb3V0ZSBwYXRoLiBTZWdtZW50cyBhcmUgbGl0ZXJhbHMsIGB7cGFyYW1ldGVyfWAsIG9yIGB7cHJveHkrfWAgc2VnbWVudHMuICovXG4gIHJlYWRvbmx5IHBhdGg6IHN0cmluZztcbiAgLyoqIEhUVFAgbWV0aG9kcyB3aXJlZCBmb3IgdGhlIHJvdXRlLCBmb3IgZXhhbXBsZSBgW1wiR0VUXCJdYCBvciBgW1wiQU5ZXCJdYC4gKi9cbiAgcmVhZG9ubHkgbWV0aG9kczogc3RyaW5nW107XG4gIC8qKlxuICAgKiBHYXRld2F5IGF1dGhvcml6YXRpb24gcG9zdHVyZSBmb3IgdGhlIHJvdXRlLlxuICAgKlxuICAgKiBPbWl0IGZvciBgTk9ORWAuIEV2ZXJ5IGV4cGxpY2l0IHZhbHVlIG90aGVyIHRoYW4gYElBTWAgb3IgYE5PTkVgIOKAlCBhblxuICAgKiB1cHBlcmNhc2Ugc3BlbGxpbmcsIGEgbWlzc3BlbGxpbmcsIGBudWxsYCwgYSBudW1iZXIsIGFuIG9iamVjdCwgb3IgYW55XG4gICAqIHVuY2hlY2tlZCBjb25maWd1cmF0aW9uIHZhbHVlIOKAlCBmYWlscyBzeW50aGVzaXMgYmVmb3JlIHRoaXMgcm91dGUgaXNcbiAgICogZW1pdHRlZCBpbnN0ZWFkIG9mIHNpbGVudGx5IGZhbGxpbmcgYmFjayB0byBgTk9ORWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIuTk9ORVxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplcj86IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXI7XG59XG5cbi8qKiBSb3V0ZS1sZXZlbCB0aHJvdHRsaW5nIGFwcGxpZWQgdG8gb25lIEFQSSBHYXRld2F5IHJvdXRlIGtleS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVJvdXRlVGhyb3R0bGluZyB7XG4gIC8qKiBSZXF1ZXN0cyBwZXIgc2Vjb25kIGZvciB0aGUgcm91dGUga2V5LiBAZGVmYXVsdCB0aGUgc3RhZ2UgZGVmYXVsdCAqL1xuICByZWFkb25seSByYXRlTGltaXQ/OiBudW1iZXI7XG4gIC8qKiBCdXJzdCBsaW1pdCBmb3IgdGhlIHJvdXRlIGtleS4gQGRlZmF1bHQgdGhlIHN0YWdlIGRlZmF1bHQgKi9cbiAgcmVhZG9ubHkgYnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpUHJvcHMge1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dC5cbiAgICpcbiAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIEFQSSBhY2Nlc3MgbG9nZ2luZyBpcyBvbiBieSBkZWZhdWx0IHRvIGFcbiAgICogbG9nIGdyb3VwIG5hbWVkIGBsb2dzL2FjY2Vzcy9hcGkve2xvZ2ljYWxOYW1lfWAgY2FycnlpbmcgdGhlIGNvbnRyYWN0J3NcbiAgICogSlNPTiBmaWVsZCBzZXQuIFBhc3MgYHN0YWdlLmFjY2Vzc0xvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0LlxuICAgKlxuICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAvKipcbiAgICogVGhlIEFQSSdzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZCB3aGVuIGFcbiAgICogbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgSFRUUCBBUEkgdjIgcm91dGVzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICogb25lIHBlcm1pc3Npb24gcGVyIHJvdXRlLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIHJvdXRlIGZhbWlsaWVzIHRoYXQgc2hhcmUgb25lXG4gICAqIExhbWJkYSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlIHBvbGljeSBzaXplXG4gICAqIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgaGFuZGxlciwgbm90IG9ubHkgdGhlIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQ09SUyBjb25maWd1cmF0aW9uLiBTZXQgdG8gdHJ1ZSBmb3IgQXBwVGhlb3J5IGRlZmF1bHRzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBFeHBsaWNpdCwgc2VtYW50aWNhbGx5IGlkZW50aWZpZWQgcm91dGVzIGFkZGVkIGFsb25nc2lkZSB0aGUgY29uc3RydWN0J3NcbiAgICogZ3JlZWR5IGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCByb3V0ZXMuXG4gICAqXG4gICAqIFVzZSB0aGlzIHdoZXJlIGEgc3RyaWN0ZXIgcGVyLXBhdGggZ2F0ZXdheSBwb3N0dXJlIChmb3IgZXhhbXBsZVxuICAgKiBgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5JQU1gKSBtdXN0IHdpbiBvdmVyIHRoZSBncmVlZHkgcm91dGVzOiBhXG4gICAqIGZ1bGwgbWV0aG9kK3BhdGggbWF0Y2ggb3V0cmFua3MgdGhlIGdyZWVkeSByb3V0ZSBieSBBUEkgR2F0ZXdheSBwcmVjZWRlbmNlLFxuICAgKiBhbmQgYSB3cm9uZy1tZXRob2QgcmVxdWVzdCBvbiBzdWNoIGEgcGF0aCBpcyBkZW5pZWQgYnkgdGhlIHJ1bnRpbWUgd2l0aCB0aGVcbiAgICogZmFpbC1jbG9zZWQgNDA0LzQwNSBlbnZlbG9wZS5cbiAgICpcbiAgICogUm91dGUgY29uc3RydWN0IGlkcyBhcmUgZGVyaXZlZCBmcm9tIHRoZSBtZXRob2QgYW5kIHBhdGgsIHNvIGluc2VydGluZyxcbiAgICogcmVtb3ZpbmcsIG9yIHJlb3JkZXJpbmcgYW4gZW50cnkgbmV2ZXIgcmVuYW1lcyBhbiB1bnJlbGF0ZWQgcm91dGUuXG4gICAqXG4gICAqIEEgZGVjbGFyZWQgYE9QVElPTlNgIHJvdXRlIGNvZXhpc3RzIHdpdGgsIGFuZCBjYW4gYmUgc2hhZG93ZWQgYnksIHRoZVxuICAgKiBBUEktbGV2ZWwgQ09SUyBjb25maWd1cmF0aW9uIGBjb3JzYCBpbnN0YWxscy4gYGJ1aWxkQ29yc1ByZWZsaWdodGAgaW5jbHVkZXNcbiAgICogYE9QVElPTlNgIGluIGl0cyBkZWZhdWx0IGBhbGxvd01ldGhvZHNgLCBhbmQgd2hpbGUgYE9QVElPTlNgIGlzIGluIHRoYXRcbiAgICogbGlzdCBBUEkgR2F0ZXdheSBhbnN3ZXJzIG1hdGNoaW5nIHByZWZsaWdodCByZXF1ZXN0cyBpdHNlbGYgYmVmb3JlIHRoZVxuICAgKiByb3V0ZSBpbnRlZ3JhdGlvbiBydW5zLCBzbyBhIGRlY2xhcmVkIGBPUFRJT05TYCByb3V0ZSBvbiB0aGUgc2FtZSBwYXRoIGlzXG4gICAqIG5ldmVyIHJlYWNoZWQuIFNldHRpbmcgYGNvcnMuYWxsb3dNZXRob2RzYCB3aXRob3V0IGBPUFRJT05TYCByZW1vdmVzIGdhdGV3YXlcbiAgICogcHJlZmxpZ2h0IGhhbmRsaW5nIGVudGlyZWx5OyBhIGRlY2xhcmVkIGBPUFRJT05TYCByb3V0ZSBpcyB0aGVuIHRoZSBvbmx5XG4gICAqIHRoaW5nIHRoYXQgYW5zd2VycyBhIHByZWZsaWdodCByZXF1ZXN0LCBhbmQgaXQgaXMgc3ViamVjdCB0byB0aGF0IHJvdXRlJ3NcbiAgICogb3duIGF1dGhvcml6ZXIuIERlY2xhcmUgdGhlIG1ldGhvZHMgeW91IG5lZWQgaW4gYGNvcnMuYWxsb3dNZXRob2RzYCByYXRoZXJcbiAgICogdGhhbiBkZXBlbmRpbmcgb24gYSBkZWNsYXJlZCBgT1BUSU9OU2Agcm91dGUuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVzPzogQXBwVGhlb3J5SHR0cEFwaVJvdXRlT3B0aW9uc1tdO1xuXG4gIC8qKlxuICAgKiBSb3V0ZS1sZXZlbCB0aHJvdHRsaW5nIGtleWVkIGJ5IEFQSSBHYXRld2F5IHJvdXRlIGtleSAoZm9yIGV4YW1wbGVcbiAgICogYFwiQU5ZIC97cHJveHkrfVwiYCkuIEFwcGxpZWQgdG8gdGhlIHN0YWdlJ3Mgcm91dGUgc2V0dGluZ3MuXG4gICAqXG4gICAqIEV2ZXJ5IGtleSBpcyB2YWxpZGF0ZWQgYXQgc3ludGhlc2lzIHRpbWUgYWdhaW5zdCB0aGUgcm91dGUga2V5cyB0aGlzXG4gICAqIGNvbnN0cnVjdCBlbWl0cyDigJQgdGhlIGdyZWVkeSBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAgcm91dGVzIHBsdXMgb25lXG4gICAqIGA8TUVUSE9EPiA8cGF0aD5gIGtleSBwZXIgYHJvdXRlc2AgZW50cnkuIEEga2V5IHRoYXQgbWF0Y2hlcyBubyBlbWl0dGVkXG4gICAqIHJvdXRlIGZhaWxzIHN5bnRoZXNpcyB3aXRoIGEgbmFtZWQgZXJyb3IgbGlzdGluZyB0aGUgZW1pdHRlZCBrZXlzLCByYXRoZXJcbiAgICogdGhhbiBiZWluZyBzaWxlbnRseSBpZ25vcmVkIGJ5IEFQSSBHYXRld2F5LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHJvdXRlU2V0dGluZ3M/OiB7IFtyb3V0ZUtleTogc3RyaW5nXTogQXBwVGhlb3J5SHR0cEFwaVJvdXRlVGhyb3R0bGluZyB9O1xuXG4gIC8qKlxuICAgKiBDdXN0b20gZG9tYWluIGNvbmZpZ3VyYXRpb24uXG4gICAqXG4gICAqIFdoZW4gYGRvbWFpbi5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbmAgaXMgc2V0LCBBcHBUaGVvcnkgZmFpbHMgY2xvc2VkIGFuZFxuICAgKiBkaXNhYmxlcyB0aGUgZGVmYXVsdCBgZXhlY3V0ZS1hcGlgIGVuZHBvaW50IHNvIHRoZSBBUEkgaXMgcmVhY2hhYmxlIG9ubHlcbiAgICogdGhyb3VnaCB0aGUgbXV0dWFsLVRMUyBjdXN0b20gZG9tYWluLiBXaXRob3V0IG11dHVhbCBUTFMgdGhlIGRlZmF1bHRcbiAgICogZW5kcG9pbnQga2VlcHMgdGhlIEFXUyBkZWZhdWx0IChlbmFibGVkKSwgc28gb3JkaW5hcnkgY3VzdG9tIGRvbWFpbnMgYXJlXG4gICAqIHVuYWZmZWN0ZWQuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlIdHRwQXBpU3RhZ2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBSZWdpb25hbCBXQUYgYXR0YWNobWVudCBpcyBpbnRlbnRpb25hbGx5IHVuYXZhaWxhYmxlIGZvciBBUEkgR2F0ZXdheSB2MlxuICAgKiBIVFRQIEFQSXMuIFN1cHBseWluZyB0aGlzIHByb3AgZmFpbHMgY2xvc2VkIGR1cmluZyBzeW50aGVzaXMgaW5zdGVhZCBvZlxuICAgKiBwcm9kdWNpbmcgYW4gdW5zdXBwb3J0ZWQgYC9hcGlzLy4uLi9zdGFnZXMvLi4uYCBXZWJBQ0wgYXNzb2NpYXRpb24uXG4gICAqXG4gICAqIFVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgd2hlbiBhIFdBRi1wcm90ZWN0ZWQgQVBJXG4gICAqIEdhdGV3YXkgc3RhZ2UgaXMgcmVxdWlyZWQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKiBAZGVwcmVjYXRlZCBIVFRQIEFQSSBXQUYgYXNzb2NpYXRpb24gaXMgdW5zdXBwb3J0ZWQgYnkgQVdTIFdBRnYyLlxuICAgKi9cbiAgcmVhZG9ubHkgd2FmPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlXYWZPcHRpb25zO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5SHR0cEFwaSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSHR0cEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlnd3YyLklTdGFnZTtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG4gIHB1YmxpYyByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlBcGlEb21haW47XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeUh0dHBBcGlQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAocHJvcHMud2FmKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5SHR0cEFwaSBkb2VzIG5vdCBzdXBwb3J0IFdBRnYyIHJlZ2lvbmFsIFdlYkFDTCBhc3NvY2lhdGlvbnMgZm9yIEFQSSBHYXRld2F5IHYyIEhUVFAgQVBJczsgdXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciBmb3IgV0FGLXByb3RlY3RlZCBSRVNUIHN0YWdlc1wiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCBjb25maWd1cmVkU3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgY29uc3Qgc3RhZ2VPcHRzID0gZWZmZWN0aXZlU3RhZ2VPcHRpb25zKGNvbmZpZ3VyZWRTdGFnZU9wdHMsIHByb3BzLm5hbWluZ0NvbnRleHQpO1xuICAgIGNvbnN0IHN0YWdlTmFtZSA9IHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nRm9ybWF0ICE9PSB1bmRlZmluZWQgJiYgIXN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpOiBzdGFnZS5hY2Nlc3NMb2dGb3JtYXQgcmVxdWlyZXMgc3RhZ2UuYWNjZXNzTG9nZ2luZ1wiKTtcbiAgICB9XG4gICAgY29uc3QgbmFtaW5nQ29udGV4dCA9IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgY29uc3QgbG9naWNhbCA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChuYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICBjb25zdCBuZWVkc0V4cGxpY2l0U3RhZ2UgPSBzdGFnZU5hbWUgIT09IFwiJGRlZmF1bHRcIlxuICAgICAgfHwgc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmdcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkO1xuXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IHByb3BzLmFwaU5hbWUgPz8gKG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICA/IG5hbWluZ0NvbnRleHQucGh5c2ljYWxOYW1lKFwiYXBpX2h0dHBcIiwgbG9naWNhbCkubmFtZVxuICAgICAgICA6IHByb3BzLmFwaU5hbWUpLFxuICAgICAgY29yc1ByZWZsaWdodDogYnVpbGRDb3JzUHJlZmxpZ2h0KHByb3BzLmNvcnMpLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlLFxuICAgICAgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludDogcHJvcHMuZG9tYWluPy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbiAhPT0gdW5kZWZpbmVkID8gdHJ1ZSA6IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0YWdlID0gbmVlZHNFeHBsaWNpdFN0YWdlXG4gICAgICA/IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgICB0aHJvdHRsZTogKHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIH0pXG4gICAgICA6IHRoaXMuYXBpLmRlZmF1bHRTdGFnZTtcbiAgICBpZiAoIXN0YWdlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpOiBmYWlsZWQgdG8gY3JlYXRlIEFQSSBzdGFnZVwiKTtcbiAgICB9XG4gICAgdGhpcy5zdGFnZSA9IHN0YWdlO1xuICAgIHRoaXMuY29uZmlndXJlQWNjZXNzTG9nZ2luZyhzdGFnZU9wdHMsIHN0YWdlLCBuYW1pbmdDb250ZXh0LCBsb2dpY2FsKTtcblxuICAgIC8vIEV2ZXJ5IHJvdXRlIGtleSB0aGlzIGNvbnN0cnVjdCBlbWl0cywgaW4gQVBJIEdhdGV3YXkgYE1FVEhPRCBwYXRoYCBmb3JtLlxuICAgIC8vIGByb3V0ZVNldHRpbmdzYCBpcyB2YWxpZGF0ZWQgYWdhaW5zdCB0aGlzIHNldCBzbyBhIHR5cG8gaXMgYSBuYW1lZFxuICAgIC8vIHN5bnRoZXNpcyBlcnJvciBpbnN0ZWFkIG9mIHNpbGVudGx5IGlnbm9yZWQgc3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICBjb25zdCBlbWl0dGVkUm91dGVLZXlzID0gbmV3IFNldChbXCJBTlkgL1wiLCBcIkFOWSAve3Byb3h5K31cIl0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL1wiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5BTlldLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIlJvb3RcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIve3Byb3h5K31cIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuQU5ZXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJQcm94eVwiLCBwcm9wcy5oYW5kbGVyLCB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGV4cGxpY2l0Um91dGVzID0gcHJvcHMucm91dGVzID8/IFtdO1xuICAgIGlmIChleHBsaWNpdFJvdXRlcy5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLmFkZEV4cGxpY2l0Um91dGVzKGV4cGxpY2l0Um91dGVzLCBwcm9wcy5oYW5kbGVyLCBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsIGVtaXR0ZWRSb3V0ZUtleXMpO1xuICAgIH1cbiAgICBpZiAocHJvcHMucm91dGVTZXR0aW5ncyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25maWd1cmVSb3V0ZVNldHRpbmdzKHN0YWdlLCBwcm9wcy5yb3V0ZVNldHRpbmdzLCBlbWl0dGVkUm91dGVLZXlzKTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICB0aGlzLmNvbmZpZ3VyZURvbWFpbihwcm9wcy5kb21haW4pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWRkRXhwbGljaXRSb3V0ZXMoXG4gICAgcm91dGVzOiBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zW10sXG4gICAgcm91dGVIYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IGJvb2xlYW4sXG4gICAgZW1pdHRlZFJvdXRlS2V5czogU2V0PHN0cmluZz4sXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiRXhwbGljaXRcIiwgcm91dGVIYW5kbGVyLCB7XG4gICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGUsXG4gICAgfSk7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2Ygcm91dGVzKSB7XG4gICAgICBjb25zdCByb3V0ZVBhdGggPSBub3JtYWxpemVFeHBsaWNpdFJvdXRlUGF0aChyb3V0ZS5wYXRoKTtcbiAgICAgIGNvbnN0IGNvbmZpZ3VyZWRNZXRob2RzID0gcm91dGUubWV0aG9kcyA/PyBbXTtcbiAgICAgIGlmIChjb25maWd1cmVkTWV0aG9kcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgZW50cnkgZm9yICR7SlNPTi5zdHJpbmdpZnkocm91dGVQYXRoKX0gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIG1ldGhvZGAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IHJhd01ldGhvZCBvZiBjb25maWd1cmVkTWV0aG9kcykge1xuICAgICAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcocmF3TWV0aG9kKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgICAgICAgaWYgKCFFWFBMSUNJVF9ST1VURV9NRVRIT0RTLmhhcyhtZXRob2QpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBtZXRob2QgbXVzdCBiZSBvbmUgb2YgJHtbLi4uRVhQTElDSVRfUk9VVEVfTUVUSE9EU10uam9pbihcIiwgXCIpfSAoZ290ICR7SlNPTi5zdHJpbmdpZnkocmF3TWV0aG9kKX0pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJvdXRlSWQgPSBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQobWV0aG9kLCByb3V0ZVBhdGgpO1xuICAgICAgICBpZiAoc2Vlbi5oYXMocm91dGVJZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIGNvbnRhaW5zIHRoZSBkdXBsaWNhdGUgcm91dGUgJHttZXRob2R9ICR7cm91dGVQYXRofWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBzZWVuLmFkZChyb3V0ZUlkKTtcbiAgICAgICAgZW1pdHRlZFJvdXRlS2V5cy5hZGQoYCR7bWV0aG9kfSAke3JvdXRlUGF0aH1gKTtcbiAgICAgICAgbmV3IGFwaWd3djIuSHR0cFJvdXRlKHRoaXMsIHJvdXRlSWQsIHtcbiAgICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChyb3V0ZVBhdGgsIG1ldGhvZCBhcyBhcGlnd3YyLkh0dHBNZXRob2QpLFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIGF1dGhvcml6ZXI6IGV4cGxpY2l0Um91dGVBdXRob3JpemVyKHJvdXRlLmF1dGhvcml6ZXIpLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZUFjY2Vzc0xvZ2dpbmcoXG4gICAgc3RhZ2VPcHRzOiBBcHBUaGVvcnlIdHRwQXBpU3RhZ2VPcHRpb25zLFxuICAgIHN0YWdlOiBhcGlnd3YyLklTdGFnZSxcbiAgICBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCxcbiAgICBsb2dpY2FsPzogc3RyaW5nLFxuICApOiB2b2lkIHtcbiAgICBpZiAoIXN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhbmRhcmQgPSBuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWU7XG4gICAgaWYgKHN0YW5kYXJkICYmICFsb2dpY2FsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpIHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSBsb2dpY2FsIG5hbWVcIik7XG4gICAgfVxuICAgIGxldCBsb2dHcm91cDogbG9ncy5JTG9nR3JvdXA7XG4gICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlKSB7XG4gICAgICBsb2dHcm91cCA9IHN0YW5kYXJkICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICA/IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgICBsb2dHcm91cE5hbWU6IG5hbWluZ0NvbnRleHQubG9nR3JvdXBOYW1lKGBsb2dzL2FjY2Vzcy9hcGkvJHtsb2dpY2FsfWApLFxuICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IobmFtaW5nQ29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICB9KVxuICAgICAgICA6IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgICAgICB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgbG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICB9XG4gICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICBmb3JtYXQ6IHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQgPz8gKHN0YW5kYXJkID8gaHR0cEFwaUFjY2Vzc0xvZ0Zvcm1hdCgpIDogZGVmYXVsdEFjY2Vzc0xvZ0Zvcm1hdCgpKSxcbiAgICB9O1xuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVEb21haW4ob3B0aW9uczogQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnMpOiB2b2lkIHtcbiAgICBjb25zdCBjZXJ0aWZpY2F0ZSA9IG9wdGlvbnMuY2VydGlmaWNhdGUgPz8gKG9wdGlvbnMuY2VydGlmaWNhdGVBcm5cbiAgICAgID8gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybih0aGlzLCBcIkltcG9ydGVkQ2VydGlmaWNhdGVcIiwgb3B0aW9ucy5jZXJ0aWZpY2F0ZUFybilcbiAgICAgIDogdW5kZWZpbmVkKTtcbiAgICBpZiAoIWNlcnRpZmljYXRlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpIGRvbWFpbiByZXF1aXJlcyBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm5cIik7XG4gICAgfVxuXG4gICAgY29uc3QgZG9tYWluID0gbmV3IEFwcFRoZW9yeUFwaURvbWFpbih0aGlzLCBcIkRvbWFpblwiLCB7XG4gICAgICBkb21haW5OYW1lOiBvcHRpb25zLmRvbWFpbk5hbWUsXG4gICAgICBjZXJ0aWZpY2F0ZSxcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgc3RhZ2U6IG9wdGlvbnMuc3RhZ2UgPz8gdGhpcy5zdGFnZSxcbiAgICAgIGhvc3RlZFpvbmU6IG9wdGlvbnMuaG9zdGVkWm9uZSxcbiAgICAgIGFwaU1hcHBpbmdLZXk6IG9wdGlvbnMuYXBpTWFwcGluZ0tleSxcbiAgICAgIGNyZWF0ZUNuYW1lOiBvcHRpb25zLmNyZWF0ZUNuYW1lLFxuICAgICAgcmVjb3JkVHRsOiBvcHRpb25zLnJlY29yZFR0bCxcbiAgICAgIG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uOiBvcHRpb25zLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uLFxuICAgICAgc2VjdXJpdHlQb2xpY3k6IG9wdGlvbnMuc2VjdXJpdHlQb2xpY3ksXG4gICAgfSk7XG4gICAgKHRoaXMgYXMgeyBkb21haW4/OiBBcHBUaGVvcnlBcGlEb21haW4gfSkuZG9tYWluID0gZG9tYWluO1xuICB9XG59XG5cbmNvbnN0IEVYUExJQ0lUX1JPVVRFX01FVEhPRFMgPSBuZXcgU2V0KFtcbiAgXCJBTllcIixcbiAgXCJERUxFVEVcIixcbiAgXCJHRVRcIixcbiAgXCJIRUFEXCIsXG4gIFwiT1BUSU9OU1wiLFxuICBcIlBBVENIXCIsXG4gIFwiUE9TVFwiLFxuICBcIlBVVFwiLFxuXSk7XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUV4cGxpY2l0Um91dGVQYXRoKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCByb3V0ZVBhdGggPSBTdHJpbmcodmFsdWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAocm91dGVQYXRoID09PSBcIlwiIHx8ICFyb3V0ZVBhdGguc3RhcnRzV2l0aChcIi9cIikgfHwgKHJvdXRlUGF0aC5sZW5ndGggPiAxICYmIHJvdXRlUGF0aC5lbmRzV2l0aChcIi9cIikpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBwYXRoIG11c3QgYmUgYW4gYWJzb2x1dGUgcGF0aCB3aXRoIG5vIHRyYWlsaW5nIHNsYXNoIChnb3QgJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9KWAsXG4gICAgKTtcbiAgfVxuICBmb3IgKGNvbnN0IHNlZ21lbnQgb2Ygcm91dGVQYXRoLnNsaWNlKDEpLnNwbGl0KFwiL1wiKSkge1xuICAgIGlmIChzZWdtZW50ID09PSBcIlwiIHx8IHNlZ21lbnQgPT09IFwiLlwiIHx8IHNlZ21lbnQgPT09IFwiLi5cIikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIHBhdGggbXVzdCBub3QgY29udGFpbiBlbXB0eSBvciBkb3Qgc2VnbWVudHMgKGdvdCAke0pTT04uc3RyaW5naWZ5KHZhbHVlKX0pYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIHJldHVybiByb3V0ZVBhdGg7XG59XG5cbmZ1bmN0aW9uIGV4cGxpY2l0Um91dGVBdXRob3JpemVyKHBvc3R1cmU/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIGlmIChwb3N0dXJlID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gIH1cbiAgc3dpdGNoIChwb3N0dXJlKSB7XG4gICAgY2FzZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLklBTTpcbiAgICAgIHJldHVybiBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBJYW1BdXRob3JpemVyKCk7XG4gICAgY2FzZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLk5PTkU6XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djIuSHR0cE5vbmVBdXRob3JpemVyKCk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBhdXRob3JpemVyIG11c3QgYmUgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5JQU0gb3IgLk5PTkUgKGdvdCAke0pTT04uc3RyaW5naWZ5KHBvc3R1cmUpfSlgLFxuICAgICAgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjb25maWd1cmVSb3V0ZVNldHRpbmdzKFxuICBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UsXG4gIHNldHRpbmdzOiB7IFtyb3V0ZUtleTogc3RyaW5nXTogQXBwVGhlb3J5SHR0cEFwaVJvdXRlVGhyb3R0bGluZyB9LFxuICBlbWl0dGVkUm91dGVLZXlzOiBTZXQ8c3RyaW5nPixcbik6IHZvaWQge1xuICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gIGNvbnN0IG1hcHBlZDogeyBbcm91dGVLZXk6IHN0cmluZ106IHsgW3Byb3BlcnR5OiBzdHJpbmddOiBudW1iZXIgfSB9ID0ge307XG4gIGZvciAoY29uc3QgW3JvdXRlS2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MpKSB7XG4gICAgaWYgKCFlbWl0dGVkUm91dGVLZXlzLmhhcyhyb3V0ZUtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XSBkb2VzIG5vdCBtYXRjaCBhbnkgcm91dGUgdGhpcyBjb25zdHJ1Y3QgZW1pdHMgKGVtaXR0ZWQ6ICR7Wy4uLmVtaXR0ZWRSb3V0ZUtleXNdLnNvcnQoKS5tYXAoKGtleSkgPT4gSlNPTi5zdHJpbmdpZnkoa2V5KSkuam9pbihcIiwgXCIpfSlgLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgcmF0ZUxpbWl0ID0gdmFsdWUucmF0ZUxpbWl0O1xuICAgIGNvbnN0IGJ1cnN0TGltaXQgPSB2YWx1ZS5idXJzdExpbWl0O1xuICAgIGlmIChyYXRlTGltaXQgPT09IHVuZGVmaW5lZCAmJiBidXJzdExpbWl0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XSByZXF1aXJlcyByYXRlTGltaXQgb3IgYnVyc3RMaW1pdGAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgJiYgKCFOdW1iZXIuaXNGaW5pdGUocmF0ZUxpbWl0KSB8fCByYXRlTGltaXQgPD0gMCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XS5yYXRlTGltaXQgbXVzdCBiZSBhIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKGJ1cnN0TGltaXQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0Zpbml0ZShidXJzdExpbWl0KSB8fCBidXJzdExpbWl0IDw9IDApKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0uYnVyc3RMaW1pdCBtdXN0IGJlIGEgcG9zaXRpdmUgZmluaXRlIG51bWJlcmAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBlbnRyeTogeyBbcHJvcGVydHk6IHN0cmluZ106IG51bWJlciB9ID0ge307XG4gICAgaWYgKHJhdGVMaW1pdCAhPT0gdW5kZWZpbmVkKSBlbnRyeVtcIlRocm90dGxpbmdSYXRlTGltaXRcIl0gPSByYXRlTGltaXQ7XG4gICAgaWYgKGJ1cnN0TGltaXQgIT09IHVuZGVmaW5lZCkgZW50cnlbXCJUaHJvdHRsaW5nQnVyc3RMaW1pdFwiXSA9IGJ1cnN0TGltaXQ7XG4gICAgbWFwcGVkW3JvdXRlS2V5XSA9IGVudHJ5O1xuICB9XG4gIGNmblN0YWdlLnJvdXRlU2V0dGluZ3MgPSBtYXBwZWQ7XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHRBY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuXG4vKipcbiAqIEFwcGx5IHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUncyBkZWZhdWx0LW9uIGFjY2VzcyBsb2dnaW5nLiBBbiBleHBsaWNpdFxuICogYGFjY2Vzc0xvZ2dpbmdgIHZhbHVlLCBpbmNsdWRpbmcgYGZhbHNlYCwgYWx3YXlzIHdpbnMuXG4gKi9cbmZ1bmN0aW9uIGVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhcbiAgc3RhZ2U6IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMsXG4gIG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuKTogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucyB7XG4gIGlmIChuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgc3RhZ2UuYWNjZXNzTG9nZ2luZyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHsgLi4uc3RhZ2UsIGFjY2Vzc0xvZ2dpbmc6IHRydWUgfTtcbiAgfVxuICByZXR1cm4gc3RhZ2U7XG59XG4iXX0=