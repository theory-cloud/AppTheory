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
const logical_name_1 = require("./private/logical-name");
const standard_logging_1 = require("./private/standard-logging");
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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend", version: "7.4.0" };
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
        const namingContext = props.namingContext;
        const logical = props.logicalName ?? (namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        const standardLogging = namingContext?.standardLogging === true && enableLogging;
        // Create logs bucket if S3 logging is enabled and the standard profile is
        // not replacing it with CloudWatch Logs delivery.
        if (enableLogging && !standardLogging) {
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
        if (standardLogging && namingContext && logical) {
            (0, standard_logging_1.enableCloudFrontStandardLogging)({
                scope: this,
                id: "CdnLogging",
                context: namingContext,
                distribution: this.distribution,
                logical: `logs/access/cdn/${logical}`,
                format: props.cloudFrontLogFormat,
            });
        }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aC1yb3V0ZWQtZnJvbnRlbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXRoLXJvdXRlZC1mcm9udGVuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTBEO0FBQzFELHdFQUEwRDtBQUMxRCx1RUFBeUQ7QUFDekQsNEVBQThEO0FBQzlELGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0QsdURBQXlDO0FBQ3pDLDJDQUF1QztBQUd2Qyx5REFBNEQ7QUFDNUQsaUVBQTZFO0FBRTdFLHlEQUFnRjtBQUVoRixTQUFTLDJDQUEyQyxDQUFDLEtBQWdCLEVBQUUsYUFBcUI7SUFDeEYsTUFBTSxNQUFNLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQ3RDLElBQUksQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNLEtBQUssV0FBVyxFQUFFLENBQUM7UUFDeEQsT0FBTztJQUNYLENBQUM7SUFFRCxNQUFNLGlCQUFpQixHQUFHLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUM3RSxNQUFNLElBQUksS0FBSyxDQUNYLEdBQUcsYUFBYSx3SEFBd0gsaUJBQWlCLDRHQUE0RyxDQUN4USxDQUFDO0FBQ04sQ0FBQztBQUVELElBQVksdUJBVVg7QUFWRCxXQUFZLHVCQUF1QjtJQUMvQjs7T0FFRztJQUNILHNDQUFXLENBQUE7SUFFWDs7T0FFRztJQUNILHdDQUFhLENBQUE7QUFDakIsQ0FBQyxFQVZXLHVCQUF1Qix1Q0FBdkIsdUJBQXVCLFFBVWxDO0FBaVBEOzs7R0FHRztBQUNILFNBQVMsOEJBQThCLENBQ25DLFVBQTZCO0lBRTdCLE1BQU0sT0FBTyxHQUFHLFVBQVU7U0FDckIsR0FBRyxDQUFDLENB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QyxDQUFDLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQy9FLE9BQU8sS0FBSyxLQUFLLHVCQUF1QixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsdUJBQXVCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyx1QkFBdUIsQ0FBQyxHQUFHLENBQUM7QUFDL0csQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQgfSBmcm9tIFwiLi9sb2dnaW5nXCI7XG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcbmltcG9ydCB7IHN0cmlwVHJhaWxpbmdQb3J0LCB0cmltUmVwZWF0ZWRDaGFyRW5kIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuZnVuY3Rpb24gYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbihzY29wZTogQ29uc3RydWN0LCBjb25zdHJ1Y3ROYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCByZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgJiYgcmVnaW9uID09PSBcInVzLWVhc3QtMVwiKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCByZWdpb25EZXNjcmlwdGlvbiA9IFRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pID8gXCJ1bnJlc29sdmVkXCIgOiByZWdpb247XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgJHtjb25zdHJ1Y3ROYW1lfSBjYW5ub3QgY3JlYXRlIGEgaG9zdGVkLXpvbmUgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB1bmxlc3MgdGhlIHN0YWNrIHJlZ2lvbiBpcyBleHBsaWNpdGx5IHVzLWVhc3QtMTsgc3RhY2sgcmVnaW9uIGlzICR7cmVnaW9uRGVzY3JpcHRpb259LiBQcm92aWRlIGRvbWFpbi5jZXJ0aWZpY2F0ZSBvciBkb21haW4uY2VydGlmaWNhdGVBcm4gZm9yIHN0YWNrcyBpbiBvdGhlciBvciBlbnZpcm9ubWVudC1hZ25vc3RpYyByZWdpb25zLmAsXG4gICAgKTtcbn1cblxuZXhwb3J0IGVudW0gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUge1xuICAgIC8qKlxuICAgICAqIFJld3JpdGUgZXh0ZW5zaW9ubGVzcyByb3V0ZXMgdG8gYGluZGV4Lmh0bWxgIHdpdGhpbiB0aGUgU1BBIHByZWZpeC5cbiAgICAgKi9cbiAgICBTUEEgPSBcInNwYVwiLFxuXG4gICAgLyoqXG4gICAgICogRG8gbm90IHJld3JpdGUgcm91dGVzLiBVc2VmdWwgZm9yIG11bHRpLXBhZ2Uvc3RhdGljIHNpdGVzLlxuICAgICAqL1xuICAgIE5PTkUgPSBcIm5vbmVcIixcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBhbiBTUEEgb3JpZ2luIHJvdXRlZCBieSBwYXRoIHByZWZpeC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBTcGFPcmlnaW5Db25maWcge1xuICAgIC8qKlxuICAgICAqIFMzIGJ1Y2tldCBjb250YWluaW5nIHRoZSBTUEEgYXNzZXRzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJ1Y2tldDogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFBhdGggcGF0dGVybiB0byByb3V0ZSB0byB0aGlzIFNQQSAoZS5nLiwgXCIvbC8qXCIsIFwiL2F1dGgvKlwiKS5cbiAgICAgKiBNdXN0IGluY2x1ZGUgdGhlIHRyYWlsaW5nIHdpbGRjYXJkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHBhdGhQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBjYWNoZSBwb2xpY3kgb3ZlcnJpZGUuIERlZmF1bHRzIHRvIENBQ0hJTkdfT1BUSU1JWkVELlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSBmb3IgdGhpcyBTUEEgYmVoYXZpb3IuXG4gICAgICogT3ZlcnJpZGVzIGBzcGFSZXNwb25zZUhlYWRlcnNQb2xpY3lgIGFuZCBgcmVzcG9uc2VIZWFkZXJzUG9saWN5YCAobGVnYWN5KS5cbiAgICAgKi9cbiAgICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIHN0cmlwIHRoZSBTUEEgcHJlZml4IGJlZm9yZSBmb3J3YXJkaW5nIHRvIHRoZSBTMyBvcmlnaW4uXG4gICAgICpcbiAgICAgKiBFeGFtcGxlOlxuICAgICAqIC0gUmVxdWVzdDogYC9hdXRoL2Fzc2V0cy9hcHAuanNgXG4gICAgICogLSBXaXRoIGBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbj10cnVlYCwgUzMgcmVjZWl2ZXM6IGAvYXNzZXRzL2FwcC5qc2BcbiAgICAgKlxuICAgICAqIFRoaXMgYWxsb3dzIGxheWluZyBvdXQgdGhlIFNQQSBidWNrZXQgYXQgcm9vdCB3aGlsZSBzdGlsbCBzZXJ2aW5nIGl0IHVuZGVyIGEgcHJlZml4LlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbj86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBTUEEgcmV3cml0ZSBtb2RlLlxuICAgICAqXG4gICAgICogLSBgU1BBYDogcmV3cml0ZSBleHRlbnNpb25sZXNzIHJvdXRlcyB0byB0aGUgU1BBJ3MgYGluZGV4Lmh0bWxgXG4gICAgICogLSBgTk9ORWA6IGRvIG5vdCByZXdyaXRlIHJvdXRlcyAodXNlZnVsIGZvciBtdWx0aS1wYWdlIHNpdGVzKVxuICAgICAqXG4gICAgICogQGRlZmF1bHQgQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuU1BBXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmV3cml0ZU1vZGU/OiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZTtcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyBTUEEgcm91dGluZyBhbmQgZ28gZGlyZWN0bHkgdG8gdGhlIEFQSSBvcmlnaW4uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBpQnlwYXNzQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBQYXRoIHBhdHRlcm4gdGhhdCBzaG91bGQgcm91dGUgdG8gdGhlIEFQSSBvcmlnaW4gaW5zdGVhZCBvZiBTUEEgKGUuZy4sIFwiL2F1dGgvd2FsbGV0LypcIikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcGF0aFBhdHRlcm46IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIGNhY2hlIHBvbGljeSBvdmVycmlkZS4gRGVmYXVsdHMgdG8gQ0FDSElOR19ESVNBQkxFRC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgb3JpZ2luIHJlcXVlc3QgcG9saWN5IG92ZXJyaWRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IG9yaWdpblJlcXVlc3RQb2xpY3k/OiBjbG91ZGZyb250LklPcmlnaW5SZXF1ZXN0UG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogUmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIHRoaXMgQVBJIGJ5cGFzcyBiZWhhdmlvci5cbiAgICAgKiBPdmVycmlkZXMgYGFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeWAgYW5kIGByZXNwb25zZUhlYWRlcnNQb2xpY3lgIChsZWdhY3kpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcbn1cblxuLyoqXG4gKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFBhdGhSb3V0ZWRGcm9udGVuZERvbWFpbkNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogVGhlIGRvbWFpbiBuYW1lIGZvciB0aGUgZGlzdHJpYnV0aW9uIChlLmcuLCBcImFwcC5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIEhUVFBTLiBNdXN0IGJlIGluIHVzLWVhc3QtMSBmb3IgQ2xvdWRGcm9udC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBUk4gb2YgYW4gZXhpc3RpbmcgQUNNIGNlcnRpZmljYXRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICAgKiBXaGVuIHByb3ZpZGVkLCBhbiBBIHJlY29yZCBhbGlhcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIHRoZSBkb21haW4uXG4gICAgICpcbiAgICAgKiBJZiBgZG9tYWluTmFtZWAgaXMgc2V0IHdpdGhvdXQgYGNlcnRpZmljYXRlYCBvciBgY2VydGlmaWNhdGVBcm5gLFxuICAgICAqIGhvc3RlZC16b25lIGNlcnRpZmljYXRlIGNyZWF0aW9uIGlzIGFsbG93ZWQgb25seSBmb3Igc3RhY2tzIHdob3NlIHJlZ2lvblxuICAgICAqIGlzIGV4cGxpY2l0bHkgYHVzLWVhc3QtMWAuIENsb3VkRnJvbnQgcmVxdWlyZXMgdmlld2VyIGNlcnRpZmljYXRlcyBpblxuICAgICAqIGB1cy1lYXN0LTFgOyBlbnZpcm9ubWVudC1hZ25vc3RpYyBvciBvdGhlci1yZWdpb24gc3RhY2tzIG11c3QgcHJvdmlkZSBhblxuICAgICAqIGV4cGxpY2l0IGNlcnRpZmljYXRlIGlucHV0LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kUHJvcHMge1xuICAgIC8qKlxuICAgICAqIFRoZSBwcmltYXJ5IEFQSSBvcmlnaW4gVVJMIChlLmcuLCB0aGUgQVBJIEdhdGV3YXkgaW52b2tlIFVSTCBvciBMYW1iZGEgZnVuY3Rpb24gVVJMKS5cbiAgICAgKiBUaGlzIGlzIHVzZWQgZm9yIHRoZSBkZWZhdWx0IGJlaGF2aW9yIGFuZCBhbnkgQVBJIGJ5cGFzcyBwYXRocy5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5Vcmw6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFNQQSBvcmlnaW5zIHdpdGggdGhlaXIgcGF0aCBwYXR0ZXJucy5cbiAgICAgKiBFYWNoIFNQQSB3aWxsIGJlIHNlcnZlZCB2aWEgQ2xvdWRGcm9udCB3aXRoIFNQQSByZXdyaXRlIHN1cHBvcnQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3BhT3JpZ2lucz86IFNwYU9yaWdpbkNvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQVBJIGJ5cGFzcyBjb25maWd1cmF0aW9ucyBmb3IgcGF0aHMgdGhhdCBzaG91bGQgZ28gZGlyZWN0bHkgdG8gdGhlIEFQSSBvcmlnaW5cbiAgICAgKiBldmVuIHRob3VnaCB0aGV5IG1pZ2h0IG1hdGNoIGFuIFNQQSBwYXRoIHByZWZpeC5cbiAgICAgKiBUaGVzZSBhcmUgZXZhbHVhdGVkIGJlZm9yZSBTUEEgcGF0aHMgZHVlIHRvIENsb3VkRnJvbnQgYmVoYXZpb3IgcHJlY2VkZW5jZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlCeXBhc3NQYXRocz86IEFwaUJ5cGFzc0NvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGN1c3RvbSBkb21haW4sIGNlcnRpZmljYXRlLCBhbmQgUm91dGU1My5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBQYXRoUm91dGVkRnJvbnRlbmREb21haW5Db25maWc7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSB0byBhcHBseSB0byBhbGwgYmVoYXZpb3JzIChsZWdhY3kpLlxuICAgICAqXG4gICAgICogUHJlZmVyIHVzaW5nIGBhcGlSZXNwb25zZUhlYWRlcnNQb2xpY3lgLCBgc3BhUmVzcG9uc2VIZWFkZXJzUG9saWN5YCwgYW5kXG4gICAgICogYGFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeWAgZm9yIGJlaGF2aW9yLXNjb3BlZCBjb250cm9sLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGZvciB0aGUgQVBJIG9yaWdpbiBkZWZhdWx0IGJlaGF2aW9yLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaVJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIFNQQSBiZWhhdmlvcnMuXG4gICAgICogQ2FuIGJlIG92ZXJyaWRkZW4gcGVyIFNQQSB2aWEgYFNwYU9yaWdpbkNvbmZpZy5yZXNwb25zZUhlYWRlcnNQb2xpY3lgLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIEFQSSBieXBhc3MgYmVoYXZpb3JzLlxuICAgICAqIENhbiBiZSBvdmVycmlkZGVuIHBlciBieXBhc3MgdmlhIGBBcGlCeXBhc3NDb25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5YC5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlCeXBhc3NSZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBPcmlnaW4gcmVxdWVzdCBwb2xpY3kgZm9yIHRoZSBBUEkgb3JpZ2luIChkZWZhdWx0IGJlaGF2aW9yKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5SZXF1ZXN0UG9saWN5PzogY2xvdWRmcm9udC5JT3JpZ2luUmVxdWVzdFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgICAqXG4gICAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG9cbiAgICAgKiBgbG9ncy9hY2Nlc3MvY2RuL3tsb2dpY2FsTmFtZX1gIHRocm91Z2ggQ2xvdWRXYXRjaCBMb2dzIHZlbmRlZCBkZWxpdmVyeS5cbiAgICAgKiBQYXNzIGBlbmFibGVMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dC5cbiAgICAgKlxuICAgICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgZGlzdHJpYnV0aW9uJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkXG4gICAgICogd2hlbiBhIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIENsb3VkRnJvbnQgc3RhbmRhcmQtbG9nZ2luZyBvdXRwdXQgZm9ybWF0IGZvciBhIENsb3VkV2F0Y2ggTG9nc1xuICAgICAqIGRlc3RpbmF0aW9uLiBPbmx5IHVzZWQgdW5kZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZS5cbiAgICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LlczQ1xuICAgICAqL1xuICAgIHJlYWRvbmx5IGNsb3VkRnJvbnRMb2dGb3JtYXQ/OiBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ2dpbmcuXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgUzMgYnVja2V0IGZvciBDbG91ZEZyb250IGFjY2VzcyBsb2dzLlxuICAgICAqIElmIG5vdCBwcm92aWRlZCBhbmQgZW5hYmxlTG9nZ2luZyBpcyB0cnVlLCBhIG5ldyBidWNrZXQgd2lsbCBiZSBjcmVhdGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIGNyZWF0ZWQgcmVzb3VyY2VzLlxuICAgICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGF1dG8tZGVsZXRlIG9iamVjdHMgaW4gY3JlYXRlZCBidWNrZXRzIG9uIHN0YWNrIGRlbGV0aW9uLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIHJlbW92YWxQb2xpY3kgaXMgREVTVFJPWS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIHdlYiBBQ0wgSUQgZm9yIEFXUyBXQUYgaW50ZWdyYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgd2ViQWNsSWQ/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBQcmljZSBjbGFzcyBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqIEBkZWZhdWx0IFByaWNlQ2xhc3MuUFJJQ0VfQ0xBU1NfQUxMXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHJpY2VDbGFzcz86IGNsb3VkZnJvbnQuUHJpY2VDbGFzcztcblxuICAgIC8qKlxuICAgICAqIEFuIG9wdGlvbmFsIG5hbWUvY29tbWVudCBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjb21tZW50Pzogc3RyaW5nO1xufVxuXG4vKipcbiAqIENsb3VkRnJvbnQgRnVuY3Rpb24gY29kZSBmb3IgU1BBIHZpZXdlci1yZXF1ZXN0IHJld3JpdGUuXG4gKiBSZXdyaXRlcyByZXF1ZXN0cyB3aXRob3V0IGZpbGUgZXh0ZW5zaW9ucyB0byB0aGUgaW5kZXguaHRtbCB3aXRoaW4gdGhlIHByZWZpeC5cbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVTcGFSZXdyaXRlRnVuY3Rpb25Db2RlKFxuICAgIHNwYU9yaWdpbnM6IFNwYU9yaWdpbkNvbmZpZ1tdLFxuKTogc3RyaW5nIHtcbiAgICBjb25zdCBjb25maWdzID0gc3BhT3JpZ2luc1xuICAgICAgICAubWFwKChzcGEpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGNsZWFuUHJlZml4ID0gc3BhLnBhdGhQYXR0ZXJuLnJlcGxhY2UoL1xcL1xcKiQvLCBcIlwiKTtcbiAgICAgICAgICAgIGNvbnN0IHByZWZpeCA9IGAke2NsZWFuUHJlZml4fS9gO1xuICAgICAgICAgICAgY29uc3QgcmV3cml0ZU1vZGUgPSBub3JtYWxpemVTcGFSZXdyaXRlTW9kZShzcGEucmV3cml0ZU1vZGUpO1xuICAgICAgICAgICAgY29uc3Qgc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4gPSBzcGEuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4gPT09IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpbmRleFBhdGggPSBgJHtjbGVhblByZWZpeH0vaW5kZXguaHRtbGA7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGNsZWFuUHJlZml4LFxuICAgICAgICAgICAgICAgIHByZWZpeCxcbiAgICAgICAgICAgICAgICByZXdyaXRlTW9kZSxcbiAgICAgICAgICAgICAgICBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbixcbiAgICAgICAgICAgICAgICBpbmRleFBhdGgsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9KVxuICAgICAgICAvLyBFbnN1cmUgbW9yZSBzcGVjaWZpYyBwcmVmaXhlcyBtYXRjaCBmaXJzdCB0byBhdm9pZCBvdmVybGFwIGlzc3Vlcy5cbiAgICAgICAgLnNvcnQoKGEsIGIpID0+IGIuY2xlYW5QcmVmaXgubGVuZ3RoIC0gYS5jbGVhblByZWZpeC5sZW5ndGgpO1xuXG4gICAgY29uc3QgcHJlZml4TWF0Y2hlcyA9IGNvbmZpZ3NcbiAgICAgICAgLm1hcCgoY2ZnKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gYHsgY2xlYW5QcmVmaXg6ICcke2NmZy5jbGVhblByZWZpeH0nLCBwcmVmaXg6ICcke2NmZy5wcmVmaXh9JywgcmV3cml0ZU1vZGU6ICcke2NmZy5yZXdyaXRlTW9kZX0nLCBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbjogJHtjZmcuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW59LCBpbmRleFBhdGg6ICcke2NmZy5pbmRleFBhdGh9JyB9YDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuXG4gICAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICB2YXIgdXJpID0gcmVxdWVzdC51cmk7XG5cblx0ICAvLyBTUEEgcHJlZml4IGNvbmZpZ3VyYXRpb25zXG5cdCAgdmFyIHNwYVByZWZpeGVzID0gW1xuXHQgICAgICAke3ByZWZpeE1hdGNoZXN9XG5cdCAgXTtcblxuXHQgIC8vIENoZWNrIGlmIHRoaXMgaXMgYW4gU1BBIHBhdGhcblx0ICBmb3IgKHZhciBpID0gMDsgaSA8IHNwYVByZWZpeGVzLmxlbmd0aDsgaSsrKSB7XG5cdCAgICB2YXIgc3BhID0gc3BhUHJlZml4ZXNbaV07XG5cdCAgICBpZiAodXJpLnN0YXJ0c1dpdGgoc3BhLnByZWZpeCkpIHtcblx0ICAgICAgdmFyIHVyaVdpdGhvdXRQcmVmaXggPSB1cmkuc3Vic3RyaW5nKHNwYS5wcmVmaXgubGVuZ3RoKTtcblxuXHQgICAgICBpZiAoc3BhLnJld3JpdGVNb2RlID09PSAnc3BhJykge1xuXHQgICAgICAgIC8vIElmIHRoZSBVUkkgZG9lc24ndCBoYXZlIGFuIGV4dGVuc2lvbiAobm8gZmlsZSksIHJld3JpdGUgdG8gaW5kZXguaHRtbFxuXHQgICAgICAgIC8vIENoZWNrIGlmIGl0IGhhcyBhIGZpbGUgZXh0ZW5zaW9uIChjb250YWlucyBhIGRvdCBpbiB0aGUgbGFzdCBwYXRoIHNlZ21lbnQpXG5cdCAgICAgICAgdmFyIGxhc3RTbGFzaCA9IHVyaVdpdGhvdXRQcmVmaXgubGFzdEluZGV4T2YoJy8nKTtcblx0ICAgICAgICB2YXIgbGFzdFNlZ21lbnQgPSBsYXN0U2xhc2ggPj0gMCA/IHVyaVdpdGhvdXRQcmVmaXguc3Vic3RyaW5nKGxhc3RTbGFzaCArIDEpIDogdXJpV2l0aG91dFByZWZpeDtcblx0ICAgICAgICBcblx0ICAgICAgICAvLyBJZiBubyBleHRlbnNpb24gaW4gdGhlIGxhc3Qgc2VnbWVudCwgc2VydmUgaW5kZXguaHRtbFxuXHQgICAgICAgIGlmIChsYXN0U2VnbWVudC5pbmRleE9mKCcuJykgPT09IC0xKSB7XG5cdCAgICAgICAgICByZXF1ZXN0LnVyaSA9IHNwYS5pbmRleFBhdGg7XG5cdCAgICAgICAgfVxuXHQgICAgICB9XG5cblx0ICAgICAgLy8gT3B0aW9uYWxseSBzdHJpcCB0aGUgcHJlZml4IGJlZm9yZSBmb3J3YXJkaW5nIHRvIHRoZSBvcmlnaW4uXG5cdCAgICAgIGlmIChzcGEuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4pIHtcblx0ICAgICAgICB2YXIgY2xlYW5QcmVmaXhXaXRoU2xhc2ggPSBzcGEuY2xlYW5QcmVmaXggKyAnLyc7XG5cdCAgICAgICAgaWYgKHJlcXVlc3QudXJpLnN0YXJ0c1dpdGgoY2xlYW5QcmVmaXhXaXRoU2xhc2gpKSB7XG5cdCAgICAgICAgICByZXF1ZXN0LnVyaSA9IHJlcXVlc3QudXJpLnN1YnN0cmluZyhzcGEuY2xlYW5QcmVmaXgubGVuZ3RoKTtcblx0ICAgICAgICB9XG5cdCAgICAgIH1cblx0ICAgICAgYnJlYWs7XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlcXVlc3Q7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbi8qKlxuICogQSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiBmb3IgcGF0aC1yb3V0ZWQgbXVsdGktU1BBICsgQVBJIGRlcGxveW1lbnRzLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGNyZWF0ZXMgYSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiB0aGF0IHJvdXRlcyByZXF1ZXN0cyB0bzpcbiAqIC0gU1BBIG9yaWdpbnMgKFMzIGJ1Y2tldHMpIGJhc2VkIG9uIHBhdGggcHJlZml4ZXMgKGUuZy4sIC9sLyosIC9hdXRoLyopXG4gKiAtIEFQSSBvcmlnaW4gKGRlZmF1bHQgYmVoYXZpb3IpIGZvciBhbGwgb3RoZXIgcGF0aHNcbiAqIC0gQVBJIGJ5cGFzcyBwYXRocyBmb3Igc3BlY2lmaWMgcGF0aHMgdGhhdCBzaG91bGQgc2tpcCBTUEEgcm91dGluZ1xuICpcbiAqIEEgQ2xvdWRGcm9udCBGdW5jdGlvbiBoYW5kbGVzIHZpZXdlci1yZXF1ZXN0IHJld3JpdGluZyBmb3IgU1BBIHJvdXRpbmcsXG4gKiBlbnN1cmluZyB0aGF0IHBhdGhzIHdpdGhvdXQgZmlsZSBleHRlbnNpb25zIGFyZSByZXdyaXR0ZW4gdG8gaW5kZXguaHRtbC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuXG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgRnVuY3Rpb24gZm9yIFNQQSByZXdyaXRlIChpZiBTUEEgb3JpZ2lucyBhcmUgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHNwYVJld3JpdGVGdW5jdGlvbj86IGNsb3VkZnJvbnQuRnVuY3Rpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBidWNrZXQgKGlmIGxvZ2dpbmcgaXMgZW5hYmxlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIGNlcnRpZmljYXRlIHVzZWQgZm9yIHRoZSBkaXN0cmlidXRpb24gKGlmIGN1c3RvbSBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmRQcm9wcykge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgICAgIGlmICghcHJvcHMuYXBpT3JpZ2luVXJsKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgcmVxdWlyZXMgcHJvcHMuYXBpT3JpZ2luVXJsXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgICAgIGNvbnN0IGVuYWJsZUxvZ2dpbmcgPSBwcm9wcy5lbmFibGVMb2dnaW5nID8/IHRydWU7XG4gICAgICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgICAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgICAgICBjb25zdCBzdGFuZGFyZExvZ2dpbmcgPSBuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgZW5hYmxlTG9nZ2luZztcblxuICAgICAgICAvLyBDcmVhdGUgbG9ncyBidWNrZXQgaWYgUzMgbG9nZ2luZyBpcyBlbmFibGVkIGFuZCB0aGUgc3RhbmRhcmQgcHJvZmlsZSBpc1xuICAgICAgICAvLyBub3QgcmVwbGFjaW5nIGl0IHdpdGggQ2xvdWRXYXRjaCBMb2dzIGRlbGl2ZXJ5LlxuICAgICAgICBpZiAoZW5hYmxlTG9nZ2luZyAmJiAhc3RhbmRhcmRMb2dnaW5nKSB7XG4gICAgICAgICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICAgICAgICAgIHByb3BzLmxvZ3NCdWNrZXQgPz9cbiAgICAgICAgICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgICAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgICAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgICAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5PQkpFQ1RfV1JJVEVSLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUGFyc2UgdGhlIEFQSSBvcmlnaW4gVVJMIHRvIGNyZWF0ZSBhbiBIdHRwT3JpZ2luIChkb21haW4gKyBvcHRpb25hbCBvcmlnaW5QYXRoKVxuICAgICAgICBjb25zdCBhcGlPcmlnaW5QYXJzZWQgPSB0aGlzLnBhcnNlT3JpZ2luRnJvbVVybChwcm9wcy5hcGlPcmlnaW5VcmwpO1xuICAgICAgICBjb25zdCBhcGlPcmlnaW4gPSBuZXcgb3JpZ2lucy5IdHRwT3JpZ2luKGFwaU9yaWdpblBhcnNlZC5kb21haW5OYW1lLCB7XG4gICAgICAgICAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQU19PTkxZLFxuICAgICAgICAgICAgLi4uKGFwaU9yaWdpblBhcnNlZC5vcmlnaW5QYXRoID8geyBvcmlnaW5QYXRoOiBhcGlPcmlnaW5QYXJzZWQub3JpZ2luUGF0aCB9IDoge30pLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBIYW5kbGUgZG9tYWluIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgICAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluLmRvbWFpbk5hbWUpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG5cbiAgICAgICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4sXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHRoaXMsIFwiQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kXCIpO1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IG5ldyBhY20uQ2VydGlmaWNhdGUodGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkb21haW5OYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvbjogYWNtLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKHByb3BzLmRvbWFpbi5ob3N0ZWRab25lKSxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgcmVxdWlyZXMgZG9tYWluLmNlcnRpZmljYXRlLCBkb21haW4uY2VydGlmaWNhdGVBcm4sIG9yIGRvbWFpbi5ob3N0ZWRab25lIHdoZW4gZG9tYWluLmRvbWFpbk5hbWUgaXMgc2V0XCIsXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlO1xuXG4gICAgICAgIC8vIENyZWF0ZSBDbG91ZEZyb250IEZ1bmN0aW9uIGZvciBTUEEgcmV3cml0ZSBpZiBTUEEgb3JpZ2lucyBhcmUgY29uZmlndXJlZFxuICAgICAgICBjb25zdCBzcGFPcmlnaW5zID0gcHJvcHMuc3BhT3JpZ2lucyA/PyBbXTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgc3BhT3JpZ2lucy5zb21lKChzcGEpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXdyaXRlTW9kZSA9IG5vcm1hbGl6ZVNwYVJld3JpdGVNb2RlKHNwYS5yZXdyaXRlTW9kZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJld3JpdGVNb2RlICE9PSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5OT05FIHx8IHNwYS5zdHJpcFByZWZpeEJlZm9yZU9yaWdpbiA9PT0gdHJ1ZTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICkge1xuICAgICAgICAgICAgY29uc3QgZnVuY3Rpb25Db2RlID0gZ2VuZXJhdGVTcGFSZXdyaXRlRnVuY3Rpb25Db2RlKHNwYU9yaWdpbnMpO1xuXG4gICAgICAgICAgICB0aGlzLnNwYVJld3JpdGVGdW5jdGlvbiA9IG5ldyBjbG91ZGZyb250LkZ1bmN0aW9uKHRoaXMsIFwiU3BhUmV3cml0ZUZ1bmN0aW9uXCIsIHtcbiAgICAgICAgICAgICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKGZ1bmN0aW9uQ29kZSksXG4gICAgICAgICAgICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgICAgICAgICAgIGNvbW1lbnQ6IFwiU1BBIHZpZXdlci1yZXF1ZXN0IHJld3JpdGUgZm9yIHBhdGgtcm91dGVkIGZyb250ZW5kXCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEJ1aWxkIGFkZGl0aW9uYWwgYmVoYXZpb3JzXG4gICAgICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuXG4gICAgICAgIC8vIEFkZCBBUEkgYnlwYXNzIHBhdGhzIGZpcnN0IChoaWdoZXIgcHJlY2VkZW5jZSBpbiBDbG91ZEZyb250KVxuICAgICAgICBmb3IgKGNvbnN0IGJ5cGFzc0NvbmZpZyBvZiBwcm9wcy5hcGlCeXBhc3NQYXRocyA/PyBbXSkge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgICAgICAgICAgICBieXBhc3NDb25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMuYXBpQnlwYXNzUmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW2J5cGFzc0NvbmZpZy5wYXRoUGF0dGVybl0gPSB7XG4gICAgICAgICAgICAgICAgb3JpZ2luOiBhcGlPcmlnaW4sXG4gICAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgICAgICAgIGNhY2hlUG9saWN5OiBieXBhc3NDb25maWcuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6XG4gICAgICAgICAgICAgICAgICAgIGJ5cGFzc0NvbmZpZy5vcmlnaW5SZXF1ZXN0UG9saWN5ID8/IHByb3BzLmFwaU9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgICAgICAgICAgLi4uKHJlc3BvbnNlSGVhZGVyc1BvbGljeVxuICAgICAgICAgICAgICAgICAgICA/IHsgcmVzcG9uc2VIZWFkZXJzUG9saWN5IH1cbiAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQWRkIFNQQSBvcmlnaW4gYmVoYXZpb3JzXG4gICAgICAgIGZvciAoY29uc3Qgc3BhQ29uZmlnIG9mIHNwYU9yaWdpbnMpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlSGVhZGVyc1BvbGljeSA9XG4gICAgICAgICAgICAgICAgc3BhQ29uZmlnLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgICAgIHByb3BzLnNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgICAgIHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeTtcbiAgICAgICAgICAgIGNvbnN0IHJld3JpdGVNb2RlID0gbm9ybWFsaXplU3BhUmV3cml0ZU1vZGUoc3BhQ29uZmlnLnJld3JpdGVNb2RlKTtcbiAgICAgICAgICAgIGNvbnN0IG5lZWRzRnVuY3Rpb24gPVxuICAgICAgICAgICAgICAgIHRoaXMuc3BhUmV3cml0ZUZ1bmN0aW9uICYmXG4gICAgICAgICAgICAgICAgKHJld3JpdGVNb2RlICE9PSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5OT05FIHx8IHNwYUNvbmZpZy5zdHJpcFByZWZpeEJlZm9yZU9yaWdpbiA9PT0gdHJ1ZSk7XG5cbiAgICAgICAgICAgIGNvbnN0IHNwYU9yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2woc3BhQ29uZmlnLmJ1Y2tldCk7XG5cbiAgICAgICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbc3BhQ29uZmlnLnBhdGhQYXR0ZXJuXSA9IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IHNwYU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgICAgICAgICAgIGNhY2hlUG9saWN5OiBzcGFDb25maWcuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRCxcbiAgICAgICAgICAgICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICAuLi4obmVlZHNGdW5jdGlvblxuICAgICAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbjogdGhpcy5zcGFSZXdyaXRlRnVuY3Rpb24sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVRVUVTVCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICAuLi4ocmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGRpc3RyaWJ1dGlvblxuICAgICAgICBjb25zdCBkZWZhdWx0UmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgICAgICAgIHByb3BzLmFwaVJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgICAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICAgICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICAgICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IGFwaU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBwcm9wcy5hcGlPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICAgICAgICAgIC4uLihkZWZhdWx0UmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3k6IGRlZmF1bHRSZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzLFxuICAgICAgICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5wcmljZUNsYXNzID8geyBwcmljZUNsYXNzOiBwcm9wcy5wcmljZUNsYXNzIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMuY29tbWVudCA/IHsgY29tbWVudDogcHJvcHMuY29tbWVudCB9IDoge30pLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoc3RhbmRhcmRMb2dnaW5nICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCkge1xuICAgICAgICAgICAgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyh7XG4gICAgICAgICAgICAgICAgc2NvcGU6IHRoaXMsXG4gICAgICAgICAgICAgICAgaWQ6IFwiQ2RuTG9nZ2luZ1wiLFxuICAgICAgICAgICAgICAgIGNvbnRleHQ6IG5hbWluZ0NvbnRleHQsXG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uOiB0aGlzLmRpc3RyaWJ1dGlvbixcbiAgICAgICAgICAgICAgICBsb2dpY2FsOiBgbG9ncy9hY2Nlc3MvY2RuLyR7bG9naWNhbH1gLFxuICAgICAgICAgICAgICAgIGZvcm1hdDogcHJvcHMuY2xvdWRGcm9udExvZ0Zvcm1hdCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgQSByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbj8uZG9tYWluTmFtZSAmJiBwcm9wcy5kb21haW4/Lmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChwcm9wcy5kb21haW4uY3JlYXRlQUFBQVJlY29yZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZEFBQUFcIiwge1xuICAgICAgICAgICAgICAgICAgICB6b25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3RzIHRoZSBkb21haW4gbmFtZSBmcm9tIGEgVVJMIChlLmcuLCBcImh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3BhdGhcIiAtPiBcImFwaS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICBwcml2YXRlIHBhcnNlT3JpZ2luRnJvbVVybCh1cmw6IHN0cmluZyk6IHsgZG9tYWluTmFtZTogc3RyaW5nOyBvcmlnaW5QYXRoPzogc3RyaW5nIH0ge1xuICAgICAgICBjb25zdCB1cmxTdHIgPSBTdHJpbmcodXJsID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgaWYgKCF1cmxTdHIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCByZXF1aXJlcyBhIG5vbi1lbXB0eSBhcGlPcmlnaW5VcmxcIik7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGdWxsIFVSTCAocmVjb21tZW5kZWQpOiBodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcm9kXG4gICAgICAgIGlmICh1cmxTdHIuaW5jbHVkZXMoXCI6Ly9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwodXJsU3RyKTtcbiAgICAgICAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocGFyc2VkLmhvc3RuYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmICghZG9tYWluTmFtZSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIGNvdWxkIG5vdCBwYXJzZSBkb21haW4gZnJvbSBhcGlPcmlnaW5Vcmw6ICR7dXJsU3RyfWApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBwYXRoID0gU3RyaW5nKHBhcnNlZC5wYXRobmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBjb25zdCBvcmlnaW5QYXRoID0gcGF0aCAmJiBwYXRoICE9PSBcIi9cIiA/IHRyaW1SZXBlYXRlZENoYXJFbmQocGF0aCwgXCIvXCIpIDogdW5kZWZpbmVkO1xuICAgICAgICAgICAgcmV0dXJuIHsgZG9tYWluTmFtZSwgLi4uKG9yaWdpblBhdGggPyB7IG9yaWdpblBhdGggfSA6IHt9KSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQmFyZSBkb21haW4gKG9yIGRvbWFpbiArIHBhdGgpOiBhcGkuZXhhbXBsZS5jb20gb3IgYXBpLmV4YW1wbGUuY29tL3Byb2RcbiAgICAgICAgY29uc3Qgd2l0aG91dFF1ZXJ5ID0gdXJsU3RyLnNwbGl0KFwiP1wiKVswXT8uc3BsaXQoXCIjXCIpWzBdID8/IHVybFN0cjtcbiAgICAgICAgY29uc3QgZmlyc3RTbGFzaEluZGV4ID0gd2l0aG91dFF1ZXJ5LmluZGV4T2YoXCIvXCIpO1xuICAgICAgICBjb25zdCBkb21haW5QYXJ0ID0gKGZpcnN0U2xhc2hJbmRleCA+PSAwID8gd2l0aG91dFF1ZXJ5LnNsaWNlKDAsIGZpcnN0U2xhc2hJbmRleCkgOiB3aXRob3V0UXVlcnkpXG4gICAgICAgICAgICAudHJpbSgpO1xuICAgICAgICBjb25zdCBub3JtYWxpemVkRG9tYWluUGFydCA9IHN0cmlwVHJhaWxpbmdQb3J0KGRvbWFpblBhcnQpO1xuICAgICAgICBpZiAoIW5vcm1hbGl6ZWREb21haW5QYXJ0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBjb3VsZCBub3QgcGFyc2UgZG9tYWluIGZyb20gYXBpT3JpZ2luVXJsOiAke3VybFN0cn1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBhdGhQYXJ0ID0gZmlyc3RTbGFzaEluZGV4ID49IDAgPyB3aXRob3V0UXVlcnkuc2xpY2UoZmlyc3RTbGFzaEluZGV4KSA6IFwiXCI7XG4gICAgICAgIGNvbnN0IG9yaWdpblBhdGggPSBwYXRoUGFydCAmJiBwYXRoUGFydCAhPT0gXCIvXCIgPyB0cmltUmVwZWF0ZWRDaGFyRW5kKHBhdGhQYXJ0LCBcIi9cIikgOiB1bmRlZmluZWQ7XG4gICAgICAgIHJldHVybiB7IGRvbWFpbk5hbWU6IG5vcm1hbGl6ZWREb21haW5QYXJ0LCAuLi4ob3JpZ2luUGF0aCA/IHsgb3JpZ2luUGF0aCB9IDoge30pIH07XG4gICAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTcGFSZXdyaXRlTW9kZShtb2RlOiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZSB8IHN0cmluZyB8IHVuZGVmaW5lZCk6IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlIHtcbiAgICBjb25zdCB2YWx1ZSA9IFN0cmluZyhtb2RlID8/IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLlNQQSkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuIHZhbHVlID09PSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5OT05FID8gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuTk9ORSA6IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLlNQQTtcbn1cbiJdfQ==