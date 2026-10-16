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
                const routeId = explicitRouteConstructId(method, routePath);
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
function explicitRouteConstructId(method, routePath) {
    return `Route${semanticRouteToken(method)}${semanticRouteToken(routePath)}`;
}
function semanticRouteToken(value) {
    const parts = String(value).split(/[^A-Za-z0-9]+/).filter((part) => part !== "");
    if (parts.length === 0) {
        return "Root";
    }
    return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1hcGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJodHRwLWFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQ0Esc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsd0VBQTBEO0FBRTFELDJEQUE2QztBQUU3QywyQ0FBdUM7QUFFdkMsNkNBQWtEO0FBQ2xELGlDQUE0QztBQW9KNUMsNEVBQTRFO0FBQzVFLElBQVksK0JBS1g7QUFMRCxXQUFZLCtCQUErQjtJQUN6QyxvQ0FBb0M7SUFDcEMsOENBQVcsQ0FBQTtJQUNYLHlEQUF5RDtJQUN6RCxnREFBYSxDQUFBO0FBQ2YsQ0FBQyxFQUxXLCtCQUErQiwrQ0FBL0IsK0JBQStCLFFBSzFDO0FBNEdELE1BQWEsZ0JBQWlCLFNBQVEsc0JBQVM7O0lBQzdCLEdBQUcsQ0FBa0I7SUFDckIsS0FBSyxDQUFpQjtJQUN0QixjQUFjLENBQWtCO0lBQ2hDLE1BQU0sQ0FBc0I7SUFFNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUE0QjtRQUNwRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ2QsTUFBTSxJQUFJLEtBQUssQ0FDYixpTEFBaUwsQ0FDbEwsQ0FBQztRQUNKLENBQUM7UUFFRCxNQUFNLFNBQVMsR0FBRyxLQUFLLENBQUMsS0FBSyxJQUFJLEVBQUUsQ0FBQztRQUNwQyxNQUFNLFNBQVMsR0FBRyxTQUFTLENBQUMsU0FBUyxJQUFJLFVBQVUsQ0FBQztRQUNwRCxJQUFJLFNBQVMsQ0FBQyxlQUFlLEtBQUssU0FBUyxJQUFJLENBQUMsU0FBUyxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ3hFLE1BQU0sSUFBSSxLQUFLLENBQUMsc0VBQXNFLENBQUMsQ0FBQztRQUMxRixDQUFDO1FBQ0QsTUFBTSxrQkFBa0IsR0FBRyxTQUFTLEtBQUssVUFBVTtlQUM5QyxTQUFTLENBQUMsYUFBYTtlQUN2QixTQUFTLENBQUMsbUJBQW1CLEtBQUssU0FBUztlQUMzQyxTQUFTLENBQUMsb0JBQW9CLEtBQUssU0FBUyxDQUFDO1FBRWxELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDMUMsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO1lBQ3RCLGFBQWEsRUFBRSxJQUFBLHlCQUFrQixFQUFDLEtBQUssQ0FBQyxJQUFJLENBQUM7WUFDN0Msa0JBQWtCLEVBQUUsQ0FBQyxrQkFBa0I7WUFDdkMseUJBQXlCLEVBQUUsS0FBSyxDQUFDLE1BQU0sRUFBRSx1QkFBdUIsS0FBSyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsU0FBUztTQUNsRyxDQUFDLENBQUM7UUFFSCxNQUFNLEtBQUssR0FBRyxrQkFBa0I7WUFDOUIsQ0FBQyxDQUFDLElBQUksT0FBTyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO2dCQUNuQyxPQUFPLEVBQUUsSUFBSSxDQUFDLEdBQUc7Z0JBQ2pCLFNBQVM7Z0JBQ1QsVUFBVSxFQUFFLElBQUk7Z0JBQ2hCLFFBQVEsRUFBRSxDQUFDLFNBQVMsQ0FBQyxtQkFBbUIsS0FBSyxTQUFTLElBQUksU0FBUyxDQUFDLG9CQUFvQixLQUFLLFNBQVMsQ0FBQztvQkFDckcsQ0FBQyxDQUFDO3dCQUNFLFNBQVMsRUFBRSxTQUFTLENBQUMsbUJBQW1CO3dCQUN4QyxVQUFVLEVBQUUsU0FBUyxDQUFDLG9CQUFvQjtxQkFDM0M7b0JBQ0gsQ0FBQyxDQUFDLFNBQVM7YUFDZCxDQUFDO1lBQ0osQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsWUFBWSxDQUFDO1FBQzFCLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQztZQUNYLE1BQU0sSUFBSSxLQUFLLENBQUMsOENBQThDLENBQUMsQ0FBQztRQUNsRSxDQUFDO1FBQ0QsSUFBSSxDQUFDLEtBQUssR0FBRyxLQUFLLENBQUM7UUFDbkIsSUFBSSxDQUFDLHNCQUFzQixDQUFDLFNBQVMsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUU5QyxJQUFJLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQztZQUNqQixJQUFJLEVBQUUsR0FBRztZQUNULE9BQU8sRUFBRSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO1lBQ2pDLFdBQVcsRUFBRSxJQUFJLG1CQUFtQixDQUFDLHFCQUFxQixDQUFDLE1BQU0sRUFBRSxLQUFLLENBQUMsT0FBTyxFQUFFO2dCQUNoRixvQkFBb0IsRUFBRSxPQUFPLENBQUMsb0JBQW9CLENBQUMsV0FBVztnQkFDOUQsc0JBQXNCLEVBQUUsS0FBSyxDQUFDLHNCQUFzQixJQUFJLElBQUk7YUFDN0QsQ0FBQztTQUNILENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDO1lBQ2pCLElBQUksRUFBRSxXQUFXO1lBQ2pCLE9BQU8sRUFBRSxDQUFDLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDO1lBQ2pDLFdBQVcsRUFBRSxJQUFJLG1CQUFtQixDQUFDLHFCQUFxQixDQUFDLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxFQUFFO2dCQUNqRixvQkFBb0IsRUFBRSxPQUFPLENBQUMsb0JBQW9CLENBQUMsV0FBVztnQkFDOUQsc0JBQXNCLEVBQUUsS0FBSyxDQUFDLHNCQUFzQixJQUFJLElBQUk7YUFDN0QsQ0FBQztTQUNILENBQUMsQ0FBQztRQUVILE1BQU0sY0FBYyxHQUFHLEtBQUssQ0FBQyxNQUFNLElBQUksRUFBRSxDQUFDO1FBQzFDLElBQUksY0FBYyxDQUFDLE1BQU0sR0FBRyxDQUFDLEVBQUUsQ0FBQztZQUM5QixJQUFJLENBQUMsaUJBQWlCLENBQUMsY0FBYyxFQUFFLEtBQUssQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLHNCQUFzQixJQUFJLElBQUksQ0FBQyxDQUFDO1FBQzlGLENBQUM7UUFDRCxJQUFJLEtBQUssQ0FBQyxhQUFhLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDdEMsc0JBQXNCLENBQUMsS0FBSyxFQUFFLEtBQUssQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNyRCxDQUFDO1FBRUQsSUFBSSxLQUFLLENBQUMsTUFBTSxFQUFFLENBQUM7WUFDakIsSUFBSSxDQUFDLGVBQWUsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDckMsQ0FBQztJQUNILENBQUM7SUFFTyxpQkFBaUIsQ0FDdkIsTUFBc0MsRUFDdEMsWUFBOEIsRUFDOUIsc0JBQStCO1FBRS9CLE1BQU0sV0FBVyxHQUFHLElBQUksbUJBQW1CLENBQUMscUJBQXFCLENBQUMsVUFBVSxFQUFFLFlBQVksRUFBRTtZQUMxRixvQkFBb0IsRUFBRSxPQUFPLENBQUMsb0JBQW9CLENBQUMsV0FBVztZQUM5RCxzQkFBc0I7U0FDdkIsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxJQUFJLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztRQUMvQixLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0sRUFBRSxDQUFDO1lBQzNCLE1BQU0sU0FBUyxHQUFHLDBCQUEwQixDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUN6RCxNQUFNLGlCQUFpQixHQUFHLEtBQUssQ0FBQyxPQUFPLElBQUksRUFBRSxDQUFDO1lBQzlDLElBQUksaUJBQWlCLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO2dCQUNuQyxNQUFNLElBQUksS0FBSyxDQUNiLHNDQUFzQyxJQUFJLENBQUMsU0FBUyxDQUFDLFNBQVMsQ0FBQywrQkFBK0IsQ0FDL0YsQ0FBQztZQUNKLENBQUM7WUFDRCxLQUFLLE1BQU0sU0FBUyxJQUFJLGlCQUFpQixFQUFFLENBQUM7Z0JBQzFDLE1BQU0sTUFBTSxHQUFHLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxXQUFXLEVBQUUsQ0FBQztnQkFDdEQsSUFBSSxDQUFDLHNCQUFzQixDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDO29CQUN4QyxNQUFNLElBQUksS0FBSyxDQUNiLGtEQUFrRCxDQUFDLEdBQUcsc0JBQXNCLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFNBQVMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUM5SCxDQUFDO2dCQUNKLENBQUM7Z0JBQ0QsTUFBTSxPQUFPLEdBQUcsd0JBQXdCLENBQUMsTUFBTSxFQUFFLFNBQVMsQ0FBQyxDQUFDO2dCQUM1RCxJQUFJLElBQUksQ0FBQyxHQUFHLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQztvQkFDdEIsTUFBTSxJQUFJLEtBQUssQ0FDYix5REFBeUQsTUFBTSxJQUFJLFNBQVMsRUFBRSxDQUMvRSxDQUFDO2dCQUNKLENBQUM7Z0JBQ0QsSUFBSSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDbEIsSUFBSSxPQUFPLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUU7b0JBQ25DLE9BQU8sRUFBRSxJQUFJLENBQUMsR0FBRztvQkFDakIsUUFBUSxFQUFFLE9BQU8sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxNQUE0QixDQUFDO29CQUM1RSxXQUFXO29CQUNYLFVBQVUsRUFBRSx1QkFBdUIsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDO2lCQUN0RCxDQUFDLENBQUM7WUFDTCxDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7SUFFTyxzQkFBc0IsQ0FBQyxTQUF1QyxFQUFFLEtBQXFCO1FBQzNGLElBQUksQ0FBQyxTQUFTLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDN0IsT0FBTztRQUNULENBQUM7UUFFRCxNQUFNLFFBQVEsR0FBRyxTQUFTLENBQUMsYUFBYSxLQUFLLElBQUk7WUFDL0MsQ0FBQyxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO2dCQUNwQyxTQUFTLEVBQUUsU0FBUyxDQUFDLGtCQUFrQixJQUFJLElBQUksQ0FBQyxhQUFhLENBQUMsU0FBUzthQUN4RSxDQUFDO1lBQ0osQ0FBQyxDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUM7UUFDM0IsSUFBNEMsQ0FBQyxjQUFjLEdBQUcsUUFBUSxDQUFDO1FBRXhFLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBZ0MsQ0FBQztRQUM3RCxRQUFRLENBQUMsaUJBQWlCLEdBQUc7WUFDM0IsY0FBYyxFQUFFLFFBQVEsQ0FBQyxXQUFXO1lBQ3BDLE1BQU0sRUFBRSxTQUFTLENBQUMsZUFBZSxJQUFJLHNCQUFzQixFQUFFO1NBQzlELENBQUM7SUFDSixDQUFDO0lBRU8sZUFBZSxDQUFDLE9BQXNDO1FBQzVELE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxXQUFXLElBQUksQ0FBQyxPQUFPLENBQUMsY0FBYztZQUNoRSxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUUsT0FBTyxDQUFDLGNBQWMsQ0FBQztZQUN6RixDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDZixJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7WUFDakIsTUFBTSxJQUFJLEtBQUssQ0FBQyx1RUFBdUUsQ0FBQyxDQUFDO1FBQzNGLENBQUM7UUFFRCxNQUFNLE1BQU0sR0FBRyxJQUFJLCtCQUFrQixDQUFDLElBQUksRUFBRSxRQUFRLEVBQUU7WUFDcEQsVUFBVSxFQUFFLE9BQU8sQ0FBQyxVQUFVO1lBQzlCLFdBQVc7WUFDWCxPQUFPLEVBQUUsSUFBSSxDQUFDLEdBQUc7WUFDakIsS0FBSyxFQUFFLE9BQU8sQ0FBQyxLQUFLLElBQUksSUFBSSxDQUFDLEtBQUs7WUFDbEMsVUFBVSxFQUFFLE9BQU8sQ0FBQyxVQUFVO1lBQzlCLGFBQWEsRUFBRSxPQUFPLENBQUMsYUFBYTtZQUNwQyxXQUFXLEVBQUUsT0FBTyxDQUFDLFdBQVc7WUFDaEMsU0FBUyxFQUFFLE9BQU8sQ0FBQyxTQUFTO1lBQzVCLHVCQUF1QixFQUFFLE9BQU8sQ0FBQyx1QkFBdUI7WUFDeEQsY0FBYyxFQUFFLE9BQU8sQ0FBQyxjQUFjO1NBQ3ZDLENBQUMsQ0FBQztRQUNGLElBQXdDLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztJQUM1RCxDQUFDOztBQXBLSCw0Q0FxS0M7QUFFRCxNQUFNLHNCQUFzQixHQUFHLElBQUksR0FBRyxDQUFDO0lBQ3JDLEtBQUs7SUFDTCxRQUFRO0lBQ1IsS0FBSztJQUNMLE1BQU07SUFDTixTQUFTO0lBQ1QsT0FBTztJQUNQLE1BQU07SUFDTixLQUFLO0NBQ04sQ0FBQyxDQUFDO0FBRUgsU0FBUywwQkFBMEIsQ0FBQyxLQUFhO0lBQy9DLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxLQUFLLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDN0MsSUFBSSxTQUFTLEtBQUssRUFBRSxJQUFJLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxJQUFJLFNBQVMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3hHLE1BQU0sSUFBSSxLQUFLLENBQ2Isc0ZBQXNGLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FDL0csQ0FBQztJQUNKLENBQUM7SUFDRCxLQUFLLE1BQU0sT0FBTyxJQUFJLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDcEQsSUFBSSxPQUFPLEtBQUssRUFBRSxJQUFJLE9BQU8sS0FBSyxHQUFHLElBQUksT0FBTyxLQUFLLElBQUksRUFBRSxDQUFDO1lBQzFELE1BQU0sSUFBSSxLQUFLLENBQ2IsNkVBQTZFLElBQUksQ0FBQyxTQUFTLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FDdEcsQ0FBQztRQUNKLENBQUM7SUFDSCxDQUFDO0lBQ0QsT0FBTyxTQUFTLENBQUM7QUFDbkIsQ0FBQztBQUVELFNBQVMsd0JBQXdCLENBQUMsTUFBYyxFQUFFLFNBQWlCO0lBQ2pFLE9BQU8sUUFBUSxrQkFBa0IsQ0FBQyxNQUFNLENBQUMsR0FBRyxrQkFBa0IsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO0FBQzlFLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEtBQWE7SUFDdkMsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssQ0FBQyxlQUFlLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUksS0FBSyxFQUFFLENBQUMsQ0FBQztJQUNqRixJQUFJLEtBQUssQ0FBQyxNQUFNLEtBQUssQ0FBQyxFQUFFLENBQUM7UUFDdkIsT0FBTyxNQUFNLENBQUM7SUFDaEIsQ0FBQztJQUNELE9BQU8sS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxFQUFFLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLEVBQUUsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0FBQ3BGLENBQUM7QUFFRCxTQUFTLHVCQUF1QixDQUFDLE9BQXlDO0lBQ3hFLE9BQU8sT0FBTyxLQUFLLCtCQUErQixDQUFDLEdBQUc7UUFDcEQsQ0FBQyxDQUFDLElBQUksa0JBQWtCLENBQUMsaUJBQWlCLEVBQUU7UUFDNUMsQ0FBQyxDQUFDLElBQUksT0FBTyxDQUFDLGtCQUFrQixFQUFFLENBQUM7QUFDdkMsQ0FBQztBQUVELFNBQVMsc0JBQXNCLENBQzdCLEtBQXFCLEVBQ3JCLFFBQWlFO0lBRWpFLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxJQUFJLENBQUMsWUFBZ0MsQ0FBQztJQUM3RCxNQUFNLE1BQU0sR0FBMkQsRUFBRSxDQUFDO0lBQzFFLEtBQUssTUFBTSxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsSUFBSSxNQUFNLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUM7UUFDekQsTUFBTSxTQUFTLEdBQUcsS0FBSyxDQUFDLFNBQVMsQ0FBQztRQUNsQyxNQUFNLFVBQVUsR0FBRyxLQUFLLENBQUMsVUFBVSxDQUFDO1FBQ3BDLElBQUksU0FBUyxLQUFLLFNBQVMsSUFBSSxVQUFVLEtBQUssU0FBUyxFQUFFLENBQUM7WUFDeEQsTUFBTSxJQUFJLEtBQUssQ0FDYixtQ0FBbUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsb0NBQW9DLENBQ2hHLENBQUM7UUFDSixDQUFDO1FBQ0QsSUFBSSxTQUFTLEtBQUssU0FBUyxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxJQUFJLFNBQVMsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDO1lBQy9FLE1BQU0sSUFBSSxLQUFLLENBQ2IsbUNBQW1DLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLDhDQUE4QyxDQUMxRyxDQUFDO1FBQ0osQ0FBQztRQUNELElBQUksVUFBVSxLQUFLLFNBQVMsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUMsSUFBSSxVQUFVLElBQUksQ0FBQyxDQUFDLEVBQUUsQ0FBQztZQUNsRixNQUFNLElBQUksS0FBSyxDQUNiLG1DQUFtQyxJQUFJLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQywrQ0FBK0MsQ0FDM0csQ0FBQztRQUNKLENBQUM7UUFDRCxNQUFNLEtBQUssR0FBbUMsRUFBRSxDQUFDO1FBQ2pELElBQUksU0FBUyxLQUFLLFNBQVM7WUFBRSxLQUFLLENBQUMscUJBQXFCLENBQUMsR0FBRyxTQUFTLENBQUM7UUFDdEUsSUFBSSxVQUFVLEtBQUssU0FBUztZQUFFLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQyxHQUFHLFVBQVUsQ0FBQztRQUN6RSxNQUFNLENBQUMsUUFBUSxDQUFDLEdBQUcsS0FBSyxDQUFDO0lBQzNCLENBQUM7SUFDRCxRQUFRLENBQUMsYUFBYSxHQUFHLE1BQU0sQ0FBQztBQUNsQyxDQUFDO0FBRUQsU0FBUyxzQkFBc0I7SUFDN0IsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDO1FBQ3BCLFNBQVMsRUFBRSxvQkFBb0I7UUFDL0IsRUFBRSxFQUFFLDRCQUE0QjtRQUNoQyxXQUFXLEVBQUUsc0JBQXNCO1FBQ25DLFVBQVUsRUFBRSxxQkFBcUI7UUFDakMsUUFBUSxFQUFFLG1CQUFtQjtRQUM3QixNQUFNLEVBQUUsaUJBQWlCO1FBQ3pCLFFBQVEsRUFBRSxtQkFBbUI7UUFDN0IsY0FBYyxFQUFFLHlCQUF5QjtRQUN6QyxrQkFBa0IsRUFBRSw2QkFBNkI7S0FDbEQsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHR5cGUgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5QXBpRG9tYWluIH0gZnJvbSBcIi4vYXBpLWRvbWFpblwiO1xuaW1wb3J0IHsgYnVpbGRDb3JzUHJlZmxpZ2h0IH0gZnJvbSBcIi4vY29yc1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlSZWdpb25hbFdhZk9wdGlvbnMgfSBmcm9tIFwiLi9yZWdpb25hbC13YWZcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpQ29yc09wdGlvbnMge1xuICAvKipcbiAgICogQWxsb3dlZCBvcmlnaW5zLlxuICAgKiBAZGVmYXVsdCBbXCIqXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd09yaWdpbnM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWxsb3dlZCBIVFRQIG1ldGhvZHMuXG4gICAqIEBkZWZhdWx0IFtcIkdFVFwiLCBcIlBPU1RcIiwgXCJQVVRcIiwgXCJERUxFVEVcIiwgXCJQQVRDSFwiLCBcIkhFQURcIiwgXCJPUFRJT05TXCJdXG4gICAqL1xuICByZWFkb25seSBhbGxvd01ldGhvZHM/OiBzdHJpbmdbXTtcblxuICAvKipcbiAgICogQWxsb3dlZCBoZWFkZXJzLlxuICAgKiBAZGVmYXVsdCBbXCJjb250ZW50LXR5cGVcIiwgXCJhdXRob3JpemF0aW9uXCIsIFwieC1yZXF1ZXN0LWlkXCIsIFwieC10ZW5hbnQtaWRcIl1cbiAgICovXG4gIHJlYWRvbmx5IGFsbG93SGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBFeHBvc2VkIHJlc3BvbnNlIGhlYWRlcnMuXG4gICAqIEBkZWZhdWx0IFtcIngtcmVxdWVzdC1pZFwiXVxuICAgKi9cbiAgcmVhZG9ubHkgZXhwb3NlSGVhZGVycz86IHN0cmluZ1tdO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIGJyb3dzZXJzIG1heSBzZW5kIGNyZWRlbnRpYWxzLlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWxsb3dDcmVkZW50aWFscz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIEJyb3dzZXIgcHJlZmxpZ2h0IGNhY2hlIGR1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5taW51dGVzKDEwKVxuICAgKi9cbiAgcmVhZG9ubHkgbWF4QWdlPzogRHVyYXRpb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaURvbWFpbk9wdGlvbnMge1xuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBuYW1lLCBmb3IgZXhhbXBsZSBgYXBpLmV4YW1wbGUuY29tYC5cbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAvKipcbiAgICogQUNNIGNlcnRpZmljYXRlIGZvciB0aGUgZG9tYWluLlxuICAgKiBQcm92aWRlIGVpdGhlciBjZXJ0aWZpY2F0ZSBvciBjZXJ0aWZpY2F0ZUFybi5cbiAgICovXG4gIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAvKipcbiAgICogQUNNIGNlcnRpZmljYXRlIEFSTi5cbiAgICogUHJvdmlkZSBlaXRoZXIgY2VydGlmaWNhdGUgb3IgY2VydGlmaWNhdGVBcm4uXG4gICAqL1xuICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAvKipcbiAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3Igb3B0aW9uYWwgQ05BTUUgcmVjb3JkIGNyZWF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gIC8qKlxuICAgKiBBUEkgbWFwcGluZyBrZXkgdW5kZXIgdGhlIGN1c3RvbSBkb21haW4uXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXBpTWFwcGluZ0tleT86IHN0cmluZztcblxuICAvKipcbiAgICogU3RhZ2UgdG8gbWFwLiBEZWZhdWx0cyB0byB0aGlzIGNvbnN0cnVjdCdzIHN0YWdlLlxuICAgKiBAZGVmYXVsdCB0aGlzLnN0YWdlXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhIENOQU1FIHdoZW4gaG9zdGVkWm9uZSBpcyBwcm92aWRlZC5cbiAgICogQGRlZmF1bHQgdHJ1ZSB3aGVuIGhvc3RlZFpvbmUgaXMgcHJvdmlkZWRcbiAgICovXG4gIHJlYWRvbmx5IGNyZWF0ZUNuYW1lPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQ05BTUUgcmVjb3JkIFRUTC5cbiAgICogQGRlZmF1bHQgRHVyYXRpb24uc2Vjb25kcygzMDApXG4gICAqL1xuICByZWFkb25seSByZWNvcmRUdGw/OiBEdXJhdGlvbjtcblxuICAvKipcbiAgICogTXV0dWFsIFRMUyBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG11dHVhbFRsc0F1dGhlbnRpY2F0aW9uPzogYXBpZ3d2Mi5NVExTQ29uZmlnO1xuXG4gIC8qKlxuICAgKiBUTFMgc2VjdXJpdHkgcG9saWN5LlxuICAgKiBAZGVmYXVsdCBBUEkgR2F0ZXdheSBkZWZhdWx0XG4gICAqL1xuICByZWFkb25seSBzZWN1cml0eVBvbGljeT86IGFwaWd3djIuU2VjdXJpdHlQb2xpY3k7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgb3IgcHJvdmlkZSBhIGxvZyBncm91cC5cbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuIHwgbG9ncy5JTG9nR3JvdXA7XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGFuIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIEFQSSBHYXRld2F5IHYyIGFjY2Vzcy1sb2cgZm9ybWF0LiBEZWZhdWx0cyB0byB0aGUgQXBwVGhlb3J5IEpTT04gZm9ybWF0LlxuICAgKiBWYWxpZCBvbmx5IHdoZW4gYGFjY2Vzc0xvZ2dpbmdgIGlzIGVuYWJsZWQuXG4gICAqIEBkZWZhdWx0IHRoZSBBcHBUaGVvcnkgSlNPTiBhY2Nlc3MtbG9nIGZvcm1hdFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0Pzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIHJhdGUgbGltaXQuXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdC5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBAZGVwcmVjYXRlZCBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSSBzdGFnZXMgYXJlIG5vdCBzdXBwb3J0ZWQgV0FGdjIgcmVnaW9uYWxcbiAqIGFzc29jaWF0aW9uIHRhcmdldHMuIFVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgd2l0aFxuICogQXBwVGhlb3J5UmVnaW9uYWxXYWZPcHRpb25zIGZvciBXQUYtcHJvdGVjdGVkIFJFU1QgQVBJIHN0YWdlcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlIdHRwQXBpV2FmT3B0aW9ucyBleHRlbmRzIEFwcFRoZW9yeVJlZ2lvbmFsV2FmT3B0aW9ucyB7fVxuXG4vKiogR2F0ZXdheSBhdXRob3JpemF0aW9uIHBvc3R1cmUgZm9yIGFuIGV4cGxpY2l0IEFwcFRoZW9yeUh0dHBBcGkgcm91dGUuICovXG5leHBvcnQgZW51bSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyIHtcbiAgLyoqIEFXUyBJQU0gKFNpZ1Y0KSBvbiB0aGUgcm91dGUuICovXG4gIElBTSA9IFwiaWFtXCIsXG4gIC8qKiBObyBnYXRld2F5IGF1dGhvcml6ZXI7IHRoZSBydW50aW1lIG93bnMgYWRtaXNzaW9uLiAqL1xuICBOT05FID0gXCJub25lXCIsXG59XG5cbi8qKlxuICogT25lIGV4cGxpY2l0LCBzZW1hbnRpY2FsbHkgaWRlbnRpZmllZCByb3V0ZSBhZGRlZCBhbG9uZ3NpZGUgdGhlIGNvbnN0cnVjdCdzXG4gKiBncmVlZHkgYEFOWSAvYCBhbmQgYEFOWSAve3Byb3h5K31gIHJvdXRlcy5cbiAqXG4gKiBBUEkgR2F0ZXdheSBwcmVjZWRlbmNlIGdpdmVzIGEgZnVsbCBtZXRob2QrcGF0aCBtYXRjaCBwcmlvcml0eSBvdmVyIHRoZVxuICogZ3JlZWR5IHJvdXRlcywgc28gYSBtb3JlIHNwZWNpZmljIHJvdXRlIHdpdGggYSBzdHJpY3RlciBhdXRob3JpemVyIChmb3JcbiAqIGV4YW1wbGUgYEFXU19JQU1gKSB3aW5zIGZvciBpdHMgb3duIHBhdGguIEEgd3JvbmctbWV0aG9kIHJlcXVlc3Qgb24gc3VjaCBhXG4gKiBwYXRoIGZhbGxzIHRocm91Z2ggdG8gdGhlIHJ1bnRpbWUncyBmYWlsLWNsb3NlZCA0MDQvNDA1IHdoZW4gdGhlIHJ1bnRpbWUgZG9lc1xuICogbm90IGRlY2xhcmUgaXQuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVJvdXRlT3B0aW9ucyB7XG4gIC8qKiBBYnNvbHV0ZSByb3V0ZSBwYXRoLiBTZWdtZW50cyBhcmUgbGl0ZXJhbHMsIGB7cGFyYW1ldGVyfWAsIG9yIGB7cHJveHkrfWAgc2VnbWVudHMuICovXG4gIHJlYWRvbmx5IHBhdGg6IHN0cmluZztcbiAgLyoqIEhUVFAgbWV0aG9kcyB3aXJlZCBmb3IgdGhlIHJvdXRlLCBmb3IgZXhhbXBsZSBgW1wiR0VUXCJdYCBvciBgW1wiQU5ZXCJdYC4gKi9cbiAgcmVhZG9ubHkgbWV0aG9kczogc3RyaW5nW107XG4gIC8qKlxuICAgKiBHYXRld2F5IGF1dGhvcml6YXRpb24gcG9zdHVyZSBmb3IgdGhlIHJvdXRlLlxuICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLk5PTkVcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXI/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyO1xufVxuXG4vKiogUm91dGUtbGV2ZWwgdGhyb3R0bGluZyBhcHBsaWVkIHRvIG9uZSBBUEkgR2F0ZXdheSByb3V0ZSBrZXkuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeUh0dHBBcGlSb3V0ZVRocm90dGxpbmcge1xuICAvKiogUmVxdWVzdHMgcGVyIHNlY29uZCBmb3IgdGhlIHJvdXRlIGtleS4gQGRlZmF1bHQgdGhlIHN0YWdlIGRlZmF1bHQgKi9cbiAgcmVhZG9ubHkgcmF0ZUxpbWl0PzogbnVtYmVyO1xuICAvKiogQnVyc3QgbGltaXQgZm9yIHRoZSByb3V0ZSBrZXkuIEBkZWZhdWx0IHRoZSBzdGFnZSBkZWZhdWx0ICovXG4gIHJlYWRvbmx5IGJ1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5SHR0cEFwaVByb3BzIHtcbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgSFRUUCBBUEkgdjIgcm91dGVzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICogb25lIHBlcm1pc3Npb24gcGVyIHJvdXRlLiBUaGlzIGlzIHRoZSBzY2FsYWJsZSBjaG9pY2UgZm9yIHJvdXRlIGZhbWlsaWVzIHRoYXQgc2hhcmUgb25lXG4gICAqIExhbWJkYSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlIHBvbGljeSBzaXplXG4gICAqIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgaGFuZGxlciwgbm90IG9ubHkgdGhlIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogQ09SUyBjb25maWd1cmF0aW9uLiBTZXQgdG8gdHJ1ZSBmb3IgQXBwVGhlb3J5IGRlZmF1bHRzLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGNvcnM/OiBib29sZWFuIHwgQXBwVGhlb3J5SHR0cEFwaUNvcnNPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBFeHBsaWNpdCwgc2VtYW50aWNhbGx5IGlkZW50aWZpZWQgcm91dGVzIGFkZGVkIGFsb25nc2lkZSB0aGUgY29uc3RydWN0J3NcbiAgICogZ3JlZWR5IGBBTlkgL2AgYW5kIGBBTlkgL3twcm94eSt9YCByb3V0ZXMuXG4gICAqXG4gICAqIFVzZSB0aGlzIHdoZXJlIGEgc3RyaWN0ZXIgcGVyLXBhdGggZ2F0ZXdheSBwb3N0dXJlIChmb3IgZXhhbXBsZVxuICAgKiBgQXBwVGhlb3J5SHR0cEFwaVJvdXRlQXV0aG9yaXplci5JQU1gKSBtdXN0IHdpbiBvdmVyIHRoZSBncmVlZHkgcm91dGVzOiBhXG4gICAqIGZ1bGwgbWV0aG9kK3BhdGggbWF0Y2ggb3V0cmFua3MgdGhlIGdyZWVkeSByb3V0ZSBieSBBUEkgR2F0ZXdheSBwcmVjZWRlbmNlLFxuICAgKiBhbmQgYSB3cm9uZy1tZXRob2QgcmVxdWVzdCBvbiBzdWNoIGEgcGF0aCBpcyBkZW5pZWQgYnkgdGhlIHJ1bnRpbWUgd2l0aCB0aGVcbiAgICogZmFpbC1jbG9zZWQgNDA0LzQwNSBlbnZlbG9wZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb3V0ZXM/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zW107XG5cbiAgLyoqXG4gICAqIFJvdXRlLWxldmVsIHRocm90dGxpbmcga2V5ZWQgYnkgQVBJIEdhdGV3YXkgcm91dGUga2V5IChmb3IgZXhhbXBsZVxuICAgKiBgXCJBTlkgL3twcm94eSt9XCJgKS4gQXBwbGllZCB0byB0aGUgc3RhZ2UncyByb3V0ZSBzZXR0aW5ncy5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSByb3V0ZVNldHRpbmdzPzogeyBbcm91dGVLZXk6IHN0cmluZ106IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZVRocm90dGxpbmcgfTtcblxuICAvKipcbiAgICogQ3VzdG9tIGRvbWFpbiBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBXaGVuIGBkb21haW4ubXV0dWFsVGxzQXV0aGVudGljYXRpb25gIGlzIHNldCwgQXBwVGhlb3J5IGZhaWxzIGNsb3NlZCBhbmRcbiAgICogZGlzYWJsZXMgdGhlIGRlZmF1bHQgYGV4ZWN1dGUtYXBpYCBlbmRwb2ludCBzbyB0aGUgQVBJIGlzIHJlYWNoYWJsZSBvbmx5XG4gICAqIHRocm91Z2ggdGhlIG11dHVhbC1UTFMgY3VzdG9tIGRvbWFpbi4gV2l0aG91dCBtdXR1YWwgVExTIHRoZSBkZWZhdWx0XG4gICAqIGVuZHBvaW50IGtlZXBzIHRoZSBBV1MgZGVmYXVsdCAoZW5hYmxlZCksIHNvIG9yZGluYXJ5IGN1c3RvbSBkb21haW5zIGFyZVxuICAgKiB1bmFmZmVjdGVkLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGRvbWFpbj86IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zO1xuXG4gIC8qKlxuICAgKiBTdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5SHR0cEFwaVN0YWdlT3B0aW9ucztcblxuICAvKipcbiAgICogUmVnaW9uYWwgV0FGIGF0dGFjaG1lbnQgaXMgaW50ZW50aW9uYWxseSB1bmF2YWlsYWJsZSBmb3IgQVBJIEdhdGV3YXkgdjJcbiAgICogSFRUUCBBUElzLiBTdXBwbHlpbmcgdGhpcyBwcm9wIGZhaWxzIGNsb3NlZCBkdXJpbmcgc3ludGhlc2lzIGluc3RlYWQgb2ZcbiAgICogcHJvZHVjaW5nIGFuIHVuc3VwcG9ydGVkIGAvYXBpcy8uLi4vc3RhZ2VzLy4uLmAgV2ViQUNMIGFzc29jaWF0aW9uLlxuICAgKlxuICAgKiBVc2UgQXBwVGhlb3J5UmVzdEFwaSBvciBBcHBUaGVvcnlSZXN0QXBpUm91dGVyIHdoZW4gYSBXQUYtcHJvdGVjdGVkIEFQSVxuICAgKiBHYXRld2F5IHN0YWdlIGlzIHJlcXVpcmVkLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICogQGRlcHJlY2F0ZWQgSFRUUCBBUEkgV0FGIGFzc29jaWF0aW9uIGlzIHVuc3VwcG9ydGVkIGJ5IEFXUyBXQUZ2Mi5cbiAgICovXG4gIHJlYWRvbmx5IHdhZj86IGJvb2xlYW4gfCBBcHBUaGVvcnlIdHRwQXBpV2FmT3B0aW9ucztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeUh0dHBBcGkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLkh0dHBBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2U7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuICBwdWJsaWMgcmVhZG9ubHkgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlIdHRwQXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzLndhZikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeUh0dHBBcGkgZG9lcyBub3Qgc3VwcG9ydCBXQUZ2MiByZWdpb25hbCBXZWJBQ0wgYXNzb2NpYXRpb25zIGZvciBBUEkgR2F0ZXdheSB2MiBIVFRQIEFQSXM7IHVzZSBBcHBUaGVvcnlSZXN0QXBpIG9yIEFwcFRoZW9yeVJlc3RBcGlSb3V0ZXIgZm9yIFdBRi1wcm90ZWN0ZWQgUkVTVCBzdGFnZXNcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCI7XG4gICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dGb3JtYXQgIT09IHVuZGVmaW5lZCAmJiAhc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGk6IHN0YWdlLmFjY2Vzc0xvZ0Zvcm1hdCByZXF1aXJlcyBzdGFnZS5hY2Nlc3NMb2dnaW5nXCIpO1xuICAgIH1cbiAgICBjb25zdCBuZWVkc0V4cGxpY2l0U3RhZ2UgPSBzdGFnZU5hbWUgIT09IFwiJGRlZmF1bHRcIlxuICAgICAgfHwgc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmdcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWRcbiAgICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkO1xuXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgICBjb3JzUHJlZmxpZ2h0OiBidWlsZENvcnNQcmVmbGlnaHQocHJvcHMuY29ycyksXG4gICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6ICFuZWVkc0V4cGxpY2l0U3RhZ2UsXG4gICAgICBkaXNhYmxlRXhlY3V0ZUFwaUVuZHBvaW50OiBwcm9wcy5kb21haW4/Lm11dHVhbFRsc0F1dGhlbnRpY2F0aW9uICE9PSB1bmRlZmluZWQgPyB0cnVlIDogdW5kZWZpbmVkLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhZ2UgPSBuZWVkc0V4cGxpY2l0U3RhZ2VcbiAgICAgID8gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgICAgIHRocm90dGxlOiAoc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgfSlcbiAgICAgIDogdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIGlmICghc3RhZ2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeUh0dHBBcGk6IGZhaWxlZCB0byBjcmVhdGUgQVBJIHN0YWdlXCIpO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlID0gc3RhZ2U7XG4gICAgdGhpcy5jb25maWd1cmVBY2Nlc3NMb2dnaW5nKHN0YWdlT3B0cywgc3RhZ2UpO1xuXG4gICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgIHBhdGg6IFwiL1wiLFxuICAgICAgbWV0aG9kczogW2FwaWd3djIuSHR0cE1ldGhvZC5BTlldLFxuICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihcIlJvb3RcIiwgcHJvcHMuaGFuZGxlciwge1xuICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlLFxuICAgICAgfSksXG4gICAgfSk7XG5cbiAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgcGF0aDogXCIve3Byb3h5K31cIixcbiAgICAgIG1ldGhvZHM6IFthcGlnd3YyLkh0dHBNZXRob2QuQU5ZXSxcbiAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24oXCJQcm94eVwiLCBwcm9wcy5oYW5kbGVyLCB7XG4gICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUsXG4gICAgICB9KSxcbiAgICB9KTtcblxuICAgIGNvbnN0IGV4cGxpY2l0Um91dGVzID0gcHJvcHMucm91dGVzID8/IFtdO1xuICAgIGlmIChleHBsaWNpdFJvdXRlcy5sZW5ndGggPiAwKSB7XG4gICAgICB0aGlzLmFkZEV4cGxpY2l0Um91dGVzKGV4cGxpY2l0Um91dGVzLCBwcm9wcy5oYW5kbGVyLCBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWUpO1xuICAgIH1cbiAgICBpZiAocHJvcHMucm91dGVTZXR0aW5ncyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBjb25maWd1cmVSb3V0ZVNldHRpbmdzKHN0YWdlLCBwcm9wcy5yb3V0ZVNldHRpbmdzKTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICB0aGlzLmNvbmZpZ3VyZURvbWFpbihwcm9wcy5kb21haW4pO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWRkRXhwbGljaXRSb3V0ZXMoXG4gICAgcm91dGVzOiBBcHBUaGVvcnlIdHRwQXBpUm91dGVPcHRpb25zW10sXG4gICAgcm91dGVIYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uLFxuICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IGJvb2xlYW4sXG4gICk6IHZvaWQge1xuICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKFwiRXhwbGljaXRcIiwgcm91dGVIYW5kbGVyLCB7XG4gICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGUsXG4gICAgfSk7XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2Ygcm91dGVzKSB7XG4gICAgICBjb25zdCByb3V0ZVBhdGggPSBub3JtYWxpemVFeHBsaWNpdFJvdXRlUGF0aChyb3V0ZS5wYXRoKTtcbiAgICAgIGNvbnN0IGNvbmZpZ3VyZWRNZXRob2RzID0gcm91dGUubWV0aG9kcyA/PyBbXTtcbiAgICAgIGlmIChjb25maWd1cmVkTWV0aG9kcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgZW50cnkgZm9yICR7SlNPTi5zdHJpbmdpZnkocm91dGVQYXRoKX0gcmVxdWlyZXMgYXQgbGVhc3Qgb25lIG1ldGhvZGAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IHJhd01ldGhvZCBvZiBjb25maWd1cmVkTWV0aG9kcykge1xuICAgICAgICBjb25zdCBtZXRob2QgPSBTdHJpbmcocmF3TWV0aG9kKS50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgICAgICAgaWYgKCFFWFBMSUNJVF9ST1VURV9NRVRIT0RTLmhhcyhtZXRob2QpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBtZXRob2QgbXVzdCBiZSBvbmUgb2YgJHtbLi4uRVhQTElDSVRfUk9VVEVfTUVUSE9EU10uam9pbihcIiwgXCIpfSAoZ290ICR7SlNPTi5zdHJpbmdpZnkocmF3TWV0aG9kKX0pYCxcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJvdXRlSWQgPSBleHBsaWNpdFJvdXRlQ29uc3RydWN0SWQobWV0aG9kLCByb3V0ZVBhdGgpO1xuICAgICAgICBpZiAoc2Vlbi5oYXMocm91dGVJZCkpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICBgQXBwVGhlb3J5SHR0cEFwaTogcm91dGVzIGNvbnRhaW5zIHRoZSBkdXBsaWNhdGUgcm91dGUgJHttZXRob2R9ICR7cm91dGVQYXRofWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBzZWVuLmFkZChyb3V0ZUlkKTtcbiAgICAgICAgbmV3IGFwaWd3djIuSHR0cFJvdXRlKHRoaXMsIHJvdXRlSWQsIHtcbiAgICAgICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgICAgICByb3V0ZUtleTogYXBpZ3d2Mi5IdHRwUm91dGVLZXkud2l0aChyb3V0ZVBhdGgsIG1ldGhvZCBhcyBhcGlnd3YyLkh0dHBNZXRob2QpLFxuICAgICAgICAgIGludGVncmF0aW9uLFxuICAgICAgICAgIGF1dGhvcml6ZXI6IGV4cGxpY2l0Um91dGVBdXRob3JpemVyKHJvdXRlLmF1dGhvcml6ZXIpLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGNvbmZpZ3VyZUFjY2Vzc0xvZ2dpbmcoc3RhZ2VPcHRzOiBBcHBUaGVvcnlIdHRwQXBpU3RhZ2VPcHRpb25zLCBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2UpOiB2b2lkIHtcbiAgICBpZiAoIXN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbG9nR3JvdXAgPSBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZVxuICAgICAgPyBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICB9KVxuICAgICAgOiBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZztcbiAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICBjZm5TdGFnZS5hY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgIGZvcm1hdDogc3RhZ2VPcHRzLmFjY2Vzc0xvZ0Zvcm1hdCA/PyBkZWZhdWx0QWNjZXNzTG9nRm9ybWF0KCksXG4gICAgfTtcbiAgfVxuXG4gIHByaXZhdGUgY29uZmlndXJlRG9tYWluKG9wdGlvbnM6IEFwcFRoZW9yeUh0dHBBcGlEb21haW5PcHRpb25zKTogdm9pZCB7XG4gICAgY29uc3QgY2VydGlmaWNhdGUgPSBvcHRpb25zLmNlcnRpZmljYXRlID8/IChvcHRpb25zLmNlcnRpZmljYXRlQXJuXG4gICAgICA/IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4odGhpcywgXCJJbXBvcnRlZENlcnRpZmljYXRlXCIsIG9wdGlvbnMuY2VydGlmaWNhdGVBcm4pXG4gICAgICA6IHVuZGVmaW5lZCk7XG4gICAgaWYgKCFjZXJ0aWZpY2F0ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5SHR0cEFwaSBkb21haW4gcmVxdWlyZXMgZWl0aGVyIGNlcnRpZmljYXRlIG9yIGNlcnRpZmljYXRlQXJuXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGRvbWFpbiA9IG5ldyBBcHBUaGVvcnlBcGlEb21haW4odGhpcywgXCJEb21haW5cIiwge1xuICAgICAgZG9tYWluTmFtZTogb3B0aW9ucy5kb21haW5OYW1lLFxuICAgICAgY2VydGlmaWNhdGUsXG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHN0YWdlOiBvcHRpb25zLnN0YWdlID8/IHRoaXMuc3RhZ2UsXG4gICAgICBob3N0ZWRab25lOiBvcHRpb25zLmhvc3RlZFpvbmUsXG4gICAgICBhcGlNYXBwaW5nS2V5OiBvcHRpb25zLmFwaU1hcHBpbmdLZXksXG4gICAgICBjcmVhdGVDbmFtZTogb3B0aW9ucy5jcmVhdGVDbmFtZSxcbiAgICAgIHJlY29yZFR0bDogb3B0aW9ucy5yZWNvcmRUdGwsXG4gICAgICBtdXR1YWxUbHNBdXRoZW50aWNhdGlvbjogb3B0aW9ucy5tdXR1YWxUbHNBdXRoZW50aWNhdGlvbixcbiAgICAgIHNlY3VyaXR5UG9saWN5OiBvcHRpb25zLnNlY3VyaXR5UG9saWN5LFxuICAgIH0pO1xuICAgICh0aGlzIGFzIHsgZG9tYWluPzogQXBwVGhlb3J5QXBpRG9tYWluIH0pLmRvbWFpbiA9IGRvbWFpbjtcbiAgfVxufVxuXG5jb25zdCBFWFBMSUNJVF9ST1VURV9NRVRIT0RTID0gbmV3IFNldChbXG4gIFwiQU5ZXCIsXG4gIFwiREVMRVRFXCIsXG4gIFwiR0VUXCIsXG4gIFwiSEVBRFwiLFxuICBcIk9QVElPTlNcIixcbiAgXCJQQVRDSFwiLFxuICBcIlBPU1RcIixcbiAgXCJQVVRcIixcbl0pO1xuXG5mdW5jdGlvbiBub3JtYWxpemVFeHBsaWNpdFJvdXRlUGF0aCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgcm91dGVQYXRoID0gU3RyaW5nKHZhbHVlID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKHJvdXRlUGF0aCA9PT0gXCJcIiB8fCAhcm91dGVQYXRoLnN0YXJ0c1dpdGgoXCIvXCIpIHx8IChyb3V0ZVBhdGgubGVuZ3RoID4gMSAmJiByb3V0ZVBhdGguZW5kc1dpdGgoXCIvXCIpKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZXMgcGF0aCBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGggd2l0aCBubyB0cmFpbGluZyBzbGFzaCAoZ290ICR7SlNPTi5zdHJpbmdpZnkodmFsdWUpfSlgLFxuICAgICk7XG4gIH1cbiAgZm9yIChjb25zdCBzZWdtZW50IG9mIHJvdXRlUGF0aC5zbGljZSgxKS5zcGxpdChcIi9cIikpIHtcbiAgICBpZiAoc2VnbWVudCA9PT0gXCJcIiB8fCBzZWdtZW50ID09PSBcIi5cIiB8fCBzZWdtZW50ID09PSBcIi4uXCIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlcyBwYXRoIG11c3Qgbm90IGNvbnRhaW4gZW1wdHkgb3IgZG90IHNlZ21lbnRzIChnb3QgJHtKU09OLnN0cmluZ2lmeSh2YWx1ZSl9KWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gcm91dGVQYXRoO1xufVxuXG5mdW5jdGlvbiBleHBsaWNpdFJvdXRlQ29uc3RydWN0SWQobWV0aG9kOiBzdHJpbmcsIHJvdXRlUGF0aDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBSb3V0ZSR7c2VtYW50aWNSb3V0ZVRva2VuKG1ldGhvZCl9JHtzZW1hbnRpY1JvdXRlVG9rZW4ocm91dGVQYXRoKX1gO1xufVxuXG5mdW5jdGlvbiBzZW1hbnRpY1JvdXRlVG9rZW4odmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHBhcnRzID0gU3RyaW5nKHZhbHVlKS5zcGxpdCgvW15BLVphLXowLTldKy8pLmZpbHRlcigocGFydCkgPT4gcGFydCAhPT0gXCJcIik7XG4gIGlmIChwYXJ0cy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gXCJSb290XCI7XG4gIH1cbiAgcmV0dXJuIHBhcnRzLm1hcCgocGFydCkgPT4gcGFydC5jaGFyQXQoMCkudG9VcHBlckNhc2UoKSArIHBhcnQuc2xpY2UoMSkpLmpvaW4oXCJcIik7XG59XG5cbmZ1bmN0aW9uIGV4cGxpY2l0Um91dGVBdXRob3JpemVyKHBvc3R1cmU/OiBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyKTogYXBpZ3d2Mi5JSHR0cFJvdXRlQXV0aG9yaXplciB7XG4gIHJldHVybiBwb3N0dXJlID09PSBBcHBUaGVvcnlIdHRwQXBpUm91dGVBdXRob3JpemVyLklBTVxuICAgID8gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwSWFtQXV0aG9yaXplcigpXG4gICAgOiBuZXcgYXBpZ3d2Mi5IdHRwTm9uZUF1dGhvcml6ZXIoKTtcbn1cblxuZnVuY3Rpb24gY29uZmlndXJlUm91dGVTZXR0aW5ncyhcbiAgc3RhZ2U6IGFwaWd3djIuSVN0YWdlLFxuICBzZXR0aW5nczogeyBbcm91dGVLZXk6IHN0cmluZ106IEFwcFRoZW9yeUh0dHBBcGlSb3V0ZVRocm90dGxpbmcgfSxcbik6IHZvaWQge1xuICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gIGNvbnN0IG1hcHBlZDogeyBbcm91dGVLZXk6IHN0cmluZ106IHsgW3Byb3BlcnR5OiBzdHJpbmddOiBudW1iZXIgfSB9ID0ge307XG4gIGZvciAoY29uc3QgW3JvdXRlS2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoc2V0dGluZ3MpKSB7XG4gICAgY29uc3QgcmF0ZUxpbWl0ID0gdmFsdWUucmF0ZUxpbWl0O1xuICAgIGNvbnN0IGJ1cnN0TGltaXQgPSB2YWx1ZS5idXJzdExpbWl0O1xuICAgIGlmIChyYXRlTGltaXQgPT09IHVuZGVmaW5lZCAmJiBidXJzdExpbWl0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XSByZXF1aXJlcyByYXRlTGltaXQgb3IgYnVyc3RMaW1pdGAsXG4gICAgICApO1xuICAgIH1cbiAgICBpZiAocmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgJiYgKCFOdW1iZXIuaXNGaW5pdGUocmF0ZUxpbWl0KSB8fCByYXRlTGltaXQgPD0gMCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYEFwcFRoZW9yeUh0dHBBcGk6IHJvdXRlU2V0dGluZ3NbJHtKU09OLnN0cmluZ2lmeShyb3V0ZUtleSl9XS5yYXRlTGltaXQgbXVzdCBiZSBhIHBvc2l0aXZlIGZpbml0ZSBudW1iZXJgLFxuICAgICAgKTtcbiAgICB9XG4gICAgaWYgKGJ1cnN0TGltaXQgIT09IHVuZGVmaW5lZCAmJiAoIU51bWJlci5pc0Zpbml0ZShidXJzdExpbWl0KSB8fCBidXJzdExpbWl0IDw9IDApKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGBBcHBUaGVvcnlIdHRwQXBpOiByb3V0ZVNldHRpbmdzWyR7SlNPTi5zdHJpbmdpZnkocm91dGVLZXkpfV0uYnVyc3RMaW1pdCBtdXN0IGJlIGEgcG9zaXRpdmUgZmluaXRlIG51bWJlcmAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBlbnRyeTogeyBbcHJvcGVydHk6IHN0cmluZ106IG51bWJlciB9ID0ge307XG4gICAgaWYgKHJhdGVMaW1pdCAhPT0gdW5kZWZpbmVkKSBlbnRyeVtcIlRocm90dGxpbmdSYXRlTGltaXRcIl0gPSByYXRlTGltaXQ7XG4gICAgaWYgKGJ1cnN0TGltaXQgIT09IHVuZGVmaW5lZCkgZW50cnlbXCJUaHJvdHRsaW5nQnVyc3RMaW1pdFwiXSA9IGJ1cnN0TGltaXQ7XG4gICAgbWFwcGVkW3JvdXRlS2V5XSA9IGVudHJ5O1xuICB9XG4gIGNmblN0YWdlLnJvdXRlU2V0dGluZ3MgPSBtYXBwZWQ7XG59XG5cbmZ1bmN0aW9uIGRlZmF1bHRBY2Nlc3NMb2dGb3JtYXQoKTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gIH0pO1xufVxuIl19