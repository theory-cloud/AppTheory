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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aC1yb3V0ZWQtZnJvbnRlbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXRoLXJvdXRlZC1mcm9udGVuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQTBEO0FBQzFELHdFQUEwRDtBQUMxRCx1RUFBeUQ7QUFDekQsNEVBQThEO0FBQzlELGlFQUFtRDtBQUNuRCx5RUFBMkQ7QUFDM0QsdURBQXlDO0FBQ3pDLDJDQUF1QztBQUd2Qyx5REFBNEQ7QUFDNUQsK0RBQTBFO0FBQzFFLGlFQUE2RTtBQUU3RSx5REFBZ0Y7QUFFaEYsU0FBUywyQ0FBMkMsQ0FBQyxLQUFnQixFQUFFLGFBQXFCO0lBQ3hGLE1BQU0sTUFBTSxHQUFHLG1CQUFLLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUN0QyxJQUFJLENBQUMsbUJBQUssQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLElBQUksTUFBTSxLQUFLLFdBQVcsRUFBRSxDQUFDO1FBQ3hELE9BQU87SUFDWCxDQUFDO0lBRUQsTUFBTSxpQkFBaUIsR0FBRyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDN0UsTUFBTSxJQUFJLEtBQUssQ0FDWCxHQUFHLGFBQWEsd0hBQXdILGlCQUFpQiw0R0FBNEcsQ0FDeFEsQ0FBQztBQUNOLENBQUM7QUFFRCxJQUFZLHVCQVVYO0FBVkQsV0FBWSx1QkFBdUI7SUFDL0I7O09BRUc7SUFDSCxzQ0FBVyxDQUFBO0lBRVg7O09BRUc7SUFDSCx3Q0FBYSxDQUFBO0FBQ2pCLENBQUMsRUFWVyx1QkFBdUIsdUNBQXZCLHVCQUF1QixRQVVsQztBQXVRRDs7O0dBR0c7QUFDSCxTQUFTLDhCQUE4QixDQUNuQyxVQUE2QjtJQUU3QixNQUFNLE9BQU8sR0FBRyxVQUFVO1NBQ3JC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dkcsQ0FBQztRQUVELE1BQU0sUUFBUSxHQUFHLGVBQWUsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUNqRixNQUFNLFVBQVUsR0FBRyxRQUFRLElBQUksUUFBUSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBQSxrQ0FBbUIsRUFBQyxRQUFRLEVBQUUsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztRQUNqRyxPQUFPLEVBQUUsVUFBVSxFQUFFLG9CQUFvQixFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUUsVUFBVSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUM7SUFDdkYsQ0FBQzs7QUE5UUwsa0VBK1FDO0FBRUQsU0FBUyx1QkFBdUIsQ0FBQyxJQUFrRDtJQUMvRSxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsSUFBSSxJQUFJLHVCQUF1QixDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQy9FLE9BQU8sS0FBSyxLQUFLLHVCQUF1QixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsdUJBQXVCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyx1QkFBdUIsQ0FBQyxHQUFHLENBQUM7QUFDL0csQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQgfSBmcm9tIFwiLi9sb2dnaW5nXCI7XG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24gfSBmcm9tIFwiLi9wcml2YXRlL3NlY3VyZS1kZWZhdWx0c1wiO1xuaW1wb3J0IHsgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcbmltcG9ydCB7IHN0cmlwVHJhaWxpbmdQb3J0LCB0cmltUmVwZWF0ZWRDaGFyRW5kIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuZnVuY3Rpb24gYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbihzY29wZTogQ29uc3RydWN0LCBjb25zdHJ1Y3ROYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCByZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgJiYgcmVnaW9uID09PSBcInVzLWVhc3QtMVwiKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCByZWdpb25EZXNjcmlwdGlvbiA9IFRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pID8gXCJ1bnJlc29sdmVkXCIgOiByZWdpb247XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgJHtjb25zdHJ1Y3ROYW1lfSBjYW5ub3QgY3JlYXRlIGEgaG9zdGVkLXpvbmUgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB1bmxlc3MgdGhlIHN0YWNrIHJlZ2lvbiBpcyBleHBsaWNpdGx5IHVzLWVhc3QtMTsgc3RhY2sgcmVnaW9uIGlzICR7cmVnaW9uRGVzY3JpcHRpb259LiBQcm92aWRlIGRvbWFpbi5jZXJ0aWZpY2F0ZSBvciBkb21haW4uY2VydGlmaWNhdGVBcm4gZm9yIHN0YWNrcyBpbiBvdGhlciBvciBlbnZpcm9ubWVudC1hZ25vc3RpYyByZWdpb25zLmAsXG4gICAgKTtcbn1cblxuZXhwb3J0IGVudW0gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUge1xuICAgIC8qKlxuICAgICAqIFJld3JpdGUgZXh0ZW5zaW9ubGVzcyByb3V0ZXMgdG8gYGluZGV4Lmh0bWxgIHdpdGhpbiB0aGUgU1BBIHByZWZpeC5cbiAgICAgKi9cbiAgICBTUEEgPSBcInNwYVwiLFxuXG4gICAgLyoqXG4gICAgICogRG8gbm90IHJld3JpdGUgcm91dGVzLiBVc2VmdWwgZm9yIG11bHRpLXBhZ2Uvc3RhdGljIHNpdGVzLlxuICAgICAqL1xuICAgIE5PTkUgPSBcIm5vbmVcIixcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBhbiBTUEEgb3JpZ2luIHJvdXRlZCBieSBwYXRoIHByZWZpeC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBTcGFPcmlnaW5Db25maWcge1xuICAgIC8qKlxuICAgICAqIFMzIGJ1Y2tldCBjb250YWluaW5nIHRoZSBTUEEgYXNzZXRzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJ1Y2tldDogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFBhdGggcGF0dGVybiB0byByb3V0ZSB0byB0aGlzIFNQQSAoZS5nLiwgXCIvbC8qXCIsIFwiL2F1dGgvKlwiKS5cbiAgICAgKiBNdXN0IGluY2x1ZGUgdGhlIHRyYWlsaW5nIHdpbGRjYXJkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHBhdGhQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBjYWNoZSBwb2xpY3kgb3ZlcnJpZGUuIERlZmF1bHRzIHRvIENBQ0hJTkdfT1BUSU1JWkVELlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSBmb3IgdGhpcyBTUEEgYmVoYXZpb3IuXG4gICAgICogT3ZlcnJpZGVzIGBzcGFSZXNwb25zZUhlYWRlcnNQb2xpY3lgIGFuZCBgcmVzcG9uc2VIZWFkZXJzUG9saWN5YCAobGVnYWN5KS5cbiAgICAgKi9cbiAgICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIHN0cmlwIHRoZSBTUEEgcHJlZml4IGJlZm9yZSBmb3J3YXJkaW5nIHRvIHRoZSBTMyBvcmlnaW4uXG4gICAgICpcbiAgICAgKiBFeGFtcGxlOlxuICAgICAqIC0gUmVxdWVzdDogYC9hdXRoL2Fzc2V0cy9hcHAuanNgXG4gICAgICogLSBXaXRoIGBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbj10cnVlYCwgUzMgcmVjZWl2ZXM6IGAvYXNzZXRzL2FwcC5qc2BcbiAgICAgKlxuICAgICAqIFRoaXMgYWxsb3dzIGxheWluZyBvdXQgdGhlIFNQQSBidWNrZXQgYXQgcm9vdCB3aGlsZSBzdGlsbCBzZXJ2aW5nIGl0IHVuZGVyIGEgcHJlZml4LlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbj86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBTUEEgcmV3cml0ZSBtb2RlLlxuICAgICAqXG4gICAgICogLSBgU1BBYDogcmV3cml0ZSBleHRlbnNpb25sZXNzIHJvdXRlcyB0byB0aGUgU1BBJ3MgYGluZGV4Lmh0bWxgXG4gICAgICogLSBgTk9ORWA6IGRvIG5vdCByZXdyaXRlIHJvdXRlcyAodXNlZnVsIGZvciBtdWx0aS1wYWdlIHNpdGVzKVxuICAgICAqXG4gICAgICogQGRlZmF1bHQgQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuU1BBXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmV3cml0ZU1vZGU/OiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZTtcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyBTUEEgcm91dGluZyBhbmQgZ28gZGlyZWN0bHkgdG8gdGhlIEFQSSBvcmlnaW4uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBpQnlwYXNzQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBQYXRoIHBhdHRlcm4gdGhhdCBzaG91bGQgcm91dGUgdG8gdGhlIEFQSSBvcmlnaW4gaW5zdGVhZCBvZiBTUEEgKGUuZy4sIFwiL2F1dGgvd2FsbGV0LypcIikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcGF0aFBhdHRlcm46IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIGNhY2hlIHBvbGljeSBvdmVycmlkZS4gRGVmYXVsdHMgdG8gQ0FDSElOR19ESVNBQkxFRC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgb3JpZ2luIHJlcXVlc3QgcG9saWN5IG92ZXJyaWRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IG9yaWdpblJlcXVlc3RQb2xpY3k/OiBjbG91ZGZyb250LklPcmlnaW5SZXF1ZXN0UG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogUmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIHRoaXMgQVBJIGJ5cGFzcyBiZWhhdmlvci5cbiAgICAgKiBPdmVycmlkZXMgYGFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeWAgYW5kIGByZXNwb25zZUhlYWRlcnNQb2xpY3lgIChsZWdhY3kpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcbn1cblxuLyoqXG4gKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFBhdGhSb3V0ZWRGcm9udGVuZERvbWFpbkNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogVGhlIGRvbWFpbiBuYW1lIGZvciB0aGUgZGlzdHJpYnV0aW9uIChlLmcuLCBcImFwcC5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIEhUVFBTLiBNdXN0IGJlIGluIHVzLWVhc3QtMSBmb3IgQ2xvdWRGcm9udC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBUk4gb2YgYW4gZXhpc3RpbmcgQUNNIGNlcnRpZmljYXRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICAgKiBXaGVuIHByb3ZpZGVkLCBhbiBBIHJlY29yZCBhbGlhcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIHRoZSBkb21haW4uXG4gICAgICpcbiAgICAgKiBJZiBgZG9tYWluTmFtZWAgaXMgc2V0IHdpdGhvdXQgYGNlcnRpZmljYXRlYCBvciBgY2VydGlmaWNhdGVBcm5gLFxuICAgICAqIGhvc3RlZC16b25lIGNlcnRpZmljYXRlIGNyZWF0aW9uIGlzIGFsbG93ZWQgb25seSBmb3Igc3RhY2tzIHdob3NlIHJlZ2lvblxuICAgICAqIGlzIGV4cGxpY2l0bHkgYHVzLWVhc3QtMWAuIENsb3VkRnJvbnQgcmVxdWlyZXMgdmlld2VyIGNlcnRpZmljYXRlcyBpblxuICAgICAqIGB1cy1lYXN0LTFgOyBlbnZpcm9ubWVudC1hZ25vc3RpYyBvciBvdGhlci1yZWdpb24gc3RhY2tzIG11c3QgcHJvdmlkZSBhblxuICAgICAqIGV4cGxpY2l0IGNlcnRpZmljYXRlIGlucHV0LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kUHJvcHMge1xuICAgIC8qKlxuICAgICAqIFRoZSBwcmltYXJ5IEFQSSBvcmlnaW4gVVJMIChlLmcuLCB0aGUgQVBJIEdhdGV3YXkgaW52b2tlIFVSTCBvciBMYW1iZGEgZnVuY3Rpb24gVVJMKS5cbiAgICAgKiBUaGlzIGlzIHVzZWQgZm9yIHRoZSBkZWZhdWx0IGJlaGF2aW9yIGFuZCBhbnkgQVBJIGJ5cGFzcyBwYXRocy5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5Vcmw6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFNQQSBvcmlnaW5zIHdpdGggdGhlaXIgcGF0aCBwYXR0ZXJucy5cbiAgICAgKiBFYWNoIFNQQSB3aWxsIGJlIHNlcnZlZCB2aWEgQ2xvdWRGcm9udCB3aXRoIFNQQSByZXdyaXRlIHN1cHBvcnQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3BhT3JpZ2lucz86IFNwYU9yaWdpbkNvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQVBJIGJ5cGFzcyBjb25maWd1cmF0aW9ucyBmb3IgcGF0aHMgdGhhdCBzaG91bGQgZ28gZGlyZWN0bHkgdG8gdGhlIEFQSSBvcmlnaW5cbiAgICAgKiBldmVuIHRob3VnaCB0aGV5IG1pZ2h0IG1hdGNoIGFuIFNQQSBwYXRoIHByZWZpeC5cbiAgICAgKiBUaGVzZSBhcmUgZXZhbHVhdGVkIGJlZm9yZSBTUEEgcGF0aHMgZHVlIHRvIENsb3VkRnJvbnQgYmVoYXZpb3IgcHJlY2VkZW5jZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlCeXBhc3NQYXRocz86IEFwaUJ5cGFzc0NvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGN1c3RvbSBkb21haW4sIGNlcnRpZmljYXRlLCBhbmQgUm91dGU1My5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBQYXRoUm91dGVkRnJvbnRlbmREb21haW5Db25maWc7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSB0byBhcHBseSB0byBhbGwgYmVoYXZpb3JzIChsZWdhY3kpLlxuICAgICAqXG4gICAgICogUHJlZmVyIHVzaW5nIGBhcGlSZXNwb25zZUhlYWRlcnNQb2xpY3lgLCBgc3BhUmVzcG9uc2VIZWFkZXJzUG9saWN5YCwgYW5kXG4gICAgICogYGFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeWAgZm9yIGJlaGF2aW9yLXNjb3BlZCBjb250cm9sLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGZvciB0aGUgQVBJIG9yaWdpbiBkZWZhdWx0IGJlaGF2aW9yLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaVJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIFNQQSBiZWhhdmlvcnMuXG4gICAgICogQ2FuIGJlIG92ZXJyaWRkZW4gcGVyIFNQQSB2aWEgYFNwYU9yaWdpbkNvbmZpZy5yZXNwb25zZUhlYWRlcnNQb2xpY3lgLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIEFQSSBieXBhc3MgYmVoYXZpb3JzLlxuICAgICAqIENhbiBiZSBvdmVycmlkZGVuIHBlciBieXBhc3MgdmlhIGBBcGlCeXBhc3NDb25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5YC5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlCeXBhc3NSZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBPcmlnaW4gcmVxdWVzdCBwb2xpY3kgZm9yIHRoZSBBUEkgb3JpZ2luIChkZWZhdWx0IGJlaGF2aW9yKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5SZXF1ZXN0UG9saWN5PzogY2xvdWRmcm9udC5JT3JpZ2luUmVxdWVzdFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgICAqXG4gICAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG9cbiAgICAgKiBgbG9ncy9hY2Nlc3MvY2RuL3tsb2dpY2FsTmFtZX1gIHRocm91Z2ggQ2xvdWRXYXRjaCBMb2dzIHZlbmRlZCBkZWxpdmVyeS5cbiAgICAgKiBQYXNzIGBlbmFibGVMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dC5cbiAgICAgKlxuICAgICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgZGlzdHJpYnV0aW9uJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkXG4gICAgICogd2hlbiBhIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIENsb3VkRnJvbnQgc3RhbmRhcmQtbG9nZ2luZyBvdXRwdXQgZm9ybWF0IGZvciBhIENsb3VkV2F0Y2ggTG9nc1xuICAgICAqIGRlc3RpbmF0aW9uLiBPbmx5IHVzZWQgdW5kZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZS5cbiAgICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LkpTT05cbiAgICAgKi9cbiAgICByZWFkb25seSBjbG91ZEZyb250TG9nRm9ybWF0PzogQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdDtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBDbG91ZEZyb250IGFjY2VzcyBsb2dnaW5nLlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmFibGVMb2dnaW5nPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIFMzIGJ1Y2tldCBmb3IgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncy5cbiAgICAgKiBJZiBub3QgcHJvdmlkZWQgYW5kIGVuYWJsZUxvZ2dpbmcgaXMgdHJ1ZSwgYSBuZXcgYnVja2V0IHdpbGwgYmUgY3JlYXRlZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFJlbW92YWwgcG9saWN5IGZvciBjcmVhdGVkIHJlc291cmNlcy5cbiAgICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBhdXRvLWRlbGV0ZSBvYmplY3RzIGluIGNyZWF0ZWQgYnVja2V0cyBvbiBzdGFjayBkZWxldGlvbi5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiByZW1vdmFsUG9saWN5IGlzIERFU1RST1kuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhdXRvRGVsZXRlT2JqZWN0cz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCB3ZWIgQUNMIElEIGZvciBBV1MgV0FGIGludGVncmF0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHdlYkFjbElkPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUHJpY2UgY2xhc3MgZm9yIHRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICAgKiBAZGVmYXVsdCBQcmljZUNsYXNzLlBSSUNFX0NMQVNTX0FMTFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHByaWNlQ2xhc3M/OiBjbG91ZGZyb250LlByaWNlQ2xhc3M7XG5cbiAgICAvKipcbiAgICAgKiBBbiBvcHRpb25hbCBuYW1lL2NvbW1lbnQgZm9yIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgY29tbWVudD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE1pbmltdW0gVExTIHByb3RvY29sIHZlcnNpb24gZm9yIHZpZXdlcnMgb2YgYSBjdXN0b20gZG9tYWluLlxuICAgICAqXG4gICAgICogV2l0aCBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQgYW5kIGEgY3VzdG9tIGNlcnRpZmljYXRlIHRoZSBkZWZhdWx0IGlzXG4gICAgICogYFRMU19WMV8yXzIwMjVgLCB0aGUgcG9saWN5IFNlY3VyaXR5IEh1YiBDbG91ZEZyb250LjE1IGFjY2VwdHMgd2l0aCB0aGVcbiAgICAgKiB3aWRlc3QgY2xpZW50IHN1cHBvcnQuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBUTFNfVjFfMl8yMDI1IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB3aXRoIGEgY2VydGlmaWNhdGUsXG4gICAgICogb3RoZXJ3aXNlIHRoZSBDbG91ZEZyb250IGRlZmF1bHQgZm9yIHRoZSBjZXJ0aWZpY2F0ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1pbmltdW1Qcm90b2NvbFZlcnNpb24/OiBjbG91ZGZyb250LlNlY3VyaXR5UG9saWN5UHJvdG9jb2w7XG5cbiAgICAvKipcbiAgICAgKiBPYmplY3QgQ2xvdWRGcm9udCByZXR1cm5zIGZvciBhIHJlcXVlc3QgdG8gdGhlIGRpc3RyaWJ1dGlvbiByb290LlxuICAgICAqXG4gICAgICogVGhlIGZyb250ZW5kJ3Mgcm9vdCBiZWhhdmlvciB0YXJnZXRzIHRoZSBBUEkgb3JpZ2luLCBhIGN1c3RvbSBvcmlnaW4gdGhhdFxuICAgICAqIFNlY3VyaXR5IEh1YiBDbG91ZEZyb250LjEgZG9lcyBub3QgZXZhbHVhdGUsIHNvIEFwcFRoZW9yeSBzZXRzIG5vIGRlZmF1bHQuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBkZWZhdWx0Um9vdE9iamVjdD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBDbG91ZEZyb250IEZ1bmN0aW9uIGNvZGUgZm9yIFNQQSB2aWV3ZXItcmVxdWVzdCByZXdyaXRlLlxuICogUmV3cml0ZXMgcmVxdWVzdHMgd2l0aG91dCBmaWxlIGV4dGVuc2lvbnMgdG8gdGhlIGluZGV4Lmh0bWwgd2l0aGluIHRoZSBwcmVmaXguXG4gKi9cbmZ1bmN0aW9uIGdlbmVyYXRlU3BhUmV3cml0ZUZ1bmN0aW9uQ29kZShcbiAgICBzcGFPcmlnaW5zOiBTcGFPcmlnaW5Db25maWdbXSxcbik6IHN0cmluZyB7XG4gICAgY29uc3QgY29uZmlncyA9IHNwYU9yaWdpbnNcbiAgICAgICAgLm1hcCgoc3BhKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjbGVhblByZWZpeCA9IHNwYS5wYXRoUGF0dGVybi5yZXBsYWNlKC9cXC9cXCokLywgXCJcIik7XG4gICAgICAgICAgICBjb25zdCBwcmVmaXggPSBgJHtjbGVhblByZWZpeH0vYDtcbiAgICAgICAgICAgIGNvbnN0IHJld3JpdGVNb2RlID0gbm9ybWFsaXplU3BhUmV3cml0ZU1vZGUoc3BhLnJld3JpdGVNb2RlKTtcbiAgICAgICAgICAgIGNvbnN0IHN0cmlwUHJlZml4QmVmb3JlT3JpZ2luID0gc3BhLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2luID09PSB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaW5kZXhQYXRoID0gYCR7Y2xlYW5QcmVmaXh9L2luZGV4Lmh0bWxgO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBjbGVhblByZWZpeCxcbiAgICAgICAgICAgICAgICBwcmVmaXgsXG4gICAgICAgICAgICAgICAgcmV3cml0ZU1vZGUsXG4gICAgICAgICAgICAgICAgc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4sXG4gICAgICAgICAgICAgICAgaW5kZXhQYXRoLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSlcbiAgICAgICAgLy8gRW5zdXJlIG1vcmUgc3BlY2lmaWMgcHJlZml4ZXMgbWF0Y2ggZmlyc3QgdG8gYXZvaWQgb3ZlcmxhcCBpc3N1ZXMuXG4gICAgICAgIC5zb3J0KChhLCBiKSA9PiBiLmNsZWFuUHJlZml4Lmxlbmd0aCAtIGEuY2xlYW5QcmVmaXgubGVuZ3RoKTtcblxuICAgIGNvbnN0IHByZWZpeE1hdGNoZXMgPSBjb25maWdzXG4gICAgICAgIC5tYXAoKGNmZykgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIGB7IGNsZWFuUHJlZml4OiAnJHtjZmcuY2xlYW5QcmVmaXh9JywgcHJlZml4OiAnJHtjZmcucHJlZml4fScsIHJld3JpdGVNb2RlOiAnJHtjZmcucmV3cml0ZU1vZGV9Jywgc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW46ICR7Y2ZnLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2lufSwgaW5kZXhQYXRoOiAnJHtjZmcuaW5kZXhQYXRofScgfWA7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKFwiLFxcbiAgICAgIFwiKTtcblxuICAgIHJldHVybiBgXG5cdGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcblx0ICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG5cdCAgdmFyIHVyaSA9IHJlcXVlc3QudXJpO1xuXG5cdCAgLy8gU1BBIHByZWZpeCBjb25maWd1cmF0aW9uc1xuXHQgIHZhciBzcGFQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtwcmVmaXhNYXRjaGVzfVxuXHQgIF07XG5cblx0ICAvLyBDaGVjayBpZiB0aGlzIGlzIGFuIFNQQSBwYXRoXG5cdCAgZm9yICh2YXIgaSA9IDA7IGkgPCBzcGFQcmVmaXhlcy5sZW5ndGg7IGkrKykge1xuXHQgICAgdmFyIHNwYSA9IHNwYVByZWZpeGVzW2ldO1xuXHQgICAgaWYgKHVyaS5zdGFydHNXaXRoKHNwYS5wcmVmaXgpKSB7XG5cdCAgICAgIHZhciB1cmlXaXRob3V0UHJlZml4ID0gdXJpLnN1YnN0cmluZyhzcGEucHJlZml4Lmxlbmd0aCk7XG5cblx0ICAgICAgaWYgKHNwYS5yZXdyaXRlTW9kZSA9PT0gJ3NwYScpIHtcblx0ICAgICAgICAvLyBJZiB0aGUgVVJJIGRvZXNuJ3QgaGF2ZSBhbiBleHRlbnNpb24gKG5vIGZpbGUpLCByZXdyaXRlIHRvIGluZGV4Lmh0bWxcblx0ICAgICAgICAvLyBDaGVjayBpZiBpdCBoYXMgYSBmaWxlIGV4dGVuc2lvbiAoY29udGFpbnMgYSBkb3QgaW4gdGhlIGxhc3QgcGF0aCBzZWdtZW50KVxuXHQgICAgICAgIHZhciBsYXN0U2xhc2ggPSB1cmlXaXRob3V0UHJlZml4Lmxhc3RJbmRleE9mKCcvJyk7XG5cdCAgICAgICAgdmFyIGxhc3RTZWdtZW50ID0gbGFzdFNsYXNoID49IDAgPyB1cmlXaXRob3V0UHJlZml4LnN1YnN0cmluZyhsYXN0U2xhc2ggKyAxKSA6IHVyaVdpdGhvdXRQcmVmaXg7XG5cdCAgICAgICAgXG5cdCAgICAgICAgLy8gSWYgbm8gZXh0ZW5zaW9uIGluIHRoZSBsYXN0IHNlZ21lbnQsIHNlcnZlIGluZGV4Lmh0bWxcblx0ICAgICAgICBpZiAobGFzdFNlZ21lbnQuaW5kZXhPZignLicpID09PSAtMSkge1xuXHQgICAgICAgICAgcmVxdWVzdC51cmkgPSBzcGEuaW5kZXhQYXRoO1xuXHQgICAgICAgIH1cblx0ICAgICAgfVxuXG5cdCAgICAgIC8vIE9wdGlvbmFsbHkgc3RyaXAgdGhlIHByZWZpeCBiZWZvcmUgZm9yd2FyZGluZyB0byB0aGUgb3JpZ2luLlxuXHQgICAgICBpZiAoc3BhLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2luKSB7XG5cdCAgICAgICAgdmFyIGNsZWFuUHJlZml4V2l0aFNsYXNoID0gc3BhLmNsZWFuUHJlZml4ICsgJy8nO1xuXHQgICAgICAgIGlmIChyZXF1ZXN0LnVyaS5zdGFydHNXaXRoKGNsZWFuUHJlZml4V2l0aFNsYXNoKSkge1xuXHQgICAgICAgICAgcmVxdWVzdC51cmkgPSByZXF1ZXN0LnVyaS5zdWJzdHJpbmcoc3BhLmNsZWFuUHJlZml4Lmxlbmd0aCk7XG5cdCAgICAgICAgfVxuXHQgICAgICB9XG5cdCAgICAgIGJyZWFrO1xuXHQgICAgfVxuXHQgIH1cblxuXHQgIHJldHVybiByZXF1ZXN0O1xuXHR9XG5cdGAudHJpbSgpO1xufVxuXG4vKipcbiAqIEEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZm9yIHBhdGgtcm91dGVkIG11bHRpLVNQQSArIEFQSSBkZXBsb3ltZW50cy5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBjcmVhdGVzIGEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gdGhhdCByb3V0ZXMgcmVxdWVzdHMgdG86XG4gKiAtIFNQQSBvcmlnaW5zIChTMyBidWNrZXRzKSBiYXNlZCBvbiBwYXRoIHByZWZpeGVzIChlLmcuLCAvbC8qLCAvYXV0aC8qKVxuICogLSBBUEkgb3JpZ2luIChkZWZhdWx0IGJlaGF2aW9yKSBmb3IgYWxsIG90aGVyIHBhdGhzXG4gKiAtIEFQSSBieXBhc3MgcGF0aHMgZm9yIHNwZWNpZmljIHBhdGhzIHRoYXQgc2hvdWxkIHNraXAgU1BBIHJvdXRpbmdcbiAqXG4gKiBBIENsb3VkRnJvbnQgRnVuY3Rpb24gaGFuZGxlcyB2aWV3ZXItcmVxdWVzdCByZXdyaXRpbmcgZm9yIFNQQSByb3V0aW5nLFxuICogZW5zdXJpbmcgdGhhdCBwYXRocyB3aXRob3V0IGZpbGUgZXh0ZW5zaW9ucyBhcmUgcmV3cml0dGVuIHRvIGluZGV4Lmh0bWwuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IEZ1bmN0aW9uIGZvciBTUEEgcmV3cml0ZSAoaWYgU1BBIG9yaWdpbnMgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBzcGFSZXdyaXRlRnVuY3Rpb24/OiBjbG91ZGZyb250LkZ1bmN0aW9uO1xuXG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgYnVja2V0IChpZiBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjZXJ0aWZpY2F0ZSB1c2VkIGZvciB0aGUgZGlzdHJpYnV0aW9uIChpZiBjdXN0b20gZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kUHJvcHMpIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICBpZiAoIXByb3BzLmFwaU9yaWdpblVybCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIHJlcXVpcmVzIHByb3BzLmFwaU9yaWdpblVybFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgICAgICBjb25zdCBhdXRvRGVsZXRlT2JqZWN0cyA9IHByb3BzLmF1dG9EZWxldGVPYmplY3RzID8/IGZhbHNlO1xuICAgICAgICBjb25zdCBlbmFibGVMb2dnaW5nID0gcHJvcHMuZW5hYmxlTG9nZ2luZyA/PyB0cnVlO1xuICAgICAgICBjb25zdCBuYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICAgICAgY29uc3QgbG9naWNhbCA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChuYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICAgICAgaWYgKG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBwcm9wcy5sb2dzQnVja2V0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBjYW5ub3QgaG9ub3IgcHJvcHMubG9nc0J1Y2tldCB1bmRlciB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlOyBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGdvIHRvIHRoZSBjb250cmFjdCBsb2cgZ3JvdXAsIHNvIHJlbW92ZSBwcm9wcy5sb2dzQnVja2V0IG9yIHVzZSB0aGUgbGVnYWN5IGxvZ2dpbmcgcHJvZmlsZVwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzdGFuZGFyZExvZ2dpbmcgPSBuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgZW5hYmxlTG9nZ2luZztcblxuICAgICAgICAvLyBDcmVhdGUgbG9ncyBidWNrZXQgaWYgUzMgbG9nZ2luZyBpcyBlbmFibGVkIGFuZCB0aGUgc3RhbmRhcmQgcHJvZmlsZSBpc1xuICAgICAgICAvLyBub3QgcmVwbGFjaW5nIGl0IHdpdGggQ2xvdWRXYXRjaCBMb2dzIGRlbGl2ZXJ5LlxuICAgICAgICBpZiAoZW5hYmxlTG9nZ2luZyAmJiAhc3RhbmRhcmRMb2dnaW5nKSB7XG4gICAgICAgICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICAgICAgICAgIHByb3BzLmxvZ3NCdWNrZXQgPz9cbiAgICAgICAgICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgICAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgICAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgICAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5PQkpFQ1RfV1JJVEVSLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUGFyc2UgdGhlIEFQSSBvcmlnaW4gVVJMIHRvIGNyZWF0ZSBhbiBIdHRwT3JpZ2luIChkb21haW4gKyBvcHRpb25hbCBvcmlnaW5QYXRoKVxuICAgICAgICBjb25zdCBhcGlPcmlnaW5QYXJzZWQgPSB0aGlzLnBhcnNlT3JpZ2luRnJvbVVybChwcm9wcy5hcGlPcmlnaW5VcmwpO1xuICAgICAgICBjb25zdCBhcGlPcmlnaW4gPSBuZXcgb3JpZ2lucy5IdHRwT3JpZ2luKGFwaU9yaWdpblBhcnNlZC5kb21haW5OYW1lLCB7XG4gICAgICAgICAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQU19PTkxZLFxuICAgICAgICAgICAgLi4uKGFwaU9yaWdpblBhcnNlZC5vcmlnaW5QYXRoID8geyBvcmlnaW5QYXRoOiBhcGlPcmlnaW5QYXJzZWQub3JpZ2luUGF0aCB9IDoge30pLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBIYW5kbGUgZG9tYWluIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgICAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluLmRvbWFpbk5hbWUpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG5cbiAgICAgICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4sXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHRoaXMsIFwiQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kXCIpO1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IG5ldyBhY20uQ2VydGlmaWNhdGUodGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkb21haW5OYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvbjogYWNtLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKHByb3BzLmRvbWFpbi5ob3N0ZWRab25lKSxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgcmVxdWlyZXMgZG9tYWluLmNlcnRpZmljYXRlLCBkb21haW4uY2VydGlmaWNhdGVBcm4sIG9yIGRvbWFpbi5ob3N0ZWRab25lIHdoZW4gZG9tYWluLmRvbWFpbk5hbWUgaXMgc2V0XCIsXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlO1xuXG4gICAgICAgIC8vIENyZWF0ZSBDbG91ZEZyb250IEZ1bmN0aW9uIGZvciBTUEEgcmV3cml0ZSBpZiBTUEEgb3JpZ2lucyBhcmUgY29uZmlndXJlZFxuICAgICAgICBjb25zdCBzcGFPcmlnaW5zID0gcHJvcHMuc3BhT3JpZ2lucyA/PyBbXTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgc3BhT3JpZ2lucy5zb21lKChzcGEpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXdyaXRlTW9kZSA9IG5vcm1hbGl6ZVNwYVJld3JpdGVNb2RlKHNwYS5yZXdyaXRlTW9kZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJld3JpdGVNb2RlICE9PSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5OT05FIHx8IHNwYS5zdHJpcFByZWZpeEJlZm9yZU9yaWdpbiA9PT0gdHJ1ZTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICkge1xuICAgICAgICAgICAgY29uc3QgZnVuY3Rpb25Db2RlID0gZ2VuZXJhdGVTcGFSZXdyaXRlRnVuY3Rpb25Db2RlKHNwYU9yaWdpbnMpO1xuXG4gICAgICAgICAgICB0aGlzLnNwYVJld3JpdGVGdW5jdGlvbiA9IG5ldyBjbG91ZGZyb250LkZ1bmN0aW9uKHRoaXMsIFwiU3BhUmV3cml0ZUZ1bmN0aW9uXCIsIHtcbiAgICAgICAgICAgICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKGZ1bmN0aW9uQ29kZSksXG4gICAgICAgICAgICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgICAgICAgICAgIGNvbW1lbnQ6IFwiU1BBIHZpZXdlci1yZXF1ZXN0IHJld3JpdGUgZm9yIHBhdGgtcm91dGVkIGZyb250ZW5kXCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEJ1aWxkIGFkZGl0aW9uYWwgYmVoYXZpb3JzXG4gICAgICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuXG4gICAgICAgIC8vIEFkZCBBUEkgYnlwYXNzIHBhdGhzIGZpcnN0IChoaWdoZXIgcHJlY2VkZW5jZSBpbiBDbG91ZEZyb250KVxuICAgICAgICBmb3IgKGNvbnN0IGJ5cGFzc0NvbmZpZyBvZiBwcm9wcy5hcGlCeXBhc3NQYXRocyA/PyBbXSkge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgICAgICAgICAgICBieXBhc3NDb25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMuYXBpQnlwYXNzUmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW2J5cGFzc0NvbmZpZy5wYXRoUGF0dGVybl0gPSB7XG4gICAgICAgICAgICAgICAgb3JpZ2luOiBhcGlPcmlnaW4sXG4gICAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgICAgICAgIGNhY2hlUG9saWN5OiBieXBhc3NDb25maWcuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6XG4gICAgICAgICAgICAgICAgICAgIGJ5cGFzc0NvbmZpZy5vcmlnaW5SZXF1ZXN0UG9saWN5ID8/IHByb3BzLmFwaU9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgICAgICAgICAgLi4uKHJlc3BvbnNlSGVhZGVyc1BvbGljeVxuICAgICAgICAgICAgICAgICAgICA/IHsgcmVzcG9uc2VIZWFkZXJzUG9saWN5IH1cbiAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQWRkIFNQQSBvcmlnaW4gYmVoYXZpb3JzXG4gICAgICAgIGZvciAoY29uc3Qgc3BhQ29uZmlnIG9mIHNwYU9yaWdpbnMpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlSGVhZGVyc1BvbGljeSA9XG4gICAgICAgICAgICAgICAgc3BhQ29uZmlnLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgICAgIHByb3BzLnNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgICAgIHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeTtcbiAgICAgICAgICAgIGNvbnN0IHJld3JpdGVNb2RlID0gbm9ybWFsaXplU3BhUmV3cml0ZU1vZGUoc3BhQ29uZmlnLnJld3JpdGVNb2RlKTtcbiAgICAgICAgICAgIGNvbnN0IG5lZWRzRnVuY3Rpb24gPVxuICAgICAgICAgICAgICAgIHRoaXMuc3BhUmV3cml0ZUZ1bmN0aW9uICYmXG4gICAgICAgICAgICAgICAgKHJld3JpdGVNb2RlICE9PSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5OT05FIHx8IHNwYUNvbmZpZy5zdHJpcFByZWZpeEJlZm9yZU9yaWdpbiA9PT0gdHJ1ZSk7XG5cbiAgICAgICAgICAgIGNvbnN0IHNwYU9yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2woc3BhQ29uZmlnLmJ1Y2tldCk7XG5cbiAgICAgICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbc3BhQ29uZmlnLnBhdGhQYXR0ZXJuXSA9IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IHNwYU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgICAgICAgICAgIGNhY2hlUG9saWN5OiBzcGFDb25maWcuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRCxcbiAgICAgICAgICAgICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICAuLi4obmVlZHNGdW5jdGlvblxuICAgICAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbjogdGhpcy5zcGFSZXdyaXRlRnVuY3Rpb24sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVRVUVTVCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICAuLi4ocmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGRpc3RyaWJ1dGlvblxuICAgICAgICBjb25zdCBkZWZhdWx0UmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgICAgICAgIHByb3BzLmFwaVJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgICAgIC8vIFNlY3VyaXR5IEh1YiBDbG91ZEZyb250LjE1IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dC5cbiAgICAgICAgY29uc3QgbWluaW11bVByb3RvY29sVmVyc2lvbiA9IGRlZmF1bHRNaW5pbXVtUHJvdG9jb2xWZXJzaW9uKFxuICAgICAgICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlICE9PSB1bmRlZmluZWQsXG4gICAgICAgICAgICBwcm9wcy5taW5pbXVtUHJvdG9jb2xWZXJzaW9uLFxuICAgICAgICApO1xuICAgICAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBcIkRpc3RyaWJ1dGlvblwiLCB7XG4gICAgICAgICAgICAuLi4oZW5hYmxlTG9nZ2luZyAmJiB0aGlzLmxvZ3NCdWNrZXRcbiAgICAgICAgICAgICAgICA/IHsgZW5hYmxlTG9nZ2luZzogdHJ1ZSwgbG9nQnVja2V0OiB0aGlzLmxvZ3NCdWNrZXQsIGxvZ0ZpbGVQcmVmaXg6IFwiY2xvdWRmcm9udC9cIiB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAuLi4oZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgJiYgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGVcbiAgICAgICAgICAgICAgICA/IHsgZG9tYWluTmFtZXM6IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzLCBjZXJ0aWZpY2F0ZTogZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgfVxuICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgLi4uKG1pbmltdW1Qcm90b2NvbFZlcnNpb24gIT09IHVuZGVmaW5lZCA/IHsgbWluaW11bVByb3RvY29sVmVyc2lvbiB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLmRlZmF1bHRSb290T2JqZWN0ICE9PSB1bmRlZmluZWQgPyB7IGRlZmF1bHRSb290T2JqZWN0OiBwcm9wcy5kZWZhdWx0Um9vdE9iamVjdCB9IDoge30pLFxuICAgICAgICAgICAgZGVmYXVsdEJlaGF2aW9yOiB7XG4gICAgICAgICAgICAgICAgb3JpZ2luOiBhcGlPcmlnaW4sXG4gICAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgICAgICAgIGNhY2hlUG9saWN5OiBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTogcHJvcHMuYXBpT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgICAgICAgICAgICAuLi4oZGVmYXVsdFJlc3BvbnNlSGVhZGVyc1BvbGljeVxuICAgICAgICAgICAgICAgICAgICA/IHsgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBkZWZhdWx0UmVzcG9uc2VIZWFkZXJzUG9saWN5IH1cbiAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9ycyxcbiAgICAgICAgICAgIC4uLihwcm9wcy53ZWJBY2xJZCA/IHsgd2ViQWNsSWQ6IHByb3BzLndlYkFjbElkIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMucHJpY2VDbGFzcyA/IHsgcHJpY2VDbGFzczogcHJvcHMucHJpY2VDbGFzcyB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLmNvbW1lbnQgPyB7IGNvbW1lbnQ6IHByb3BzLmNvbW1lbnQgfSA6IHt9KSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHN0YW5kYXJkTG9nZ2luZyAmJiBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwpIHtcbiAgICAgICAgICAgIGVuYWJsZUNsb3VkRnJvbnRTdGFuZGFyZExvZ2dpbmcoe1xuICAgICAgICAgICAgICAgIHNjb3BlOiB0aGlzLFxuICAgICAgICAgICAgICAgIGlkOiBcIkNkbkxvZ2dpbmdcIixcbiAgICAgICAgICAgICAgICBjb250ZXh0OiBuYW1pbmdDb250ZXh0LFxuICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbjogdGhpcy5kaXN0cmlidXRpb24sXG4gICAgICAgICAgICAgICAgbG9naWNhbDogYGxvZ3MvYWNjZXNzL2Nkbi8ke2xvZ2ljYWx9YCxcbiAgICAgICAgICAgICAgICBmb3JtYXQ6IHByb3BzLmNsb3VkRnJvbnRMb2dGb3JtYXQsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSBSb3V0ZTUzIEEgcmVjb3JkIGlmIGhvc3RlZCB6b25lIGlzIHByb3ZpZGVkXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4/LmRvbWFpbk5hbWUgJiYgcHJvcHMuZG9tYWluPy5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgICAgICAgIHpvbmU6IHByb3BzLmRvbWFpbi5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbi5kb21haW5OYW1lLFxuICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNyZWF0ZUFBQUFSZWNvcmQgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBuZXcgcm91dGU1My5BYWFhUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRBQUFBXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbi5kb21haW5OYW1lLFxuICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0cyB0aGUgZG9tYWluIG5hbWUgZnJvbSBhIFVSTCAoZS5nLiwgXCJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wYXRoXCIgLT4gXCJhcGkuZXhhbXBsZS5jb21cIikuXG4gICAgICovXG4gICAgcHJpdmF0ZSBwYXJzZU9yaWdpbkZyb21VcmwodXJsOiBzdHJpbmcpOiB7IGRvbWFpbk5hbWU6IHN0cmluZzsgb3JpZ2luUGF0aD86IHN0cmluZyB9IHtcbiAgICAgICAgY29uc3QgdXJsU3RyID0gU3RyaW5nKHVybCA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgIGlmICghdXJsU3RyKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgcmVxdWlyZXMgYSBub24tZW1wdHkgYXBpT3JpZ2luVXJsXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRnVsbCBVUkwgKHJlY29tbWVuZGVkKTogaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJvZFxuICAgICAgICBpZiAodXJsU3RyLmluY2x1ZGVzKFwiOi8vXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBwYXJzZWQgPSBuZXcgVVJMKHVybFN0cik7XG4gICAgICAgICAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHBhcnNlZC5ob3N0bmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoIWRvbWFpbk5hbWUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBjb3VsZCBub3QgcGFyc2UgZG9tYWluIGZyb20gYXBpT3JpZ2luVXJsOiAke3VybFN0cn1gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcGF0aCA9IFN0cmluZyhwYXJzZWQucGF0aG5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgICAgICAgICAgY29uc3Qgb3JpZ2luUGF0aCA9IHBhdGggJiYgcGF0aCAhPT0gXCIvXCIgPyB0cmltUmVwZWF0ZWRDaGFyRW5kKHBhdGgsIFwiL1wiKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIHJldHVybiB7IGRvbWFpbk5hbWUsIC4uLihvcmlnaW5QYXRoID8geyBvcmlnaW5QYXRoIH0gOiB7fSkgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEJhcmUgZG9tYWluIChvciBkb21haW4gKyBwYXRoKTogYXBpLmV4YW1wbGUuY29tIG9yIGFwaS5leGFtcGxlLmNvbS9wcm9kXG4gICAgICAgIGNvbnN0IHdpdGhvdXRRdWVyeSA9IHVybFN0ci5zcGxpdChcIj9cIilbMF0/LnNwbGl0KFwiI1wiKVswXSA/PyB1cmxTdHI7XG4gICAgICAgIGNvbnN0IGZpcnN0U2xhc2hJbmRleCA9IHdpdGhvdXRRdWVyeS5pbmRleE9mKFwiL1wiKTtcbiAgICAgICAgY29uc3QgZG9tYWluUGFydCA9IChmaXJzdFNsYXNoSW5kZXggPj0gMCA/IHdpdGhvdXRRdWVyeS5zbGljZSgwLCBmaXJzdFNsYXNoSW5kZXgpIDogd2l0aG91dFF1ZXJ5KVxuICAgICAgICAgICAgLnRyaW0oKTtcbiAgICAgICAgY29uc3Qgbm9ybWFsaXplZERvbWFpblBhcnQgPSBzdHJpcFRyYWlsaW5nUG9ydChkb21haW5QYXJ0KTtcbiAgICAgICAgaWYgKCFub3JtYWxpemVkRG9tYWluUGFydCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgY291bGQgbm90IHBhcnNlIGRvbWFpbiBmcm9tIGFwaU9yaWdpblVybDogJHt1cmxTdHJ9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwYXRoUGFydCA9IGZpcnN0U2xhc2hJbmRleCA+PSAwID8gd2l0aG91dFF1ZXJ5LnNsaWNlKGZpcnN0U2xhc2hJbmRleCkgOiBcIlwiO1xuICAgICAgICBjb25zdCBvcmlnaW5QYXRoID0gcGF0aFBhcnQgJiYgcGF0aFBhcnQgIT09IFwiL1wiID8gdHJpbVJlcGVhdGVkQ2hhckVuZChwYXRoUGFydCwgXCIvXCIpIDogdW5kZWZpbmVkO1xuICAgICAgICByZXR1cm4geyBkb21haW5OYW1lOiBub3JtYWxpemVkRG9tYWluUGFydCwgLi4uKG9yaWdpblBhdGggPyB7IG9yaWdpblBhdGggfSA6IHt9KSB9O1xuICAgIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3BhUmV3cml0ZU1vZGUobW9kZTogQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUgfCBzdHJpbmcgfCB1bmRlZmluZWQpOiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZSB7XG4gICAgY29uc3QgdmFsdWUgPSBTdHJpbmcobW9kZSA/PyBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5TUEEpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIHJldHVybiB2YWx1ZSA9PT0gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuTk9ORSA/IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLk5PTkUgOiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5TUEE7XG59XG4iXX0=