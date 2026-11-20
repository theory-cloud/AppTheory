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
const secure_defaults_1 = require("./private/secure-defaults");
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
        if (namingContext?.standardLogging === true && props.logsBucket !== undefined) {
            throw new Error("AppTheoryPathRoutedFrontend cannot honor props.logsBucket under the standard logging profile; CloudFront access logs go to the contract log group, so remove props.logsBucket or use the legacy logging profile");
        }
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
        // Security Hub CloudFront.15 under a derived naming context.
        const minimumProtocolVersion = (0, secure_defaults_1.defaultMinimumProtocolVersion)(namingContext, distributionCertificate !== undefined, props.minimumProtocolVersion);
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            ...(enableLogging && this.logsBucket
                ? { enableLogging: true, logBucket: this.logsBucket, logFilePrefix: "cloudfront/" }
                : {}),
            ...(distributionDomainNames && distributionCertificate
                ? { domainNames: distributionDomainNames, certificate: distributionCertificate }
                : {}),
            ...(minimumProtocolVersion !== undefined ? { minimumProtocolVersion } : {}),
            ...(props.defaultRootObject !== undefined ? { defaultRootObject: props.defaultRootObject } : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aC1yb3V0ZWQtZnJvbnRlbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXRoLXJvdXRlZC1mcm9udGVuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTBEO0FBQzFELHdFQUEwRDtBQUMxRCx1RUFBeUQ7QUFDekQsNEVBQThEO0FBQzlELGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0QsdURBQXlDO0FBQ3pDLDJDQUF1QztBQUd2Qyx5REFBNEQ7QUFDNUQsK0RBQTBFO0FBQzFFLGlFQUE2RTtBQUU3RSx5REFBZ0Y7QUFFaEYsU0FBUywyQ0FBMkMsQ0FBQyxLQUFnQixFQUFFLGFBQXFCO0lBQ3hGLE1BQU0sTUFBTSxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUN0QyxJQUFJLENBQUMsbUJBQUssQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxLQUFLLFdBQVcsRUFBRSxDQUFDO1FBQ3hELE9BQU87SUFDWCxDQUFDO0lBRUQsTUFBTSxpQkFBaUIsR0FBRyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDN0UsTUFBTSxJQUFJLEtBQUssQ0FDWCxHQUFHLGFBQWEsd0hBQXdILGlCQUFpQiw0R0FBNEcsQ0FDeFEsQ0FBQztBQUNOLENBQUM7QUFFRCxJQUFZLHVCQVVYO0FBVkQsV0FBWSx1QkFBdUI7SUFDL0I7O09BRUc7SUFDSCxzQ0FBVyxDQUFBO0lBRVg7O09BRUc7SUFDSCx3Q0FBYSxDQUFBO0FBQ2pCLENBQUMsRUFWVyx1QkFBdUIsdUNBQXZCLHVCQUF1QixRQVVsQztBQTBRRDs7O0dBR0c7QUFDSCxTQUFTLDhCQUE4QixDQUNuQyxVQUE2QjtJQUU3QixNQUFNLE9BQU8sR0FBRyxVQUFVO1NBQ3JC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dkcsQ0FBQztRQUVELE1BQU0sUUFBUSxHQUFHLGVBQWUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNqRixNQUFNLFVBQVUsR0FBRyxRQUFRLElBQUksUUFBUSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBQSxrQ0FBbUIsRUFBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUNqRyxPQUFPLEVBQUUsVUFBVSxFQUFFLG9CQUFvQixFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUUsVUFBVSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUM7SUFDdkYsQ0FBQzs7QUE5UUwsa0VBK1FDO0FBRUQsU0FBUyx1QkFBdUIsQ0FBQyxJQUFrRDtJQUMvRSxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsSUFBSSxJQUFJLHVCQUF1QixDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQy9FLE9BQU8sS0FBSyxLQUFLLHVCQUF1QixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsdUJBQXVCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyx1QkFBdUIsQ0FBQyxHQUFHLENBQUM7QUFDL0csQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQgfSBmcm9tIFwiLi9sb2dnaW5nXCI7XG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24gfSBmcm9tIFwiLi9wcml2YXRlL3NlY3VyZS1kZWZhdWx0c1wiO1xuaW1wb3J0IHsgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcbmltcG9ydCB7IHN0cmlwVHJhaWxpbmdQb3J0LCB0cmltUmVwZWF0ZWRDaGFyRW5kIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuZnVuY3Rpb24gYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbihzY29wZTogQ29uc3RydWN0LCBjb25zdHJ1Y3ROYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCByZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgJiYgcmVnaW9uID09PSBcInVzLWVhc3QtMVwiKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCByZWdpb25EZXNjcmlwdGlvbiA9IFRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pID8gXCJ1bnJlc29sdmVkXCIgOiByZWdpb247XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgJHtjb25zdHJ1Y3ROYW1lfSBjYW5ub3QgY3JlYXRlIGEgaG9zdGVkLXpvbmUgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB1bmxlc3MgdGhlIHN0YWNrIHJlZ2lvbiBpcyBleHBsaWNpdGx5IHVzLWVhc3QtMTsgc3RhY2sgcmVnaW9uIGlzICR7cmVnaW9uRGVzY3JpcHRpb259LiBQcm92aWRlIGRvbWFpbi5jZXJ0aWZpY2F0ZSBvciBkb21haW4uY2VydGlmaWNhdGVBcm4gZm9yIHN0YWNrcyBpbiBvdGhlciBvciBlbnZpcm9ubWVudC1hZ25vc3RpYyByZWdpb25zLmAsXG4gICAgKTtcbn1cblxuZXhwb3J0IGVudW0gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUge1xuICAgIC8qKlxuICAgICAqIFJld3JpdGUgZXh0ZW5zaW9ubGVzcyByb3V0ZXMgdG8gYGluZGV4Lmh0bWxgIHdpdGhpbiB0aGUgU1BBIHByZWZpeC5cbiAgICAgKi9cbiAgICBTUEEgPSBcInNwYVwiLFxuXG4gICAgLyoqXG4gICAgICogRG8gbm90IHJld3JpdGUgcm91dGVzLiBVc2VmdWwgZm9yIG11bHRpLXBhZ2Uvc3RhdGljIHNpdGVzLlxuICAgICAqL1xuICAgIE5PTkUgPSBcIm5vbmVcIixcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBhbiBTUEEgb3JpZ2luIHJvdXRlZCBieSBwYXRoIHByZWZpeC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBTcGFPcmlnaW5Db25maWcge1xuICAgIC8qKlxuICAgICAqIFMzIGJ1Y2tldCBjb250YWluaW5nIHRoZSBTUEEgYXNzZXRzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJ1Y2tldDogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFBhdGggcGF0dGVybiB0byByb3V0ZSB0byB0aGlzIFNQQSAoZS5nLiwgXCIvbC8qXCIsIFwiL2F1dGgvKlwiKS5cbiAgICAgKiBNdXN0IGluY2x1ZGUgdGhlIHRyYWlsaW5nIHdpbGRjYXJkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHBhdGhQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBjYWNoZSBwb2xpY3kgb3ZlcnJpZGUuIERlZmF1bHRzIHRvIENBQ0hJTkdfT1BUSU1JWkVELlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSBmb3IgdGhpcyBTUEEgYmVoYXZpb3IuXG4gICAgICogT3ZlcnJpZGVzIGBzcGFSZXNwb25zZUhlYWRlcnNQb2xpY3lgIGFuZCBgcmVzcG9uc2VIZWFkZXJzUG9saWN5YCAobGVnYWN5KS5cbiAgICAgKi9cbiAgICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIHN0cmlwIHRoZSBTUEEgcHJlZml4IGJlZm9yZSBmb3J3YXJkaW5nIHRvIHRoZSBTMyBvcmlnaW4uXG4gICAgICpcbiAgICAgKiBFeGFtcGxlOlxuICAgICAqIC0gUmVxdWVzdDogYC9hdXRoL2Fzc2V0cy9hcHAuanNgXG4gICAgICogLSBXaXRoIGBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbj10cnVlYCwgUzMgcmVjZWl2ZXM6IGAvYXNzZXRzL2FwcC5qc2BcbiAgICAgKlxuICAgICAqIFRoaXMgYWxsb3dzIGxheWluZyBvdXQgdGhlIFNQQSBidWNrZXQgYXQgcm9vdCB3aGlsZSBzdGlsbCBzZXJ2aW5nIGl0IHVuZGVyIGEgcHJlZml4LlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbj86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBTUEEgcmV3cml0ZSBtb2RlLlxuICAgICAqXG4gICAgICogLSBgU1BBYDogcmV3cml0ZSBleHRlbnNpb25sZXNzIHJvdXRlcyB0byB0aGUgU1BBJ3MgYGluZGV4Lmh0bWxgXG4gICAgICogLSBgTk9ORWA6IGRvIG5vdCByZXdyaXRlIHJvdXRlcyAodXNlZnVsIGZvciBtdWx0aS1wYWdlIHNpdGVzKVxuICAgICAqXG4gICAgICogQGRlZmF1bHQgQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuU1BBXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmV3cml0ZU1vZGU/OiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZTtcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyBTUEEgcm91dGluZyBhbmQgZ28gZGlyZWN0bHkgdG8gdGhlIEFQSSBvcmlnaW4uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBpQnlwYXNzQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBQYXRoIHBhdHRlcm4gdGhhdCBzaG91bGQgcm91dGUgdG8gdGhlIEFQSSBvcmlnaW4gaW5zdGVhZCBvZiBTUEEgKGUuZy4sIFwiL2F1dGgvd2FsbGV0LypcIikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcGF0aFBhdHRlcm46IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIGNhY2hlIHBvbGljeSBvdmVycmlkZS4gRGVmYXVsdHMgdG8gQ0FDSElOR19ESVNBQkxFRC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgb3JpZ2luIHJlcXVlc3QgcG9saWN5IG92ZXJyaWRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IG9yaWdpblJlcXVlc3RQb2xpY3k/OiBjbG91ZGZyb250LklPcmlnaW5SZXF1ZXN0UG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogUmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIHRoaXMgQVBJIGJ5cGFzcyBiZWhhdmlvci5cbiAgICAgKiBPdmVycmlkZXMgYGFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeWAgYW5kIGByZXNwb25zZUhlYWRlcnNQb2xpY3lgIChsZWdhY3kpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcbn1cblxuLyoqXG4gKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFBhdGhSb3V0ZWRGcm9udGVuZERvbWFpbkNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogVGhlIGRvbWFpbiBuYW1lIGZvciB0aGUgZGlzdHJpYnV0aW9uIChlLmcuLCBcImFwcC5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIEhUVFBTLiBNdXN0IGJlIGluIHVzLWVhc3QtMSBmb3IgQ2xvdWRGcm9udC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBUk4gb2YgYW4gZXhpc3RpbmcgQUNNIGNlcnRpZmljYXRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICAgKiBXaGVuIHByb3ZpZGVkLCBhbiBBIHJlY29yZCBhbGlhcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIHRoZSBkb21haW4uXG4gICAgICpcbiAgICAgKiBJZiBgZG9tYWluTmFtZWAgaXMgc2V0IHdpdGhvdXQgYGNlcnRpZmljYXRlYCBvciBgY2VydGlmaWNhdGVBcm5gLFxuICAgICAqIGhvc3RlZC16b25lIGNlcnRpZmljYXRlIGNyZWF0aW9uIGlzIGFsbG93ZWQgb25seSBmb3Igc3RhY2tzIHdob3NlIHJlZ2lvblxuICAgICAqIGlzIGV4cGxpY2l0bHkgYHVzLWVhc3QtMWAuIENsb3VkRnJvbnQgcmVxdWlyZXMgdmlld2VyIGNlcnRpZmljYXRlcyBpblxuICAgICAqIGB1cy1lYXN0LTFgOyBlbnZpcm9ubWVudC1hZ25vc3RpYyBvciBvdGhlci1yZWdpb24gc3RhY2tzIG11c3QgcHJvdmlkZSBhblxuICAgICAqIGV4cGxpY2l0IGNlcnRpZmljYXRlIGlucHV0LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kUHJvcHMge1xuICAgIC8qKlxuICAgICAqIFRoZSBwcmltYXJ5IEFQSSBvcmlnaW4gVVJMIChlLmcuLCB0aGUgQVBJIEdhdGV3YXkgaW52b2tlIFVSTCBvciBMYW1iZGEgZnVuY3Rpb24gVVJMKS5cbiAgICAgKiBUaGlzIGlzIHVzZWQgZm9yIHRoZSBkZWZhdWx0IGJlaGF2aW9yIGFuZCBhbnkgQVBJIGJ5cGFzcyBwYXRocy5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5Vcmw6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFNQQSBvcmlnaW5zIHdpdGggdGhlaXIgcGF0aCBwYXR0ZXJucy5cbiAgICAgKiBFYWNoIFNQQSB3aWxsIGJlIHNlcnZlZCB2aWEgQ2xvdWRGcm9udCB3aXRoIFNQQSByZXdyaXRlIHN1cHBvcnQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3BhT3JpZ2lucz86IFNwYU9yaWdpbkNvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQVBJIGJ5cGFzcyBjb25maWd1cmF0aW9ucyBmb3IgcGF0aHMgdGhhdCBzaG91bGQgZ28gZGlyZWN0bHkgdG8gdGhlIEFQSSBvcmlnaW5cbiAgICAgKiBldmVuIHRob3VnaCB0aGV5IG1pZ2h0IG1hdGNoIGFuIFNQQSBwYXRoIHByZWZpeC5cbiAgICAgKiBUaGVzZSBhcmUgZXZhbHVhdGVkIGJlZm9yZSBTUEEgcGF0aHMgZHVlIHRvIENsb3VkRnJvbnQgYmVoYXZpb3IgcHJlY2VkZW5jZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlCeXBhc3NQYXRocz86IEFwaUJ5cGFzc0NvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGN1c3RvbSBkb21haW4sIGNlcnRpZmljYXRlLCBhbmQgUm91dGU1My5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBQYXRoUm91dGVkRnJvbnRlbmREb21haW5Db25maWc7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSB0byBhcHBseSB0byBhbGwgYmVoYXZpb3JzIChsZWdhY3kpLlxuICAgICAqXG4gICAgICogUHJlZmVyIHVzaW5nIGBhcGlSZXNwb25zZUhlYWRlcnNQb2xpY3lgLCBgc3BhUmVzcG9uc2VIZWFkZXJzUG9saWN5YCwgYW5kXG4gICAgICogYGFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeWAgZm9yIGJlaGF2aW9yLXNjb3BlZCBjb250cm9sLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGZvciB0aGUgQVBJIG9yaWdpbiBkZWZhdWx0IGJlaGF2aW9yLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaVJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIFNQQSBiZWhhdmlvcnMuXG4gICAgICogQ2FuIGJlIG92ZXJyaWRkZW4gcGVyIFNQQSB2aWEgYFNwYU9yaWdpbkNvbmZpZy5yZXNwb25zZUhlYWRlcnNQb2xpY3lgLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIEFQSSBieXBhc3MgYmVoYXZpb3JzLlxuICAgICAqIENhbiBiZSBvdmVycmlkZGVuIHBlciBieXBhc3MgdmlhIGBBcGlCeXBhc3NDb25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5YC5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlCeXBhc3NSZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBPcmlnaW4gcmVxdWVzdCBwb2xpY3kgZm9yIHRoZSBBUEkgb3JpZ2luIChkZWZhdWx0IGJlaGF2aW9yKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5SZXF1ZXN0UG9saWN5PzogY2xvdWRmcm9udC5JT3JpZ2luUmVxdWVzdFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgICAqXG4gICAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG9cbiAgICAgKiBgbG9ncy9hY2Nlc3MvY2RuL3tsb2dpY2FsTmFtZX1gIHRocm91Z2ggQ2xvdWRXYXRjaCBMb2dzIHZlbmRlZCBkZWxpdmVyeS5cbiAgICAgKiBQYXNzIGBlbmFibGVMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dC5cbiAgICAgKlxuICAgICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgZGlzdHJpYnV0aW9uJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkXG4gICAgICogd2hlbiBhIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIENsb3VkRnJvbnQgc3RhbmRhcmQtbG9nZ2luZyBvdXRwdXQgZm9ybWF0IGZvciBhIENsb3VkV2F0Y2ggTG9nc1xuICAgICAqIGRlc3RpbmF0aW9uLiBPbmx5IHVzZWQgdW5kZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZS5cbiAgICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LkpTT05cbiAgICAgKi9cbiAgICByZWFkb25seSBjbG91ZEZyb250TG9nRm9ybWF0PzogQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdDtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBDbG91ZEZyb250IGFjY2VzcyBsb2dnaW5nLlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmFibGVMb2dnaW5nPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIFMzIGJ1Y2tldCBmb3IgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncy5cbiAgICAgKiBJZiBub3QgcHJvdmlkZWQgYW5kIGVuYWJsZUxvZ2dpbmcgaXMgdHJ1ZSwgYSBuZXcgYnVja2V0IHdpbGwgYmUgY3JlYXRlZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFJlbW92YWwgcG9saWN5IGZvciBjcmVhdGVkIHJlc291cmNlcy5cbiAgICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBhdXRvLWRlbGV0ZSBvYmplY3RzIGluIGNyZWF0ZWQgYnVja2V0cyBvbiBzdGFjayBkZWxldGlvbi5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiByZW1vdmFsUG9saWN5IGlzIERFU1RST1kuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhdXRvRGVsZXRlT2JqZWN0cz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCB3ZWIgQUNMIElEIGZvciBBV1MgV0FGIGludGVncmF0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHdlYkFjbElkPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUHJpY2UgY2xhc3MgZm9yIHRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICAgKiBAZGVmYXVsdCBQcmljZUNsYXNzLlBSSUNFX0NMQVNTX0FMTFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHByaWNlQ2xhc3M/OiBjbG91ZGZyb250LlByaWNlQ2xhc3M7XG5cbiAgICAvKipcbiAgICAgKiBBbiBvcHRpb25hbCBuYW1lL2NvbW1lbnQgZm9yIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgY29tbWVudD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE1pbmltdW0gVExTIHByb3RvY29sIHZlcnNpb24gZm9yIHZpZXdlcnMgb2YgYSBjdXN0b20gZG9tYWluLlxuICAgICAqXG4gICAgICogV2l0aCBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQgYW5kIGEgY3VzdG9tIGNlcnRpZmljYXRlIHRoZSBkZWZhdWx0IGlzXG4gICAgICogYFRMU19WMV8yXzIwMjVgLCB0aGUgcG9saWN5IFNlY3VyaXR5IEh1YiBDbG91ZEZyb250LjE1IGFjY2VwdHMgd2l0aCB0aGVcbiAgICAgKiB3aWRlc3QgY2xpZW50IHN1cHBvcnQuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBUTFNfVjFfMl8yMDI1IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB3aXRoIGEgY2VydGlmaWNhdGUsXG4gICAgICogb3RoZXJ3aXNlIHRoZSBDbG91ZEZyb250IGRlZmF1bHQgZm9yIHRoZSBjZXJ0aWZpY2F0ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1pbmltdW1Qcm90b2NvbFZlcnNpb24/OiBjbG91ZGZyb250LlNlY3VyaXR5UG9saWN5UHJvdG9jb2w7XG5cbiAgICAvKipcbiAgICAgKiBPYmplY3QgQ2xvdWRGcm9udCByZXR1cm5zIGZvciBhIHJlcXVlc3QgdG8gdGhlIGRpc3RyaWJ1dGlvbiByb290LlxuICAgICAqXG4gICAgICogVGhlIGZyb250ZW5kJ3MgZGVmYXVsdCBiZWhhdmlvciB0YXJnZXRzIHRoZSBBUEkgb3JpZ2luLiBXaGVuIFNQQSBwcmVmaXhlc1xuICAgICAqIHJvdXRlIHRvIFMzIG9yaWdpbnMgdGhlIGRpc3RyaWJ1dGlvbiBjYXJyaWVzIFMzIG9yaWdpbnMsIHNvIFNlY3VyaXR5IEh1YlxuICAgICAqIENsb3VkRnJvbnQuMSBldmFsdWF0ZXMgaXQsIGJ1dCBgL2AgbXVzdCByZWFjaCB0aGUgQVBJIG9yaWdpbjsgYSBkZWZhdWx0XG4gICAgICogcm9vdCBvYmplY3Qgd291bGQgcmV3cml0ZSBgL2Agb250byB0aGUgQVBJLCBzbyBBcHBUaGVvcnkgZGVsaWJlcmF0ZWx5XG4gICAgICogc2V0cyBub25lIGFuZCB0aGUgY29udHJvbCByZXBvcnRzIGEgcmVzaWR1YWwgZmluZGluZy5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlZmF1bHRSb290T2JqZWN0Pzogc3RyaW5nO1xufVxuXG4vKipcbiAqIENsb3VkRnJvbnQgRnVuY3Rpb24gY29kZSBmb3IgU1BBIHZpZXdlci1yZXF1ZXN0IHJld3JpdGUuXG4gKiBSZXdyaXRlcyByZXF1ZXN0cyB3aXRob3V0IGZpbGUgZXh0ZW5zaW9ucyB0byB0aGUgaW5kZXguaHRtbCB3aXRoaW4gdGhlIHByZWZpeC5cbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVTcGFSZXdyaXRlRnVuY3Rpb25Db2RlKFxuICAgIHNwYU9yaWdpbnM6IFNwYU9yaWdpbkNvbmZpZ1tdLFxuKTogc3RyaW5nIHtcbiAgICBjb25zdCBjb25maWdzID0gc3BhT3JpZ2luc1xuICAgICAgICAubWFwKChzcGEpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGNsZWFuUHJlZml4ID0gc3BhLnBhdGhQYXR0ZXJuLnJlcGxhY2UoL1xcL1xcKiQvLCBcIlwiKTtcbiAgICAgICAgICAgIGNvbnN0IHByZWZpeCA9IGAke2NsZWFuUHJlZml4fS9gO1xuICAgICAgICAgICAgY29uc3QgcmV3cml0ZU1vZGUgPSBub3JtYWxpemVTcGFSZXdyaXRlTW9kZShzcGEucmV3cml0ZU1vZGUpO1xuICAgICAgICAgICAgY29uc3Qgc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4gPSBzcGEuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4gPT09IHRydWU7XG4gICAgICAgICAgICBjb25zdCBpbmRleFBhdGggPSBgJHtjbGVhblByZWZpeH0vaW5kZXguaHRtbGA7XG4gICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgIGNsZWFuUHJlZml4LFxuICAgICAgICAgICAgICAgIHByZWZpeCxcbiAgICAgICAgICAgICAgICByZXdyaXRlTW9kZSxcbiAgICAgICAgICAgICAgICBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbixcbiAgICAgICAgICAgICAgICBpbmRleFBhdGgsXG4gICAgICAgICAgICB9O1xuICAgICAgICB9KVxuICAgICAgICAvLyBFbnN1cmUgbW9yZSBzcGVjaWZpYyBwcmVmaXhlcyBtYXRjaCBmaXJzdCB0byBhdm9pZCBvdmVybGFwIGlzc3Vlcy5cbiAgICAgICAgLnNvcnQoKGEsIGIpID0+IGIuY2xlYW5QcmVmaXgubGVuZ3RoIC0gYS5jbGVhblByZWZpeC5sZW5ndGgpO1xuXG4gICAgY29uc3QgcHJlZml4TWF0Y2hlcyA9IGNvbmZpZ3NcbiAgICAgICAgLm1hcCgoY2ZnKSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gYHsgY2xlYW5QcmVmaXg6ICcke2NmZy5jbGVhblByZWZpeH0nLCBwcmVmaXg6ICcke2NmZy5wcmVmaXh9JywgcmV3cml0ZU1vZGU6ICcke2NmZy5yZXdyaXRlTW9kZX0nLCBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbjogJHtjZmcuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW59LCBpbmRleFBhdGg6ICcke2NmZy5pbmRleFBhdGh9JyB9YDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oXCIsXFxuICAgICAgXCIpO1xuXG4gICAgcmV0dXJuIGBcblx0ZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuXHQgIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcblx0ICB2YXIgdXJpID0gcmVxdWVzdC51cmk7XG5cblx0ICAvLyBTUEEgcHJlZml4IGNvbmZpZ3VyYXRpb25zXG5cdCAgdmFyIHNwYVByZWZpeGVzID0gW1xuXHQgICAgICAke3ByZWZpeE1hdGNoZXN9XG5cdCAgXTtcblxuXHQgIC8vIENoZWNrIGlmIHRoaXMgaXMgYW4gU1BBIHBhdGhcblx0ICBmb3IgKHZhciBpID0gMDsgaSA8IHNwYVByZWZpeGVzLmxlbmd0aDsgaSsrKSB7XG5cdCAgICB2YXIgc3BhID0gc3BhUHJlZml4ZXNbaV07XG5cdCAgICBpZiAodXJpLnN0YXJ0c1dpdGgoc3BhLnByZWZpeCkpIHtcblx0ICAgICAgdmFyIHVyaVdpdGhvdXRQcmVmaXggPSB1cmkuc3Vic3RyaW5nKHNwYS5wcmVmaXgubGVuZ3RoKTtcblxuXHQgICAgICBpZiAoc3BhLnJld3JpdGVNb2RlID09PSAnc3BhJykge1xuXHQgICAgICAgIC8vIElmIHRoZSBVUkkgZG9lc24ndCBoYXZlIGFuIGV4dGVuc2lvbiAobm8gZmlsZSksIHJld3JpdGUgdG8gaW5kZXguaHRtbFxuXHQgICAgICAgIC8vIENoZWNrIGlmIGl0IGhhcyBhIGZpbGUgZXh0ZW5zaW9uIChjb250YWlucyBhIGRvdCBpbiB0aGUgbGFzdCBwYXRoIHNlZ21lbnQpXG5cdCAgICAgICAgdmFyIGxhc3RTbGFzaCA9IHVyaVdpdGhvdXRQcmVmaXgubGFzdEluZGV4T2YoJy8nKTtcblx0ICAgICAgICB2YXIgbGFzdFNlZ21lbnQgPSBsYXN0U2xhc2ggPj0gMCA/IHVyaVdpdGhvdXRQcmVmaXguc3Vic3RyaW5nKGxhc3RTbGFzaCArIDEpIDogdXJpV2l0aG91dFByZWZpeDtcblx0ICAgICAgICBcblx0ICAgICAgICAvLyBJZiBubyBleHRlbnNpb24gaW4gdGhlIGxhc3Qgc2VnbWVudCwgc2VydmUgaW5kZXguaHRtbFxuXHQgICAgICAgIGlmIChsYXN0U2VnbWVudC5pbmRleE9mKCcuJykgPT09IC0xKSB7XG5cdCAgICAgICAgICByZXF1ZXN0LnVyaSA9IHNwYS5pbmRleFBhdGg7XG5cdCAgICAgICAgfVxuXHQgICAgICB9XG5cblx0ICAgICAgLy8gT3B0aW9uYWxseSBzdHJpcCB0aGUgcHJlZml4IGJlZm9yZSBmb3J3YXJkaW5nIHRvIHRoZSBvcmlnaW4uXG5cdCAgICAgIGlmIChzcGEuc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4pIHtcblx0ICAgICAgICB2YXIgY2xlYW5QcmVmaXhXaXRoU2xhc2ggPSBzcGEuY2xlYW5QcmVmaXggKyAnLyc7XG5cdCAgICAgICAgaWYgKHJlcXVlc3QudXJpLnN0YXJ0c1dpdGgoY2xlYW5QcmVmaXhXaXRoU2xhc2gpKSB7XG5cdCAgICAgICAgICByZXF1ZXN0LnVyaSA9IHJlcXVlc3QudXJpLnN1YnN0cmluZyhzcGEuY2xlYW5QcmVmaXgubGVuZ3RoKTtcblx0ICAgICAgICB9XG5cdCAgICAgIH1cblx0ICAgICAgYnJlYWs7XG5cdCAgICB9XG5cdCAgfVxuXG5cdCAgcmV0dXJuIHJlcXVlc3Q7XG5cdH1cblx0YC50cmltKCk7XG59XG5cbi8qKlxuICogQSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiBmb3IgcGF0aC1yb3V0ZWQgbXVsdGktU1BBICsgQVBJIGRlcGxveW1lbnRzLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGNyZWF0ZXMgYSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiB0aGF0IHJvdXRlcyByZXF1ZXN0cyB0bzpcbiAqIC0gU1BBIG9yaWdpbnMgKFMzIGJ1Y2tldHMpIGJhc2VkIG9uIHBhdGggcHJlZml4ZXMgKGUuZy4sIC9sLyosIC9hdXRoLyopXG4gKiAtIEFQSSBvcmlnaW4gKGRlZmF1bHQgYmVoYXZpb3IpIGZvciBhbGwgb3RoZXIgcGF0aHNcbiAqIC0gQVBJIGJ5cGFzcyBwYXRocyBmb3Igc3BlY2lmaWMgcGF0aHMgdGhhdCBzaG91bGQgc2tpcCBTUEEgcm91dGluZ1xuICpcbiAqIEEgQ2xvdWRGcm9udCBGdW5jdGlvbiBoYW5kbGVzIHZpZXdlci1yZXF1ZXN0IHJld3JpdGluZyBmb3IgU1BBIHJvdXRpbmcsXG4gKiBlbnN1cmluZyB0aGF0IHBhdGhzIHdpdGhvdXQgZmlsZSBleHRlbnNpb25zIGFyZSByZXdyaXR0ZW4gdG8gaW5kZXguaHRtbC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuXG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgRnVuY3Rpb24gZm9yIFNQQSByZXdyaXRlIChpZiBTUEEgb3JpZ2lucyBhcmUgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHNwYVJld3JpdGVGdW5jdGlvbj86IGNsb3VkZnJvbnQuRnVuY3Rpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBidWNrZXQgKGlmIGxvZ2dpbmcgaXMgZW5hYmxlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIGNlcnRpZmljYXRlIHVzZWQgZm9yIHRoZSBkaXN0cmlidXRpb24gKGlmIGN1c3RvbSBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmRQcm9wcykge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgICAgIGlmICghcHJvcHMuYXBpT3JpZ2luVXJsKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgcmVxdWlyZXMgcHJvcHMuYXBpT3JpZ2luVXJsXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgICAgIGNvbnN0IGVuYWJsZUxvZ2dpbmcgPSBwcm9wcy5lbmFibGVMb2dnaW5nID8/IHRydWU7XG4gICAgICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgICAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgICAgICBpZiAobmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIHByb3BzLmxvZ3NCdWNrZXQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIFwiQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIGNhbm5vdCBob25vciBwcm9wcy5sb2dzQnVja2V0IHVuZGVyIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGU7IENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG8gdGhlIGNvbnRyYWN0IGxvZyBncm91cCwgc28gcmVtb3ZlIHByb3BzLmxvZ3NCdWNrZXQgb3IgdXNlIHRoZSBsZWdhY3kgbG9nZ2luZyBwcm9maWxlXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHN0YW5kYXJkTG9nZ2luZyA9IG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBlbmFibGVMb2dnaW5nO1xuXG4gICAgICAgIC8vIENyZWF0ZSBsb2dzIGJ1Y2tldCBpZiBTMyBsb2dnaW5nIGlzIGVuYWJsZWQgYW5kIHRoZSBzdGFuZGFyZCBwcm9maWxlIGlzXG4gICAgICAgIC8vIG5vdCByZXBsYWNpbmcgaXQgd2l0aCBDbG91ZFdhdGNoIExvZ3MgZGVsaXZlcnkuXG4gICAgICAgIGlmIChlbmFibGVMb2dnaW5nICYmICFzdGFuZGFyZExvZ2dpbmcpIHtcbiAgICAgICAgICAgIHRoaXMubG9nc0J1Y2tldCA9XG4gICAgICAgICAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICAgICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICAgICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICAgICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgICAgICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBQYXJzZSB0aGUgQVBJIG9yaWdpbiBVUkwgdG8gY3JlYXRlIGFuIEh0dHBPcmlnaW4gKGRvbWFpbiArIG9wdGlvbmFsIG9yaWdpblBhdGgpXG4gICAgICAgIGNvbnN0IGFwaU9yaWdpblBhcnNlZCA9IHRoaXMucGFyc2VPcmlnaW5Gcm9tVXJsKHByb3BzLmFwaU9yaWdpblVybCk7XG4gICAgICAgIGNvbnN0IGFwaU9yaWdpbiA9IG5ldyBvcmlnaW5zLkh0dHBPcmlnaW4oYXBpT3JpZ2luUGFyc2VkLmRvbWFpbk5hbWUsIHtcbiAgICAgICAgICAgIHByb3RvY29sUG9saWN5OiBjbG91ZGZyb250Lk9yaWdpblByb3RvY29sUG9saWN5LkhUVFBTX09OTFksXG4gICAgICAgICAgICAuLi4oYXBpT3JpZ2luUGFyc2VkLm9yaWdpblBhdGggPyB7IG9yaWdpblBhdGg6IGFwaU9yaWdpblBhcnNlZC5vcmlnaW5QYXRoIH0gOiB7fSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEhhbmRsZSBkb21haW4gY29uZmlndXJhdGlvblxuICAgICAgICBsZXQgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuICAgICAgICBsZXQgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGUgfCB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgICAgICAgY29uc3QgZG9tYWluTmFtZSA9IFN0cmluZyhwcm9wcy5kb21haW4uZG9tYWluTmFtZSkudHJpbSgpO1xuICAgICAgICAgICAgaWYgKGRvbWFpbk5hbWUpIHtcbiAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25Eb21haW5OYW1lcyA9IFtkb21haW5OYW1lXTtcblxuICAgICAgICAgICAgICAgIGlmIChwcm9wcy5kb21haW4uY2VydGlmaWNhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBwcm9wcy5kb21haW4uY2VydGlmaWNhdGU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4pIHtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcyxcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZUFybixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmRvbWFpbi5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydENsb3VkRnJvbnRIb3N0ZWRab25lQ2VydGlmaWNhdGVSZWdpb24odGhpcywgXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmRcIik7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uOiBhY20uQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnMocHJvcHMuZG9tYWluLmhvc3RlZFpvbmUpLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCByZXF1aXJlcyBkb21haW4uY2VydGlmaWNhdGUsIGRvbWFpbi5jZXJ0aWZpY2F0ZUFybiwgb3IgZG9tYWluLmhvc3RlZFpvbmUgd2hlbiBkb21haW4uZG9tYWluTmFtZSBpcyBzZXRcIixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmNlcnRpZmljYXRlID0gZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU7XG5cbiAgICAgICAgLy8gQ3JlYXRlIENsb3VkRnJvbnQgRnVuY3Rpb24gZm9yIFNQQSByZXdyaXRlIGlmIFNQQSBvcmlnaW5zIGFyZSBjb25maWd1cmVkXG4gICAgICAgIGNvbnN0IHNwYU9yaWdpbnMgPSBwcm9wcy5zcGFPcmlnaW5zID8/IFtdO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgICBzcGFPcmlnaW5zLnNvbWUoKHNwYSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJld3JpdGVNb2RlID0gbm9ybWFsaXplU3BhUmV3cml0ZU1vZGUoc3BhLnJld3JpdGVNb2RlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmV3cml0ZU1vZGUgIT09IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLk5PTkUgfHwgc3BhLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2luID09PSB0cnVlO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgICBjb25zdCBmdW5jdGlvbkNvZGUgPSBnZW5lcmF0ZVNwYVJld3JpdGVGdW5jdGlvbkNvZGUoc3BhT3JpZ2lucyk7XG5cbiAgICAgICAgICAgIHRoaXMuc3BhUmV3cml0ZUZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTcGFSZXdyaXRlRnVuY3Rpb25cIiwge1xuICAgICAgICAgICAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoZnVuY3Rpb25Db2RlKSxcbiAgICAgICAgICAgICAgICBydW50aW1lOiBjbG91ZGZyb250LkZ1bmN0aW9uUnVudGltZS5KU18yXzAsXG4gICAgICAgICAgICAgICAgY29tbWVudDogXCJTUEEgdmlld2VyLXJlcXVlc3QgcmV3cml0ZSBmb3IgcGF0aC1yb3V0ZWQgZnJvbnRlbmRcIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQnVpbGQgYWRkaXRpb25hbCBiZWhhdmlvcnNcbiAgICAgICAgY29uc3QgYWRkaXRpb25hbEJlaGF2aW9yczogUmVjb3JkPHN0cmluZywgY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnM+ID0ge307XG5cbiAgICAgICAgLy8gQWRkIEFQSSBieXBhc3MgcGF0aHMgZmlyc3QgKGhpZ2hlciBwcmVjZWRlbmNlIGluIENsb3VkRnJvbnQpXG4gICAgICAgIGZvciAoY29uc3QgYnlwYXNzQ29uZmlnIG9mIHByb3BzLmFwaUJ5cGFzc1BhdGhzID8/IFtdKSB7XG4gICAgICAgICAgICBjb25zdCByZXNwb25zZUhlYWRlcnNQb2xpY3kgPVxuICAgICAgICAgICAgICAgIGJ5cGFzc0NvbmZpZy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgICAgICAgICAgICBwcm9wcy5hcGlCeXBhc3NSZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgICAgICAgICAgICBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAgICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbYnlwYXNzQ29uZmlnLnBhdGhQYXR0ZXJuXSA9IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IGFwaU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGJ5cGFzc0NvbmZpZy5jYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTpcbiAgICAgICAgICAgICAgICAgICAgYnlwYXNzQ29uZmlnLm9yaWdpblJlcXVlc3RQb2xpY3kgPz8gcHJvcHMuYXBpT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgICAgICAgICAgICAuLi4ocmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBZGQgU1BBIG9yaWdpbiBiZWhhdmlvcnNcbiAgICAgICAgZm9yIChjb25zdCBzcGFDb25maWcgb2Ygc3BhT3JpZ2lucykge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgICAgICAgICAgICBzcGFDb25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMuc3BhUmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuICAgICAgICAgICAgY29uc3QgcmV3cml0ZU1vZGUgPSBub3JtYWxpemVTcGFSZXdyaXRlTW9kZShzcGFDb25maWcucmV3cml0ZU1vZGUpO1xuICAgICAgICAgICAgY29uc3QgbmVlZHNGdW5jdGlvbiA9XG4gICAgICAgICAgICAgICAgdGhpcy5zcGFSZXdyaXRlRnVuY3Rpb24gJiZcbiAgICAgICAgICAgICAgICAocmV3cml0ZU1vZGUgIT09IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLk5PTkUgfHwgc3BhQ29uZmlnLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2luID09PSB0cnVlKTtcblxuICAgICAgICAgICAgY29uc3Qgc3BhT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbChzcGFDb25maWcuYnVja2V0KTtcblxuICAgICAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9yc1tzcGFDb25maWcucGF0aFBhdHRlcm5dID0ge1xuICAgICAgICAgICAgICAgIG9yaWdpbjogc3BhT3JpZ2luLFxuICAgICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IHNwYUNvbmZpZy5jYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfT1BUSU1JWkVELFxuICAgICAgICAgICAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgICAgICAgICAgIC4uLihuZWVkc0Z1bmN0aW9uXG4gICAgICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uOiB0aGlzLnNwYVJld3JpdGVGdW5jdGlvbixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgIC4uLihyZXNwb25zZUhlYWRlcnNQb2xpY3lcbiAgICAgICAgICAgICAgICAgICAgPyB7IHJlc3BvbnNlSGVhZGVyc1BvbGljeSB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZGlzdHJpYnV0aW9uXG4gICAgICAgIGNvbnN0IGRlZmF1bHRSZXNwb25zZUhlYWRlcnNQb2xpY3kgPVxuICAgICAgICAgICAgcHJvcHMuYXBpUmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAgICAgLy8gU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMTUgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0LlxuICAgICAgICBjb25zdCBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uID0gZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24oXG4gICAgICAgICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgIT09IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHByb3BzLm1pbmltdW1Qcm90b2NvbFZlcnNpb24sXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgICAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICAgICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICAgICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAuLi4obWluaW11bVByb3RvY29sVmVyc2lvbiAhPT0gdW5kZWZpbmVkID8geyBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMuZGVmYXVsdFJvb3RPYmplY3QgIT09IHVuZGVmaW5lZCA/IHsgZGVmYXVsdFJvb3RPYmplY3Q6IHByb3BzLmRlZmF1bHRSb290T2JqZWN0IH0gOiB7fSksXG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IGFwaU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBwcm9wcy5hcGlPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICAgICAgICAgIC4uLihkZWZhdWx0UmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3k6IGRlZmF1bHRSZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzLFxuICAgICAgICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5wcmljZUNsYXNzID8geyBwcmljZUNsYXNzOiBwcm9wcy5wcmljZUNsYXNzIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMuY29tbWVudCA/IHsgY29tbWVudDogcHJvcHMuY29tbWVudCB9IDoge30pLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoc3RhbmRhcmRMb2dnaW5nICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCkge1xuICAgICAgICAgICAgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyh7XG4gICAgICAgICAgICAgICAgc2NvcGU6IHRoaXMsXG4gICAgICAgICAgICAgICAgaWQ6IFwiQ2RuTG9nZ2luZ1wiLFxuICAgICAgICAgICAgICAgIGNvbnRleHQ6IG5hbWluZ0NvbnRleHQsXG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uOiB0aGlzLmRpc3RyaWJ1dGlvbixcbiAgICAgICAgICAgICAgICBsb2dpY2FsOiBgbG9ncy9hY2Nlc3MvY2RuLyR7bG9naWNhbH1gLFxuICAgICAgICAgICAgICAgIGZvcm1hdDogcHJvcHMuY2xvdWRGcm9udExvZ0Zvcm1hdCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgQSByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbj8uZG9tYWluTmFtZSAmJiBwcm9wcy5kb21haW4/Lmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChwcm9wcy5kb21haW4uY3JlYXRlQUFBQVJlY29yZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZEFBQUFcIiwge1xuICAgICAgICAgICAgICAgICAgICB6b25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3RzIHRoZSBkb21haW4gbmFtZSBmcm9tIGEgVVJMIChlLmcuLCBcImh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3BhdGhcIiAtPiBcImFwaS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICBwcml2YXRlIHBhcnNlT3JpZ2luRnJvbVVybCh1cmw6IHN0cmluZyk6IHsgZG9tYWluTmFtZTogc3RyaW5nOyBvcmlnaW5QYXRoPzogc3RyaW5nIH0ge1xuICAgICAgICBjb25zdCB1cmxTdHIgPSBTdHJpbmcodXJsID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgaWYgKCF1cmxTdHIpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCByZXF1aXJlcyBhIG5vbi1lbXB0eSBhcGlPcmlnaW5VcmxcIik7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBGdWxsIFVSTCAocmVjb21tZW5kZWQpOiBodHRwczovL2FwaS5leGFtcGxlLmNvbS9wcm9kXG4gICAgICAgIGlmICh1cmxTdHIuaW5jbHVkZXMoXCI6Ly9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHBhcnNlZCA9IG5ldyBVUkwodXJsU3RyKTtcbiAgICAgICAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocGFyc2VkLmhvc3RuYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmICghZG9tYWluTmFtZSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIGNvdWxkIG5vdCBwYXJzZSBkb21haW4gZnJvbSBhcGlPcmlnaW5Vcmw6ICR7dXJsU3RyfWApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb25zdCBwYXRoID0gU3RyaW5nKHBhcnNlZC5wYXRobmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBjb25zdCBvcmlnaW5QYXRoID0gcGF0aCAmJiBwYXRoICE9PSBcIi9cIiA/IHRyaW1SZXBlYXRlZENoYXJFbmQocGF0aCwgXCIvXCIpIDogdW5kZWZpbmVkO1xuICAgICAgICAgICAgcmV0dXJuIHsgZG9tYWluTmFtZSwgLi4uKG9yaWdpblBhdGggPyB7IG9yaWdpblBhdGggfSA6IHt9KSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQmFyZSBkb21haW4gKG9yIGRvbWFpbiArIHBhdGgpOiBhcGkuZXhhbXBsZS5jb20gb3IgYXBpLmV4YW1wbGUuY29tL3Byb2RcbiAgICAgICAgY29uc3Qgd2l0aG91dFF1ZXJ5ID0gdXJsU3RyLnNwbGl0KFwiP1wiKVswXT8uc3BsaXQoXCIjXCIpWzBdID8/IHVybFN0cjtcbiAgICAgICAgY29uc3QgZmlyc3RTbGFzaEluZGV4ID0gd2l0aG91dFF1ZXJ5LmluZGV4T2YoXCIvXCIpO1xuICAgICAgICBjb25zdCBkb21haW5QYXJ0ID0gKGZpcnN0U2xhc2hJbmRleCA+PSAwID8gd2l0aG91dFF1ZXJ5LnNsaWNlKDAsIGZpcnN0U2xhc2hJbmRleCkgOiB3aXRob3V0UXVlcnkpXG4gICAgICAgICAgICAudHJpbSgpO1xuICAgICAgICBjb25zdCBub3JtYWxpemVkRG9tYWluUGFydCA9IHN0cmlwVHJhaWxpbmdQb3J0KGRvbWFpblBhcnQpO1xuICAgICAgICBpZiAoIW5vcm1hbGl6ZWREb21haW5QYXJ0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBjb3VsZCBub3QgcGFyc2UgZG9tYWluIGZyb20gYXBpT3JpZ2luVXJsOiAke3VybFN0cn1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBhdGhQYXJ0ID0gZmlyc3RTbGFzaEluZGV4ID49IDAgPyB3aXRob3V0UXVlcnkuc2xpY2UoZmlyc3RTbGFzaEluZGV4KSA6IFwiXCI7XG4gICAgICAgIGNvbnN0IG9yaWdpblBhdGggPSBwYXRoUGFydCAmJiBwYXRoUGFydCAhPT0gXCIvXCIgPyB0cmltUmVwZWF0ZWRDaGFyRW5kKHBhdGhQYXJ0LCBcIi9cIikgOiB1bmRlZmluZWQ7XG4gICAgICAgIHJldHVybiB7IGRvbWFpbk5hbWU6IG5vcm1hbGl6ZWREb21haW5QYXJ0LCAuLi4ob3JpZ2luUGF0aCA/IHsgb3JpZ2luUGF0aCB9IDoge30pIH07XG4gICAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTcGFSZXdyaXRlTW9kZShtb2RlOiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZSB8IHN0cmluZyB8IHVuZGVmaW5lZCk6IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlIHtcbiAgICBjb25zdCB2YWx1ZSA9IFN0cmluZyhtb2RlID8/IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLlNQQSkudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG4gICAgcmV0dXJuIHZhbHVlID09PSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5OT05FID8gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuTk9ORSA6IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLlNQQTtcbn1cbiJdfQ==