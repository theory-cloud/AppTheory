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
exports.AppTheoryPathRoutedFrontend = exports.AppTheorySpaRewriteMode = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = __importStar(require("aws-cdk-lib/aws-certificatemanager"));
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const origins = __importStar(require("aws-cdk-lib/aws-cloudfront-origins"));
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
const targets = __importStar(require("aws-cdk-lib/aws-route53-targets"));
const s3 = __importStar(require("aws-cdk-lib/aws-s3"));
const constructs_1 = require("constructs");
const string_utils_1 = require("./private/string-utils");
function assertCloudFrontHostedZoneCertificateRegion(scope, constructName) {
    const region = aws_cdk_lib_1.Stack.of(scope).region;
    if (!aws_cdk_lib_1.Token.isUnresolved(region) && region === "us-east-1") {
        return;
    }
    const regionDescription = aws_cdk_lib_1.Token.isUnresolved(region) ? "unresolved" : region;
    throw new Error(`${constructName} cannot create a hosted-zone CloudFront certificate unless the stack region is explicitly us-east-1; stack region is ${regionDescription}. Provide domain.certificate or domain.certificateArn for stacks in other or environment-agnostic regions.`);
}
var AppTheorySpaRewriteMode;
(function (AppTheorySpaRewriteMode) {
    /**
     * Rewrite extensionless routes to `index.html` within the SPA prefix.
     */
    AppTheorySpaRewriteMode["SPA"] = "spa";
    /**
     * Do not rewrite routes. Useful for multi-page/static sites.
     */
    AppTheorySpaRewriteMode["NONE"] = "none";
})(AppTheorySpaRewriteMode || (exports.AppTheorySpaRewriteMode = AppTheorySpaRewriteMode = {}));
/**
 * CloudFront Function code for SPA viewer-request rewrite.
 * Rewrites requests without file extensions to the index.html within the prefix.
 */
function generateSpaRewriteFunctionCode(spaOrigins) {
    const configs = spaOrigins
        .map((spa) => {
        const cleanPrefix = spa.pathPattern.replace(/\/\*$/, "");
        const prefix = `${cleanPrefix}/`;
        const rewriteMode = normalizeSpaRewriteMode(spa.rewriteMode);
        const stripPrefixBeforeOrigin = spa.stripPrefixBeforeOrigin === true;
        const indexPath = `${cleanPrefix}/index.html`;
        return {
            cleanPrefix,
            prefix,
            rewriteMode,
            stripPrefixBeforeOrigin,
            indexPath,
        };
    })
        // Ensure more specific prefixes match first to avoid overlap issues.
        .sort((a, b) => b.cleanPrefix.length - a.cleanPrefix.length);
    const prefixMatches = configs
        .map((cfg) => {
        return `{ cleanPrefix: '${cfg.cleanPrefix}', prefix: '${cfg.prefix}', rewriteMode: '${cfg.rewriteMode}', stripPrefixBeforeOrigin: ${cfg.stripPrefixBeforeOrigin}, indexPath: '${cfg.indexPath}' }`;
    })
        .join(",\n      ");
    return `
	function handler(event) {
	  var request = event.request;
	  var uri = request.uri;

	  // SPA prefix configurations
	  var spaPrefixes = [
	      ${prefixMatches}
	  ];

	  // Check if this is an SPA path
	  for (var i = 0; i < spaPrefixes.length; i++) {
	    var spa = spaPrefixes[i];
	    if (uri.startsWith(spa.prefix)) {
	      var uriWithoutPrefix = uri.substring(spa.prefix.length);

	      if (spa.rewriteMode === 'spa') {
	        // If the URI doesn't have an extension (no file), rewrite to index.html
	        // Check if it has a file extension (contains a dot in the last path segment)
	        var lastSlash = uriWithoutPrefix.lastIndexOf('/');
	        var lastSegment = lastSlash >= 0 ? uriWithoutPrefix.substring(lastSlash + 1) : uriWithoutPrefix;
	        
	        // If no extension in the last segment, serve index.html
	        if (lastSegment.indexOf('.') === -1) {
	          request.uri = spa.indexPath;
	        }
	      }

	      // Optionally strip the prefix before forwarding to the origin.
	      if (spa.stripPrefixBeforeOrigin) {
	        var cleanPrefixWithSlash = spa.cleanPrefix + '/';
	        if (request.uri.startsWith(cleanPrefixWithSlash)) {
	          request.uri = request.uri.substring(spa.cleanPrefix.length);
	        }
	      }
	      break;
	    }
	  }

	  return request;
	}
	`.trim();
}
/**
 * A CloudFront distribution for path-routed multi-SPA + API deployments.
 *
 * This construct creates a CloudFront distribution that routes requests to:
 * - SPA origins (S3 buckets) based on path prefixes (e.g., /l/*, /auth/*)
 * - API origin (default behavior) for all other paths
 * - API bypass paths for specific paths that should skip SPA routing
 *
 * A CloudFront Function handles viewer-request rewriting for SPA routing,
 * ensuring that paths without file extensions are rewritten to index.html.
 */
class AppTheoryPathRoutedFrontend extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend", version: "4.4.2-rc" };
    /**
     * The CloudFront distribution.
     */
    distribution;
    /**
     * The CloudFront Function for SPA rewrite (if SPA origins are configured).
     */
    spaRewriteFunction;
    /**
     * The CloudFront access logs bucket (if logging is enabled).
     */
    logsBucket;
    /**
     * The certificate used for the distribution (if custom domain is configured).
     */
    certificate;
    constructor(scope, id, props) {
        super(scope, id);
        if (!props.apiOriginUrl) {
            throw new Error("AppTheoryPathRoutedFrontend requires props.apiOriginUrl");
        }
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const autoDeleteObjects = props.autoDeleteObjects ?? false;
        const enableLogging = props.enableLogging ?? true;
        // Create logs bucket if logging is enabled
        if (enableLogging) {
            this.logsBucket =
                props.logsBucket ??
                    new s3.Bucket(this, "CloudFrontLogsBucket", {
                        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                        encryption: s3.BucketEncryption.S3_MANAGED,
                        enforceSSL: true,
                        removalPolicy,
                        autoDeleteObjects,
                        objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
                    });
        }
        // Parse the API origin URL to create an HttpOrigin (domain + optional originPath)
        const apiOriginParsed = this.parseOriginFromUrl(props.apiOriginUrl);
        const apiOrigin = new origins.HttpOrigin(apiOriginParsed.domainName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            ...(apiOriginParsed.originPath ? { originPath: apiOriginParsed.originPath } : {}),
        });
        // Handle domain configuration
        let distributionDomainNames;
        let distributionCertificate;
        if (props.domain) {
            const domainName = String(props.domain.domainName).trim();
            if (domainName) {
                distributionDomainNames = [domainName];
                if (props.domain.certificate) {
                    distributionCertificate = props.domain.certificate;
                }
                else if (props.domain.certificateArn) {
                    distributionCertificate = acm.Certificate.fromCertificateArn(this, "Certificate", props.domain.certificateArn);
                }
                else if (props.domain.hostedZone) {
                    assertCloudFrontHostedZoneCertificateRegion(this, "AppTheoryPathRoutedFrontend");
                    distributionCertificate = new acm.Certificate(this, "Certificate", {
                        domainName,
                        validation: acm.CertificateValidation.fromDns(props.domain.hostedZone),
                    });
                }
                else {
                    throw new Error("AppTheoryPathRoutedFrontend requires domain.certificate, domain.certificateArn, or domain.hostedZone when domain.domainName is set");
                }
            }
        }
        this.certificate = distributionCertificate;
        // Create CloudFront Function for SPA rewrite if SPA origins are configured
        const spaOrigins = props.spaOrigins ?? [];
        if (spaOrigins.some((spa) => {
            const rewriteMode = normalizeSpaRewriteMode(spa.rewriteMode);
            return rewriteMode !== AppTheorySpaRewriteMode.NONE || spa.stripPrefixBeforeOrigin === true;
        })) {
            const functionCode = generateSpaRewriteFunctionCode(spaOrigins);
            this.spaRewriteFunction = new cloudfront.Function(this, "SpaRewriteFunction", {
                code: cloudfront.FunctionCode.fromInline(functionCode),
                runtime: cloudfront.FunctionRuntime.JS_2_0,
                comment: "SPA viewer-request rewrite for path-routed frontend",
            });
        }
        // Build additional behaviors
        const additionalBehaviors = {};
        // Add API bypass paths first (higher precedence in CloudFront)
        for (const bypassConfig of props.apiBypassPaths ?? []) {
            const responseHeadersPolicy = bypassConfig.responseHeadersPolicy ??
                props.apiBypassResponseHeadersPolicy ??
                props.responseHeadersPolicy;
            additionalBehaviors[bypassConfig.pathPattern] = {
                origin: apiOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: bypassConfig.cachePolicy ?? cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: bypassConfig.originRequestPolicy ?? props.apiOriginRequestPolicy,
                ...(responseHeadersPolicy
                    ? { responseHeadersPolicy }
                    : {}),
            };
        }
        // Add SPA origin behaviors
        for (const spaConfig of spaOrigins) {
            const responseHeadersPolicy = spaConfig.responseHeadersPolicy ??
                props.spaResponseHeadersPolicy ??
                props.responseHeadersPolicy;
            const rewriteMode = normalizeSpaRewriteMode(spaConfig.rewriteMode);
            const needsFunction = this.spaRewriteFunction &&
                (rewriteMode !== AppTheorySpaRewriteMode.NONE || spaConfig.stripPrefixBeforeOrigin === true);
            const spaOrigin = origins.S3BucketOrigin.withOriginAccessControl(spaConfig.bucket);
            additionalBehaviors[spaConfig.pathPattern] = {
                origin: spaOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                cachePolicy: spaConfig.cachePolicy ?? cloudfront.CachePolicy.CACHING_OPTIMIZED,
                compress: true,
                ...(needsFunction
                    ? {
                        functionAssociations: [
                            {
                                function: this.spaRewriteFunction,
                                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                            },
                        ],
                    }
                    : {}),
                ...(responseHeadersPolicy
                    ? { responseHeadersPolicy }
                    : {}),
            };
        }
        // Create the distribution
        const defaultResponseHeadersPolicy = props.apiResponseHeadersPolicy ??
            props.responseHeadersPolicy;
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            ...(enableLogging && this.logsBucket
                ? { enableLogging: true, logBucket: this.logsBucket, logFilePrefix: "cloudfront/" }
                : {}),
            ...(distributionDomainNames && distributionCertificate
                ? { domainNames: distributionDomainNames, certificate: distributionCertificate }
                : {}),
            defaultBehavior: {
                origin: apiOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: props.apiOriginRequestPolicy,
                ...(defaultResponseHeadersPolicy
                    ? { responseHeadersPolicy: defaultResponseHeadersPolicy }
                    : {}),
            },
            additionalBehaviors,
            ...(props.webAclId ? { webAclId: props.webAclId } : {}),
            ...(props.priceClass ? { priceClass: props.priceClass } : {}),
            ...(props.comment ? { comment: props.comment } : {}),
        });
        // Create Route53 A record if hosted zone is provided
        if (props.domain?.domainName && props.domain?.hostedZone) {
            new route53.ARecord(this, "AliasRecord", {
                zone: props.domain.hostedZone,
                recordName: props.domain.domainName,
                target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
            });
            if (props.domain.createAAAARecord === true) {
                new route53.AaaaRecord(this, "AliasRecordAAAA", {
                    zone: props.domain.hostedZone,
                    recordName: props.domain.domainName,
                    target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
                });
            }
        }
    }
    /**
     * Extracts the domain name from a URL (e.g., "https://api.example.com/path" -> "api.example.com").
     */
    parseOriginFromUrl(url) {
        const urlStr = String(url ?? "").trim();
        if (!urlStr) {
            throw new Error("AppTheoryPathRoutedFrontend requires a non-empty apiOriginUrl");
        }
        // Full URL (recommended): https://api.example.com/prod
        if (urlStr.includes("://")) {
            const parsed = new URL(urlStr);
            const domainName = String(parsed.hostname ?? "").trim();
            if (!domainName) {
                throw new Error(`AppTheoryPathRoutedFrontend could not parse domain from apiOriginUrl: ${urlStr}`);
            }
            const path = String(parsed.pathname ?? "").trim();
            const originPath = path && path !== "/" ? (0, string_utils_1.trimRepeatedCharEnd)(path, "/") : undefined;
            return { domainName, ...(originPath ? { originPath } : {}) };
        }
        // Bare domain (or domain + path): api.example.com or api.example.com/prod
        const withoutQuery = urlStr.split("?")[0]?.split("#")[0] ?? urlStr;
        const firstSlashIndex = withoutQuery.indexOf("/");
        const domainPart = (firstSlashIndex >= 0 ? withoutQuery.slice(0, firstSlashIndex) : withoutQuery)
            .trim();
        const normalizedDomainPart = (0, string_utils_1.stripTrailingPort)(domainPart);
        if (!normalizedDomainPart) {
            throw new Error(`AppTheoryPathRoutedFrontend could not parse domain from apiOriginUrl: ${urlStr}`);
        }
        const pathPart = firstSlashIndex >= 0 ? withoutQuery.slice(firstSlashIndex) : "";
        const originPath = pathPart && pathPart !== "/" ? (0, string_utils_1.trimRepeatedCharEnd)(pathPart, "/") : undefined;
        return { domainName: normalizedDomainPart, ...(originPath ? { originPath } : {}) };
    }
}
exports.AppTheoryPathRoutedFrontend = AppTheoryPathRoutedFrontend;
function normalizeSpaRewriteMode(mode) {
    const value = String(mode ?? AppTheorySpaRewriteMode.SPA).trim().toLowerCase();
    return value === AppTheorySpaRewriteMode.NONE ? AppTheorySpaRewriteMode.NONE : AppTheorySpaRewriteMode.SPA;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aC1yb3V0ZWQtZnJvbnRlbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXRoLXJvdXRlZC1mcm9udGVuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTBEO0FBQzFELHdFQUEwRDtBQUMxRCx1RUFBeUQ7QUFDekQsNEVBQThEO0FBQzlELGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0QsdURBQXlDO0FBQ3pDLDJDQUF1QztBQUV2Qyx5REFBZ0Y7QUFFaEYsU0FBUywyQ0FBMkMsQ0FBQyxLQUFnQixFQUFFLGFBQXFCO0lBQ3hGLE1BQU0sTUFBTSxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUN0QyxJQUFJLENBQUMsbUJBQUssQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxLQUFLLFdBQVcsRUFBRSxDQUFDO1FBQ3hELE9BQU87SUFDWCxDQUFDO0lBRUQsTUFBTSxpQkFBaUIsR0FBRyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDN0UsTUFBTSxJQUFJLEtBQUssQ0FDWCxHQUFHLGFBQWEsd0hBQXdILGlCQUFpQiw0R0FBNEcsQ0FDeFEsQ0FBQztBQUNOLENBQUM7QUFFRCxJQUFZLHVCQVVYO0FBVkQsV0FBWSx1QkFBdUI7SUFDL0I7O09BRUc7SUFDSCxzQ0FBVyxDQUFBO0lBRVg7O09BRUc7SUFDSCx3Q0FBYSxDQUFBO0FBQ2pCLENBQUMsRUFWVyx1QkFBdUIsdUNBQXZCLHVCQUF1QixRQVVsQztBQXFORDs7O0dBR0c7QUFDSCxTQUFTLDhCQUE4QixDQUNuQyxVQUE2QjtJQUU3QixNQUFNLE9BQU8sR0FBRyxVQUFVO1NBQ3JCLEdBQUcsQ0FBQyxDQUFDLEdBQUcsRUFBRSxFQUFFO1FBQ1QsTUFB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RSxDQUFDO1FBQ2pGLE1BQU0sVUFBVSxHQUFHLFFBQVEsSUFBSSxRQUFRLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFBLGtDQUFtQixFQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1FBQ2pHLE9BQU8sRUFBRSxVQUFVLEVBQUUsb0JBQW9CLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBRSxVQUFVLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUN2RixDQUFDOztBQWxQTCxrRUFtUEM7QUFFRCxTQUFTLHVCQUF1QixDQUFDLElBQWtEO0lBQy9FLE1BQU0sS0FBSyxHQUFHLE1BQU0sQ0FBQyxJQUFJLElBQUksdUJBQXVCLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLENBQUM7SUFDL0UsT0FBTyxLQUFLLEtBQUssdUJBQXVCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyx1QkFBdUIsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLHVCQUF1QixDQUFDLEdBQUcsQ0FBQztBQUMvRyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgc3RyaXBUcmFpbGluZ1BvcnQsIHRyaW1SZXBlYXRlZENoYXJFbmQgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuXG5mdW5jdGlvbiBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHNjb3BlOiBDb25zdHJ1Y3QsIGNvbnN0cnVjdE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHJlZ2lvbiA9IFN0YWNrLm9mKHNjb3BlKS5yZWdpb247XG4gICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQocmVnaW9uKSAmJiByZWdpb24gPT09IFwidXMtZWFzdC0xXCIpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHJlZ2lvbkRlc2NyaXB0aW9uID0gVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgPyBcInVucmVzb2x2ZWRcIiA6IHJlZ2lvbjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGAke2NvbnN0cnVjdE5hbWV9IGNhbm5vdCBjcmVhdGUgYSBob3N0ZWQtem9uZSBDbG91ZEZyb250IGNlcnRpZmljYXRlIHVubGVzcyB0aGUgc3RhY2sgcmVnaW9uIGlzIGV4cGxpY2l0bHkgdXMtZWFzdC0xOyBzdGFjayByZWdpb24gaXMgJHtyZWdpb25EZXNjcmlwdGlvbn0uIFByb3ZpZGUgZG9tYWluLmNlcnRpZmljYXRlIG9yIGRvbWFpbi5jZXJ0aWZpY2F0ZUFybiBmb3Igc3RhY2tzIGluIG90aGVyIG9yIGVudmlyb25tZW50LWFnbm9zdGljIHJlZ2lvbnMuYCxcbiAgICApO1xufVxuXG5leHBvcnQgZW51bSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZSB7XG4gICAgLyoqXG4gICAgICogUmV3cml0ZSBleHRlbnNpb25sZXNzIHJvdXRlcyB0byBgaW5kZXguaHRtbGAgd2l0aGluIHRoZSBTUEEgcHJlZml4LlxuICAgICAqL1xuICAgIFNQQSA9IFwic3BhXCIsXG5cbiAgICAvKipcbiAgICAgKiBEbyBub3QgcmV3cml0ZSByb3V0ZXMuIFVzZWZ1bCBmb3IgbXVsdGktcGFnZS9zdGF0aWMgc2l0ZXMuXG4gICAgICovXG4gICAgTk9ORSA9IFwibm9uZVwiLFxufVxuXG4vKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIGFuIFNQQSBvcmlnaW4gcm91dGVkIGJ5IHBhdGggcHJlZml4LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFNwYU9yaWdpbkNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogUzMgYnVja2V0IGNvbnRhaW5pbmcgdGhlIFNQQSBhc3NldHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYnVja2V0OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogUGF0aCBwYXR0ZXJuIHRvIHJvdXRlIHRvIHRoaXMgU1BBIChlLmcuLCBcIi9sLypcIiwgXCIvYXV0aC8qXCIpLlxuICAgICAqIE11c3QgaW5jbHVkZSB0aGUgdHJhaWxpbmcgd2lsZGNhcmQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcGF0aFBhdHRlcm46IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIGNhY2hlIHBvbGljeSBvdmVycmlkZS4gRGVmYXVsdHMgdG8gQ0FDSElOR19PUFRJTUlaRUQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGZvciB0aGlzIFNQQSBiZWhhdmlvci5cbiAgICAgKiBPdmVycmlkZXMgYHNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeWAgYW5kIGByZXNwb25zZUhlYWRlcnNQb2xpY3lgIChsZWdhY3kpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gc3RyaXAgdGhlIFNQQSBwcmVmaXggYmVmb3JlIGZvcndhcmRpbmcgdG8gdGhlIFMzIG9yaWdpbi5cbiAgICAgKlxuICAgICAqIEV4YW1wbGU6XG4gICAgICogLSBSZXF1ZXN0OiBgL2F1dGgvYXNzZXRzL2FwcC5qc2BcbiAgICAgKiAtIFdpdGggYHN0cmlwUHJlZml4QmVmb3JlT3JpZ2luPXRydWVgLCBTMyByZWNlaXZlczogYC9hc3NldHMvYXBwLmpzYFxuICAgICAqXG4gICAgICogVGhpcyBhbGxvd3MgbGF5aW5nIG91dCB0aGUgU1BBIGJ1Y2tldCBhdCByb290IHdoaWxlIHN0aWxsIHNlcnZpbmcgaXQgdW5kZXIgYSBwcmVmaXguXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0cmlwUHJlZml4QmVmb3JlT3JpZ2luPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFNQQSByZXdyaXRlIG1vZGUuXG4gICAgICpcbiAgICAgKiAtIGBTUEFgOiByZXdyaXRlIGV4dGVuc2lvbmxlc3Mgcm91dGVzIHRvIHRoZSBTUEEncyBgaW5kZXguaHRtbGBcbiAgICAgKiAtIGBOT05FYDogZG8gbm90IHJld3JpdGUgcm91dGVzICh1c2VmdWwgZm9yIG11bHRpLXBhZ2Ugc2l0ZXMpXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5TUEFcbiAgICAgKi9cbiAgICByZWFkb25seSByZXdyaXRlTW9kZT86IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlO1xufVxuXG4vKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIHBhdGggcGF0dGVybnMgdGhhdCBzaG91bGQgYnlwYXNzIFNQQSByb3V0aW5nIGFuZCBnbyBkaXJlY3RseSB0byB0aGUgQVBJIG9yaWdpbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcGlCeXBhc3NDb25maWcge1xuICAgIC8qKlxuICAgICAqIFBhdGggcGF0dGVybiB0aGF0IHNob3VsZCByb3V0ZSB0byB0aGUgQVBJIG9yaWdpbiBpbnN0ZWFkIG9mIFNQQSAoZS5nLiwgXCIvYXV0aC93YWxsZXQvKlwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBwYXRoUGF0dGVybjogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgY2FjaGUgcG9saWN5IG92ZXJyaWRlLiBEZWZhdWx0cyB0byBDQUNISU5HX0RJU0FCTEVELlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBvcmlnaW4gcmVxdWVzdCBwb2xpY3kgb3ZlcnJpZGUuXG4gICAgICovXG4gICAgcmVhZG9ubHkgb3JpZ2luUmVxdWVzdFBvbGljeT86IGNsb3VkZnJvbnQuSU9yaWdpblJlcXVlc3RQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSBmb3IgdGhpcyBBUEkgYnlwYXNzIGJlaGF2aW9yLlxuICAgICAqIE92ZXJyaWRlcyBgYXBpQnlwYXNzUmVzcG9uc2VIZWFkZXJzUG9saWN5YCBhbmQgYHJlc3BvbnNlSGVhZGVyc1BvbGljeWAgKGxlZ2FjeSkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xufVxuXG4vKipcbiAqIERvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUGF0aFJvdXRlZEZyb250ZW5kRG9tYWluQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBUaGUgZG9tYWluIG5hbWUgZm9yIHRoZSBkaXN0cmlidXRpb24gKGUuZy4sIFwiYXBwLmV4YW1wbGUuY29tXCIpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgSFRUUFMuIE11c3QgYmUgaW4gdXMtZWFzdC0xIGZvciBDbG91ZEZyb250LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIEFSTiBvZiBhbiBleGlzdGluZyBBQ00gY2VydGlmaWNhdGUuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgICAqIFdoZW4gcHJvdmlkZWQsIGFuIEEgcmVjb3JkIGFsaWFzIHdpbGwgYmUgY3JlYXRlZCBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKlxuICAgICAqIElmIGBkb21haW5OYW1lYCBpcyBzZXQgd2l0aG91dCBgY2VydGlmaWNhdGVgIG9yIGBjZXJ0aWZpY2F0ZUFybmAsXG4gICAgICogaG9zdGVkLXpvbmUgY2VydGlmaWNhdGUgY3JlYXRpb24gaXMgYWxsb3dlZCBvbmx5IGZvciBzdGFja3Mgd2hvc2UgcmVnaW9uXG4gICAgICogaXMgZXhwbGljaXRseSBgdXMtZWFzdC0xYC4gQ2xvdWRGcm9udCByZXF1aXJlcyB2aWV3ZXIgY2VydGlmaWNhdGVzIGluXG4gICAgICogYHVzLWVhc3QtMWA7IGVudmlyb25tZW50LWFnbm9zdGljIG9yIG90aGVyLXJlZ2lvbiBzdGFja3MgbXVzdCBwcm92aWRlIGFuXG4gICAgICogZXhwbGljaXQgY2VydGlmaWNhdGUgaW5wdXQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhbiBBQUFBIGFsaWFzIHJlY29yZCBpbiBhZGRpdGlvbiB0byB0aGUgQSBhbGlhcyByZWNvcmQuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBjcmVhdGVBQUFBUmVjb3JkPzogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmRQcm9wcyB7XG4gICAgLyoqXG4gICAgICogVGhlIHByaW1hcnkgQVBJIG9yaWdpbiBVUkwgKGUuZy4sIHRoZSBBUEkgR2F0ZXdheSBpbnZva2UgVVJMIG9yIExhbWJkYSBmdW5jdGlvbiBVUkwpLlxuICAgICAqIFRoaXMgaXMgdXNlZCBmb3IgdGhlIGRlZmF1bHQgYmVoYXZpb3IgYW5kIGFueSBBUEkgYnlwYXNzIHBhdGhzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaU9yaWdpblVybDogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogU1BBIG9yaWdpbnMgd2l0aCB0aGVpciBwYXRoIHBhdHRlcm5zLlxuICAgICAqIEVhY2ggU1BBIHdpbGwgYmUgc2VydmVkIHZpYSBDbG91ZEZyb250IHdpdGggU1BBIHJld3JpdGUgc3VwcG9ydC5cbiAgICAgKi9cbiAgICByZWFkb25seSBzcGFPcmlnaW5zPzogU3BhT3JpZ2luQ29uZmlnW107XG5cbiAgICAvKipcbiAgICAgKiBBUEkgYnlwYXNzIGNvbmZpZ3VyYXRpb25zIGZvciBwYXRocyB0aGF0IHNob3VsZCBnbyBkaXJlY3RseSB0byB0aGUgQVBJIG9yaWdpblxuICAgICAqIGV2ZW4gdGhvdWdoIHRoZXkgbWlnaHQgbWF0Y2ggYW4gU1BBIHBhdGggcHJlZml4LlxuICAgICAqIFRoZXNlIGFyZSBldmFsdWF0ZWQgYmVmb3JlIFNQQSBwYXRocyBkdWUgdG8gQ2xvdWRGcm9udCBiZWhhdmlvciBwcmVjZWRlbmNlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaUJ5cGFzc1BhdGhzPzogQXBpQnlwYXNzQ29uZmlnW107XG5cbiAgICAvKipcbiAgICAgKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgY3VzdG9tIGRvbWFpbiwgY2VydGlmaWNhdGUsIGFuZCBSb3V0ZTUzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbj86IFBhdGhSb3V0ZWRGcm9udGVuZERvbWFpbkNvbmZpZztcblxuICAgIC8qKlxuICAgICAqIFJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IHRvIGFwcGx5IHRvIGFsbCBiZWhhdmlvcnMgKGxlZ2FjeSkuXG4gICAgICpcbiAgICAgKiBQcmVmZXIgdXNpbmcgYGFwaVJlc3BvbnNlSGVhZGVyc1BvbGljeWAsIGBzcGFSZXNwb25zZUhlYWRlcnNQb2xpY3lgLCBhbmRcbiAgICAgKiBgYXBpQnlwYXNzUmVzcG9uc2VIZWFkZXJzUG9saWN5YCBmb3IgYmVoYXZpb3Itc2NvcGVkIGNvbnRyb2wuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogUmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIHRoZSBBUEkgb3JpZ2luIGRlZmF1bHQgYmVoYXZpb3IuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpUmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogRGVmYXVsdCByZXNwb25zZSBoZWFkZXJzIHBvbGljeSBmb3IgU1BBIGJlaGF2aW9ycy5cbiAgICAgKiBDYW4gYmUgb3ZlcnJpZGRlbiBwZXIgU1BBIHZpYSBgU3BhT3JpZ2luQ29uZmlnLnJlc3BvbnNlSGVhZGVyc1BvbGljeWAuXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3BhUmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogRGVmYXVsdCByZXNwb25zZSBoZWFkZXJzIHBvbGljeSBmb3IgQVBJIGJ5cGFzcyBiZWhhdmlvcnMuXG4gICAgICogQ2FuIGJlIG92ZXJyaWRkZW4gcGVyIGJ5cGFzcyB2aWEgYEFwaUJ5cGFzc0NvbmZpZy5yZXNwb25zZUhlYWRlcnNQb2xpY3lgLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIE9yaWdpbiByZXF1ZXN0IHBvbGljeSBmb3IgdGhlIEFQSSBvcmlnaW4gKGRlZmF1bHQgYmVoYXZpb3IpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaU9yaWdpblJlcXVlc3RQb2xpY3k/OiBjbG91ZGZyb250LklPcmlnaW5SZXF1ZXN0UG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ2dpbmcuXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgUzMgYnVja2V0IGZvciBDbG91ZEZyb250IGFjY2VzcyBsb2dzLlxuICAgICAqIElmIG5vdCBwcm92aWRlZCBhbmQgZW5hYmxlTG9nZ2luZyBpcyB0cnVlLCBhIG5ldyBidWNrZXQgd2lsbCBiZSBjcmVhdGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIGNyZWF0ZWQgcmVzb3VyY2VzLlxuICAgICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGF1dG8tZGVsZXRlIG9iamVjdHMgaW4gY3JlYXRlZCBidWNrZXRzIG9uIHN0YWNrIGRlbGV0aW9uLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIHJlbW92YWxQb2xpY3kgaXMgREVTVFJPWS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIHdlYiBBQ0wgSUQgZm9yIEFXUyBXQUYgaW50ZWdyYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgd2ViQWNsSWQ/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBQcmljZSBjbGFzcyBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqIEBkZWZhdWx0IFByaWNlQ2xhc3MuUFJJQ0VfQ0xBU1NfQUxMXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHJpY2VDbGFzcz86IGNsb3VkZnJvbnQuUHJpY2VDbGFzcztcblxuICAgIC8qKlxuICAgICAqIEFuIG9wdGlvbmFsIG5hbWUvY29tbWVudCBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjb21tZW50Pzogc3RyaW5nO1xufVxuXG4vKipcbiAqIENsb3VkRnJvbnQgRnVuY3Rpb24gY29kZSBmb3IgU1BBIHZpZXdlci1yZXF1ZXN0IHJld3JpdGUuXG4gKiBSZXdyaXRlcyByZXF1ZXN0cyB3aXRob3V0IGZpbGUgZXh0ZW5zaW9ucyB0byB0aGUgaW5kZXguaHRtbCB3aXRoaW4gdGhlIHByZWZpeC5cbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVTcGFSZXdyaXRlRnVuY3Rpb25Db2RlKFxuICAgIHNwYU9yaWdpbnM6IFNwYU9yaWdpbkNvbmZpZ1tdLFxuKTogc3RyaW5nIHtcbiAgICBjb25zdCBjb25maWdzID0gc3BhT3JpZ2luc1xuICAgICAgICAubWFwKChzcGEpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGNsZWFuUHJlZml4ID0gc3BhLnBhdGhQYXR0ZXJuLnJlcGxhY2UoL1xcL1xcKiQvLCBcIlwiKTtcbiAgICAgICAgICAgIGNvbnN0IHByZWZpeCA9IGAke2NsZWFuUHJlZml4fS9gO1xuICAgICAgICAgICAgY29uc3QgcmV3cml0ZU1vZGUgPSBub3JtYWxpemVTcGFSZXdyaXRlTW9kZShzcGEucmV3cml0ZU1vZGUpO1xuICAgICAgICAgICAgY29uc3Qgc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4gPSBzcGEuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4gPT09IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpbmRleFBhdGggPSBgJHtjbGVhblByZWZpeH0vaW5kZXguaHRtbGA7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGNsZWFuUHJlZml4LFxuICAgICAgICAgICAgICAgIHByZWZpeCxcbiAgICAgICAgICAgICAgICByZXdyaXRlTW9kZSxcbiAgICAgICAgICAgICAgICBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbixcbiAgICAgICAgICAgICAgICBpbmRleFBhdGgsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9KVxuICAgICAgICAvLyBFbnN1cmUgbW9yZSBzcGVjaWZpYyBwcmVmaXhlcyBtYXRjaCBmaXJzdCB0byBhdm9pZCBvdmVybGFwIGlzc3Vlcy5cbiAgICAgICAgLnNvcnQoKGEsIGIpID0+IGIuY2xlYW5QcmVmaXgubGVuZ3RoIC0gYS5jbGVhblByZWZpeC5sZW5ndGgpO1xuXG4gICAgY29uc3QgcHJlZml4TWF0Y2hlcyA9IGNvbmZpZ3NcbiAgICAgICAgLm1hcCgoY2ZnKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gYHsgY2xlYW5QcmVmaXg6ICcke2NmZy5jbGVhblByZWZpeH0nLCBwcmVmaXg6ICcke2NmZy5wcmVmaXh9JywgcmV3cml0ZU1vZGU6ICcke2NmZy5yZXdyaXRlTW9kZX0nLCBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbjogJHtjZmcuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW59LCBpbmRleFBhdGg6ICcke2NmZy5pbmRleFBhdGh9JyB9YDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuXG4gICAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICB2YXIgdXJpID0gcmVxdWVzdC51cmk7XG5cblx0ICAvLyBTUEEgcHJlZml4IGNvbmZpZ3VyYXRpb25zXG5cdCAgdmFyIHNwYVByZWZpeGVzID0gW1xuXHQgICAgICAke3ByZWZpeE1hdGNoZXN9XG5cdCAgXTtcblxuXHQgIC8vIENoZWNrIGlmIHRoaXMgaXMgYW4gU1BBIHBhdGhcblx0ICBmb3IgKHZhciBpID0gMDsgaSA8IHNwYVByZWZpeGVzLmxlbmd0aDsgaSsrKSB7XG5cdCAgICB2YXIgc3BhID0gc3BhUHJlZml4ZXNbaV07XG5cdCAgICBpZiAodXJpLnN0YXJ0c1dpdGgoc3BhLnByZWZpeCkpIHtcblx0ICAgICAgdmFyIHVyaVdpdGhvdXRQcmVmaXggPSB1cmkuc3Vic3RyaW5nKHNwYS5wcmVmaXgubGVuZ3RoKTtcblxuXHQgICAgICBpZiAoc3BhLnJld3JpdGVNb2RlID09PSAnc3BhJykge1xuXHQgICAgICAgIC8vIElmIHRoZSBVUkkgZG9lc24ndCBoYXZlIGFuIGV4dGVuc2lvbiAobm8gZmlsZSksIHJld3JpdGUgdG8gaW5kZXguaHRtbFxuXHQgICAgICAgIC8vIENoZWNrIGlmIGl0IGhhcyBhIGZpbGUgZXh0ZW5zaW9uIChjb250YWlucyBhIGRvdCBpbiB0aGUgbGFzdCBwYXRoIHNlZ21lbnQpXG5cdCAgICAgICAgdmFyIGxhc3RTbGFzaCA9IHVyaVdpdGhvdXRQcmVmaXgubGFzdEluZGV4T2YoJy8nKTtcblx0ICAgICAgICB2YXIgbGFzdFNlZ21lbnQgPSBsYXN0U2xhc2ggPj0gMCA/IHVyaVdpdGhvdXRQcmVmaXguc3Vic3RyaW5nKGxhc3RTbGFzaCArIDEpIDogdXJpV2l0aG91dFByZWZpeDtcblx0ICAgICAgICBcblx0ICAgICAgICAvLyBJZiBubyBleHRlbnNpb24gaW4gdGhlIGxhc3Qgc2VnbWVudCwgc2VydmUgaW5kZXguaHRtbFxuXHQgICAgICAgIGlmIChsYXN0U2VnbWVudC5pbmRleE9mKCcuJykgPT09IC0xKSB7XG5cdCAgICAgICAgICByZXF1ZXN0LnVyaSA9IHNwYS5pbmRleFBhdGg7XG5cdCAgICAgICAgfVxuXHQgICAgICB9XG5cblx0ICAgICAgLy8gT3B0aW9uYWxseSBzdHJpcCB0aGUgcHJlZml4IGJlZm9yZSBmb3J3YXJkaW5nIHRvIHRoZSBvcmlnaW4uXG5cdCAgICAgIGlmIChzcGEuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4pIHtcblx0ICAgICAgICB2YXIgY2xlYW5QcmVmaXhXaXRoU2xhc2ggPSBzcGEuY2xlYW5QcmVmaXggKyAnLyc7XG5cdCAgICAgICAgaWYgKHJlcXVlc3QudXJpLnN0YXJ0c1dpdGgoY2xlYW5QcmVmaXhXaXRoU2xhc2gpKSB7XG5cdCAgICAgICAgICByZXF1ZXN0LnVyaSA9IHJlcXVlc3QudXJpLnN1YnN0cmluZyhzcGEuY2xlYW5QcmVmaXgubGVuZ3RoKTtcblx0ICAgICAgICB9XG5cdCAgICAgIH1cblx0ICAgICAgYnJlYWs7XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlcXVlc3Q7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbi8qKlxuICogQSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiBmb3IgcGF0aC1yb3V0ZWQgbXVsdGktU1BBICsgQVBJIGRlcGxveW1lbnRzLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGNyZWF0ZXMgYSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiB0aGF0IHJvdXRlcyByZXF1ZXN0cyB0bzpcbiAqIC0gU1BBIG9yaWdpbnMgKFMzIGJ1Y2tldHMpIGJhc2VkIG9uIHBhdGggcHJlZml4ZXMgKGUuZy4sIC9sLyosIC9hdXRoLyopXG4gKiAtIEFQSSBvcmlnaW4gKGRlZmF1bHQgYmVoYXZpb3IpIGZvciBhbGwgb3RoZXIgcGF0aHNcbiAqIC0gQVBJIGJ5cGFzcyBwYXRocyBmb3Igc3BlY2lmaWMgcGF0aHMgdGhhdCBzaG91bGQgc2tpcCBTUEEgcm91dGluZ1xuICpcbiAqIEEgQ2xvdWRGcm9udCBGdW5jdGlvbiBoYW5kbGVzIHZpZXdlci1yZXF1ZXN0IHJld3JpdGluZyBmb3IgU1BBIHJvdXRpbmcsXG4gKiBlbnN1cmluZyB0aGF0IHBhdGhzIHdpdGhvdXQgZmlsZSBleHRlbnNpb25zIGFyZSByZXdyaXR0ZW4gdG8gaW5kZXguaHRtbC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuXG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgRnVuY3Rpb24gZm9yIFNQQSByZXdyaXRlIChpZiBTUEEgb3JpZ2lucyBhcmUgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHNwYVJld3JpdGVGdW5jdGlvbj86IGNsb3VkZnJvbnQuRnVuY3Rpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBidWNrZXQgKGlmIGxvZ2dpbmcgaXMgZW5hYmxlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIGNlcnRpZmljYXRlIHVzZWQgZm9yIHRoZSBkaXN0cmlidXRpb24gKGlmIGN1c3RvbSBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmRQcm9wcykge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgICAgIGlmICghcHJvcHMuYXBpT3JpZ2luVXJsKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgcmVxdWlyZXMgcHJvcHMuYXBpT3JpZ2luVXJsXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgICAgIGNvbnN0IGVuYWJsZUxvZ2dpbmcgPSBwcm9wcy5lbmFibGVMb2dnaW5nID8/IHRydWU7XG5cbiAgICAgICAgLy8gQ3JlYXRlIGxvZ3MgYnVja2V0IGlmIGxvZ2dpbmcgaXMgZW5hYmxlZFxuICAgICAgICBpZiAoZW5hYmxlTG9nZ2luZykge1xuICAgICAgICAgICAgdGhpcy5sb2dzQnVja2V0ID1cbiAgICAgICAgICAgICAgICBwcm9wcy5sb2dzQnVja2V0ID8/XG4gICAgICAgICAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkNsb3VkRnJvbnRMb2dzQnVja2V0XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICAgICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgICAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgICAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICAgICAgICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuT0JKRUNUX1dSSVRFUixcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFBhcnNlIHRoZSBBUEkgb3JpZ2luIFVSTCB0byBjcmVhdGUgYW4gSHR0cE9yaWdpbiAoZG9tYWluICsgb3B0aW9uYWwgb3JpZ2luUGF0aClcbiAgICAgICAgY29uc3QgYXBpT3JpZ2luUGFyc2VkID0gdGhpcy5wYXJzZU9yaWdpbkZyb21VcmwocHJvcHMuYXBpT3JpZ2luVXJsKTtcbiAgICAgICAgY29uc3QgYXBpT3JpZ2luID0gbmV3IG9yaWdpbnMuSHR0cE9yaWdpbihhcGlPcmlnaW5QYXJzZWQuZG9tYWluTmFtZSwge1xuICAgICAgICAgICAgcHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUHJvdG9jb2xQb2xpY3kuSFRUUFNfT05MWSxcbiAgICAgICAgICAgIC4uLihhcGlPcmlnaW5QYXJzZWQub3JpZ2luUGF0aCA/IHsgb3JpZ2luUGF0aDogYXBpT3JpZ2luUGFyc2VkLm9yaWdpblBhdGggfSA6IHt9KSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gSGFuZGxlIGRvbWFpbiBjb25maWd1cmF0aW9uXG4gICAgICAgIGxldCBkaXN0cmlidXRpb25Eb21haW5OYW1lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gICAgICAgIGxldCBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTogYWNtLklDZXJ0aWZpY2F0ZSB8IHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICAgICAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbi5kb21haW5OYW1lKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoZG9tYWluTmFtZSkge1xuICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzID0gW2RvbWFpbk5hbWVdO1xuXG4gICAgICAgICAgICAgICAgaWYgKHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZUFybikge1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4oXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbih0aGlzLCBcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZFwiKTtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBuZXcgYWNtLkNlcnRpZmljYXRlKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhbGlkYXRpb246IGFjbS5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucyhwcm9wcy5kb21haW4uaG9zdGVkWm9uZSksXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIHJlcXVpcmVzIGRvbWFpbi5jZXJ0aWZpY2F0ZSwgZG9tYWluLmNlcnRpZmljYXRlQXJuLCBvciBkb21haW4uaG9zdGVkWm9uZSB3aGVuIGRvbWFpbi5kb21haW5OYW1lIGlzIHNldFwiLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTtcblxuICAgICAgICAvLyBDcmVhdGUgQ2xvdWRGcm9udCBGdW5jdGlvbiBmb3IgU1BBIHJld3JpdGUgaWYgU1BBIG9yaWdpbnMgYXJlIGNvbmZpZ3VyZWRcbiAgICAgICAgY29uc3Qgc3BhT3JpZ2lucyA9IHByb3BzLnNwYU9yaWdpbnMgPz8gW107XG4gICAgICAgIGlmIChcbiAgICAgICAgICAgIHNwYU9yaWdpbnMuc29tZSgoc3BhKSA9PiB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmV3cml0ZU1vZGUgPSBub3JtYWxpemVTcGFSZXdyaXRlTW9kZShzcGEucmV3cml0ZU1vZGUpO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXdyaXRlTW9kZSAhPT0gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuTk9ORSB8fCBzcGEuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4gPT09IHRydWU7XG4gICAgICAgICAgICB9KVxuICAgICAgICApIHtcbiAgICAgICAgICAgIGNvbnN0IGZ1bmN0aW9uQ29kZSA9IGdlbmVyYXRlU3BhUmV3cml0ZUZ1bmN0aW9uQ29kZShzcGFPcmlnaW5zKTtcblxuICAgICAgICAgICAgdGhpcy5zcGFSZXdyaXRlRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNwYVJld3JpdGVGdW5jdGlvblwiLCB7XG4gICAgICAgICAgICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShmdW5jdGlvbkNvZGUpLFxuICAgICAgICAgICAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgICAgICAgICAgICBjb21tZW50OiBcIlNQQSB2aWV3ZXItcmVxdWVzdCByZXdyaXRlIGZvciBwYXRoLXJvdXRlZCBmcm9udGVuZFwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBCdWlsZCBhZGRpdGlvbmFsIGJlaGF2aW9yc1xuICAgICAgICBjb25zdCBhZGRpdGlvbmFsQmVoYXZpb3JzOiBSZWNvcmQ8c3RyaW5nLCBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucz4gPSB7fTtcblxuICAgICAgICAvLyBBZGQgQVBJIGJ5cGFzcyBwYXRocyBmaXJzdCAoaGlnaGVyIHByZWNlZGVuY2UgaW4gQ2xvdWRGcm9udClcbiAgICAgICAgZm9yIChjb25zdCBieXBhc3NDb25maWcgb2YgcHJvcHMuYXBpQnlwYXNzUGF0aHMgPz8gW10pIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlSGVhZGVyc1BvbGljeSA9XG4gICAgICAgICAgICAgICAgYnlwYXNzQ29uZmlnLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgICAgIHByb3BzLmFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgICAgIHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgICAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9yc1tieXBhc3NDb25maWcucGF0aFBhdHRlcm5dID0ge1xuICAgICAgICAgICAgICAgIG9yaWdpbjogYXBpT3JpZ2luLFxuICAgICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgICAgICAgICAgICBjYWNoZVBvbGljeTogYnlwYXNzQ29uZmlnLmNhY2hlUG9saWN5ID8/IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OlxuICAgICAgICAgICAgICAgICAgICBieXBhc3NDb25maWcub3JpZ2luUmVxdWVzdFBvbGljeSA/PyBwcm9wcy5hcGlPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICAgICAgICAgIC4uLihyZXNwb25zZUhlYWRlcnNQb2xpY3lcbiAgICAgICAgICAgICAgICAgICAgPyB7IHJlc3BvbnNlSGVhZGVyc1BvbGljeSB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFkZCBTUEEgb3JpZ2luIGJlaGF2aW9yc1xuICAgICAgICBmb3IgKGNvbnN0IHNwYUNvbmZpZyBvZiBzcGFPcmlnaW5zKSB7XG4gICAgICAgICAgICBjb25zdCByZXNwb25zZUhlYWRlcnNQb2xpY3kgPVxuICAgICAgICAgICAgICAgIHNwYUNvbmZpZy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgICAgICAgICAgICBwcm9wcy5zcGFSZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgICAgICAgICAgICBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3k7XG4gICAgICAgICAgICBjb25zdCByZXdyaXRlTW9kZSA9IG5vcm1hbGl6ZVNwYVJld3JpdGVNb2RlKHNwYUNvbmZpZy5yZXdyaXRlTW9kZSk7XG4gICAgICAgICAgICBjb25zdCBuZWVkc0Z1bmN0aW9uID1cbiAgICAgICAgICAgICAgICB0aGlzLnNwYVJld3JpdGVGdW5jdGlvbiAmJlxuICAgICAgICAgICAgICAgIChyZXdyaXRlTW9kZSAhPT0gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuTk9ORSB8fCBzcGFDb25maWcuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4gPT09IHRydWUpO1xuXG4gICAgICAgICAgICBjb25zdCBzcGFPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHNwYUNvbmZpZy5idWNrZXQpO1xuXG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW3NwYUNvbmZpZy5wYXRoUGF0dGVybl0gPSB7XG4gICAgICAgICAgICAgICAgb3JpZ2luOiBzcGFPcmlnaW4sXG4gICAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgICAgICAgICAgICBjYWNoZVBvbGljeTogc3BhQ29uZmlnLmNhY2hlUG9saWN5ID8/IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19PUFRJTUlaRUQsXG4gICAgICAgICAgICAgICAgY29tcHJlc3M6IHRydWUsXG4gICAgICAgICAgICAgICAgLi4uKG5lZWRzRnVuY3Rpb25cbiAgICAgICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbkFzc29jaWF0aW9uczogW1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZnVuY3Rpb246IHRoaXMuc3BhUmV3cml0ZUZ1bmN0aW9uLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBldmVudFR5cGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25FdmVudFR5cGUuVklFV0VSX1JFUVVFU1QsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAgICAgLi4uKHJlc3BvbnNlSGVhZGVyc1BvbGljeVxuICAgICAgICAgICAgICAgICAgICA/IHsgcmVzcG9uc2VIZWFkZXJzUG9saWN5IH1cbiAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBkaXN0cmlidXRpb25cbiAgICAgICAgY29uc3QgZGVmYXVsdFJlc3BvbnNlSGVhZGVyc1BvbGljeSA9XG4gICAgICAgICAgICBwcm9wcy5hcGlSZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgICAgICAgIHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgICAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBcIkRpc3RyaWJ1dGlvblwiLCB7XG4gICAgICAgICAgICAuLi4oZW5hYmxlTG9nZ2luZyAmJiB0aGlzLmxvZ3NCdWNrZXRcbiAgICAgICAgICAgICAgICA/IHsgZW5hYmxlTG9nZ2luZzogdHJ1ZSwgbG9nQnVja2V0OiB0aGlzLmxvZ3NCdWNrZXQsIGxvZ0ZpbGVQcmVmaXg6IFwiY2xvdWRmcm9udC9cIiB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAuLi4oZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgJiYgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGVcbiAgICAgICAgICAgICAgICA/IHsgZG9tYWluTmFtZXM6IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzLCBjZXJ0aWZpY2F0ZTogZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgfVxuICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgICAgICAgICAgb3JpZ2luOiBhcGlPcmlnaW4sXG4gICAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgICAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogcHJvcHMuYXBpT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgICAgICAgICAgICAuLi4oZGVmYXVsdFJlc3BvbnNlSGVhZGVyc1BvbGljeVxuICAgICAgICAgICAgICAgICAgICA/IHsgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBkZWZhdWx0UmVzcG9uc2VIZWFkZXJzUG9saWN5IH1cbiAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9ycyxcbiAgICAgICAgICAgIC4uLihwcm9wcy53ZWJBY2xJZCA/IHsgd2ViQWNsSWQ6IHByb3BzLndlYkFjbElkIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMucHJpY2VDbGFzcyA/IHsgcHJpY2VDbGFzczogcHJvcHMucHJpY2VDbGFzcyB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLmNvbW1lbnQgPyB7IGNvbW1lbnQ6IHByb3BzLmNvbW1lbnQgfSA6IHt9KSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgQSByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbj8uZG9tYWluTmFtZSAmJiBwcm9wcy5kb21haW4/Lmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChwcm9wcy5kb21haW4uY3JlYXRlQUFBQVJlY29yZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZEFBQUFcIiwge1xuICAgICAgICAgICAgICAgICAgICB6b25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3RzIHRoZSBkb21haW4gbmFtZSBmcm9tIGEgVVJMIChlLmcuLCBcImh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3BhdGhcIiAtPiBcImFwaS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICBwcml2YXRlIHBhcnNlT3JpZ2luRnJvbVVybCh1cmw6IHN0cmluZyk6IHsgZG9tYWluTmFtZTogc3RyaW5nOyBvcmlnaW5QYXRoPzogc3RyaW5nIH0ge1xuICAgICAgICBjb25zdCB1cmxTdHIgPSBTdHJpbmcodXJsID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgaWYgKCF1cmxTdHIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCByZXF1aXJlcyBhIG5vbi1lbXB0eSBhcGlPcmlnaW5VcmxcIik7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGdWxsIFVSTCAocmVjb21tZW5kZWQpOiBodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcm9kXG4gICAgICAgIGlmICh1cmxTdHIuaW5jbHVkZXMoXCI6Ly9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwodXJsU3RyKTtcbiAgICAgICAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocGFyc2VkLmhvc3RuYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmICghZG9tYWluTmFtZSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIGNvdWxkIG5vdCBwYXJzZSBkb21haW4gZnJvbSBhcGlPcmlnaW5Vcmw6ICR7dXJsU3RyfWApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBwYXRoID0gU3RyaW5nKHBhcnNlZC5wYXRobmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBjb25zdCBvcmlnaW5QYXRoID0gcGF0aCAmJiBwYXRoICE9PSBcIi9cIiA/IHRyaW1SZXBlYXRlZENoYXJFbmQocGF0aCwgXCIvXCIpIDogdW5kZWZpbmVkO1xuICAgICAgICAgICAgcmV0dXJuIHsgZG9tYWluTmFtZSwgLi4uKG9yaWdpblBhdGggPyB7IG9yaWdpblBhdGggfSA6IHt9KSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQmFyZSBkb21haW4gKG9yIGRvbWFpbiArIHBhdGgpOiBhcGkuZXhhbXBsZS5jb20gb3IgYXBpLmV4YW1wbGUuY29tL3Byb2RcbiAgICAgICAgY29uc3Qgd2l0aG91dFF1ZXJ5ID0gdXJsU3RyLnNwbGl0KFwiP1wiKVswXT8uc3BsaXQoXCIjXCIpWzBdID8/IHVybFN0cjtcbiAgICAgICAgY29uc3QgZmlyc3RTbGFzaEluZGV4ID0gd2l0aG91dFF1ZXJ5LmluZGV4T2YoXCIvXCIpO1xuICAgICAgICBjb25zdCBkb21haW5QYXJ0ID0gKGZpcnN0U2xhc2hJbmRleCA+PSAwID8gd2l0aG91dFF1ZXJ5LnNsaWNlKDAsIGZpcnN0U2xhc2hJbmRleCkgOiB3aXRob3V0UXVlcnkpXG4gICAgICAgICAgICAudHJpbSgpO1xuICAgICAgICBjb25zdCBub3JtYWxpemVkRG9tYWluUGFydCA9IHN0cmlwVHJhaWxpbmdQb3J0KGRvbWFpblBhcnQpO1xuICAgICAgICBpZiAoIW5vcm1hbGl6ZWREb21haW5QYXJ0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBjb3VsZCBub3QgcGFyc2UgZG9tYWluIGZyb20gYXBpT3JpZ2luVXJsOiAke3VybFN0cn1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBhdGhQYXJ0ID0gZmlyc3RTbGFzaEluZGV4ID49IDAgPyB3aXRob3V0UXVlcnkuc2xpY2UoZmlyc3RTbGFzaEluZGV4KSA6IFwiXCI7XG4gICAgICAgIGNvbnN0IG9yaWdpblBhdGggPSBwYXRoUGFydCAmJiBwYXRoUGFydCAhPT0gXCIvXCIgPyB0cmltUmVwZWF0ZWRDaGFyRW5kKHBhdGhQYXJ0LCBcIi9cIikgOiB1bmRlZmluZWQ7XG4gICAgICAgIHJldHVybiB7IGRvbWFpbk5hbWU6IG5vcm1hbGl6ZWREb21haW5QYXJ0LCAuLi4ob3JpZ2luUGF0aCA/IHsgb3JpZ2luUGF0aCB9IDoge30pIH07XG4gICAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTcGFSZXdyaXRlTW9kZShtb2RlOiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZSB8IHN0cmluZyB8IHVuZGVmaW5lZCk6IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlIHtcbiAgICBjb25zdCB2YWx1ZSA9IFN0cmluZyhtb2RlID8/IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLlNQQSkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuIHZhbHVlID09PSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5OT05FID8gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuTk9ORSA6IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLlNQQTtcbn1cbiJdfQ==