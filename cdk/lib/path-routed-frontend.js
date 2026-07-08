"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryPathRoutedFrontend = exports.AppTheorySpaRewriteMode = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const origins = require("aws-cdk-lib/aws-cloudfront-origins");
const route53 = require("aws-cdk-lib/aws-route53");
const targets = require("aws-cdk-lib/aws-route53-targets");
const s3 = require("aws-cdk-lib/aws-s3");
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
_a = JSII_RTTI_SYMBOL_1;
AppTheoryPathRoutedFrontend[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend", version: "1.16.1-rc" };
function normalizeSpaRewriteMode(mode) {
    const value = String(mode ?? AppTheorySpaRewriteMode.SPA).trim().toLowerCase();
    return value === AppTheorySpaRewriteMode.NONE ? AppTheorySpaRewriteMode.NONE : AppTheorySpaRewriteMode.SPA;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aC1yb3V0ZWQtZnJvbnRlbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXRoLXJvdXRlZC1mcm9udGVuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUEwRDtBQUMxRCwwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUM5RCxtREFBbUQ7QUFDbkQsMkRBQTJEO0FBQzNELHlDQUF5QztBQUN6QywyQ0FBdUM7QUFFdkMseURBQWdGO0FBRWhGLFNBQVMsMkNBQTJDLENBQUMsS0FBZ0IsRUFBRSxhQUFxQjtJQUN4RixNQUFNLE1BQU0sR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDdEMsSUFBSSxDQUFDLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQU0sS0FBSyxXQUFXLEVBQUUsQ0FBQztRQUN4RCxPQUFPO0lBQ1gsQ0FBQztJQUVELE1BQU0saUJBQWlCLEdBQUcsbUJBQUssQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQzdFLE1BQU0sSUFBSSxLQUFLLENBQ1gsR0FBRyxhQUFhLHdIQUF3SCxpQkFBaUIsNEdBQTRHLENBQ3hRLENBQUM7QUFDTixDQUFDO0FBRUQsSUFBWSx1QkFVWDtBQVZELFdBQVksdUJBQXVCO0lBQy9COztPQUVHO0lBQ0gsc0NBQVcsQ0FBQTtJQUVYOztPQUVHO0lBQ0gsd0NBQWEsQ0FBQTtBQUNqQixDQUFDLEVBVlcsdUJBQXVCLHVDQUF2Qix1QkFBdUIsUUFVbEM7QUFxTkQ7OztHQUdHO0FBQ0gsU0FBUyw4QkFBOEIsQ0FDbkMsVUFBNkI7SUFFN0IsTUFBTSxPQUFPLEdBQUcsVUFBVTtTQUNyQixHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRTtRQUNULE1BQU0sV0FBVyxHQUFHLEdBQUcsQ0FBQyxXQUFXLENBQUMs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LFVBQVUsRUFBRSxvQkFBb0IsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLFVBQVUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDO0lBQ3ZGLENBQUM7O0FBbFBMLGtFQW1QQzs7O0FBRUQsU0FBUyx1QkFBdUIsQ0FBQyxJQUFrRDtJQUMvRSxNQUFNLEtBQUssR0FBRyxNQUFNLENBQUMsSUFBSSxJQUFJLHVCQUF1QixDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQy9FLE9BQU8sS0FBSyxLQUFLLHVCQUF1QixDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsdUJBQXVCLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyx1QkFBdUIsQ0FBQyxHQUFHLENBQUM7QUFDL0csQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IHN0cmlwVHJhaWxpbmdQb3J0LCB0cmltUmVwZWF0ZWRDaGFyRW5kIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdHJpbmctdXRpbHNcIjtcblxuZnVuY3Rpb24gYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbihzY29wZTogQ29uc3RydWN0LCBjb25zdHJ1Y3ROYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCByZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgJiYgcmVnaW9uID09PSBcInVzLWVhc3QtMVwiKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCByZWdpb25EZXNjcmlwdGlvbiA9IFRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pID8gXCJ1bnJlc29sdmVkXCIgOiByZWdpb247XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgJHtjb25zdHJ1Y3ROYW1lfSBjYW5ub3QgY3JlYXRlIGEgaG9zdGVkLXpvbmUgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB1bmxlc3MgdGhlIHN0YWNrIHJlZ2lvbiBpcyBleHBsaWNpdGx5IHVzLWVhc3QtMTsgc3RhY2sgcmVnaW9uIGlzICR7cmVnaW9uRGVzY3JpcHRpb259LiBQcm92aWRlIGRvbWFpbi5jZXJ0aWZpY2F0ZSBvciBkb21haW4uY2VydGlmaWNhdGVBcm4gZm9yIHN0YWNrcyBpbiBvdGhlciBvciBlbnZpcm9ubWVudC1hZ25vc3RpYyByZWdpb25zLmAsXG4gICAgKTtcbn1cblxuZXhwb3J0IGVudW0gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUge1xuICAgIC8qKlxuICAgICAqIFJld3JpdGUgZXh0ZW5zaW9ubGVzcyByb3V0ZXMgdG8gYGluZGV4Lmh0bWxgIHdpdGhpbiB0aGUgU1BBIHByZWZpeC5cbiAgICAgKi9cbiAgICBTUEEgPSBcInNwYVwiLFxuXG4gICAgLyoqXG4gICAgICogRG8gbm90IHJld3JpdGUgcm91dGVzLiBVc2VmdWwgZm9yIG11bHRpLXBhZ2Uvc3RhdGljIHNpdGVzLlxuICAgICAqL1xuICAgIE5PTkUgPSBcIm5vbmVcIixcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBhbiBTUEEgb3JpZ2luIHJvdXRlZCBieSBwYXRoIHByZWZpeC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBTcGFPcmlnaW5Db25maWcge1xuICAgIC8qKlxuICAgICAqIFMzIGJ1Y2tldCBjb250YWluaW5nIHRoZSBTUEEgYXNzZXRzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJ1Y2tldDogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFBhdGggcGF0dGVybiB0byByb3V0ZSB0byB0aGlzIFNQQSAoZS5nLiwgXCIvbC8qXCIsIFwiL2F1dGgvKlwiKS5cbiAgICAgKiBNdXN0IGluY2x1ZGUgdGhlIHRyYWlsaW5nIHdpbGRjYXJkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHBhdGhQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBjYWNoZSBwb2xpY3kgb3ZlcnJpZGUuIERlZmF1bHRzIHRvIENBQ0hJTkdfT1BUSU1JWkVELlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSBmb3IgdGhpcyBTUEEgYmVoYXZpb3IuXG4gICAgICogT3ZlcnJpZGVzIGBzcGFSZXNwb25zZUhlYWRlcnNQb2xpY3lgIGFuZCBgcmVzcG9uc2VIZWFkZXJzUG9saWN5YCAobGVnYWN5KS5cbiAgICAgKi9cbiAgICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIHN0cmlwIHRoZSBTUEEgcHJlZml4IGJlZm9yZSBmb3J3YXJkaW5nIHRvIHRoZSBTMyBvcmlnaW4uXG4gICAgICpcbiAgICAgKiBFeGFtcGxlOlxuICAgICAqIC0gUmVxdWVzdDogYC9hdXRoL2Fzc2V0cy9hcHAuanNgXG4gICAgICogLSBXaXRoIGBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbj10cnVlYCwgUzMgcmVjZWl2ZXM6IGAvYXNzZXRzL2FwcC5qc2BcbiAgICAgKlxuICAgICAqIFRoaXMgYWxsb3dzIGxheWluZyBvdXQgdGhlIFNQQSBidWNrZXQgYXQgcm9vdCB3aGlsZSBzdGlsbCBzZXJ2aW5nIGl0IHVuZGVyIGEgcHJlZml4LlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbj86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBTUEEgcmV3cml0ZSBtb2RlLlxuICAgICAqXG4gICAgICogLSBgU1BBYDogcmV3cml0ZSBleHRlbnNpb25sZXNzIHJvdXRlcyB0byB0aGUgU1BBJ3MgYGluZGV4Lmh0bWxgXG4gICAgICogLSBgTk9ORWA6IGRvIG5vdCByZXdyaXRlIHJvdXRlcyAodXNlZnVsIGZvciBtdWx0aS1wYWdlIHNpdGVzKVxuICAgICAqXG4gICAgICogQGRlZmF1bHQgQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuU1BBXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmV3cml0ZU1vZGU/OiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZTtcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBwYXRoIHBhdHRlcm5zIHRoYXQgc2hvdWxkIGJ5cGFzcyBTUEEgcm91dGluZyBhbmQgZ28gZGlyZWN0bHkgdG8gdGhlIEFQSSBvcmlnaW4uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBpQnlwYXNzQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBQYXRoIHBhdHRlcm4gdGhhdCBzaG91bGQgcm91dGUgdG8gdGhlIEFQSSBvcmlnaW4gaW5zdGVhZCBvZiBTUEEgKGUuZy4sIFwiL2F1dGgvd2FsbGV0LypcIikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcGF0aFBhdHRlcm46IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIGNhY2hlIHBvbGljeSBvdmVycmlkZS4gRGVmYXVsdHMgdG8gQ0FDSElOR19ESVNBQkxFRC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgb3JpZ2luIHJlcXVlc3QgcG9saWN5IG92ZXJyaWRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IG9yaWdpblJlcXVlc3RQb2xpY3k/OiBjbG91ZGZyb250LklPcmlnaW5SZXF1ZXN0UG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogUmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIHRoaXMgQVBJIGJ5cGFzcyBiZWhhdmlvci5cbiAgICAgKiBPdmVycmlkZXMgYGFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeWAgYW5kIGByZXNwb25zZUhlYWRlcnNQb2xpY3lgIChsZWdhY3kpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcbn1cblxuLyoqXG4gKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFBhdGhSb3V0ZWRGcm9udGVuZERvbWFpbkNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogVGhlIGRvbWFpbiBuYW1lIGZvciB0aGUgZGlzdHJpYnV0aW9uIChlLmcuLCBcImFwcC5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIEhUVFBTLiBNdXN0IGJlIGluIHVzLWVhc3QtMSBmb3IgQ2xvdWRGcm9udC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBUk4gb2YgYW4gZXhpc3RpbmcgQUNNIGNlcnRpZmljYXRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICAgKiBXaGVuIHByb3ZpZGVkLCBhbiBBIHJlY29yZCBhbGlhcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIHRoZSBkb21haW4uXG4gICAgICpcbiAgICAgKiBJZiBgZG9tYWluTmFtZWAgaXMgc2V0IHdpdGhvdXQgYGNlcnRpZmljYXRlYCBvciBgY2VydGlmaWNhdGVBcm5gLFxuICAgICAqIGhvc3RlZC16b25lIGNlcnRpZmljYXRlIGNyZWF0aW9uIGlzIGFsbG93ZWQgb25seSBmb3Igc3RhY2tzIHdob3NlIHJlZ2lvblxuICAgICAqIGlzIGV4cGxpY2l0bHkgYHVzLWVhc3QtMWAuIENsb3VkRnJvbnQgcmVxdWlyZXMgdmlld2VyIGNlcnRpZmljYXRlcyBpblxuICAgICAqIGB1cy1lYXN0LTFgOyBlbnZpcm9ubWVudC1hZ25vc3RpYyBvciBvdGhlci1yZWdpb24gc3RhY2tzIG11c3QgcHJvdmlkZSBhblxuICAgICAqIGV4cGxpY2l0IGNlcnRpZmljYXRlIGlucHV0LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kUHJvcHMge1xuICAgIC8qKlxuICAgICAqIFRoZSBwcmltYXJ5IEFQSSBvcmlnaW4gVVJMIChlLmcuLCB0aGUgQVBJIEdhdGV3YXkgaW52b2tlIFVSTCBvciBMYW1iZGEgZnVuY3Rpb24gVVJMKS5cbiAgICAgKiBUaGlzIGlzIHVzZWQgZm9yIHRoZSBkZWZhdWx0IGJlaGF2aW9yIGFuZCBhbnkgQVBJIGJ5cGFzcyBwYXRocy5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5Vcmw6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFNQQSBvcmlnaW5zIHdpdGggdGhlaXIgcGF0aCBwYXR0ZXJucy5cbiAgICAgKiBFYWNoIFNQQSB3aWxsIGJlIHNlcnZlZCB2aWEgQ2xvdWRGcm9udCB3aXRoIFNQQSByZXdyaXRlIHN1cHBvcnQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3BhT3JpZ2lucz86IFNwYU9yaWdpbkNvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQVBJIGJ5cGFzcyBjb25maWd1cmF0aW9ucyBmb3IgcGF0aHMgdGhhdCBzaG91bGQgZ28gZGlyZWN0bHkgdG8gdGhlIEFQSSBvcmlnaW5cbiAgICAgKiBldmVuIHRob3VnaCB0aGV5IG1pZ2h0IG1hdGNoIGFuIFNQQSBwYXRoIHByZWZpeC5cbiAgICAgKiBUaGVzZSBhcmUgZXZhbHVhdGVkIGJlZm9yZSBTUEEgcGF0aHMgZHVlIHRvIENsb3VkRnJvbnQgYmVoYXZpb3IgcHJlY2VkZW5jZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlCeXBhc3NQYXRocz86IEFwaUJ5cGFzc0NvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGN1c3RvbSBkb21haW4sIGNlcnRpZmljYXRlLCBhbmQgUm91dGU1My5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBQYXRoUm91dGVkRnJvbnRlbmREb21haW5Db25maWc7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSB0byBhcHBseSB0byBhbGwgYmVoYXZpb3JzIChsZWdhY3kpLlxuICAgICAqXG4gICAgICogUHJlZmVyIHVzaW5nIGBhcGlSZXNwb25zZUhlYWRlcnNQb2xpY3lgLCBgc3BhUmVzcG9uc2VIZWFkZXJzUG9saWN5YCwgYW5kXG4gICAgICogYGFwaUJ5cGFzc1Jlc3BvbnNlSGVhZGVyc1BvbGljeWAgZm9yIGJlaGF2aW9yLXNjb3BlZCBjb250cm9sLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGZvciB0aGUgQVBJIG9yaWdpbiBkZWZhdWx0IGJlaGF2aW9yLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaVJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIFNQQSBiZWhhdmlvcnMuXG4gICAgICogQ2FuIGJlIG92ZXJyaWRkZW4gcGVyIFNQQSB2aWEgYFNwYU9yaWdpbkNvbmZpZy5yZXNwb25zZUhlYWRlcnNQb2xpY3lgLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgZm9yIEFQSSBieXBhc3MgYmVoYXZpb3JzLlxuICAgICAqIENhbiBiZSBvdmVycmlkZGVuIHBlciBieXBhc3MgdmlhIGBBcGlCeXBhc3NDb25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5YC5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlCeXBhc3NSZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBPcmlnaW4gcmVxdWVzdCBwb2xpY3kgZm9yIHRoZSBBUEkgb3JpZ2luIChkZWZhdWx0IGJlaGF2aW9yKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5SZXF1ZXN0UG9saWN5PzogY2xvdWRmcm9udC5JT3JpZ2luUmVxdWVzdFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBDbG91ZEZyb250IGFjY2VzcyBsb2dnaW5nLlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmFibGVMb2dnaW5nPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIFMzIGJ1Y2tldCBmb3IgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncy5cbiAgICAgKiBJZiBub3QgcHJvdmlkZWQgYW5kIGVuYWJsZUxvZ2dpbmcgaXMgdHJ1ZSwgYSBuZXcgYnVja2V0IHdpbGwgYmUgY3JlYXRlZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFJlbW92YWwgcG9saWN5IGZvciBjcmVhdGVkIHJlc291cmNlcy5cbiAgICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBhdXRvLWRlbGV0ZSBvYmplY3RzIGluIGNyZWF0ZWQgYnVja2V0cyBvbiBzdGFjayBkZWxldGlvbi5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiByZW1vdmFsUG9saWN5IGlzIERFU1RST1kuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhdXRvRGVsZXRlT2JqZWN0cz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCB3ZWIgQUNMIElEIGZvciBBV1MgV0FGIGludGVncmF0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHdlYkFjbElkPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUHJpY2UgY2xhc3MgZm9yIHRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICAgKiBAZGVmYXVsdCBQcmljZUNsYXNzLlBSSUNFX0NMQVNTX0FMTFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHByaWNlQ2xhc3M/OiBjbG91ZGZyb250LlByaWNlQ2xhc3M7XG5cbiAgICAvKipcbiAgICAgKiBBbiBvcHRpb25hbCBuYW1lL2NvbW1lbnQgZm9yIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgY29tbWVudD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBDbG91ZEZyb250IEZ1bmN0aW9uIGNvZGUgZm9yIFNQQSB2aWV3ZXItcmVxdWVzdCByZXdyaXRlLlxuICogUmV3cml0ZXMgcmVxdWVzdHMgd2l0aG91dCBmaWxlIGV4dGVuc2lvbnMgdG8gdGhlIGluZGV4Lmh0bWwgd2l0aGluIHRoZSBwcmVmaXguXG4gKi9cbmZ1bmN0aW9uIGdlbmVyYXRlU3BhUmV3cml0ZUZ1bmN0aW9uQ29kZShcbiAgICBzcGFPcmlnaW5zOiBTcGFPcmlnaW5Db25maWdbXSxcbik6IHN0cmluZyB7XG4gICAgY29uc3QgY29uZmlncyA9IHNwYU9yaWdpbnNcbiAgICAgICAgLm1hcCgoc3BhKSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjbGVhblByZWZpeCA9IHNwYS5wYXRoUGF0dGVybi5yZXBsYWNlKC9cXC9cXCokLywgXCJcIik7XG4gICAgICAgICAgICBjb25zdCBwcmVmaXggPSBgJHtjbGVhblByZWZpeH0vYDtcbiAgICAgICAgICAgIGNvbnN0IHJld3JpdGVNb2RlID0gbm9ybWFsaXplU3BhUmV3cml0ZU1vZGUoc3BhLnJld3JpdGVNb2RlKTtcbiAgICAgICAgICAgIGNvbnN0IHN0cmlwUHJlZml4QmVmb3JlT3JpZ2luID0gc3BhLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2luID09PSB0cnVlO1xuICAgICAgICAgICAgY29uc3QgaW5kZXhQYXRoID0gYCR7Y2xlYW5QcmVmaXh9L2luZGV4Lmh0bWxgO1xuICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICBjbGVhblByZWZpeCxcbiAgICAgICAgICAgICAgICBwcmVmaXgsXG4gICAgICAgICAgICAgICAgcmV3cml0ZU1vZGUsXG4gICAgICAgICAgICAgICAgc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW4sXG4gICAgICAgICAgICAgICAgaW5kZXhQYXRoLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfSlcbiAgICAgICAgLy8gRW5zdXJlIG1vcmUgc3BlY2lmaWMgcHJlZml4ZXMgbWF0Y2ggZmlyc3QgdG8gYXZvaWQgb3ZlcmxhcCBpc3N1ZXMuXG4gICAgICAgIC5zb3J0KChhLCBiKSA9PiBiLmNsZWFuUHJlZml4Lmxlbmd0aCAtIGEuY2xlYW5QcmVmaXgubGVuZ3RoKTtcblxuICAgIGNvbnN0IHByZWZpeE1hdGNoZXMgPSBjb25maWdzXG4gICAgICAgIC5tYXAoKGNmZykgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIGB7IGNsZWFuUHJlZml4OiAnJHtjZmcuY2xlYW5QcmVmaXh9JywgcHJlZml4OiAnJHtjZmcucHJlZml4fScsIHJld3JpdGVNb2RlOiAnJHtjZmcucmV3cml0ZU1vZGV9Jywgc3RyaXBQcmVmaXhCZWZvcmVPcmlnaW46ICR7Y2ZnLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2lufSwgaW5kZXhQYXRoOiAnJHtjZmcuaW5kZXhQYXRofScgfWA7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKFwiLFxcbiAgICAgIFwiKTtcblxuICAgIHJldHVybiBgXG5cdGZ1bmN0aW9uIGhhbmRsZXIoZXZlbnQpIHtcblx0ICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG5cdCAgdmFyIHVyaSA9IHJlcXVlc3QudXJpO1xuXG5cdCAgLy8gU1BBIHByZWZpeCBjb25maWd1cmF0aW9uc1xuXHQgIHZhciBzcGFQcmVmaXhlcyA9IFtcblx0ICAgICAgJHtwcmVmaXhNYXRjaGVzfVxuXHQgIF07XG5cblx0ICAvLyBDaGVjayBpZiB0aGlzIGlzIGFuIFNQQSBwYXRoXG5cdCAgZm9yICh2YXIgaSA9IDA7IGkgPCBzcGFQcmVmaXhlcy5sZW5ndGg7IGkrKykge1xuXHQgICAgdmFyIHNwYSA9IHNwYVByZWZpeGVzW2ldO1xuXHQgICAgaWYgKHVyaS5zdGFydHNXaXRoKHNwYS5wcmVmaXgpKSB7XG5cdCAgICAgIHZhciB1cmlXaXRob3V0UHJlZml4ID0gdXJpLnN1YnN0cmluZyhzcGEucHJlZml4Lmxlbmd0aCk7XG5cblx0ICAgICAgaWYgKHNwYS5yZXdyaXRlTW9kZSA9PT0gJ3NwYScpIHtcblx0ICAgICAgICAvLyBJZiB0aGUgVVJJIGRvZXNuJ3QgaGF2ZSBhbiBleHRlbnNpb24gKG5vIGZpbGUpLCByZXdyaXRlIHRvIGluZGV4Lmh0bWxcblx0ICAgICAgICAvLyBDaGVjayBpZiBpdCBoYXMgYSBmaWxlIGV4dGVuc2lvbiAoY29udGFpbnMgYSBkb3QgaW4gdGhlIGxhc3QgcGF0aCBzZWdtZW50KVxuXHQgICAgICAgIHZhciBsYXN0U2xhc2ggPSB1cmlXaXRob3V0UHJlZml4Lmxhc3RJbmRleE9mKCcvJyk7XG5cdCAgICAgICAgdmFyIGxhc3RTZWdtZW50ID0gbGFzdFNsYXNoID49IDAgPyB1cmlXaXRob3V0UHJlZml4LnN1YnN0cmluZyhsYXN0U2xhc2ggKyAxKSA6IHVyaVdpdGhvdXRQcmVmaXg7XG5cdCAgICAgICAgXG5cdCAgICAgICAgLy8gSWYgbm8gZXh0ZW5zaW9uIGluIHRoZSBsYXN0IHNlZ21lbnQsIHNlcnZlIGluZGV4Lmh0bWxcblx0ICAgICAgICBpZiAobGFzdFNlZ21lbnQuaW5kZXhPZignLicpID09PSAtMSkge1xuXHQgICAgICAgICAgcmVxdWVzdC51cmkgPSBzcGEuaW5kZXhQYXRoO1xuXHQgICAgICAgIH1cblx0ICAgICAgfVxuXG5cdCAgICAgIC8vIE9wdGlvbmFsbHkgc3RyaXAgdGhlIHByZWZpeCBiZWZvcmUgZm9yd2FyZGluZyB0byB0aGUgb3JpZ2luLlxuXHQgICAgICBpZiAoc3BhLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2luKSB7XG5cdCAgICAgICAgdmFyIGNsZWFuUHJlZml4V2l0aFNsYXNoID0gc3BhLmNsZWFuUHJlZml4ICsgJy8nO1xuXHQgICAgICAgIGlmIChyZXF1ZXN0LnVyaS5zdGFydHNXaXRoKGNsZWFuUHJlZml4V2l0aFNsYXNoKSkge1xuXHQgICAgICAgICAgcmVxdWVzdC51cmkgPSByZXF1ZXN0LnVyaS5zdWJzdHJpbmcoc3BhLmNsZWFuUHJlZml4Lmxlbmd0aCk7XG5cdCAgICAgICAgfVxuXHQgICAgICB9XG5cdCAgICAgIGJyZWFrO1xuXHQgICAgfVxuXHQgIH1cblxuXHQgIHJldHVybiByZXF1ZXN0O1xuXHR9XG5cdGAudHJpbSgpO1xufVxuXG4vKipcbiAqIEEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZm9yIHBhdGgtcm91dGVkIG11bHRpLVNQQSArIEFQSSBkZXBsb3ltZW50cy5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBjcmVhdGVzIGEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gdGhhdCByb3V0ZXMgcmVxdWVzdHMgdG86XG4gKiAtIFNQQSBvcmlnaW5zIChTMyBidWNrZXRzKSBiYXNlZCBvbiBwYXRoIHByZWZpeGVzIChlLmcuLCAvbC8qLCAvYXV0aC8qKVxuICogLSBBUEkgb3JpZ2luIChkZWZhdWx0IGJlaGF2aW9yKSBmb3IgYWxsIG90aGVyIHBhdGhzXG4gKiAtIEFQSSBieXBhc3MgcGF0aHMgZm9yIHNwZWNpZmljIHBhdGhzIHRoYXQgc2hvdWxkIHNraXAgU1BBIHJvdXRpbmdcbiAqXG4gKiBBIENsb3VkRnJvbnQgRnVuY3Rpb24gaGFuZGxlcyB2aWV3ZXItcmVxdWVzdCByZXdyaXRpbmcgZm9yIFNQQSByb3V0aW5nLFxuICogZW5zdXJpbmcgdGhhdCBwYXRocyB3aXRob3V0IGZpbGUgZXh0ZW5zaW9ucyBhcmUgcmV3cml0dGVuIHRvIGluZGV4Lmh0bWwuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IEZ1bmN0aW9uIGZvciBTUEEgcmV3cml0ZSAoaWYgU1BBIG9yaWdpbnMgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBzcGFSZXdyaXRlRnVuY3Rpb24/OiBjbG91ZGZyb250LkZ1bmN0aW9uO1xuXG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgYnVja2V0IChpZiBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjZXJ0aWZpY2F0ZSB1c2VkIGZvciB0aGUgZGlzdHJpYnV0aW9uIChpZiBjdXN0b20gZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kUHJvcHMpIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICBpZiAoIXByb3BzLmFwaU9yaWdpblVybCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIHJlcXVpcmVzIHByb3BzLmFwaU9yaWdpblVybFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgICAgICBjb25zdCBhdXRvRGVsZXRlT2JqZWN0cyA9IHByb3BzLmF1dG9EZWxldGVPYmplY3RzID8/IGZhbHNlO1xuICAgICAgICBjb25zdCBlbmFibGVMb2dnaW5nID0gcHJvcHMuZW5hYmxlTG9nZ2luZyA/PyB0cnVlO1xuXG4gICAgICAgIC8vIENyZWF0ZSBsb2dzIGJ1Y2tldCBpZiBsb2dnaW5nIGlzIGVuYWJsZWRcbiAgICAgICAgaWYgKGVuYWJsZUxvZ2dpbmcpIHtcbiAgICAgICAgICAgIHRoaXMubG9nc0J1Y2tldCA9XG4gICAgICAgICAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICAgICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICAgICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICAgICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgICAgICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBQYXJzZSB0aGUgQVBJIG9yaWdpbiBVUkwgdG8gY3JlYXRlIGFuIEh0dHBPcmlnaW4gKGRvbWFpbiArIG9wdGlvbmFsIG9yaWdpblBhdGgpXG4gICAgICAgIGNvbnN0IGFwaU9yaWdpblBhcnNlZCA9IHRoaXMucGFyc2VPcmlnaW5Gcm9tVXJsKHByb3BzLmFwaU9yaWdpblVybCk7XG4gICAgICAgIGNvbnN0IGFwaU9yaWdpbiA9IG5ldyBvcmlnaW5zLkh0dHBPcmlnaW4oYXBpT3JpZ2luUGFyc2VkLmRvbWFpbk5hbWUsIHtcbiAgICAgICAgICAgIHByb3RvY29sUG9saWN5OiBjbG91ZGZyb250Lk9yaWdpblByb3RvY29sUG9saWN5LkhUVFBTX09OTFksXG4gICAgICAgICAgICAuLi4oYXBpT3JpZ2luUGFyc2VkLm9yaWdpblBhdGggPyB7IG9yaWdpblBhdGg6IGFwaU9yaWdpblBhcnNlZC5vcmlnaW5QYXRoIH0gOiB7fSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEhhbmRsZSBkb21haW4gY29uZmlndXJhdGlvblxuICAgICAgICBsZXQgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuICAgICAgICBsZXQgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGUgfCB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgICAgICAgY29uc3QgZG9tYWluTmFtZSA9IFN0cmluZyhwcm9wcy5kb21haW4uZG9tYWluTmFtZSkudHJpbSgpO1xuICAgICAgICAgICAgaWYgKGRvbWFpbk5hbWUpIHtcbiAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25Eb21haW5OYW1lcyA9IFtkb21haW5OYW1lXTtcblxuICAgICAgICAgICAgICAgIGlmIChwcm9wcy5kb21haW4uY2VydGlmaWNhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBwcm9wcy5kb21haW4uY2VydGlmaWNhdGU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4pIHtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcyxcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZUFybixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmRvbWFpbi5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydENsb3VkRnJvbnRIb3N0ZWRab25lQ2VydGlmaWNhdGVSZWdpb24odGhpcywgXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmRcIik7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uOiBhY20uQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnMocHJvcHMuZG9tYWluLmhvc3RlZFpvbmUpLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCByZXF1aXJlcyBkb21haW4uY2VydGlmaWNhdGUsIGRvbWFpbi5jZXJ0aWZpY2F0ZUFybiwgb3IgZG9tYWluLmhvc3RlZFpvbmUgd2hlbiBkb21haW4uZG9tYWluTmFtZSBpcyBzZXRcIixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmNlcnRpZmljYXRlID0gZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU7XG5cbiAgICAgICAgLy8gQ3JlYXRlIENsb3VkRnJvbnQgRnVuY3Rpb24gZm9yIFNQQSByZXdyaXRlIGlmIFNQQSBvcmlnaW5zIGFyZSBjb25maWd1cmVkXG4gICAgICAgIGNvbnN0IHNwYU9yaWdpbnMgPSBwcm9wcy5zcGFPcmlnaW5zID8/IFtdO1xuICAgICAgICBpZiAoXG4gICAgICAgICAgICBzcGFPcmlnaW5zLnNvbWUoKHNwYSkgPT4ge1xuICAgICAgICAgICAgICAgIGNvbnN0IHJld3JpdGVNb2RlID0gbm9ybWFsaXplU3BhUmV3cml0ZU1vZGUoc3BhLnJld3JpdGVNb2RlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmV3cml0ZU1vZGUgIT09IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLk5PTkUgfHwgc3BhLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2luID09PSB0cnVlO1xuICAgICAgICAgICAgfSlcbiAgICAgICAgKSB7XG4gICAgICAgICAgICBjb25zdCBmdW5jdGlvbkNvZGUgPSBnZW5lcmF0ZVNwYVJld3JpdGVGdW5jdGlvbkNvZGUoc3BhT3JpZ2lucyk7XG5cbiAgICAgICAgICAgIHRoaXMuc3BhUmV3cml0ZUZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTcGFSZXdyaXRlRnVuY3Rpb25cIiwge1xuICAgICAgICAgICAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoZnVuY3Rpb25Db2RlKSxcbiAgICAgICAgICAgICAgICBydW50aW1lOiBjbG91ZGZyb250LkZ1bmN0aW9uUnVudGltZS5KU18yXzAsXG4gICAgICAgICAgICAgICAgY29tbWVudDogXCJTUEEgdmlld2VyLXJlcXVlc3QgcmV3cml0ZSBmb3IgcGF0aC1yb3V0ZWQgZnJvbnRlbmRcIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQnVpbGQgYWRkaXRpb25hbCBiZWhhdmlvcnNcbiAgICAgICAgY29uc3QgYWRkaXRpb25hbEJlaGF2aW9yczogUmVjb3JkPHN0cmluZywgY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnM+ID0ge307XG5cbiAgICAgICAgLy8gQWRkIEFQSSBieXBhc3MgcGF0aHMgZmlyc3QgKGhpZ2hlciBwcmVjZWRlbmNlIGluIENsb3VkRnJvbnQpXG4gICAgICAgIGZvciAoY29uc3QgYnlwYXNzQ29uZmlnIG9mIHByb3BzLmFwaUJ5cGFzc1BhdGhzID8/IFtdKSB7XG4gICAgICAgICAgICBjb25zdCByZXNwb25zZUhlYWRlcnNQb2xpY3kgPVxuICAgICAgICAgICAgICAgIGJ5cGFzc0NvbmZpZy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgICAgICAgICAgICBwcm9wcy5hcGlCeXBhc3NSZXNwb25zZUhlYWRlcnNQb2xpY3kgPz9cbiAgICAgICAgICAgICAgICBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAgICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbYnlwYXNzQ29uZmlnLnBhdGhQYXR0ZXJuXSA9IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IGFwaU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGJ5cGFzc0NvbmZpZy5jYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTpcbiAgICAgICAgICAgICAgICAgICAgYnlwYXNzQ29uZmlnLm9yaWdpblJlcXVlc3RQb2xpY3kgPz8gcHJvcHMuYXBpT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgICAgICAgICAgICAuLi4ocmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBZGQgU1BBIG9yaWdpbiBiZWhhdmlvcnNcbiAgICAgICAgZm9yIChjb25zdCBzcGFDb25maWcgb2Ygc3BhT3JpZ2lucykge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgICAgICAgICAgICBzcGFDb25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMuc3BhUmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuICAgICAgICAgICAgY29uc3QgcmV3cml0ZU1vZGUgPSBub3JtYWxpemVTcGFSZXdyaXRlTW9kZShzcGFDb25maWcucmV3cml0ZU1vZGUpO1xuICAgICAgICAgICAgY29uc3QgbmVlZHNGdW5jdGlvbiA9XG4gICAgICAgICAgICAgICAgdGhpcy5zcGFSZXdyaXRlRnVuY3Rpb24gJiZcbiAgICAgICAgICAgICAgICAocmV3cml0ZU1vZGUgIT09IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLk5PTkUgfHwgc3BhQ29uZmlnLnN0cmlwUHJlZml4QmVmb3JlT3JpZ2luID09PSB0cnVlKTtcblxuICAgICAgICAgICAgY29uc3Qgc3BhT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbChzcGFDb25maWcuYnVja2V0KTtcblxuICAgICAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9yc1tzcGFDb25maWcucGF0aFBhdHRlcm5dID0ge1xuICAgICAgICAgICAgICAgIG9yaWdpbjogc3BhT3JpZ2luLFxuICAgICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IHNwYUNvbmZpZy5jYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfT1BUSU1JWkVELFxuICAgICAgICAgICAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgICAgICAgICAgIC4uLihuZWVkc0Z1bmN0aW9uXG4gICAgICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uOiB0aGlzLnNwYVJld3JpdGVGdW5jdGlvbixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgIC4uLihyZXNwb25zZUhlYWRlcnNQb2xpY3lcbiAgICAgICAgICAgICAgICAgICAgPyB7IHJlc3BvbnNlSGVhZGVyc1BvbGljeSB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZGlzdHJpYnV0aW9uXG4gICAgICAgIGNvbnN0IGRlZmF1bHRSZXNwb25zZUhlYWRlcnNQb2xpY3kgPVxuICAgICAgICAgICAgcHJvcHMuYXBpUmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAgICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgXCJEaXN0cmlidXRpb25cIiwge1xuICAgICAgICAgICAgLi4uKGVuYWJsZUxvZ2dpbmcgJiYgdGhpcy5sb2dzQnVja2V0XG4gICAgICAgICAgICAgICAgPyB7IGVuYWJsZUxvZ2dpbmc6IHRydWUsIGxvZ0J1Y2tldDogdGhpcy5sb2dzQnVja2V0LCBsb2dGaWxlUHJlZml4OiBcImNsb3VkZnJvbnQvXCIgfVxuICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgLi4uKGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzICYmIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlXG4gICAgICAgICAgICAgICAgPyB7IGRvbWFpbk5hbWVzOiBkaXN0cmlidXRpb25Eb21haW5OYW1lcywgY2VydGlmaWNhdGU6IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIGRlZmF1bHRCZWhhdmlvcjoge1xuICAgICAgICAgICAgICAgIG9yaWdpbjogYXBpT3JpZ2luLFxuICAgICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgICAgICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IHByb3BzLmFwaU9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgICAgICAgICAgLi4uKGRlZmF1bHRSZXNwb25zZUhlYWRlcnNQb2xpY3lcbiAgICAgICAgICAgICAgICAgICAgPyB7IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogZGVmYXVsdFJlc3BvbnNlSGVhZGVyc1BvbGljeSB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnMsXG4gICAgICAgICAgICAuLi4ocHJvcHMud2ViQWNsSWQgPyB7IHdlYkFjbElkOiBwcm9wcy53ZWJBY2xJZCB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLnByaWNlQ2xhc3MgPyB7IHByaWNlQ2xhc3M6IHByb3BzLnByaWNlQ2xhc3MgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5jb21tZW50ID8geyBjb21tZW50OiBwcm9wcy5jb21tZW50IH0gOiB7fSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIENyZWF0ZSBSb3V0ZTUzIEEgcmVjb3JkIGlmIGhvc3RlZCB6b25lIGlzIHByb3ZpZGVkXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4/LmRvbWFpbk5hbWUgJiYgcHJvcHMuZG9tYWluPy5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgICAgICAgIHpvbmU6IHByb3BzLmRvbWFpbi5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbi5kb21haW5OYW1lLFxuICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNyZWF0ZUFBQUFSZWNvcmQgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBuZXcgcm91dGU1My5BYWFhUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRBQUFBXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbi5kb21haW5OYW1lLFxuICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0cyB0aGUgZG9tYWluIG5hbWUgZnJvbSBhIFVSTCAoZS5nLiwgXCJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wYXRoXCIgLT4gXCJhcGkuZXhhbXBsZS5jb21cIikuXG4gICAgICovXG4gICAgcHJpdmF0ZSBwYXJzZU9yaWdpbkZyb21VcmwodXJsOiBzdHJpbmcpOiB7IGRvbWFpbk5hbWU6IHN0cmluZzsgb3JpZ2luUGF0aD86IHN0cmluZyB9IHtcbiAgICAgICAgY29uc3QgdXJsU3RyID0gU3RyaW5nKHVybCA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgIGlmICghdXJsU3RyKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgcmVxdWlyZXMgYSBub24tZW1wdHkgYXBpT3JpZ2luVXJsXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRnVsbCBVUkwgKHJlY29tbWVuZGVkKTogaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJvZFxuICAgICAgICBpZiAodXJsU3RyLmluY2x1ZGVzKFwiOi8vXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBwYXJzZWQgPSBuZXcgVVJMKHVybFN0cik7XG4gICAgICAgICAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHBhcnNlZC5ob3N0bmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoIWRvbWFpbk5hbWUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBjb3VsZCBub3QgcGFyc2UgZG9tYWluIGZyb20gYXBpT3JpZ2luVXJsOiAke3VybFN0cn1gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcGF0aCA9IFN0cmluZyhwYXJzZWQucGF0aG5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgICAgICAgICAgY29uc3Qgb3JpZ2luUGF0aCA9IHBhdGggJiYgcGF0aCAhPT0gXCIvXCIgPyB0cmltUmVwZWF0ZWRDaGFyRW5kKHBhdGgsIFwiL1wiKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgICAgIHJldHVybiB7IGRvbWFpbk5hbWUsIC4uLihvcmlnaW5QYXRoID8geyBvcmlnaW5QYXRoIH0gOiB7fSkgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEJhcmUgZG9tYWluIChvciBkb21haW4gKyBwYXRoKTogYXBpLmV4YW1wbGUuY29tIG9yIGFwaS5leGFtcGxlLmNvbS9wcm9kXG4gICAgICAgIGNvbnN0IHdpdGhvdXRRdWVyeSA9IHVybFN0ci5zcGxpdChcIj9cIilbMF0/LnNwbGl0KFwiI1wiKVswXSA/PyB1cmxTdHI7XG4gICAgICAgIGNvbnN0IGZpcnN0U2xhc2hJbmRleCA9IHdpdGhvdXRRdWVyeS5pbmRleE9mKFwiL1wiKTtcbiAgICAgICAgY29uc3QgZG9tYWluUGFydCA9IChmaXJzdFNsYXNoSW5kZXggPj0gMCA/IHdpdGhvdXRRdWVyeS5zbGljZSgwLCBmaXJzdFNsYXNoSW5kZXgpIDogd2l0aG91dFF1ZXJ5KVxuICAgICAgICAgICAgLnRyaW0oKTtcbiAgICAgICAgY29uc3Qgbm9ybWFsaXplZERvbWFpblBhcnQgPSBzdHJpcFRyYWlsaW5nUG9ydChkb21haW5QYXJ0KTtcbiAgICAgICAgaWYgKCFub3JtYWxpemVkRG9tYWluUGFydCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgY291bGQgbm90IHBhcnNlIGRvbWFpbiBmcm9tIGFwaU9yaWdpblVybDogJHt1cmxTdHJ9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBwYXRoUGFydCA9IGZpcnN0U2xhc2hJbmRleCA+PSAwID8gd2l0aG91dFF1ZXJ5LnNsaWNlKGZpcnN0U2xhc2hJbmRleCkgOiBcIlwiO1xuICAgICAgICBjb25zdCBvcmlnaW5QYXRoID0gcGF0aFBhcnQgJiYgcGF0aFBhcnQgIT09IFwiL1wiID8gdHJpbVJlcGVhdGVkQ2hhckVuZChwYXRoUGFydCwgXCIvXCIpIDogdW5kZWZpbmVkO1xuICAgICAgICByZXR1cm4geyBkb21haW5OYW1lOiBub3JtYWxpemVkRG9tYWluUGFydCwgLi4uKG9yaWdpblBhdGggPyB7IG9yaWdpblBhdGggfSA6IHt9KSB9O1xuICAgIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3BhUmV3cml0ZU1vZGUobW9kZTogQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUgfCBzdHJpbmcgfCB1bmRlZmluZWQpOiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZSB7XG4gICAgY29uc3QgdmFsdWUgPSBTdHJpbmcobW9kZSA/PyBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5TUEEpLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xuICAgIHJldHVybiB2YWx1ZSA9PT0gQXBwVGhlb3J5U3BhUmV3cml0ZU1vZGUuTk9ORSA/IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLk5PTkUgOiBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5TUEE7XG59XG4iXX0=