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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHttpApi", version: "6.4.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQ0Esc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMsNkNBQWtEO0FBQ2xELGlDQUE0QztBQUU1QywyQ0FBdUQ7QUFtSnZELDRFQUE0RTtBQUM1RSxJQUFZLCtCQUtYO0FBTEQsV0FBWSwrQkFBK0I7SUFDekMsb0NBQW9DO0lBQ3BDLDhDQUFXLENBQUE7SUFDWCx5REFBeUQ7SUFDekQsZ0RBQWEsQ0FBQTtBQUNmLENBQUMsRUFMVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQUsxQztBQXFJRCxNQUFhLGdCQUFpQixTQUFRLHNCQUFTOztJQUM3QixHQUFHLENBQWtCO0lBQ3JCLEtBQUssQ0FBaUI7SUFDdEIsY0FBYyxDQUFrQjtJQUNoQyxNQUFNLENBQXNCO0lBRTVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNkLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUxBQWlMLENBQ2xMLENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDcEMsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFDcEQsSUFBSSxTQUFTLENBQUMsZUFBZSxLQUFLLFNBQVMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUN4RSxNQUFNLElBQUksS0FBSyxDQUFDLHNFQUFzRSxDQUFDLENBQUM7UUFDMUYsQ0FBQztRQUNELE1B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QUFDLEdBQUcsU0FBUyxDQUFDO1FBQ3RFLElBQUksVUFBVSxLQUFLLFNBQVM7WUFBRSxLQUFLLENBQUMsc0JBQXNCLENBQUMsR0FBRyxVQUFVLENBQUM7UUFDekUsTUFBTSxDQUFDLFFBQVEsQ0FBQyxHQUFHLEtBQUssQ0FBQztJQUMzQixDQUFDO0lBQ0QsUUFBUSxDQUFDLGFBQWEsR0FBRyxNQUFNLENBQUM7QUFDbEMsQ0FBQztBQUVELFNBQVMsc0JBQXNCO0lBQzdCLE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQztRQUNwQixTQUFTLEVBQUUsb0JBQW9CO1FBQy9CLEVBQUUsRUFBRSw0QkFBNEI7UUFDaEMsV0FBVyxFQUFFLHNCQUFzQjtRQUNuQyxVQUFVLEVBQUUscUJBQXFCO1FBQ2pDLFFBQVEsRUFBRSxtQkFBbUI7UUFDN0IsTUFBTSxFQUFFLGlCQUFpQjtRQUN6QixRQUFRLEVBQUUsbUJBQW1CO1FBQzdCLGNBQWMsRUFBRSx5QkFBeUI7UUFDekMsa0JBQWtCLEVBQUUsNkJBQTZCO0tBQ2xELENBQUMsQ0FBQztBQUNMLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB0eXBlICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUFwaURvbWFpbiB9IGZyb20gXCIuL2FwaS1kb21haW5cIjtcbmltcG9ydCB7IGJ1aWxkQ29yc1ByZWZsaWdodCB9IGZyb20gXCIuL2NvcnNcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIH0gZnJvbSBcIi4vcmVnaW9uYWwtd2FmXCI7XG5pbXBvcnQgeyBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQgfSBmcm9tIFwiLi9yb3V0ZS1pZHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnMge1xuICAvKipcbiAgICogQWxsb3dlZCBvcmlnaW5zLlxuICAgKiBAZGVmYXVsdCBbXCIqXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd09yaWdpbnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWxsb3dlZCBIVFRQIG1ldGhvZHMuXG4gICAqIEBkZWZhdWx0IFtcIkdFVFwiLCBcIlBPU1RcIiwgXCJQVVRcIiwgXCJERUxFVEVcIiwgXCJQQVRDSFwiLCBcIkhFQURcIiwgXCJPUFRJT05TXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd01ldGhvZHM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWxsb3dlZCBoZWFkZXJzLlxuICAgKiBAZGVmYXVsdCBbXCJjb250ZW50LXR5cGVcIiwgXCJhdXRob3JpemF0aW9uXCIsIFwieC1yZXF1ZXN0LWlkXCIsIFwieC10ZW5hbnQtaWRcIl1cbiAgICovXG4gIHJlYWRvbmx5IGFsbG93SGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBFeHBvc2VkIHJlc3BvbnNlIGhlYWRlcnMuXG4gICAqIEBkZWZhdWx0IFtcIngtcmVxdWVzdC1pZFwiXVxuICAgKi9cbiAgcmVhZG9ubHkgZXhwb3NlSGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGJyb3dzZXJzIG1heSBzZW5kIGNyZWRlbnRpYWxzLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dDcmVkZW50aWFscz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEJyb3dzZXIgcHJlZmxpZ2h0IGNhY2hlIGR1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5taW51dGVzKDEwKVxuICAgKi9cbiAgcmVhZG9ubHkgbWF4QWdlPzogRHVyYXRpb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnMge1xuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBuYW1lLCBmb3IgZXhhbXBsZSBgYXBpLmV4YW1wbGUuY29tYC5cbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLlxuICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKipcbiAgICogQUNNIGNlcnRpZmljYXRlIEFSTi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3Igb3B0aW9uYWwgQ05BTUUgcmVjb3JkIGNyZWF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gIC8qKlxuICAgKiBBUEkgbWFwcGluZyBrZXkgdW5kZXIgdGhlIGN1c3RvbSBkb21haW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXBpTWFwcGluZ0tleT86IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgdG8gbWFwLiBEZWZhdWx0cyB0byB0aGlzIGNvbnN0cnVjdCdzIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB0aGlzLnN0YWdlXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhIENOQU1FIHdoZW4gaG9zdGVkWm9uZSBpcyBwcm92aWRlZC5cbiAgICogQGRlZmF1bHQgdHJ1ZSB3aGVuIGhvc3RlZFpvbmUgaXMgcHJvdmlkZWRcbiAgICovXG4gIHJlYWRvbmx5IGNyZWF0ZUNuYW1lPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQ05BTUUgcmVjb3JkIFRUTC5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24uc2Vjb25kcygzMDApXG4gICAqL1xuICByZWFkb25seSByZWNvcmRUdGw/OiBEdXJhdGlvbjtcblxuICAvKipcbiAgICogTXV0dWFsIFRMUyBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uPzogYXBpZ3d2Mi5NVExTQ29uZmlnO1xuXG4gIC8qKlxuICAgKiBUTFMgc2VjdXJpdHkgcG9saWN5LlxuICAgKiBAZGVmYXVsdCBBUEkgR2F0ZXdheSBkZWZhdWx0XG4gICAqL1xuICByZWFkb25seSBzZWN1cml0eVBvbGljeT86IGFwaWd3djIuU2VjdXJpdHlQb2xpY3k7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgb3IgcHJvdmlkZSBhIGxvZyBncm91cC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuIHwgbG9ncy5JTG9nR3JvdXA7XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGFuIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIEFQSSBHYXRld2F5IHYyIGFjY2Vzcy1sb2cgZm9ybWF0LiBEZWZhdWx0cyB0byB0aGUgQXBwVGhlb3J5IEpTT04gZm9ybWF0LlxuICAgKiBWYWxpZCBvbmx5IHdoZW4gYGFjY2Vzc0xvZ2dpbmdgIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IHRoZSBBcHBUaGVvcnkgSlNPTiBhY2Nlc3MtbG9nIGZvcm1hdFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIHJhdGUgbGltaXQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBAZGVwcmVjYXRlZCBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSSBzdGFnZXMgYXJlIG5vdCBzdXBwb3J0ZWQgV0FGdjIgcmVnaW9uYWxcbiAqIGFzc29jaWF0aW9uIHRhcmdldHMuIFVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgd2l0aFxuICogQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIGZvciBXQUYtcHJvdGVjdGVkIFJFU1QgQVBJIHN0YWdlcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpV2FmT3B0aW9ucyBleHRlbmRzIEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyB7fVxuXG4vKiogR2F0ZXdheSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIGFuIGV4cGxpY2l0IEFwcFRoZW9yeUh0dHBBcGkgcm91dGUuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyIHtcbiAgLyoqIEFXUyBJQU0gKFNpZ1Y0KSBvbiB0aGUgcm91dGUuICovXG4gIElBTSA9IFwiaWFtXCIsXG4gIC8qKiBObyBnYXRld2F5IGF1dGhvcml6ZXI7IHRoZSBydW50aW1lIG93bnMgYWRtaXNzaW9uLiAqL1xuICBOT05FID0gXCJub25lXCIsXG59XG5cbi8qKlxuICogT25lIGV4cGxpY2l0LCBzZW1hbnRpY2FsbHkgaWRlbnRpZmllZCByb3V0ZSBhZGRlZCBhbG9uZ3NpZGUgdGhlIGNvbnN0cnVjdCdzXG4gKiBncmVlZHkgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gIHJvdXRlcy5cbiAqXG4gKiBBUEkgR2F0ZXdheSBwcmVjZWRlbmNlIGdpdmVzIGEgZnVsbCBtZXRob2QrcGF0aCBtYXRjaCBwcmlvcml0eSBvdmVyIHRoZVxuICogZ3JlZWR5IHJvdXRlcywgc28gYSBtb3JlIHNwZWNpZmljIHJvdXRlIHdpdGggYSBzdHJpY3RlciBhdXRob3JpemVyIChmb3JcbiAqIGV4YW1wbGUgYEFXU19JQU1gKSB3aW5zIGZvciBpdHMgb3duIHBhdGguIEEgd3JvbmctbWV0aG9kIHJlcXVlc3Qgb24gc3VjaCBhXG4gKiBwYXRoIGZhbGxzIHRocm91Z2ggdG8gdGhlIHJ1bnRpbWUncyBmYWlsLWNsb3NlZCA0MDQvNDA1IHdoZW4gdGhlIHJ1bnRpbWUgZG9lc1xuICogbm90IGRlY2xhcmUgaXQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVJvdXRlT3B0aW9ucyB7XG4gIC8qKiBBYnNvbHV0ZSByb3V0ZSBwYXRoLiBTZWdtZW50cyBhcmUgbGl0ZXJhbHMsIGB7cGFyYW1ldGVyfWAsIG9yIGB7cHJveHkrfWAgc2VnbWVudHMuICovXG4gIHJlYWRvbmx5IHBhdGg6IHN0cmluZztcbiAgLyoqIEhUVFAgbWV0aG9kcyB3aXJlZCBmb3IgdGhlIHJvdXRlLCBmb3IgZXhhbXBsZSBgW1wiR0VUXCJdYCBvciBgW1wiQU5ZXCJdYC4gKi9cbiAgcmVhZG9ubHkgbWV0aG9kczogc3RyaW5nW107XG4gIC8qKlxuICAgKiBHYXRld2F5IGF1dGhvcml6YXRpb24gcG9zdHVyZSBmb3IgdGhlIHJvdXRlLlxuICAgKlxuICAgKiBPbWl0IGZvciBgTk9ORWAuIEV2ZXJ5IGV4cGxpY2l0IHZhbHVlIG90aGVyIHRoYW4gYElBTWAgb3IgYE5PTkVgIOKAlCBhblxuICAgKiB1cHBlcmNhc2Ugc3BlbGxpbmcsIGEgbWlzc3BlbGxpbmcsIGBudWxsYCwgYSBudW1iZXIsIGFuIG9iamVjdCwgb3IgYW55XG4gICAqIHVuY2hlY2tlZCBjb25maWd1cmF0aW9uIHZhbHVlIOKAlCBmYWlscyBzeW50aGVzaXMgYmVmb3JlIHRoaXMgcm91dGUgaXNcbiAgICogZW1pdHRlZCBpbnN0ZWFkIG9mIHNpbGVudGx5IGZhbGxpbmcgYmFjayB0byBgTk9ORWAuXG4gICAqIEBkZWZhdWx0IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIuTk9ORVxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplcj86IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXI7XG59XG5cbi8qKiBSb3V0ZS1sZXZlbCB0aHJvdHRsaW5nIGFwcGxpZWQgdG8gb25lIEFQSSBHYXRld2F5IHJvdXRlIGtleS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVJvdXRlVGhyb3R0bGluZyB7XG4gIC8qKiBSZXF1ZXN0cyBwZXIgc2Vjb25kIGZvciB0aGUgcm91dGUga2V5LiBAZGVmYXVsdCB0aGUgc3RhZ2UgZGVmYXVsdCAqL1xuICByZWFkb25seSByYXRlTGltaXQ/OiBudW1iZXI7XG4gIC8qKiBCdXJzdCBsaW1pdCBmb3IgdGhlIHJvdXRlIGtleS4gQGRlZmF1bHQgdGhlIHN0YWdlIGRlZmF1bHQgKi9cbiAgcmVhZG9ubHkgYnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpUHJvcHMge1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICAvKipcbiAgICogV2hldGhlciBMYW1iZGEgaW52b2tlIHBlcm1pc3Npb25zIHNob3VsZCBiZSBzY29wZWQgdG8gaW5kaXZpZHVhbCBIVFRQIEFQSSB2MiByb3V0ZXMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgcm91dGUuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3Igcm91dGUgZmFtaWxpZXMgdGhhdCBzaGFyZSBvbmVcbiAgICogTGFtYmRhLCB3aGVyZSB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2UgcG9saWN5IHNpemVcbiAgICogbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBoYW5kbGVyLCBub3Qgb25seSB0aGUgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBDT1JTIGNvbmZpZ3VyYXRpb24uIFNldCB0byB0cnVlIGZvciBBcHBUaGVvcnkgZGVmYXVsdHMuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgY29ycz86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnM7XG5cbiAgLyoqXG4gICAqIEV4cGxpY2l0LCBzZW1hbnRpY2FsbHkgaWRlbnRpZmllZCByb3V0ZXMgYWRkZWQgYWxvbmdzaWRlIHRoZSBjb25zdHJ1Y3Qnc1xuICAgKiBncmVlZHkgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gIHJvdXRlcy5cbiAgICpcbiAgICogVXNlIHRoaXMgd2hlcmUgYSBzdHJpY3RlciBwZXItcGF0aCBnYXRld2F5IHBvc3R1cmUgKGZvciBleGFtcGxlXG4gICAqIGBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLklBTWApIG11c3Qgd2luIG92ZXIgdGhlIGdyZWVkeSByb3V0ZXM6IGFcbiAgICogZnVsbCBtZXRob2QrcGF0aCBtYXRjaCBvdXRyYW5rcyB0aGUgZ3JlZWR5IHJvdXRlIGJ5IEFQSSBHYXRld2F5IHByZWNlZGVuY2UsXG4gICAqIGFuZCBhIHdyb25nLW1ldGhvZCByZXF1ZXN0IG9uIHN1Y2ggYSBwYXRoIGlzIGRlbmllZCBieSB0aGUgcnVudGltZSB3aXRoIHRoZVxuICAgKiBmYWlsLWNsb3NlZCA0MDQvNDA1IGVudmVsb3BlLlxuICAgKlxuICAgKiBSb3V0ZSBjb25zdHJ1Y3QgaWRzIGFyZSBkZXJpdmVkIGZyb20gdGhlIG1ldGhvZCBhbmQgcGF0aCwgc28gaW5zZXJ0aW5nLFxuICAgKiByZW1vdmluZywgb3IgcmVvcmRlcmluZyBhbiBlbnRyeSBuZXZlciByZW5hbWVzIGFuIHVucmVsYXRlZCByb3V0ZS5cbiAgICpcbiAgICogQSBkZWNsYXJlZCBgT1BUSU9OU2Agcm91dGUgY29leGlzdHMgd2l0aCwgYW5kIGNhbiBiZSBzaGFkb3dlZCBieSwgdGhlXG4gICAqIEFQSS1sZXZlbCBDT1JTIGNvbmZpZ3VyYXRpb24gYGNvcnNgIGluc3RhbGxzLiBgYnVpbGRDb3JzUHJlZmxpZ2h0YCBpbmNsdWRlc1xuICAgKiBgT1BUSU9OU2AgaW4gaXRzIGRlZmF1bHQgYGFsbG93TWV0aG9kc2AsIGFuZCB3aGlsZSBgT1BUSU9OU2AgaXMgaW4gdGhhdFxuICAgKiBsaXN0IEFQSSBHYXRld2F5IGFuc3dlcnMgbWF0Y2hpbmcgcHJlZmxpZ2h0IHJlcXVlc3RzIGl0c2VsZiBiZWZvcmUgdGhlXG4gICAqIHJvdXRlIGludGVncmF0aW9uIHJ1bnMsIHNvIGEgZGVjbGFyZWQgYE9QVElPTlNgIHJvdXRlIG9uIHRoZSBzYW1lIHBhdGggaXNcbiAgICogbmV2ZXIgcmVhY2hlZC4gU2V0dGluZyBgY29ycy5hbGxvd01ldGhvZHNgIHdpdGhvdXQgYE9QVElPTlNgIHJlbW92ZXMgZ2F0ZXdheVxuICAgKiBwcmVmbGlnaHQgaGFuZGxpbmcgZW50aXJlbHk7IGEgZGVjbGFyZWQgYE9QVElPTlNgIHJvdXRlIGlzIHRoZW4gdGhlIG9ubHlcbiAgICogdGhpbmcgdGhhdCBhbnN3ZXJzIGEgcHJlZmxpZ2h0IHJlcXVlc3QsIGFuZCBpdCBpcyBzdWJqZWN0IHRvIHRoYXQgcm91dGUnc1xuICAgKiBvd24gYXV0aG9yaXplci4gRGVjbGFyZSB0aGUgbWV0aG9kcyB5b3UgbmVlZCBpbiBgY29ycy5hbGxvd01ldGhvZHNgIHJhdGhlclxuICAgKiB0aGFuIGRlcGVuZGluZyBvbiBhIGRlY2xhcmVkIGBPUFRJT05TYCByb3V0ZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb3V0ZXM/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zW107XG5cbiAgLyoqXG4gICAqIFJvdXRlLWxldmVsIHRocm90dGxpbmcga2V5ZWQgYnkgQVBJIEdhdGV3YXkgcm91dGUga2V5IChmb3IgZXhhbXBsZVxuICAgKiBgXCJBTlkgL3twcm94eSt9XCJgKS4gQXBwbGllZCB0byB0aGUgc3RhZ2UncyByb3V0ZSBzZXR0aW5ncy5cbiAgICpcbiAgICogRXZlcnkga2V5IGlzIHZhbGlkYXRlZCBhdCBzeW50aGVzaXMgdGltZSBhZ2FpbnN0IHRoZSByb3V0ZSBrZXlzIHRoaXNcbiAgICogY29uc3RydWN0IGVtaXRzIOKAlCB0aGUgZ3JlZWR5IGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCByb3V0ZXMgcGx1cyBvbmVcbiAgICogYDxNRVRIT0Q+IDxwYXRoPmAga2V5IHBlciBgcm91dGVzYCBlbnRyeS4gQSBrZXkgdGhhdCBtYXRjaGVzIG5vIGVtaXR0ZWRcbiAgICogcm91dGUgZmFpbHMgc3ludGhlc2lzIHdpdGggYSBuYW1lZCBlcnJvciBsaXN0aW5nIHRoZSBlbWl0dGVkIGtleXMsIHJhdGhlclxuICAgKiB0aGFuIGJlaW5nIHNpbGVudGx5IGlnbm9yZWQgYnkgQVBJIEdhdGV3YXkuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVTZXR0aW5ncz86IHsgW3JvdXRlS2V5OiBzdHJpbmddOiBBcHBUaGVvcnlIdHRwQXBpUm91dGVUaHJvdHRsaW5nIH07XG5cbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICpcbiAgICogV2hlbiBgZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBpcyBzZXQsIEFwcFRoZW9yeSBmYWlscyBjbG9zZWQgYW5kXG4gICAqIGRpc2FibGVzIHRoZSBkZWZhdWx0IGBleGVjdXRlLWFwaWAgZW5kcG9pbnQgc28gdGhlIEFQSSBpcyByZWFjaGFibGUgb25seVxuICAgKiB0aHJvdWdoIHRoZSBtdXR1YWwtVExTIGN1c3RvbSBkb21haW4uIFdpdGhvdXQgbXV0dWFsIFRMUyB0aGUgZGVmYXVsdFxuICAgKiBlbmRwb2ludCBrZWVwcyB0aGUgQVdTIGRlZmF1bHQgKGVuYWJsZWQpLCBzbyBvcmRpbmFyeSBjdXN0b20gZG9tYWlucyBhcmVcbiAgICogdW5hZmZlY3RlZC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFJlZ2lvbmFsIFdBRiBhdHRhY2htZW50IGlzIGludGVudGlvbmFsbHkgdW5hdmFpbGFibGUgZm9yIEFQSSBHYXRld2F5IHYyXG4gICAqIEhUVFAgQVBJcy4gU3VwcGx5aW5nIHRoaXMgcHJvcCBmYWlscyBjbG9zZWQgZHVyaW5nIHN5bnRoZXNpcyBpbnN0ZWFkIG9mXG4gICAqIHByb2R1Y2luZyBhbiB1bnN1cHBvcnRlZCBgL2FwaXMvLi4uL3N0YWdlcy8uLi5gIFdlYkFDTCBhc3NvY2lhdGlvbi5cbiAgICpcbiAgICogVXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciB3aGVuIGEgV0FGLXByb3RlY3RlZCBBUElcbiAgICogR2F0ZXdheSBzdGFnZSBpcyByZXF1aXJlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqIEBkZXByZWNhdGVkIEhUVFAgQVBJIFdBRiBhc3NvY2lhdGlvbiBpcyB1bnN1cHBvcnRlZCBieSBBV1MgV0FGdjIuXG4gICAqL1xuICByZWFkb25seSB3YWY/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaVdhZk9wdGlvbnM7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlIdHRwQXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUFwaURvbWFpbjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5SHR0cEFwaVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcy53YWYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlIdHRwQXBpIGRvZXMgbm90IHN1cHBvcnQgV0FGdjIgcmVnaW9uYWwgV2ViQUNMIGFzc29jaWF0aW9ucyBmb3IgQVBJIEdhdGV3YXkgdjIgSFRUUCBBUElzOyB1c2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGZvciBXQUYtcHJvdGVjdGVkIFJFU1Qgc3RhZ2VzXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgIGNvbnN0IHN0YWdlTmFtZSA9IHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nRm9ybWF0ICE9PSB1bmRlZmluZWQgJiYgIXN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpOiBzdGFnZS5hY2Nlc3NMb2dGb3JtYXQgcmVxdWlyZXMgc3RhZ2UuYWNjZXNzTG9nZ2luZ1wiKTtcbiAgICB9XG4gICAgY29uc3QgbmVlZHNFeHBsaWNpdFN0YWdlID0gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY29yc1ByZWZsaWdodDogYnVpbGRDb3JzUHJlZmxpZ2h0KHByb3BzLmNvcnMpLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlLFxuICAgICAgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludDogcHJvcHMuZG9tYWluPy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbiAhPT0gdW5kZWZpbmVkID8gdHJ1ZSA6IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0YWdlID0gbmVlZHNFeHBsaWNpdFN0YWdlXG4gICAgICA/IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgICB0aHJvdHRsZTogKHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIH0pXG4gICAgICA6IHRoaXMuYXBpLmRlZmF1bHRTdGFnZTtcbiAgICBpZiAoIXN0YWdlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpOiBmYWlsZWQgdG8gY3JlYXRlIEFQSSBzdGFnZVwiKTtcbiAgICB9XG4gICAgdGhpcy5zdGFnZSA9IHN0YWdlO1xuICAgIHRoaXMuY29uZmlndXJlQWNjZXNzTG9nZ2luZyhzdGFnZU9wdHMsIHN0YWdlKTtcblxuICAgIC8vIEV2ZXJ5IHJvdXRlIGtleSB0aGlzIGNvbnN0cnVjdCBlbWl0cywgaW4gQVBJIEdhdGV3YXkgYE1FVEhPRCBwYXRoYCBmb3JtLlxuICAgIC8vIGByb3V0ZVNldHRpbmdzYCBpcyB2YWxpZGF0ZWQgYWdhaW5zdCB0aGlzIHNldCBzbyBhIHR5cG8gaXMgYSBuYW1lZFxuICAgIC8vIHN5bnRoZXNpcyBlcnJvciBpbnN0ZWFkIG9mIHNpbGVudGx5IGlnbm9yZWQgc3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICBjb25zdCBlbWl0dGVkUm91dGVLZXlzID0gbmV3IFNldChbXCJBTlkgL1wiLCBcIkFOWSAve3Byb3h5K31cIl0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL1wiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5BTlldLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIlJvb3RcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIve3Byb3h5K31cIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuQU5ZXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJQcm94eVwiLCBwcm9wcy5oYW5kbGVyLCB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGV4cGxpY2l0Um91dGVzID0gcHJvcHMucm91dGVzID8/IFtdO1xuICAgIGlmIChleHBsaWNpdFJvdXRlcy5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLmFkZEV4cGxpY2l0Um91dGVzKGV4cGxpY2l0Um91dGVzLCBwcm9wcy5oYW5kbGVyLCBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsIGVtaXR0ZWRSb3V0ZUtleXMpO1xuICAgIH1cbiAgICBpZiAocHJvcHMucm91dGVTZXR0aW5ncyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25maWd1cmVSb3V0ZVNldHRpbmdzKHN0YWdlLCBwcm9wcy5yb3V0ZVNldHRpbmdzLCBlbWl0dGVkUm91dGVLZXlzKTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICB0aGlzLmNvbmZpZ3VyZURvbWFpbihwcm9wcy5kb21haW4pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWRkRXhwbGljaXRSb3V0ZXMoXG4gICAgcm91dGVzOiBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zW10sXG4gICAgcm91dGVIYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IGJvb2xlYW4sXG4gICAgZW1pdHRlZFJvdXRlS2V5czogU2V0PHN0cmluZz4sXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiRXhwbGljaXRcIiwgcm91dGVIYW5kbGVyLCB7XG4gICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGUsXG4gICAgfSk7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2Ygcm91dGVzKSB7XG4gICAgICBjb25zdCByb3V0ZVBhdGggPSBub3JtYWxpemVFeHBsaWNpdFJvdXRlUGF0aChyb3V0ZS5wYXRoKTtcbiAgICAgIGNvbnN0IGNvbmZpZ3VyZWRNZXRob2RzID0gcm91dGUubWV0aG9kcyA/PyBbXTtcbiAgICAgIGlmIChjb25maWd1cmVkTWV0aG9kcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgZW50cnkgZm9yICR7SlNPTi5zdHJpbmdpZnkocm91dGVQYXRoKX0gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIG1ldGhvZGAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IHJhd01ldGhvZCBvZiBjb25maWd1cmVkTWV0aG9kcykge1xuICAgICAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcocmF3TWV0aG9kKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgICAgICAgaWYgKCFFWFBMSUNJVF9ST1VURV9NRVRIT0RTLmhhcyhtZXRob2QpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBtZXRob2QgbXVzdCBiZSBvbmUgb2YgJHtbLi4uRVhQTElDSVRfUk9VVEVfTUVUSE9EU10uam9pbihcIiwgXCIpfSAoZ290ICR7SlNPTi5zdHJpbmdpZnkocmF3TWV0aG9kKX0pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJvdXRlSWQgPSBzZW1hbnRpY1JvdXRlQ29uc3RydWN0SWQobWV0aG9kLCByb3V0ZVBhdGgpO1xuICAgICAgICBpZiAoc2Vlbi5oYXMocm91dGVJZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIGNvbnRhaW5zIHRoZSBkdXBsaWNhdGUgcm91dGUgJHttZXRob2R9ICR7cm91dGVQYXRofWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBzZWVuLmFkZChyb3V0ZUlkKTtcbiAgICAgICAgZW1pdHRlZFJvdXRlS2V5cy5hZGQoYCR7bWV0aG9kfSAke3JvdXRlUGF0aH1gKTtcbiAgICAgICAgbmV3IGFwaWd3djIuSHR0cFJvdXRlKHRoaXMsIHJvdXRlSWQsIHtcbiAgICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChyb3V0ZVBhdGgsIG1ldGhvZCBhcyBhcGlnd3YyLkh0dHBNZXRob2QpLFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIGF1dGhvcml6ZXI6IGV4cGxpY2l0Um91dGVBdXRob3JpemVyKHJvdXRlLmF1dGhvcml6ZXIpLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZUFjY2Vzc0xvZ2dpbmcoc3RhZ2VPcHRzOiBBcHBUaGVvcnlIdHRwQXBpU3RhZ2VPcHRpb25zLCBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UpOiB2b2lkIHtcbiAgICBpZiAoIXN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZVxuICAgICAgPyBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICB9KVxuICAgICAgOiBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICBjZm5TdGFnZS5hY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgIGZvcm1hdDogc3RhZ2VPcHRzLmFjY2Vzc0xvZ0Zvcm1hdCA/PyBkZWZhdWx0QWNjZXNzTG9nRm9ybWF0KCksXG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgY29uZmlndXJlRG9tYWluKG9wdGlvbnM6IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRpZmljYXRlXCIsIG9wdGlvbnMuY2VydGlmaWNhdGVBcm4pXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEFwaSBkb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGRvbWFpbiA9IG5ldyBBcHBUaGVvcnlBcGlEb21haW4odGhpcywgXCJEb21haW5cIiwge1xuICAgICAgZG9tYWluTmFtZTogb3B0aW9ucy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHN0YWdlOiBvcHRpb25zLnN0YWdlID8/IHRoaXMuc3RhZ2UsXG4gICAgICBob3N0ZWRab25lOiBvcHRpb25zLmhvc3RlZFpvbmUsXG4gICAgICBhcGlNYXBwaW5nS2V5OiBvcHRpb25zLmFwaU1hcHBpbmdLZXksXG4gICAgICBjcmVhdGVDbmFtZTogb3B0aW9ucy5jcmVhdGVDbmFtZSxcbiAgICAgIHJlY29yZFR0bDogb3B0aW9ucy5yZWNvcmRUdGwsXG4gICAgICBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbjogb3B0aW9ucy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICAgIHNlY3VyaXR5UG9saWN5OiBvcHRpb25zLnNlY3VyaXR5UG9saWN5LFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluIH0pLmRvbWFpbiA9IGRvbWFpbjtcbiAgfVxufVxuXG5jb25zdCBFWFBMSUNJVF9ST1VURV9NRVRIT0RTID0gbmV3IFNldChbXG4gIFwiQU5ZXCIsXG4gIFwiREVMRVRFXCIsXG4gIFwiR0VUXCIsXG4gIFwiSEVBRFwiLFxuICBcIk9QVElPTlNcIixcbiAgXCJQQVRDSFwiLFxuICBcIlBPU1RcIixcbiAgXCJQVVRcIixcbl0pO1xuXG5mdW5jdGlvbiBub3JtYWxpemVFeHBsaWNpdFJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgcm91dGVQYXRoID0gU3RyaW5nKHZhbHVlID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKHJvdXRlUGF0aCA9PT0gXCJcIiB8fCAhcm91dGVQYXRoLnN0YXJ0c1dpdGgoXCIvXCIpIHx8IChyb3V0ZVBhdGgubGVuZ3RoID4gMSAmJiByb3V0ZVBhdGguZW5kc1dpdGgoXCIvXCIpKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgcGF0aCBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGggd2l0aCBubyB0cmFpbGluZyBzbGFzaCAoZ290ICR7SlNPTi5zdHJpbmdpZnkodmFsdWUpfSlgLFxuICAgICk7XG4gIH1cbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHJvdXRlUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIikpIHtcbiAgICBpZiAoc2VnbWVudCA9PT0gXCJcIiB8fCBzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBwYXRoIG11c3Qgbm90IGNvbnRhaW4gZW1wdHkgb3IgZG90IHNlZ21lbnRzIChnb3QgJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9KWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBleHBsaWNpdFJvdXRlQXV0aG9yaXplcihwb3N0dXJlPzogQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplcik6IGFwaWd3djIuSUh0dHBSb3V0ZUF1dGhvcml6ZXIge1xuICBpZiAocG9zdHVyZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICB9XG4gIHN3aXRjaCAocG9zdHVyZSkge1xuICAgIGNhc2UgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5JQU06XG4gICAgICByZXR1cm4gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSWFtQXV0aG9yaXplcigpO1xuICAgIGNhc2UgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5OT05FOlxuICAgICAgcmV0dXJuIG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xuICAgIGRlZmF1bHQ6XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgYXV0aG9yaXplciBtdXN0IGJlIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIuSUFNIG9yIC5OT05FIChnb3QgJHtKU09OLnN0cmluZ2lmeShwb3N0dXJlKX0pYCxcbiAgICAgICk7XG4gIH1cbn1cblxuZnVuY3Rpb24gY29uZmlndXJlUm91dGVTZXR0aW5ncyhcbiAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICBzZXR0aW5nczogeyBbcm91dGVLZXk6IHN0cmluZ106IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZVRocm90dGxpbmcgfSxcbiAgZW1pdHRlZFJvdXRlS2V5czogU2V0PHN0cmluZz4sXG4pOiB2b2lkIHtcbiAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICBjb25zdCBtYXBwZWQ6IHsgW3JvdXRlS2V5OiBzdHJpbmddOiB7IFtwcm9wZXJ0eTogc3RyaW5nXTogbnVtYmVyIH0gfSA9IHt9O1xuICBmb3IgKGNvbnN0IFtyb3V0ZUtleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHNldHRpbmdzKSkge1xuICAgIGlmICghZW1pdHRlZFJvdXRlS2V5cy5oYXMocm91dGVLZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0gZG9lcyBub3QgbWF0Y2ggYW55IHJvdXRlIHRoaXMgY29uc3RydWN0IGVtaXRzIChlbWl0dGVkOiAke1suLi5lbWl0dGVkUm91dGVLZXlzXS5zb3J0KCkubWFwKChrZXkpID0+IEpTT04uc3RyaW5naWZ5KGtleSkpLmpvaW4oXCIsIFwiKX0pYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IHJhdGVMaW1pdCA9IHZhbHVlLnJhdGVMaW1pdDtcbiAgICBjb25zdCBidXJzdExpbWl0ID0gdmFsdWUuYnVyc3RMaW1pdDtcbiAgICBpZiAocmF0ZUxpbWl0ID09PSB1bmRlZmluZWQgJiYgYnVyc3RMaW1pdCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0gcmVxdWlyZXMgcmF0ZUxpbWl0IG9yIGJ1cnN0TGltaXRgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKHJhdGVMaW1pdCAhPT0gdW5kZWZpbmVkICYmICghTnVtYmVyLmlzRmluaXRlKHJhdGVMaW1pdCkgfHwgcmF0ZUxpbWl0IDw9IDApKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0ucmF0ZUxpbWl0IG11c3QgYmUgYSBwb3NpdGl2ZSBmaW5pdGUgbnVtYmVyYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChidXJzdExpbWl0ICE9PSB1bmRlZmluZWQgJiYgKCFOdW1iZXIuaXNGaW5pdGUoYnVyc3RMaW1pdCkgfHwgYnVyc3RMaW1pdCA8PSAwKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVTZXR0aW5nc1ske0pTT04uc3RyaW5naWZ5KHJvdXRlS2V5KX1dLmJ1cnN0TGltaXQgbXVzdCBiZSBhIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJgLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZW50cnk6IHsgW3Byb3BlcnR5OiBzdHJpbmddOiBudW1iZXIgfSA9IHt9O1xuICAgIGlmIChyYXRlTGltaXQgIT09IHVuZGVmaW5lZCkgZW50cnlbXCJUaHJvdHRsaW5nUmF0ZUxpbWl0XCJdID0gcmF0ZUxpbWl0O1xuICAgIGlmIChidXJzdExpbWl0ICE9PSB1bmRlZmluZWQpIGVudHJ5W1wiVGhyb3R0bGluZ0J1cnN0TGltaXRcIl0gPSBidXJzdExpbWl0O1xuICAgIG1hcHBlZFtyb3V0ZUtleV0gPSBlbnRyeTtcbiAgfVxuICBjZm5TdGFnZS5yb3V0ZVNldHRpbmdzID0gbWFwcGVkO1xufVxuXG5mdW5jdGlvbiBkZWZhdWx0QWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICB9KTtcbn1cbiJdfQ==