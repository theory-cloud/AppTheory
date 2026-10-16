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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryHttpApi", version: "6.1.0" };
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
            this.addExplicitRoutes(explicitRoutes, props.handler, props.scopePermissionToRoute ?? true);
        }
        if (props.routeSettings !== undefined) {
            configureRouteSettings(stage, props.routeSettings);
        }
        if (props.domain) {
            this.configureDomain(props.domain);
        }
    }
    addExplicitRoutes(routes, routeHandler, scopePermissionToRoute) {
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
function configureRouteSettings(stage, settings) {
    const cfnStage = stage.node.defaultChild;
    const mapped = {};
    for (const [routeKey, value] of Object.entries(settings)) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQ0Esc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMsNkNBQWtEO0FBQ2xELGlDQUE0QztBQUU1QywyQ0FBdUQ7QUFtSnZELDRFQUE0RTtBQUM1RSxJQUFZLCtCQUtYO0FBTEQsV0FBWSwrQkFBK0I7SUFDekMsb0NBQW9DO0lBQ3BDLDhDQUFXLENBQUE7SUFDWCx5REFBeUQ7SUFDekQsZ0RBQWEsQ0FBQTtBQUNmLENBQUMsRUFMVywrQkFBK0IsK0NBQS9CLCtCQUErQixRQUsxQztBQTZHRCxNQUFhLGdCQUFpQixTQUFRLHNCQUFTOztJQUM3QixHQUFHLENBQWtCO0lBQ3JCLEtBQUssQ0FBaUI7SUFDdEIsY0FBYyxDQUFrQjtJQUNoQyxNQUFNLENBQXNCO0lBRTVDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBNEI7UUFDcEUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNkLE1BQU0sSUFBSSxLQUFLLENBQ2IsaUxBQWlMLENBQ2xMLENBQUM7UUFDSixDQUFDO1FBRUQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLEtBQUssSUFBSSxFQUFFLENBQUM7UUFDcEMsTUFBTSxTQUFTLEdBQUcsU0FBUyxDQUFDLFNBQVMsSUFBSSxVQUFVLENBQUM7UUFDcEQsSUFBSSxTQUFTLENBQUMsZUFBZSxLQUFLLFNBQVMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUN4RSxNQUFNLElBQUksS0FBSyxDQUFDLHNFQUFzRSxDQUFDLENBQUM7UUFDMUYsQ0FBQztRQUNELE1B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QU0sSUFBSSxLQUFLLENBQ2IsbUNBQW1DLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLCtDQUErQyxDQUMzRyxDQUFDO1FBQ0osQ0FBQztRQUNELE1BQU0sS0FBSyxHQUFtQyxFQUFFLENBQUM7UUFDakQsSUFBSSxTQUFTLEtBQUssU0FBUztZQUFFLEtBQUssQ0FBQyxxQkFBcUIsQ0FBQyxHQUFHLFNBQVMsQ0FBQztRQUN0RSxJQUFJLFVBQVUsS0FBSyxTQUFTO1lBQUUsS0FBSyxDQUFDLHNCQUFzQixDQUFDLEdBQUcsVUFBVSxDQUFDO1FBQ3pFLE1BQU0sQ0FBQyxRQUFRLENBQUMsR0FBRyxLQUFLLENBQUM7SUFDM0IsQ0FBQztJQUNELFFBQVEsQ0FBQyxhQUFhLEdBQUcsTUFBTSxDQUFDO0FBQ2xDLENBQUM7QUFFRCxTQUFTLHNCQUFzQjtJQUM3QixPQUFPLElBQUksQ0FBQyxTQUFTLENBQUM7UUFDcEIsU0FBUyxFQUFFLG9CQUFvQjtRQUMvQixFQUFFLEVBQUUsNEJBQTRCO1FBQ2hDLFdBQVcsRUFBRSxzQkFBc0I7UUFDbkMsVUFBVSxFQUFFLHFCQUFxQjtRQUNqQyxRQUFRLEVBQUUsbUJBQW1CO1FBQzdCLE1BQU0sRUFBRSxpQkFBaUI7UUFDekIsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixjQUFjLEVBQUUseUJBQXlCO1FBQ3pDLGtCQUFrQixFQUFFLDZCQUE2QjtLQUNsRCxDQUFDLENBQUM7QUFDTCxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgdHlwZSAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlBcGlEb21haW4gfSBmcm9tIFwiLi9hcGktZG9tYWluXCI7XG5pbXBvcnQgeyBidWlsZENvcnNQcmVmbGlnaHQgfSBmcm9tIFwiLi9jb3JzXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyB9IGZyb20gXCIuL3JlZ2lvbmFsLXdhZlwiO1xuaW1wb3J0IHsgc2VtYW50aWNSb3V0ZUNvbnN0cnVjdElkIH0gZnJvbSBcIi4vcm91dGUtaWRzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zIHtcbiAgLyoqXG4gICAqIEFsbG93ZWQgb3JpZ2lucy5cbiAgICogQGRlZmF1bHQgW1wiKlwiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dPcmlnaW5zPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzLlxuICAgKiBAZGVmYXVsdCBbXCJHRVRcIiwgXCJQT1NUXCIsIFwiUFVUXCIsIFwiREVMRVRFXCIsIFwiUEFUQ0hcIiwgXCJIRUFEXCIsIFwiT1BUSU9OU1wiXVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dNZXRob2RzPzogc3RyaW5nW107XG5cbiAgLyoqXG4gICAqIEFsbG93ZWQgaGVhZGVycy5cbiAgICogQGRlZmF1bHQgW1wiY29udGVudC10eXBlXCIsIFwiYXV0aG9yaXphdGlvblwiLCBcIngtcmVxdWVzdC1pZFwiLCBcIngtdGVuYW50LWlkXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd0hlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogRXhwb3NlZCByZXNwb25zZSBoZWFkZXJzLlxuICAgKiBAZGVmYXVsdCBbXCJ4LXJlcXVlc3QtaWRcIl1cbiAgICovXG4gIHJlYWRvbmx5IGV4cG9zZUhlYWRlcnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogV2hldGhlciBicm93c2VycyBtYXkgc2VuZCBjcmVkZW50aWFscy5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFsbG93Q3JlZGVudGlhbHM/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBCcm93c2VyIHByZWZsaWdodCBjYWNoZSBkdXJhdGlvbi5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24ubWludXRlcygxMClcbiAgICovXG4gIHJlYWRvbmx5IG1heEFnZT86IER1cmF0aW9uO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zIHtcbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gbmFtZSwgZm9yIGV4YW1wbGUgYGFwaS5leGFtcGxlLmNvbWAuXG4gICAqL1xuICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgdGhlIGRvbWFpbi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgLyoqXG4gICAqIEFDTSBjZXJ0aWZpY2F0ZSBBUk4uXG4gICAqIFByb3ZpZGUgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuLlxuICAgKi9cbiAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIG9wdGlvbmFsIENOQU1FIHJlY29yZCBjcmVhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAvKipcbiAgICogQVBJIG1hcHBpbmcga2V5IHVuZGVyIHRoZSBjdXN0b20gZG9tYWluLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU1hcHBpbmdLZXk/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFN0YWdlIHRvIG1hcC4gRGVmYXVsdHMgdG8gdGhpcyBjb25zdHJ1Y3QncyBzdGFnZS5cbiAgICogQGRlZmF1bHQgdGhpcy5zdGFnZVxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBhcGlnd3YyLklTdGFnZTtcblxuICAvKipcbiAgICogV2hldGhlciB0byBjcmVhdGUgYSBDTkFNRSB3aGVuIGhvc3RlZFpvbmUgaXMgcHJvdmlkZWQuXG4gICAqIEBkZWZhdWx0IHRydWUgd2hlbiBob3N0ZWRab25lIGlzIHByb3ZpZGVkXG4gICAqL1xuICByZWFkb25seSBjcmVhdGVDbmFtZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENOQU1FIHJlY29yZCBUVEwuXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLnNlY29uZHMoMzAwKVxuICAgKi9cbiAgcmVhZG9ubHkgcmVjb3JkVHRsPzogRHVyYXRpb247XG5cbiAgLyoqXG4gICAqIE11dHVhbCBUTFMgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbj86IGFwaWd3djIuTVRMU0NvbmZpZztcblxuICAvKipcbiAgICogVExTIHNlY3VyaXR5IHBvbGljeS5cbiAgICogQGRlZmF1bHQgQVBJIEdhdGV3YXkgZGVmYXVsdFxuICAgKi9cbiAgcmVhZG9ubHkgc2VjdXJpdHlQb2xpY3k/OiBhcGlnd3YyLlNlY3VyaXR5UG9saWN5O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnMge1xuICAvKipcbiAgICogU3RhZ2UgbmFtZS5cbiAgICogQGRlZmF1bHQgXCIkZGVmYXVsdFwiXG4gICAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEVuYWJsZSBDbG91ZFdhdGNoIGFjY2VzcyBsb2dnaW5nIG9yIHByb3ZpZGUgYSBsb2cgZ3JvdXAuXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbiB8IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhbiBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKlxuICAgKiBBUEkgR2F0ZXdheSB2MiBhY2Nlc3MtbG9nIGZvcm1hdC4gRGVmYXVsdHMgdG8gdGhlIEFwcFRoZW9yeSBKU09OIGZvcm1hdC5cbiAgICogVmFsaWQgb25seSB3aGVuIGBhY2Nlc3NMb2dnaW5nYCBpcyBlbmFibGVkLlxuICAgKiBAZGVmYXVsdCB0aGUgQXBwVGhlb3J5IEpTT04gYWNjZXNzLWxvZyBmb3JtYXRcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IHN0cmluZztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0LlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogQGRlcHJlY2F0ZWQgQVBJIEdhdGV3YXkgdjIgSFRUUCBBUEkgc3RhZ2VzIGFyZSBub3Qgc3VwcG9ydGVkIFdBRnYyIHJlZ2lvbmFsXG4gKiBhc3NvY2lhdGlvbiB0YXJnZXRzLiBVc2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHdpdGhcbiAqIEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyBmb3IgV0FGLXByb3RlY3RlZCBSRVNUIEFQSSBzdGFnZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVdhZk9wdGlvbnMgZXh0ZW5kcyBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMge31cblxuLyoqIEdhdGV3YXkgYXV0aG9yaXphdGlvbiBwb3N0dXJlIGZvciBhbiBleHBsaWNpdCBBcHBUaGVvcnlIdHRwQXBpIHJvdXRlLiAqL1xuZXhwb3J0IGVudW0gQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplciB7XG4gIC8qKiBBV1MgSUFNIChTaWdWNCkgb24gdGhlIHJvdXRlLiAqL1xuICBJQU0gPSBcImlhbVwiLFxuICAvKiogTm8gZ2F0ZXdheSBhdXRob3JpemVyOyB0aGUgcnVudGltZSBvd25zIGFkbWlzc2lvbi4gKi9cbiAgTk9ORSA9IFwibm9uZVwiLFxufVxuXG4vKipcbiAqIE9uZSBleHBsaWNpdCwgc2VtYW50aWNhbGx5IGlkZW50aWZpZWQgcm91dGUgYWRkZWQgYWxvbmdzaWRlIHRoZSBjb25zdHJ1Y3Qnc1xuICogZ3JlZWR5IGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCByb3V0ZXMuXG4gKlxuICogQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSBnaXZlcyBhIGZ1bGwgbWV0aG9kK3BhdGggbWF0Y2ggcHJpb3JpdHkgb3ZlciB0aGVcbiAqIGdyZWVkeSByb3V0ZXMsIHNvIGEgbW9yZSBzcGVjaWZpYyByb3V0ZSB3aXRoIGEgc3RyaWN0ZXIgYXV0aG9yaXplciAoZm9yXG4gKiBleGFtcGxlIGBBV1NfSUFNYCkgd2lucyBmb3IgaXRzIG93biBwYXRoLiBBIHdyb25nLW1ldGhvZCByZXF1ZXN0IG9uIHN1Y2ggYVxuICogcGF0aCBmYWxscyB0aHJvdWdoIHRvIHRoZSBydW50aW1lJ3MgZmFpbC1jbG9zZWQgNDA0LzQwNSB3aGVuIHRoZSBydW50aW1lIGRvZXNcbiAqIG5vdCBkZWNsYXJlIGl0LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZU9wdGlvbnMge1xuICAvKiogQWJzb2x1dGUgcm91dGUgcGF0aC4gU2VnbWVudHMgYXJlIGxpdGVyYWxzLCBge3BhcmFtZXRlcn1gLCBvciBge3Byb3h5K31gIHNlZ21lbnRzLiAqL1xuICByZWFkb25seSBwYXRoOiBzdHJpbmc7XG4gIC8qKiBIVFRQIG1ldGhvZHMgd2lyZWQgZm9yIHRoZSByb3V0ZSwgZm9yIGV4YW1wbGUgYFtcIkdFVFwiXWAgb3IgYFtcIkFOWVwiXWAuICovXG4gIHJlYWRvbmx5IG1ldGhvZHM6IHN0cmluZ1tdO1xuICAvKipcbiAgICogR2F0ZXdheSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIHRoZSByb3V0ZS5cbiAgICogQGRlZmF1bHQgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5OT05FXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyPzogQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplcjtcbn1cblxuLyoqIFJvdXRlLWxldmVsIHRocm90dGxpbmcgYXBwbGllZCB0byBvbmUgQVBJIEdhdGV3YXkgcm91dGUga2V5LiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpUm91dGVUaHJvdHRsaW5nIHtcbiAgLyoqIFJlcXVlc3RzIHBlciBzZWNvbmQgZm9yIHRoZSByb3V0ZSBrZXkuIEBkZWZhdWx0IHRoZSBzdGFnZSBkZWZhdWx0ICovXG4gIHJlYWRvbmx5IHJhdGVMaW1pdD86IG51bWJlcjtcbiAgLyoqIEJ1cnN0IGxpbWl0IGZvciB0aGUgcm91dGUga2V5LiBAZGVmYXVsdCB0aGUgc3RhZ2UgZGVmYXVsdCAqL1xuICByZWFkb25seSBidXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIEhUVFAgQVBJIHYyIHJvdXRlcy5cbiAgICpcbiAgICogV2hlbiBmYWxzZSwgdGhlIGNvbnN0cnVjdCBncmFudHMgb25lIEFQSS1zY29wZWQgaW52b2tlIHBlcm1pc3Npb24gcGVyIExhbWJkYSBpbnN0ZWFkIG9mXG4gICAqIG9uZSBwZXJtaXNzaW9uIHBlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciByb3V0ZSBmYW1pbGllcyB0aGF0IHNoYXJlIG9uZVxuICAgKiBMYW1iZGEsIHdoZXJlIHRoZSBwZXItcm91dGUgcGVybWlzc2lvbnMgY2FuIGV4aGF1c3QgdGhlIExhbWJkYSByZXNvdXJjZSBwb2xpY3kgc2l6ZVxuICAgKiBsaW1pdC5cbiAgICpcbiAgICogVGhlIHRyYWRlLW9mZiBpcyBleHBsaWNpdDogdGhlIEFQSS1zY29wZWQgcGVybWlzc2lvbiBhbGxvd3MgZXZlcnkgcm91dGUgb24gdGhhdCBIVFRQIEFQSVxuICAgKiB0byBpbnZva2UgdGhlIGhhbmRsZXIsIG5vdCBvbmx5IHRoZSByb3V0ZXMgdGhpcyBjb25zdHJ1Y3Qgb3ducy5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIENPUlMgY29uZmlndXJhdGlvbi4gU2V0IHRvIHRydWUgZm9yIEFwcFRoZW9yeSBkZWZhdWx0cy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBjb3JzPzogYm9vbGVhbiB8IEFwcFRoZW9yeUh0dHBBcGlDb3JzT3B0aW9ucztcblxuICAvKipcbiAgICogRXhwbGljaXQsIHNlbWFudGljYWxseSBpZGVudGlmaWVkIHJvdXRlcyBhZGRlZCBhbG9uZ3NpZGUgdGhlIGNvbnN0cnVjdCdzXG4gICAqIGdyZWVkeSBgQU5ZIC9gIGFuZCBgQU5ZIC97cHJveHkrfWAgcm91dGVzLlxuICAgKlxuICAgKiBVc2UgdGhpcyB3aGVyZSBhIHN0cmljdGVyIHBlci1wYXRoIGdhdGV3YXkgcG9zdHVyZSAoZm9yIGV4YW1wbGVcbiAgICogYEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIuSUFNYCkgbXVzdCB3aW4gb3ZlciB0aGUgZ3JlZWR5IHJvdXRlczogYVxuICAgKiBmdWxsIG1ldGhvZCtwYXRoIG1hdGNoIG91dHJhbmtzIHRoZSBncmVlZHkgcm91dGUgYnkgQVBJIEdhdGV3YXkgcHJlY2VkZW5jZSxcbiAgICogYW5kIGEgd3JvbmctbWV0aG9kIHJlcXVlc3Qgb24gc3VjaCBhIHBhdGggaXMgZGVuaWVkIGJ5IHRoZSBydW50aW1lIHdpdGggdGhlXG4gICAqIGZhaWwtY2xvc2VkIDQwNC80MDUgZW52ZWxvcGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVzPzogQXBwVGhlb3J5SHR0cEFwaVJvdXRlT3B0aW9uc1tdO1xuXG4gIC8qKlxuICAgKiBSb3V0ZS1sZXZlbCB0aHJvdHRsaW5nIGtleWVkIGJ5IEFQSSBHYXRld2F5IHJvdXRlIGtleSAoZm9yIGV4YW1wbGVcbiAgICogYFwiQU5ZIC97cHJveHkrfVwiYCkuIEFwcGxpZWQgdG8gdGhlIHN0YWdlJ3Mgcm91dGUgc2V0dGluZ3MuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgcm91dGVTZXR0aW5ncz86IHsgW3JvdXRlS2V5OiBzdHJpbmddOiBBcHBUaGVvcnlIdHRwQXBpUm91dGVUaHJvdHRsaW5nIH07XG5cbiAgLyoqXG4gICAqIEN1c3RvbSBkb21haW4gY29uZmlndXJhdGlvbi5cbiAgICpcbiAgICogV2hlbiBgZG9tYWluLm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uYCBpcyBzZXQsIEFwcFRoZW9yeSBmYWlscyBjbG9zZWQgYW5kXG4gICAqIGRpc2FibGVzIHRoZSBkZWZhdWx0IGBleGVjdXRlLWFwaWAgZW5kcG9pbnQgc28gdGhlIEFQSSBpcyByZWFjaGFibGUgb25seVxuICAgKiB0aHJvdWdoIHRoZSBtdXR1YWwtVExTIGN1c3RvbSBkb21haW4uIFdpdGhvdXQgbXV0dWFsIFRMUyB0aGUgZGVmYXVsdFxuICAgKiBlbmRwb2ludCBrZWVwcyB0aGUgQVdTIGRlZmF1bHQgKGVuYWJsZWQpLCBzbyBvcmRpbmFyeSBjdXN0b20gZG9tYWlucyBhcmVcbiAgICogdW5hZmZlY3RlZC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBkb21haW4/OiBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucztcblxuICAvKipcbiAgICogU3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeUh0dHBBcGlTdGFnZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFJlZ2lvbmFsIFdBRiBhdHRhY2htZW50IGlzIGludGVudGlvbmFsbHkgdW5hdmFpbGFibGUgZm9yIEFQSSBHYXRld2F5IHYyXG4gICAqIEhUVFAgQVBJcy4gU3VwcGx5aW5nIHRoaXMgcHJvcCBmYWlscyBjbG9zZWQgZHVyaW5nIHN5bnRoZXNpcyBpbnN0ZWFkIG9mXG4gICAqIHByb2R1Y2luZyBhbiB1bnN1cHBvcnRlZCBgL2FwaXMvLi4uL3N0YWdlcy8uLi5gIFdlYkFDTCBhc3NvY2lhdGlvbi5cbiAgICpcbiAgICogVXNlIEFwcFRoZW9yeVJlc3RBcGkgb3IgQXBwVGhlb3J5UmVzdEFwaVJvdXRlciB3aGVuIGEgV0FGLXByb3RlY3RlZCBBUElcbiAgICogR2F0ZXdheSBzdGFnZSBpcyByZXF1aXJlZC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqIEBkZXByZWNhdGVkIEhUVFAgQVBJIFdBRiBhc3NvY2lhdGlvbiBpcyB1bnN1cHBvcnRlZCBieSBBV1MgV0FGdjIuXG4gICAqL1xuICByZWFkb25seSB3YWY/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaVdhZk9wdGlvbnM7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlIdHRwQXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcbiAgcHVibGljIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUFwaURvbWFpbjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5SHR0cEFwaVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcy53YWYpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlIdHRwQXBpIGRvZXMgbm90IHN1cHBvcnQgV0FGdjIgcmVnaW9uYWwgV2ViQUNMIGFzc29jaWF0aW9ucyBmb3IgQVBJIEdhdGV3YXkgdjIgSFRUUCBBUElzOyB1c2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIGZvciBXQUYtcHJvdGVjdGVkIFJFU1Qgc3RhZ2VzXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgIGNvbnN0IHN0YWdlTmFtZSA9IHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiO1xuICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nRm9ybWF0ICE9PSB1bmRlZmluZWQgJiYgIXN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpOiBzdGFnZS5hY2Nlc3NMb2dGb3JtYXQgcmVxdWlyZXMgc3RhZ2UuYWNjZXNzTG9nZ2luZ1wiKTtcbiAgICB9XG4gICAgY29uc3QgbmVlZHNFeHBsaWNpdFN0YWdlID0gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY29yc1ByZWZsaWdodDogYnVpbGRDb3JzUHJlZmxpZ2h0KHByb3BzLmNvcnMpLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlLFxuICAgICAgZGlzYWJsZUV4ZWN1dGVBcGlFbmRwb2ludDogcHJvcHMuZG9tYWluPy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbiAhPT0gdW5kZWZpbmVkID8gdHJ1ZSA6IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0YWdlID0gbmVlZHNFeHBsaWNpdFN0YWdlXG4gICAgICA/IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgICAgICB0aHJvdHRsZTogKHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgIH0pXG4gICAgICA6IHRoaXMuYXBpLmRlZmF1bHRTdGFnZTtcbiAgICBpZiAoIXN0YWdlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlIdHRwQXBpOiBmYWlsZWQgdG8gY3JlYXRlIEFQSSBzdGFnZVwiKTtcbiAgICB9XG4gICAgdGhpcy5zdGFnZSA9IHN0YWdlO1xuICAgIHRoaXMuY29uZmlndXJlQWNjZXNzTG9nZ2luZyhzdGFnZU9wdHMsIHN0YWdlKTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICBwYXRoOiBcIi9cIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuQU5ZXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJSb290XCIsIHByb3BzLmhhbmRsZXIsIHtcbiAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZSxcbiAgICAgIH0pLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL3twcm94eSt9XCIsXG4gICAgICBtZXRob2RzOiBbYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWV0sXG4gICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiUHJveHlcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBleHBsaWNpdFJvdXRlcyA9IHByb3BzLnJvdXRlcyA/PyBbXTtcbiAgICBpZiAoZXhwbGljaXRSb3V0ZXMubGVuZ3RoID4gMCkge1xuICAgICAgdGhpcy5hZGRFeHBsaWNpdFJvdXRlcyhleHBsaWNpdFJvdXRlcywgcHJvcHMuaGFuZGxlciwgcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlKTtcbiAgICB9XG4gICAgaWYgKHByb3BzLnJvdXRlU2V0dGluZ3MgIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uZmlndXJlUm91dGVTZXR0aW5ncyhzdGFnZSwgcHJvcHMucm91dGVTZXR0aW5ncyk7XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgdGhpcy5jb25maWd1cmVEb21haW4ocHJvcHMuZG9tYWluKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFkZEV4cGxpY2l0Um91dGVzKFxuICAgIHJvdXRlczogQXBwVGhlb3J5SHR0cEFwaVJvdXRlT3B0aW9uc1tdLFxuICAgIHJvdXRlSGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbixcbiAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBib29sZWFuLFxuICApOiB2b2lkIHtcbiAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIkV4cGxpY2l0XCIsIHJvdXRlSGFuZGxlciwge1xuICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlLFxuICAgIH0pO1xuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBmb3IgKGNvbnN0IHJvdXRlIG9mIHJvdXRlcykge1xuICAgICAgY29uc3Qgcm91dGVQYXRoID0gbm9ybWFsaXplRXhwbGljaXRSb3V0ZVBhdGgocm91dGUucGF0aCk7XG4gICAgICBjb25zdCBjb25maWd1cmVkTWV0aG9kcyA9IHJvdXRlLm1ldGhvZHMgPz8gW107XG4gICAgICBpZiAoY29uZmlndXJlZE1ldGhvZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIGVudHJ5IGZvciAke0pTT04uc3RyaW5naWZ5KHJvdXRlUGF0aCl9IHJlcXVpcmVzIGF0IGxlYXN0IG9uZSBtZXRob2RgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgZm9yIChjb25zdCByYXdNZXRob2Qgb2YgY29uZmlndXJlZE1ldGhvZHMpIHtcbiAgICAgICAgY29uc3QgbWV0aG9kID0gU3RyaW5nKHJhd01ldGhvZCkudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gICAgICAgIGlmICghRVhQTElDSVRfUk9VVEVfTUVUSE9EUy5oYXMobWV0aG9kKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgbWV0aG9kIG11c3QgYmUgb25lIG9mICR7Wy4uLkVYUExJQ0lUX1JPVVRFX01FVEhPRFNdLmpvaW4oXCIsIFwiKX0gKGdvdCAke0pTT04uc3RyaW5naWZ5KHJhd01ldGhvZCl9KWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCByb3V0ZUlkID0gc2VtYW50aWNSb3V0ZUNvbnN0cnVjdElkKG1ldGhvZCwgcm91dGVQYXRoKTtcbiAgICAgICAgaWYgKHNlZW4uaGFzKHJvdXRlSWQpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBjb250YWlucyB0aGUgZHVwbGljYXRlIHJvdXRlICR7bWV0aG9kfSAke3JvdXRlUGF0aH1gLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgc2Vlbi5hZGQocm91dGVJZCk7XG4gICAgICAgIG5ldyBhcGlnd3YyLkh0dHBSb3V0ZSh0aGlzLCByb3V0ZUlkLCB7XG4gICAgICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICAgICAgcm91dGVLZXk6IGFwaWd3djIuSHR0cFJvdXRlS2V5LndpdGgocm91dGVQYXRoLCBtZXRob2QgYXMgYXBpZ3d2Mi5IdHRwTWV0aG9kKSxcbiAgICAgICAgICBpbnRlZ3JhdGlvbixcbiAgICAgICAgICBhdXRob3JpemVyOiBleHBsaWNpdFJvdXRlQXV0aG9yaXplcihyb3V0ZS5hdXRob3JpemVyKSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBjb25maWd1cmVBY2Nlc3NMb2dnaW5nKHN0YWdlT3B0czogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucywgc3RhZ2U6IGFwaWd3djIuSVN0YWdlKTogdm9pZCB7XG4gICAgaWYgKCFzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGxvZ0dyb3VwID0gc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IHRydWVcbiAgICAgID8gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgICAgfSlcbiAgICAgIDogc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmc7XG4gICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICBmb3JtYXQ6IHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQgPz8gZGVmYXVsdEFjY2Vzc0xvZ0Zvcm1hdCgpLFxuICAgIH07XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZURvbWFpbihvcHRpb25zOiBBcHBUaGVvcnlIdHRwQXBpRG9tYWluT3B0aW9ucyk6IHZvaWQge1xuICAgIGNvbnN0IGNlcnRpZmljYXRlID0gb3B0aW9ucy5jZXJ0aWZpY2F0ZSA/PyAob3B0aW9ucy5jZXJ0aWZpY2F0ZUFyblxuICAgICAgPyBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKHRoaXMsIFwiSW1wb3J0ZWRDZXJ0aWZpY2F0ZVwiLCBvcHRpb25zLmNlcnRpZmljYXRlQXJuKVxuICAgICAgOiB1bmRlZmluZWQpO1xuICAgIGlmICghY2VydGlmaWNhdGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGkgZG9tYWluIHJlcXVpcmVzIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFyblwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBkb21haW4gPSBuZXcgQXBwVGhlb3J5QXBpRG9tYWluKHRoaXMsIFwiRG9tYWluXCIsIHtcbiAgICAgIGRvbWFpbk5hbWU6IG9wdGlvbnMuZG9tYWluTmFtZSxcbiAgICAgIGNlcnRpZmljYXRlLFxuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZTogb3B0aW9ucy5zdGFnZSA/PyB0aGlzLnN0YWdlLFxuICAgICAgaG9zdGVkWm9uZTogb3B0aW9ucy5ob3N0ZWRab25lLFxuICAgICAgYXBpTWFwcGluZ0tleTogb3B0aW9ucy5hcGlNYXBwaW5nS2V5LFxuICAgICAgY3JlYXRlQ25hbWU6IG9wdGlvbnMuY3JlYXRlQ25hbWUsXG4gICAgICByZWNvcmRUdGw6IG9wdGlvbnMucmVjb3JkVHRsLFxuICAgICAgbXV0dWFsVGxzQXV0aGVudGljYXRpb246IG9wdGlvbnMubXV0dWFsVGxzQXV0aGVudGljYXRpb24sXG4gICAgICBzZWN1cml0eVBvbGljeTogb3B0aW9ucy5zZWN1cml0eVBvbGljeSxcbiAgICB9KTtcbiAgICAodGhpcyBhcyB7IGRvbWFpbj86IEFwcFRoZW9yeUFwaURvbWFpbiB9KS5kb21haW4gPSBkb21haW47XG4gIH1cbn1cblxuY29uc3QgRVhQTElDSVRfUk9VVEVfTUVUSE9EUyA9IG5ldyBTZXQoW1xuICBcIkFOWVwiLFxuICBcIkRFTEVURVwiLFxuICBcIkdFVFwiLFxuICBcIkhFQURcIixcbiAgXCJPUFRJT05TXCIsXG4gIFwiUEFUQ0hcIixcbiAgXCJQT1NUXCIsXG4gIFwiUFVUXCIsXG5dKTtcblxuZnVuY3Rpb24gbm9ybWFsaXplRXhwbGljaXRSb3V0ZVBhdGgodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHJvdXRlUGF0aCA9IFN0cmluZyh2YWx1ZSA/PyBcIlwiKS50cmltKCk7XG4gIGlmIChyb3V0ZVBhdGggPT09IFwiXCIgfHwgIXJvdXRlUGF0aC5zdGFydHNXaXRoKFwiL1wiKSB8fCAocm91dGVQYXRoLmxlbmd0aCA+IDEgJiYgcm91dGVQYXRoLmVuZHNXaXRoKFwiL1wiKSkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIHBhdGggbXVzdCBiZSBhbiBhYnNvbHV0ZSBwYXRoIHdpdGggbm8gdHJhaWxpbmcgc2xhc2ggKGdvdCAke0pTT04uc3RyaW5naWZ5KHZhbHVlKX0pYCxcbiAgICApO1xuICB9XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiByb3V0ZVBhdGguc2xpY2UoMSkuc3BsaXQoXCIvXCIpKSB7XG4gICAgaWYgKHNlZ21lbnQgPT09IFwiXCIgfHwgc2VnbWVudCA9PT0gXCIuXCIgfHwgc2VnbWVudCA9PT0gXCIuLlwiKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgcGF0aCBtdXN0IG5vdCBjb250YWluIGVtcHR5IG9yIGRvdCBzZWdtZW50cyAoZ290ICR7SlNPTi5zdHJpbmdpZnkodmFsdWUpfSlgLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJvdXRlUGF0aDtcbn1cblxuZnVuY3Rpb24gZXhwbGljaXRSb3V0ZUF1dGhvcml6ZXIocG9zdHVyZT86IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIpOiBhcGlnd3YyLklIdHRwUm91dGVBdXRob3JpemVyIHtcbiAgcmV0dXJuIHBvc3R1cmUgPT09IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZUF1dGhvcml6ZXIuSUFNXG4gICAgPyBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBJYW1BdXRob3JpemVyKClcbiAgICA6IG5ldyBhcGlnd3YyLkh0dHBOb25lQXV0aG9yaXplcigpO1xufVxuXG5mdW5jdGlvbiBjb25maWd1cmVSb3V0ZVNldHRpbmdzKFxuICBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UsXG4gIHNldHRpbmdzOiB7IFtyb3V0ZUtleTogc3RyaW5nXTogQXBwVGhlb3J5SHR0cEFwaVJvdXRlVGhyb3R0bGluZyB9LFxuKTogdm9pZCB7XG4gIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgY29uc3QgbWFwcGVkOiB7IFtyb3V0ZUtleTogc3RyaW5nXTogeyBbcHJvcGVydHk6IHN0cmluZ106IG51bWJlciB9IH0gPSB7fTtcbiAgZm9yIChjb25zdCBbcm91dGVLZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhzZXR0aW5ncykpIHtcbiAgICBjb25zdCByYXRlTGltaXQgPSB2YWx1ZS5yYXRlTGltaXQ7XG4gICAgY29uc3QgYnVyc3RMaW1pdCA9IHZhbHVlLmJ1cnN0TGltaXQ7XG4gICAgaWYgKHJhdGVMaW1pdCA9PT0gdW5kZWZpbmVkICYmIGJ1cnN0TGltaXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVTZXR0aW5nc1ske0pTT04uc3RyaW5naWZ5KHJvdXRlS2V5KX1dIHJlcXVpcmVzIHJhdGVMaW1pdCBvciBidXJzdExpbWl0YCxcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChyYXRlTGltaXQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0Zpbml0ZShyYXRlTGltaXQpIHx8IHJhdGVMaW1pdCA8PSAwKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVTZXR0aW5nc1ske0pTT04uc3RyaW5naWZ5KHJvdXRlS2V5KX1dLnJhdGVMaW1pdCBtdXN0IGJlIGEgcG9zaXRpdmUgZmluaXRlIG51bWJlcmAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAoYnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkICYmICghTnVtYmVyLmlzRmluaXRlKGJ1cnN0TGltaXQpIHx8IGJ1cnN0TGltaXQgPD0gMCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XS5idXJzdExpbWl0IG11c3QgYmUgYSBwb3NpdGl2ZSBmaW5pdGUgbnVtYmVyYCxcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGVudHJ5OiB7IFtwcm9wZXJ0eTogc3RyaW5nXTogbnVtYmVyIH0gPSB7fTtcbiAgICBpZiAocmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQpIGVudHJ5W1wiVGhyb3R0bGluZ1JhdGVMaW1pdFwiXSA9IHJhdGVMaW1pdDtcbiAgICBpZiAoYnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKSBlbnRyeVtcIlRocm90dGxpbmdCdXJzdExpbWl0XCJdID0gYnVyc3RMaW1pdDtcbiAgICBtYXBwZWRbcm91dGVLZXldID0gZW50cnk7XG4gIH1cbiAgY2ZuU3RhZ2Uucm91dGVTZXR0aW5ncyA9IG1hcHBlZDtcbn1cblxuZnVuY3Rpb24gZGVmYXVsdEFjY2Vzc0xvZ0Zvcm1hdCgpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgfSk7XG59XG4iXX0=