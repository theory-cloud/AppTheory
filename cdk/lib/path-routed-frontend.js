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
        const rewriteMode = spa.rewriteMode ?? AppTheorySpaRewriteMode.SPA;
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
                    // Create a DNS-validated certificate
                    distributionCertificate = new acm.DnsValidatedCertificate(this, "Certificate", {
                        domainName,
                        hostedZone: props.domain.hostedZone,
                        region: "us-east-1",
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
            const rewriteMode = spa.rewriteMode ?? AppTheorySpaRewriteMode.SPA;
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
            const rewriteMode = spaConfig.rewriteMode ?? AppTheorySpaRewriteMode.SPA;
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
AppTheoryPathRoutedFrontend[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend", version: "0.22.1" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aC1yb3V0ZWQtZnJvbnRlbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXRoLXJvdXRlZC1mcm9udGVuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUE0QztBQUM1QywwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUM5RCxtREFBbUQ7QUFDbkQsMkRBQTJEO0FBQzNELHlDQUF5QztBQUN6QywyQ0FBdUM7QUFFdkMseURBQWdGO0FBRWhGLElBQVksdUJBVVg7QUFWRCxXQUFZLHVCQUF1QjtJQUMvQjs7T0FFRztJQUNILHNDQUFXLENBQUE7SUFFWDs7T0FFRztJQUNILHdDQUFhLENBQUE7QUFDakIsQ0FBQyxFQVZXLHVCQUF1Qix1Q0FBdkIsdUJBQXVCLFFBVWxDO0FBK01EOzs7R0FHRztBQUNILFNBQVMsOEJBQThCLENBQ25DLFVBQTZCO0lBRTdCLE1BQU0sT0FBTyxHQUFHLFVBQVU7U0FDckIsR0FBRyxDQUFDLENBQUMsR0FBRyxFQUFFLEVBQUU7UUFDVCxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUMsV0FBVyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDekQsTUFBTSxNQUFNLEdBQUcsR0FBRyxXQUFXLEdBQUcsQ0FBQztRQUNqQyxNQUFNLFdBQVcsR0FBRyxHQUFHLENBQUMsV0FBVyxJQUFJLHVCQUF1QixDQUFDLEdBQUcsQ0FBQztRQUNuRSxNQUFNLHVCQUF1QixHQUFHLEdBQUcsQ0FBQyx1QkFBdUIsS0FBSyxJQUFJLENBQUM7UUFDckUsTUFBTSxTQUFTLEdBQUcsR0FBRyxXQUFXLGFBQWEsQ0FBQztRQUM5QyxPQUFPO1lBQ0gsV0FBVztZQUNYLE1BQU07WUFDTixXQUFXO1lBQ1gsdUJBQXVCO1lBQ3ZCLFNBQVM7U0FDWixDQUFDO0lBQ04sQ0FBQyxDQUFDO1FBQ0YscUVBQXFFO1NBQ3BFLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsRUFB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Q0FBQyxDQUFDLFlBQVksQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLGVBQWUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUM7YUFDNUYsSUFBSSxFQUFFLENBQUM7UUFDWixNQUFNLG9CQUFvQixHQUFHLElBQUEsZ0NBQWlCLEVBQUMsVUFBVSxDQUFDLENBQUM7UUFDM0QsSUFBSSxDQUFDLG9CQUFvQixFQUFFLENBQUM7WUFDeEIsTUFBTSxJQUFJLEtBQUssQ0FBQyx5RUFBeUUsTUFBTSxFQUFFLENBQUMsQ0FBQztRQUN2RyxDQUFDO1FBRUQsTUFBTSxRQUFRLEdBQUcsZUFBZSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ2pGLE1BQU0sVUFBVSxHQUFHLFFBQVEsSUFBSSxRQUFRLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFBLGtDQUFtQixFQUFDLFFBQVEsRUFBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO1FBQ2pHLE9BQU8sRUFBRSxVQUFVLEVBQUUsb0JBQW9CLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsRUFBRSxVQUFVLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUN2RixDQUFDOztBQW5QTCxrRUFvUEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgc3RyaXBUcmFpbGluZ1BvcnQsIHRyaW1SZXBlYXRlZENoYXJFbmQgfSBmcm9tIFwiLi9wcml2YXRlL3N0cmluZy11dGlsc1wiO1xuXG5leHBvcnQgZW51bSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZSB7XG4gICAgLyoqXG4gICAgICogUmV3cml0ZSBleHRlbnNpb25sZXNzIHJvdXRlcyB0byBgaW5kZXguaHRtbGAgd2l0aGluIHRoZSBTUEEgcHJlZml4LlxuICAgICAqL1xuICAgIFNQQSA9IFwic3BhXCIsXG5cbiAgICAvKipcbiAgICAgKiBEbyBub3QgcmV3cml0ZSByb3V0ZXMuIFVzZWZ1bCBmb3IgbXVsdGktcGFnZS9zdGF0aWMgc2l0ZXMuXG4gICAgICovXG4gICAgTk9ORSA9IFwibm9uZVwiLFxufVxuXG4vKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIGFuIFNQQSBvcmlnaW4gcm91dGVkIGJ5IHBhdGggcHJlZml4LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFNwYU9yaWdpbkNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogUzMgYnVja2V0IGNvbnRhaW5pbmcgdGhlIFNQQSBhc3NldHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYnVja2V0OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogUGF0aCBwYXR0ZXJuIHRvIHJvdXRlIHRvIHRoaXMgU1BBIChlLmcuLCBcIi9sLypcIiwgXCIvYXV0aC8qXCIpLlxuICAgICAqIE11c3QgaW5jbHVkZSB0aGUgdHJhaWxpbmcgd2lsZGNhcmQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcGF0aFBhdHRlcm46IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIGNhY2hlIHBvbGljeSBvdmVycmlkZS4gRGVmYXVsdHMgdG8gQ0FDSElOR19PUFRJTUlaRUQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGZvciB0aGlzIFNQQSBiZWhhdmlvci5cbiAgICAgKiBPdmVycmlkZXMgYHNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeWAgYW5kIGByZXNwb25zZUhlYWRlcnNQb2xpY3lgIChsZWdhY3kpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gc3RyaXAgdGhlIFNQQSBwcmVmaXggYmVmb3JlIGZvcndhcmRpbmcgdG8gdGhlIFMzIG9yaWdpbi5cbiAgICAgKlxuICAgICAqIEV4YW1wbGU6XG4gICAgICogLSBSZXF1ZXN0OiBgL2F1dGgvYXNzZXRzL2FwcC5qc2BcbiAgICAgKiAtIFdpdGggYHN0cmlwUHJlZml4QmVmb3JlT3JpZ2luPXRydWVgLCBTMyByZWNlaXZlczogYC9hc3NldHMvYXBwLmpzYFxuICAgICAqXG4gICAgICogVGhpcyBhbGxvd3MgbGF5aW5nIG91dCB0aGUgU1BBIGJ1Y2tldCBhdCByb290IHdoaWxlIHN0aWxsIHNlcnZpbmcgaXQgdW5kZXIgYSBwcmVmaXguXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IHN0cmlwUHJlZml4QmVmb3JlT3JpZ2luPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIFNQQSByZXdyaXRlIG1vZGUuXG4gICAgICpcbiAgICAgKiAtIGBTUEFgOiByZXdyaXRlIGV4dGVuc2lvbmxlc3Mgcm91dGVzIHRvIHRoZSBTUEEncyBgaW5kZXguaHRtbGBcbiAgICAgKiAtIGBOT05FYDogZG8gbm90IHJld3JpdGUgcm91dGVzICh1c2VmdWwgZm9yIG11bHRpLXBhZ2Ugc2l0ZXMpXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5TUEFcbiAgICAgKi9cbiAgICByZWFkb25seSByZXdyaXRlTW9kZT86IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlO1xufVxuXG4vKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIHBhdGggcGF0dGVybnMgdGhhdCBzaG91bGQgYnlwYXNzIFNQQSByb3V0aW5nIGFuZCBnbyBkaXJlY3RseSB0byB0aGUgQVBJIG9yaWdpbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcGlCeXBhc3NDb25maWcge1xuICAgIC8qKlxuICAgICAqIFBhdGggcGF0dGVybiB0aGF0IHNob3VsZCByb3V0ZSB0byB0aGUgQVBJIG9yaWdpbiBpbnN0ZWFkIG9mIFNQQSAoZS5nLiwgXCIvYXV0aC93YWxsZXQvKlwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBwYXRoUGF0dGVybjogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgY2FjaGUgcG9saWN5IG92ZXJyaWRlLiBEZWZhdWx0cyB0byBDQUNISU5HX0RJU0FCTEVELlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBvcmlnaW4gcmVxdWVzdCBwb2xpY3kgb3ZlcnJpZGUuXG4gICAgICovXG4gICAgcmVhZG9ubHkgb3JpZ2luUmVxdWVzdFBvbGljeT86IGNsb3VkZnJvbnQuSU9yaWdpblJlcXVlc3RQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSBmb3IgdGhpcyBBUEkgYnlwYXNzIGJlaGF2aW9yLlxuICAgICAqIE92ZXJyaWRlcyBgYXBpQnlwYXNzUmVzcG9uc2VIZWFkZXJzUG9saWN5YCBhbmQgYHJlc3BvbnNlSGVhZGVyc1BvbGljeWAgKGxlZ2FjeSkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xufVxuXG4vKipcbiAqIERvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUGF0aFJvdXRlZEZyb250ZW5kRG9tYWluQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBUaGUgZG9tYWluIG5hbWUgZm9yIHRoZSBkaXN0cmlidXRpb24gKGUuZy4sIFwiYXBwLmV4YW1wbGUuY29tXCIpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgSFRUUFMuIE11c3QgYmUgaW4gdXMtZWFzdC0xIGZvciBDbG91ZEZyb250LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIEFSTiBvZiBhbiBleGlzdGluZyBBQ00gY2VydGlmaWNhdGUuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgICAqIFdoZW4gcHJvdmlkZWQsIGFuIEEgcmVjb3JkIGFsaWFzIHdpbGwgYmUgY3JlYXRlZCBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gY3JlYXRlIGFuIEFBQUEgYWxpYXMgcmVjb3JkIGluIGFkZGl0aW9uIHRvIHRoZSBBIGFsaWFzIHJlY29yZC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNyZWF0ZUFBQUFSZWNvcmQ/OiBib29sZWFuO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZFByb3BzIHtcbiAgICAvKipcbiAgICAgKiBUaGUgcHJpbWFyeSBBUEkgb3JpZ2luIFVSTCAoZS5nLiwgdGhlIEFQSSBHYXRld2F5IGludm9rZSBVUkwgb3IgTGFtYmRhIGZ1bmN0aW9uIFVSTCkuXG4gICAgICogVGhpcyBpcyB1c2VkIGZvciB0aGUgZGVmYXVsdCBiZWhhdmlvciBhbmQgYW55IEFQSSBieXBhc3MgcGF0aHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpT3JpZ2luVXJsOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBTUEEgb3JpZ2lucyB3aXRoIHRoZWlyIHBhdGggcGF0dGVybnMuXG4gICAgICogRWFjaCBTUEEgd2lsbCBiZSBzZXJ2ZWQgdmlhIENsb3VkRnJvbnQgd2l0aCBTUEEgcmV3cml0ZSBzdXBwb3J0LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNwYU9yaWdpbnM/OiBTcGFPcmlnaW5Db25maWdbXTtcblxuICAgIC8qKlxuICAgICAqIEFQSSBieXBhc3MgY29uZmlndXJhdGlvbnMgZm9yIHBhdGhzIHRoYXQgc2hvdWxkIGdvIGRpcmVjdGx5IHRvIHRoZSBBUEkgb3JpZ2luXG4gICAgICogZXZlbiB0aG91Z2ggdGhleSBtaWdodCBtYXRjaCBhbiBTUEEgcGF0aCBwcmVmaXguXG4gICAgICogVGhlc2UgYXJlIGV2YWx1YXRlZCBiZWZvcmUgU1BBIHBhdGhzIGR1ZSB0byBDbG91ZEZyb250IGJlaGF2aW9yIHByZWNlZGVuY2UuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpQnlwYXNzUGF0aHM/OiBBcGlCeXBhc3NDb25maWdbXTtcblxuICAgIC8qKlxuICAgICAqIERvbWFpbiBjb25maWd1cmF0aW9uIGZvciBjdXN0b20gZG9tYWluLCBjZXJ0aWZpY2F0ZSwgYW5kIFJvdXRlNTMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluPzogUGF0aFJvdXRlZEZyb250ZW5kRG9tYWluQ29uZmlnO1xuXG4gICAgLyoqXG4gICAgICogUmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgdG8gYXBwbHkgdG8gYWxsIGJlaGF2aW9ycyAobGVnYWN5KS5cbiAgICAgKlxuICAgICAqIFByZWZlciB1c2luZyBgYXBpUmVzcG9uc2VIZWFkZXJzUG9saWN5YCwgYHNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeWAsIGFuZFxuICAgICAqIGBhcGlCeXBhc3NSZXNwb25zZUhlYWRlcnNQb2xpY3lgIGZvciBiZWhhdmlvci1zY29wZWQgY29udHJvbC5cbiAgICAgKi9cbiAgICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSBmb3IgdGhlIEFQSSBvcmlnaW4gZGVmYXVsdCBiZWhhdmlvci5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlSZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBEZWZhdWx0IHJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGZvciBTUEEgYmVoYXZpb3JzLlxuICAgICAqIENhbiBiZSBvdmVycmlkZGVuIHBlciBTUEEgdmlhIGBTcGFPcmlnaW5Db25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5YC5cbiAgICAgKi9cbiAgICByZWFkb25seSBzcGFSZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBEZWZhdWx0IHJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IGZvciBBUEkgYnlwYXNzIGJlaGF2aW9ycy5cbiAgICAgKiBDYW4gYmUgb3ZlcnJpZGRlbiBwZXIgYnlwYXNzIHZpYSBgQXBpQnlwYXNzQ29uZmlnLnJlc3BvbnNlSGVhZGVyc1BvbGljeWAuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpQnlwYXNzUmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogT3JpZ2luIHJlcXVlc3QgcG9saWN5IGZvciB0aGUgQVBJIG9yaWdpbiAoZGVmYXVsdCBiZWhhdmlvcikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpT3JpZ2luUmVxdWVzdFBvbGljeT86IGNsb3VkZnJvbnQuSU9yaWdpblJlcXVlc3RQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgQ2xvdWRGcm9udCBhY2Nlc3MgbG9nZ2luZy5cbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5hYmxlTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBTMyBidWNrZXQgZm9yIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MuXG4gICAgICogSWYgbm90IHByb3ZpZGVkIGFuZCBlbmFibGVMb2dnaW5nIGlzIHRydWUsIGEgbmV3IGJ1Y2tldCB3aWxsIGJlIGNyZWF0ZWQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgY3JlYXRlZCByZXNvdXJjZXMuXG4gICAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICAgKi9cbiAgICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gYXV0by1kZWxldGUgb2JqZWN0cyBpbiBjcmVhdGVkIGJ1Y2tldHMgb24gc3RhY2sgZGVsZXRpb24uXG4gICAgICogT25seSBhcHBsaWVzIHdoZW4gcmVtb3ZhbFBvbGljeSBpcyBERVNUUk9ZLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXV0b0RlbGV0ZU9iamVjdHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgd2ViIEFDTCBJRCBmb3IgQVdTIFdBRiBpbnRlZ3JhdGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSB3ZWJBY2xJZD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFByaWNlIGNsYXNzIGZvciB0aGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAgICogQGRlZmF1bHQgUHJpY2VDbGFzcy5QUklDRV9DTEFTU19BTExcbiAgICAgKi9cbiAgICByZWFkb25seSBwcmljZUNsYXNzPzogY2xvdWRmcm9udC5QcmljZUNsYXNzO1xuXG4gICAgLyoqXG4gICAgICogQW4gb3B0aW9uYWwgbmFtZS9jb21tZW50IGZvciB0aGUgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNvbW1lbnQ/OiBzdHJpbmc7XG59XG5cbi8qKlxuICogQ2xvdWRGcm9udCBGdW5jdGlvbiBjb2RlIGZvciBTUEEgdmlld2VyLXJlcXVlc3QgcmV3cml0ZS5cbiAqIFJld3JpdGVzIHJlcXVlc3RzIHdpdGhvdXQgZmlsZSBleHRlbnNpb25zIHRvIHRoZSBpbmRleC5odG1sIHdpdGhpbiB0aGUgcHJlZml4LlxuICovXG5mdW5jdGlvbiBnZW5lcmF0ZVNwYVJld3JpdGVGdW5jdGlvbkNvZGUoXG4gICAgc3BhT3JpZ2luczogU3BhT3JpZ2luQ29uZmlnW10sXG4pOiBzdHJpbmcge1xuICAgIGNvbnN0IGNvbmZpZ3MgPSBzcGFPcmlnaW5zXG4gICAgICAgIC5tYXAoKHNwYSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgY2xlYW5QcmVmaXggPSBzcGEucGF0aFBhdHRlcm4ucmVwbGFjZSgvXFwvXFwqJC8sIFwiXCIpO1xuICAgICAgICAgICAgY29uc3QgcHJlZml4ID0gYCR7Y2xlYW5QcmVmaXh9L2A7XG4gICAgICAgICAgICBjb25zdCByZXdyaXRlTW9kZSA9IHNwYS5yZXdyaXRlTW9kZSA/PyBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5TUEE7XG4gICAgICAgICAgICBjb25zdCBzdHJpcFByZWZpeEJlZm9yZU9yaWdpbiA9IHNwYS5zdHJpcFByZWZpeEJlZm9yZU9yaWdpbiA9PT0gdHJ1ZTtcbiAgICAgICAgICAgIGNvbnN0IGluZGV4UGF0aCA9IGAke2NsZWFuUHJlZml4fS9pbmRleC5odG1sYDtcbiAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgY2xlYW5QcmVmaXgsXG4gICAgICAgICAgICAgICAgcHJlZml4LFxuICAgICAgICAgICAgICAgIHJld3JpdGVNb2RlLFxuICAgICAgICAgICAgICAgIHN0cmlwUHJlZml4QmVmb3JlT3JpZ2luLFxuICAgICAgICAgICAgICAgIGluZGV4UGF0aCxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH0pXG4gICAgICAgIC8vIEVuc3VyZSBtb3JlIHNwZWNpZmljIHByZWZpeGVzIG1hdGNoIGZpcnN0IHRvIGF2b2lkIG92ZXJsYXAgaXNzdWVzLlxuICAgICAgICAuc29ydCgoYSwgYikgPT4gYi5jbGVhblByZWZpeC5sZW5ndGggLSBhLmNsZWFuUHJlZml4Lmxlbmd0aCk7XG5cbiAgICBjb25zdCBwcmVmaXhNYXRjaGVzID0gY29uZmlnc1xuICAgICAgICAubWFwKChjZmcpID0+IHtcbiAgICAgICAgICAgIHJldHVybiBgeyBjbGVhblByZWZpeDogJyR7Y2ZnLmNsZWFuUHJlZml4fScsIHByZWZpeDogJyR7Y2ZnLnByZWZpeH0nLCByZXdyaXRlTW9kZTogJyR7Y2ZnLnJld3JpdGVNb2RlfScsIHN0cmlwUHJlZml4QmVmb3JlT3JpZ2luOiAke2NmZy5zdHJpcFByZWZpeEJlZm9yZU9yaWdpbn0sIGluZGV4UGF0aDogJyR7Y2ZnLmluZGV4UGF0aH0nIH1gO1xuICAgICAgICB9KVxuICAgICAgICAuam9pbihcIixcXG4gICAgICBcIik7XG5cbiAgICByZXR1cm4gYFxuXHRmdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG5cdCAgdmFyIHJlcXVlc3QgPSBldmVudC5yZXF1ZXN0O1xuXHQgIHZhciB1cmkgPSByZXF1ZXN0LnVyaTtcblxuXHQgIC8vIFNQQSBwcmVmaXggY29uZmlndXJhdGlvbnNcblx0ICB2YXIgc3BhUHJlZml4ZXMgPSBbXG5cdCAgICAgICR7cHJlZml4TWF0Y2hlc31cblx0ICBdO1xuXG5cdCAgLy8gQ2hlY2sgaWYgdGhpcyBpcyBhbiBTUEEgcGF0aFxuXHQgIGZvciAodmFyIGkgPSAwOyBpIDwgc3BhUHJlZml4ZXMubGVuZ3RoOyBpKyspIHtcblx0ICAgIHZhciBzcGEgPSBzcGFQcmVmaXhlc1tpXTtcblx0ICAgIGlmICh1cmkuc3RhcnRzV2l0aChzcGEucHJlZml4KSkge1xuXHQgICAgICB2YXIgdXJpV2l0aG91dFByZWZpeCA9IHVyaS5zdWJzdHJpbmcoc3BhLnByZWZpeC5sZW5ndGgpO1xuXG5cdCAgICAgIGlmIChzcGEucmV3cml0ZU1vZGUgPT09ICdzcGEnKSB7XG5cdCAgICAgICAgLy8gSWYgdGhlIFVSSSBkb2Vzbid0IGhhdmUgYW4gZXh0ZW5zaW9uIChubyBmaWxlKSwgcmV3cml0ZSB0byBpbmRleC5odG1sXG5cdCAgICAgICAgLy8gQ2hlY2sgaWYgaXQgaGFzIGEgZmlsZSBleHRlbnNpb24gKGNvbnRhaW5zIGEgZG90IGluIHRoZSBsYXN0IHBhdGggc2VnbWVudClcblx0ICAgICAgICB2YXIgbGFzdFNsYXNoID0gdXJpV2l0aG91dFByZWZpeC5sYXN0SW5kZXhPZignLycpO1xuXHQgICAgICAgIHZhciBsYXN0U2VnbWVudCA9IGxhc3RTbGFzaCA+PSAwID8gdXJpV2l0aG91dFByZWZpeC5zdWJzdHJpbmcobGFzdFNsYXNoICsgMSkgOiB1cmlXaXRob3V0UHJlZml4O1xuXHQgICAgICAgIFxuXHQgICAgICAgIC8vIElmIG5vIGV4dGVuc2lvbiBpbiB0aGUgbGFzdCBzZWdtZW50LCBzZXJ2ZSBpbmRleC5odG1sXG5cdCAgICAgICAgaWYgKGxhc3RTZWdtZW50LmluZGV4T2YoJy4nKSA9PT0gLTEpIHtcblx0ICAgICAgICAgIHJlcXVlc3QudXJpID0gc3BhLmluZGV4UGF0aDtcblx0ICAgICAgICB9XG5cdCAgICAgIH1cblxuXHQgICAgICAvLyBPcHRpb25hbGx5IHN0cmlwIHRoZSBwcmVmaXggYmVmb3JlIGZvcndhcmRpbmcgdG8gdGhlIG9yaWdpbi5cblx0ICAgICAgaWYgKHNwYS5zdHJpcFByZWZpeEJlZm9yZU9yaWdpbikge1xuXHQgICAgICAgIHZhciBjbGVhblByZWZpeFdpdGhTbGFzaCA9IHNwYS5jbGVhblByZWZpeCArICcvJztcblx0ICAgICAgICBpZiAocmVxdWVzdC51cmkuc3RhcnRzV2l0aChjbGVhblByZWZpeFdpdGhTbGFzaCkpIHtcblx0ICAgICAgICAgIHJlcXVlc3QudXJpID0gcmVxdWVzdC51cmkuc3Vic3RyaW5nKHNwYS5jbGVhblByZWZpeC5sZW5ndGgpO1xuXHQgICAgICAgIH1cblx0ICAgICAgfVxuXHQgICAgICBicmVhaztcblx0ICAgIH1cblx0ICB9XG5cblx0ICByZXR1cm4gcmVxdWVzdDtcblx0fVxuXHRgLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBBIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIGZvciBwYXRoLXJvdXRlZCBtdWx0aS1TUEEgKyBBUEkgZGVwbG95bWVudHMuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgY3JlYXRlcyBhIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIHRoYXQgcm91dGVzIHJlcXVlc3RzIHRvOlxuICogLSBTUEEgb3JpZ2lucyAoUzMgYnVja2V0cykgYmFzZWQgb24gcGF0aCBwcmVmaXhlcyAoZS5nLiwgL2wvKiwgL2F1dGgvKilcbiAqIC0gQVBJIG9yaWdpbiAoZGVmYXVsdCBiZWhhdmlvcikgZm9yIGFsbCBvdGhlciBwYXRoc1xuICogLSBBUEkgYnlwYXNzIHBhdGhzIGZvciBzcGVjaWZpYyBwYXRocyB0aGF0IHNob3VsZCBza2lwIFNQQSByb3V0aW5nXG4gKlxuICogQSBDbG91ZEZyb250IEZ1bmN0aW9uIGhhbmRsZXMgdmlld2VyLXJlcXVlc3QgcmV3cml0aW5nIGZvciBTUEEgcm91dGluZyxcbiAqIGVuc3VyaW5nIHRoYXQgcGF0aHMgd2l0aG91dCBmaWxlIGV4dGVuc2lvbnMgYXJlIHJld3JpdHRlbiB0byBpbmRleC5odG1sLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBGdW5jdGlvbiBmb3IgU1BBIHJld3JpdGUgKGlmIFNQQSBvcmlnaW5zIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgc3BhUmV3cml0ZUZ1bmN0aW9uPzogY2xvdWRmcm9udC5GdW5jdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGJ1Y2tldCAoaWYgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgY2VydGlmaWNhdGUgdXNlZCBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoaWYgY3VzdG9tIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZFByb3BzKSB7XG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAgICAgaWYgKCFwcm9wcy5hcGlPcmlnaW5VcmwpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCByZXF1aXJlcyBwcm9wcy5hcGlPcmlnaW5VcmxcIik7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICAgICAgY29uc3QgYXV0b0RlbGV0ZU9iamVjdHMgPSBwcm9wcy5hdXRvRGVsZXRlT2JqZWN0cyA/PyBmYWxzZTtcbiAgICAgICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcblxuICAgICAgICAvLyBDcmVhdGUgbG9ncyBidWNrZXQgaWYgbG9nZ2luZyBpcyBlbmFibGVkXG4gICAgICAgIGlmIChlbmFibGVMb2dnaW5nKSB7XG4gICAgICAgICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICAgICAgICAgIHByb3BzLmxvZ3NCdWNrZXQgPz9cbiAgICAgICAgICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgICAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgICAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgICAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5PQkpFQ1RfV1JJVEVSLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUGFyc2UgdGhlIEFQSSBvcmlnaW4gVVJMIHRvIGNyZWF0ZSBhbiBIdHRwT3JpZ2luIChkb21haW4gKyBvcHRpb25hbCBvcmlnaW5QYXRoKVxuICAgICAgICBjb25zdCBhcGlPcmlnaW5QYXJzZWQgPSB0aGlzLnBhcnNlT3JpZ2luRnJvbVVybChwcm9wcy5hcGlPcmlnaW5VcmwpO1xuICAgICAgICBjb25zdCBhcGlPcmlnaW4gPSBuZXcgb3JpZ2lucy5IdHRwT3JpZ2luKGFwaU9yaWdpblBhcnNlZC5kb21haW5OYW1lLCB7XG4gICAgICAgICAgICBwcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5PcmlnaW5Qcm90b2NvbFBvbGljeS5IVFRQU19PTkxZLFxuICAgICAgICAgICAgLi4uKGFwaU9yaWdpblBhcnNlZC5vcmlnaW5QYXRoID8geyBvcmlnaW5QYXRoOiBhcGlPcmlnaW5QYXJzZWQub3JpZ2luUGF0aCB9IDoge30pLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBIYW5kbGUgZG9tYWluIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgICAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluLmRvbWFpbk5hbWUpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG5cbiAgICAgICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4sXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBDcmVhdGUgYSBETlMtdmFsaWRhdGVkIGNlcnRpZmljYXRlXG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5EbnNWYWxpZGF0ZWRDZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBob3N0ZWRab25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZ2lvbjogXCJ1cy1lYXN0LTFcIixcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgcmVxdWlyZXMgZG9tYWluLmNlcnRpZmljYXRlLCBkb21haW4uY2VydGlmaWNhdGVBcm4sIG9yIGRvbWFpbi5ob3N0ZWRab25lIHdoZW4gZG9tYWluLmRvbWFpbk5hbWUgaXMgc2V0XCIsXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlO1xuXG4gICAgICAgIC8vIENyZWF0ZSBDbG91ZEZyb250IEZ1bmN0aW9uIGZvciBTUEEgcmV3cml0ZSBpZiBTUEEgb3JpZ2lucyBhcmUgY29uZmlndXJlZFxuICAgICAgICBjb25zdCBzcGFPcmlnaW5zID0gcHJvcHMuc3BhT3JpZ2lucyA/PyBbXTtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICAgc3BhT3JpZ2lucy5zb21lKChzcGEpID0+IHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXdyaXRlTW9kZSA9IHNwYS5yZXdyaXRlTW9kZSA/PyBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5TUEE7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJld3JpdGVNb2RlICE9PSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5OT05FIHx8IHNwYS5zdHJpcFByZWZpeEJlZm9yZU9yaWdpbiA9PT0gdHJ1ZTtcbiAgICAgICAgICAgIH0pXG4gICAgICAgICkge1xuICAgICAgICAgICAgY29uc3QgZnVuY3Rpb25Db2RlID0gZ2VuZXJhdGVTcGFSZXdyaXRlRnVuY3Rpb25Db2RlKHNwYU9yaWdpbnMpO1xuXG4gICAgICAgICAgICB0aGlzLnNwYVJld3JpdGVGdW5jdGlvbiA9IG5ldyBjbG91ZGZyb250LkZ1bmN0aW9uKHRoaXMsIFwiU3BhUmV3cml0ZUZ1bmN0aW9uXCIsIHtcbiAgICAgICAgICAgICAgICBjb2RlOiBjbG91ZGZyb250LkZ1bmN0aW9uQ29kZS5mcm9tSW5saW5lKGZ1bmN0aW9uQ29kZSksXG4gICAgICAgICAgICAgICAgcnVudGltZTogY2xvdWRmcm9udC5GdW5jdGlvblJ1bnRpbWUuSlNfMl8wLFxuICAgICAgICAgICAgICAgIGNvbW1lbnQ6IFwiU1BBIHZpZXdlci1yZXF1ZXN0IHJld3JpdGUgZm9yIHBhdGgtcm91dGVkIGZyb250ZW5kXCIsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEJ1aWxkIGFkZGl0aW9uYWwgYmVoYXZpb3JzXG4gICAgICAgIGNvbnN0IGFkZGl0aW9uYWxCZWhhdmlvcnM6IFJlY29yZDxzdHJpbmcsIGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zPiA9IHt9O1xuXG4gICAgICAgIC8vIEFkZCBBUEkgYnlwYXNzIHBhdGhzIGZpcnN0IChoaWdoZXIgcHJlY2VkZW5jZSBpbiBDbG91ZEZyb250KVxuICAgICAgICBmb3IgKGNvbnN0IGJ5cGFzc0NvbmZpZyBvZiBwcm9wcy5hcGlCeXBhc3NQYXRocyA/PyBbXSkge1xuICAgICAgICAgICAgY29uc3QgcmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgICAgICAgICAgICBieXBhc3NDb25maWcucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMuYXBpQnlwYXNzUmVzcG9uc2VIZWFkZXJzUG9saWN5ID8/XG4gICAgICAgICAgICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW2J5cGFzc0NvbmZpZy5wYXRoUGF0dGVybl0gPSB7XG4gICAgICAgICAgICAgICAgb3JpZ2luOiBhcGlPcmlnaW4sXG4gICAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgICAgICAgIGNhY2hlUG9saWN5OiBieXBhc3NDb25maWcuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6XG4gICAgICAgICAgICAgICAgICAgIGJ5cGFzc0NvbmZpZy5vcmlnaW5SZXF1ZXN0UG9saWN5ID8/IHByb3BzLmFwaU9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgICAgICAgICAgLi4uKHJlc3BvbnNlSGVhZGVyc1BvbGljeVxuICAgICAgICAgICAgICAgICAgICA/IHsgcmVzcG9uc2VIZWFkZXJzUG9saWN5IH1cbiAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQWRkIFNQQSBvcmlnaW4gYmVoYXZpb3JzXG4gICAgICAgIGZvciAoY29uc3Qgc3BhQ29uZmlnIG9mIHNwYU9yaWdpbnMpIHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3BvbnNlSGVhZGVyc1BvbGljeSA9XG4gICAgICAgICAgICAgICAgc3BhQ29uZmlnLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgICAgIHByb3BzLnNwYVJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgICAgIHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeTtcbiAgICAgICAgICAgIGNvbnN0IHJld3JpdGVNb2RlID0gc3BhQ29uZmlnLnJld3JpdGVNb2RlID8/IEFwcFRoZW9yeVNwYVJld3JpdGVNb2RlLlNQQTtcbiAgICAgICAgICAgIGNvbnN0IG5lZWRzRnVuY3Rpb24gPVxuICAgICAgICAgICAgICAgIHRoaXMuc3BhUmV3cml0ZUZ1bmN0aW9uICYmXG4gICAgICAgICAgICAgICAgKHJld3JpdGVNb2RlICE9PSBBcHBUaGVvcnlTcGFSZXdyaXRlTW9kZS5OT05FIHx8IHNwYUNvbmZpZy5zdHJpcFByZWZpeEJlZm9yZU9yaWdpbiA9PT0gdHJ1ZSk7XG5cbiAgICAgICAgICAgIGNvbnN0IHNwYU9yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2woc3BhQ29uZmlnLmJ1Y2tldCk7XG5cbiAgICAgICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbc3BhQ29uZmlnLnBhdGhQYXR0ZXJuXSA9IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IHNwYU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgICAgICAgICAgIGNhY2hlUG9saWN5OiBzcGFDb25maWcuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRCxcbiAgICAgICAgICAgICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICAuLi4obmVlZHNGdW5jdGlvblxuICAgICAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbjogdGhpcy5zcGFSZXdyaXRlRnVuY3Rpb24sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVRVUVTVCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICAuLi4ocmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGRpc3RyaWJ1dGlvblxuICAgICAgICBjb25zdCBkZWZhdWx0UmVzcG9uc2VIZWFkZXJzUG9saWN5ID1cbiAgICAgICAgICAgIHByb3BzLmFwaVJlc3BvbnNlSGVhZGVyc1BvbGljeSA/P1xuICAgICAgICAgICAgcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgICAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICAgICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICAgICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IGFwaU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBwcm9wcy5hcGlPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICAgICAgICAgIC4uLihkZWZhdWx0UmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3k6IGRlZmF1bHRSZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzLFxuICAgICAgICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5wcmljZUNsYXNzID8geyBwcmljZUNsYXNzOiBwcm9wcy5wcmljZUNsYXNzIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMuY29tbWVudCA/IHsgY29tbWVudDogcHJvcHMuY29tbWVudCB9IDoge30pLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBDcmVhdGUgUm91dGU1MyBBIHJlY29yZCBpZiBob3N0ZWQgem9uZSBpcyBwcm92aWRlZFxuICAgICAgICBpZiAocHJvcHMuZG9tYWluPy5kb21haW5OYW1lICYmIHByb3BzLmRvbWFpbj8uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgICAgICAgICB6b25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW4uZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHByb3BzLmRvbWFpbi5jcmVhdGVBQUFBUmVjb3JkID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkQUFBQVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIHpvbmU6IHByb3BzLmRvbWFpbi5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW4uZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdHMgdGhlIGRvbWFpbiBuYW1lIGZyb20gYSBVUkwgKGUuZy4sIFwiaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcGF0aFwiIC0+IFwiYXBpLmV4YW1wbGUuY29tXCIpLlxuICAgICAqL1xuICAgIHByaXZhdGUgcGFyc2VPcmlnaW5Gcm9tVXJsKHVybDogc3RyaW5nKTogeyBkb21haW5OYW1lOiBzdHJpbmc7IG9yaWdpblBhdGg/OiBzdHJpbmcgfSB7XG4gICAgICAgIGNvbnN0IHVybFN0ciA9IFN0cmluZyh1cmwgPz8gXCJcIikudHJpbSgpO1xuICAgICAgICBpZiAoIXVybFN0cikge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIHJlcXVpcmVzIGEgbm9uLWVtcHR5IGFwaU9yaWdpblVybFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEZ1bGwgVVJMIChyZWNvbW1lbmRlZCk6IGh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3Byb2RcbiAgICAgICAgaWYgKHVybFN0ci5pbmNsdWRlcyhcIjovL1wiKSkge1xuICAgICAgICAgICAgY29uc3QgcGFyc2VkID0gbmV3IFVSTCh1cmxTdHIpO1xuICAgICAgICAgICAgY29uc3QgZG9tYWluTmFtZSA9IFN0cmluZyhwYXJzZWQuaG9zdG5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgICAgICAgICAgaWYgKCFkb21haW5OYW1lKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgY291bGQgbm90IHBhcnNlIGRvbWFpbiBmcm9tIGFwaU9yaWdpblVybDogJHt1cmxTdHJ9YCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IHBhdGggPSBTdHJpbmcocGFyc2VkLnBhdGhuYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgICAgIGNvbnN0IG9yaWdpblBhdGggPSBwYXRoICYmIHBhdGggIT09IFwiL1wiID8gdHJpbVJlcGVhdGVkQ2hhckVuZChwYXRoLCBcIi9cIikgOiB1bmRlZmluZWQ7XG4gICAgICAgICAgICByZXR1cm4geyBkb21haW5OYW1lLCAuLi4ob3JpZ2luUGF0aCA/IHsgb3JpZ2luUGF0aCB9IDoge30pIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyBCYXJlIGRvbWFpbiAob3IgZG9tYWluICsgcGF0aCk6IGFwaS5leGFtcGxlLmNvbSBvciBhcGkuZXhhbXBsZS5jb20vcHJvZFxuICAgICAgICBjb25zdCB3aXRob3V0UXVlcnkgPSB1cmxTdHIuc3BsaXQoXCI/XCIpWzBdPy5zcGxpdChcIiNcIilbMF0gPz8gdXJsU3RyO1xuICAgICAgICBjb25zdCBmaXJzdFNsYXNoSW5kZXggPSB3aXRob3V0UXVlcnkuaW5kZXhPZihcIi9cIik7XG4gICAgICAgIGNvbnN0IGRvbWFpblBhcnQgPSAoZmlyc3RTbGFzaEluZGV4ID49IDAgPyB3aXRob3V0UXVlcnkuc2xpY2UoMCwgZmlyc3RTbGFzaEluZGV4KSA6IHdpdGhvdXRRdWVyeSlcbiAgICAgICAgICAgIC50cmltKCk7XG4gICAgICAgIGNvbnN0IG5vcm1hbGl6ZWREb21haW5QYXJ0ID0gc3RyaXBUcmFpbGluZ1BvcnQoZG9tYWluUGFydCk7XG4gICAgICAgIGlmICghbm9ybWFsaXplZERvbWFpblBhcnQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIGNvdWxkIG5vdCBwYXJzZSBkb21haW4gZnJvbSBhcGlPcmlnaW5Vcmw6ICR7dXJsU3RyfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGF0aFBhcnQgPSBmaXJzdFNsYXNoSW5kZXggPj0gMCA/IHdpdGhvdXRRdWVyeS5zbGljZShmaXJzdFNsYXNoSW5kZXgpIDogXCJcIjtcbiAgICAgICAgY29uc3Qgb3JpZ2luUGF0aCA9IHBhdGhQYXJ0ICYmIHBhdGhQYXJ0ICE9PSBcIi9cIiA/IHRyaW1SZXBlYXRlZENoYXJFbmQocGF0aFBhcnQsIFwiL1wiKSA6IHVuZGVmaW5lZDtcbiAgICAgICAgcmV0dXJuIHsgZG9tYWluTmFtZTogbm9ybWFsaXplZERvbWFpblBhcnQsIC4uLihvcmlnaW5QYXRoID8geyBvcmlnaW5QYXRoIH0gOiB7fSkgfTtcbiAgICB9XG59XG4iXX0=