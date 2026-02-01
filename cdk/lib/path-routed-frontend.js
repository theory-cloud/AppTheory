"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryPathRoutedFrontend = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const acm = require("aws-cdk-lib/aws-certificatemanager");
const cloudfront = require("aws-cdk-lib/aws-cloudfront");
const origins = require("aws-cdk-lib/aws-cloudfront-origins");
const route53 = require("aws-cdk-lib/aws-route53");
const targets = require("aws-cdk-lib/aws-route53-targets");
const s3 = require("aws-cdk-lib/aws-s3");
const constructs_1 = require("constructs");
/**
 * CloudFront Function code for SPA viewer-request rewrite.
 * Rewrites requests without file extensions to the index.html within the prefix.
 */
function generateSpaRewriteFunctionCode(spaPathPrefixes) {
    const prefixMatches = spaPathPrefixes
        .map((prefix) => {
        const cleanPrefix = prefix.replace(/\/\*$/, "");
        return `{ prefix: '${cleanPrefix}/', indexPath: '${cleanPrefix}/index.html' }`;
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
      // If the URI doesn't have an extension (no file), rewrite to index.html
      var uriWithoutPrefix = uri.substring(spa.prefix.length);
      // Check if it has a file extension (contains a dot in the last path segment)
      var lastSlash = uriWithoutPrefix.lastIndexOf('/');
      var lastSegment = lastSlash >= 0 ? uriWithoutPrefix.substring(lastSlash + 1) : uriWithoutPrefix;
      
      // If no extension in the last segment, serve index.html
      if (lastSegment.indexOf('.') === -1) {
        request.uri = spa.indexPath;
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
        if (spaOrigins.length > 0) {
            const spaPathPrefixes = spaOrigins.map((spa) => spa.pathPattern);
            const functionCode = generateSpaRewriteFunctionCode(spaPathPrefixes);
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
            additionalBehaviors[bypassConfig.pathPattern] = {
                origin: apiOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: bypassConfig.cachePolicy ?? cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: bypassConfig.originRequestPolicy ?? props.apiOriginRequestPolicy,
                ...(props.responseHeadersPolicy
                    ? { responseHeadersPolicy: props.responseHeadersPolicy }
                    : {}),
            };
        }
        // Add SPA origin behaviors
        for (const spaConfig of spaOrigins) {
            const spaOrigin = origins.S3BucketOrigin.withOriginAccessControl(spaConfig.bucket);
            additionalBehaviors[spaConfig.pathPattern] = {
                origin: spaOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                cachePolicy: spaConfig.cachePolicy ?? cloudfront.CachePolicy.CACHING_OPTIMIZED,
                compress: true,
                ...(this.spaRewriteFunction
                    ? {
                        functionAssociations: [
                            {
                                function: this.spaRewriteFunction,
                                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                            },
                        ],
                    }
                    : {}),
                ...(props.responseHeadersPolicy
                    ? { responseHeadersPolicy: props.responseHeadersPolicy }
                    : {}),
            };
        }
        // Create the distribution
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
                ...(props.responseHeadersPolicy
                    ? { responseHeadersPolicy: props.responseHeadersPolicy }
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
            const originPath = path && path !== "/" ? path.replace(/\/+$/, "") : undefined;
            return { domainName, ...(originPath ? { originPath } : {}) };
        }
        // Bare domain (or domain + path): api.example.com or api.example.com/prod
        const withoutQuery = urlStr.split("?")[0]?.split("#")[0] ?? urlStr;
        const firstSlashIndex = withoutQuery.indexOf("/");
        const domainPart = (firstSlashIndex >= 0 ? withoutQuery.slice(0, firstSlashIndex) : withoutQuery)
            .trim()
            .replace(/:\d+$/, "");
        if (!domainPart) {
            throw new Error(`AppTheoryPathRoutedFrontend could not parse domain from apiOriginUrl: ${urlStr}`);
        }
        const pathPart = firstSlashIndex >= 0 ? withoutQuery.slice(firstSlashIndex) : "";
        const originPath = pathPart && pathPart !== "/" ? pathPart.replace(/\/+$/, "") : undefined;
        return { domainName: domainPart, ...(originPath ? { originPath } : {}) };
    }
}
exports.AppTheoryPathRoutedFrontend = AppTheoryPathRoutedFrontend;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryPathRoutedFrontend[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend", version: "0.5.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aC1yb3V0ZWQtZnJvbnRlbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXRoLXJvdXRlZC1mcm9udGVuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUE0QztBQUM1QywwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUM5RCxtREFBbUQ7QUFDbkQsMkRBQTJEO0FBQzNELHlDQUF5QztBQUN6QywyQ0FBdUM7QUFrSnZDOzs7R0FHRztBQUNILFNBQVMsOEJBQThCLENBQUMsZUFBeUI7SUFDN0QsTUFBTSxhQUFhLEdBQUcsZUFBZTtTQUNoQyxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRTtRQUNaLE1BQU0sV0FBVyxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ2hELE9BQU8sY0FBYyxXQUFXLG1CQUFtQixXQUFXLGdCQUFnQixDQUFDO0lBQ25GLENBQUMsQ0FBQztTQUNELElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUV2QixPQUFPOzs7Ozs7O1FBT0gsYUFBYTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QnBCLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDVCxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7R0FVRztBQUNILE1BQWEsMkJBQTRCLFNBQVEsc0JBQVM7SUFxQnRELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBdUM7UUFDN0UsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLENBQUMsS0FBSyxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3RCLE1BQU0sSUFBSSxLQUFLLENBQUMseURBQXlELENBQUMsQ0FBQztRQUMvRSxDQUFDO1FBRUQsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsSUFBSSwyQkFBYSxDQUFDLE1BQU0sQ0FBQztRQUNsRSxNQUFNLGlCQUFpQixHQUFHLEtBQUssQ0FBQyxpQkFBaUIs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Q0FBQztJQUM3RSxDQUFDOztBQXJOTCxrRUFzTkMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBhbiBTUEEgb3JpZ2luIHJvdXRlZCBieSBwYXRoIHByZWZpeC5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBTcGFPcmlnaW5Db25maWcge1xuICAgIC8qKlxuICAgICAqIFMzIGJ1Y2tldCBjb250YWluaW5nIHRoZSBTUEEgYXNzZXRzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJ1Y2tldDogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFBhdGggcGF0dGVybiB0byByb3V0ZSB0byB0aGlzIFNQQSAoZS5nLiwgXCIvbC8qXCIsIFwiL2F1dGgvKlwiKS5cbiAgICAgKiBNdXN0IGluY2x1ZGUgdGhlIHRyYWlsaW5nIHdpbGRjYXJkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHBhdGhQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBjYWNoZSBwb2xpY3kgb3ZlcnJpZGUuIERlZmF1bHRzIHRvIENBQ0hJTkdfT1BUSU1JWkVELlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG59XG5cbi8qKlxuICogQ29uZmlndXJhdGlvbiBmb3IgcGF0aCBwYXR0ZXJucyB0aGF0IHNob3VsZCBieXBhc3MgU1BBIHJvdXRpbmcgYW5kIGdvIGRpcmVjdGx5IHRvIHRoZSBBUEkgb3JpZ2luLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwaUJ5cGFzc0NvbmZpZyB7XG4gICAgLyoqXG4gICAgICogUGF0aCBwYXR0ZXJuIHRoYXQgc2hvdWxkIHJvdXRlIHRvIHRoZSBBUEkgb3JpZ2luIGluc3RlYWQgb2YgU1BBIChlLmcuLCBcIi9hdXRoL3dhbGxldC8qXCIpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHBhdGhQYXR0ZXJuOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBjYWNoZSBwb2xpY3kgb3ZlcnJpZGUuIERlZmF1bHRzIHRvIENBQ0hJTkdfRElTQUJMRUQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIG9yaWdpbiByZXF1ZXN0IHBvbGljeSBvdmVycmlkZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBvcmlnaW5SZXF1ZXN0UG9saWN5PzogY2xvdWRmcm9udC5JT3JpZ2luUmVxdWVzdFBvbGljeTtcbn1cblxuLyoqXG4gKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFBhdGhSb3V0ZWRGcm9udGVuZERvbWFpbkNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogVGhlIGRvbWFpbiBuYW1lIGZvciB0aGUgZGlzdHJpYnV0aW9uIChlLmcuLCBcImFwcC5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIEhUVFBTLiBNdXN0IGJlIGluIHVzLWVhc3QtMSBmb3IgQ2xvdWRGcm9udC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBUk4gb2YgYW4gZXhpc3RpbmcgQUNNIGNlcnRpZmljYXRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICAgKiBXaGVuIHByb3ZpZGVkLCBhbiBBIHJlY29yZCBhbGlhcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIHRoZSBkb21haW4uXG4gICAgICovXG4gICAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kUHJvcHMge1xuICAgIC8qKlxuICAgICAqIFRoZSBwcmltYXJ5IEFQSSBvcmlnaW4gVVJMIChlLmcuLCB0aGUgQVBJIEdhdGV3YXkgaW52b2tlIFVSTCBvciBMYW1iZGEgZnVuY3Rpb24gVVJMKS5cbiAgICAgKiBUaGlzIGlzIHVzZWQgZm9yIHRoZSBkZWZhdWx0IGJlaGF2aW9yIGFuZCBhbnkgQVBJIGJ5cGFzcyBwYXRocy5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5Vcmw6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFNQQSBvcmlnaW5zIHdpdGggdGhlaXIgcGF0aCBwYXR0ZXJucy5cbiAgICAgKiBFYWNoIFNQQSB3aWxsIGJlIHNlcnZlZCB2aWEgQ2xvdWRGcm9udCB3aXRoIFNQQSByZXdyaXRlIHN1cHBvcnQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgc3BhT3JpZ2lucz86IFNwYU9yaWdpbkNvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogQVBJIGJ5cGFzcyBjb25maWd1cmF0aW9ucyBmb3IgcGF0aHMgdGhhdCBzaG91bGQgZ28gZGlyZWN0bHkgdG8gdGhlIEFQSSBvcmlnaW5cbiAgICAgKiBldmVuIHRob3VnaCB0aGV5IG1pZ2h0IG1hdGNoIGFuIFNQQSBwYXRoIHByZWZpeC5cbiAgICAgKiBUaGVzZSBhcmUgZXZhbHVhdGVkIGJlZm9yZSBTUEEgcGF0aHMgZHVlIHRvIENsb3VkRnJvbnQgYmVoYXZpb3IgcHJlY2VkZW5jZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlCeXBhc3NQYXRocz86IEFwaUJ5cGFzc0NvbmZpZ1tdO1xuXG4gICAgLyoqXG4gICAgICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGN1c3RvbSBkb21haW4sIGNlcnRpZmljYXRlLCBhbmQgUm91dGU1My5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBQYXRoUm91dGVkRnJvbnRlbmREb21haW5Db25maWc7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSB0byBhcHBseSB0byBhbGwgYmVoYXZpb3JzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIE9yaWdpbiByZXF1ZXN0IHBvbGljeSBmb3IgdGhlIEFQSSBvcmlnaW4gKGRlZmF1bHQgYmVoYXZpb3IpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGFwaU9yaWdpblJlcXVlc3RQb2xpY3k/OiBjbG91ZGZyb250LklPcmlnaW5SZXF1ZXN0UG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ2dpbmcuXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgUzMgYnVja2V0IGZvciBDbG91ZEZyb250IGFjY2VzcyBsb2dzLlxuICAgICAqIElmIG5vdCBwcm92aWRlZCBhbmQgZW5hYmxlTG9nZ2luZyBpcyB0cnVlLCBhIG5ldyBidWNrZXQgd2lsbCBiZSBjcmVhdGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIGNyZWF0ZWQgcmVzb3VyY2VzLlxuICAgICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGF1dG8tZGVsZXRlIG9iamVjdHMgaW4gY3JlYXRlZCBidWNrZXRzIG9uIHN0YWNrIGRlbGV0aW9uLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIHJlbW92YWxQb2xpY3kgaXMgREVTVFJPWS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIHdlYiBBQ0wgSUQgZm9yIEFXUyBXQUYgaW50ZWdyYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgd2ViQWNsSWQ/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBQcmljZSBjbGFzcyBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqIEBkZWZhdWx0IFByaWNlQ2xhc3MuUFJJQ0VfQ0xBU1NfQUxMXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHJpY2VDbGFzcz86IGNsb3VkZnJvbnQuUHJpY2VDbGFzcztcblxuICAgIC8qKlxuICAgICAqIEFuIG9wdGlvbmFsIG5hbWUvY29tbWVudCBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjb21tZW50Pzogc3RyaW5nO1xufVxuXG4vKipcbiAqIENsb3VkRnJvbnQgRnVuY3Rpb24gY29kZSBmb3IgU1BBIHZpZXdlci1yZXF1ZXN0IHJld3JpdGUuXG4gKiBSZXdyaXRlcyByZXF1ZXN0cyB3aXRob3V0IGZpbGUgZXh0ZW5zaW9ucyB0byB0aGUgaW5kZXguaHRtbCB3aXRoaW4gdGhlIHByZWZpeC5cbiAqL1xuZnVuY3Rpb24gZ2VuZXJhdGVTcGFSZXdyaXRlRnVuY3Rpb25Db2RlKHNwYVBhdGhQcmVmaXhlczogc3RyaW5nW10pOiBzdHJpbmcge1xuICAgIGNvbnN0IHByZWZpeE1hdGNoZXMgPSBzcGFQYXRoUHJlZml4ZXNcbiAgICAgICAgLm1hcCgocHJlZml4KSA9PiB7XG4gICAgICAgICAgICBjb25zdCBjbGVhblByZWZpeCA9IHByZWZpeC5yZXBsYWNlKC9cXC9cXCokLywgXCJcIik7XG4gICAgICAgICAgICByZXR1cm4gYHsgcHJlZml4OiAnJHtjbGVhblByZWZpeH0vJywgaW5kZXhQYXRoOiAnJHtjbGVhblByZWZpeH0vaW5kZXguaHRtbCcgfWA7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKFwiLFxcbiAgICAgIFwiKTtcblxuICAgIHJldHVybiBgXG5mdW5jdGlvbiBoYW5kbGVyKGV2ZW50KSB7XG4gIHZhciByZXF1ZXN0ID0gZXZlbnQucmVxdWVzdDtcbiAgdmFyIHVyaSA9IHJlcXVlc3QudXJpO1xuXG4gIC8vIFNQQSBwcmVmaXggY29uZmlndXJhdGlvbnNcbiAgdmFyIHNwYVByZWZpeGVzID0gW1xuICAgICAgJHtwcmVmaXhNYXRjaGVzfVxuICBdO1xuXG4gIC8vIENoZWNrIGlmIHRoaXMgaXMgYW4gU1BBIHBhdGhcbiAgZm9yICh2YXIgaSA9IDA7IGkgPCBzcGFQcmVmaXhlcy5sZW5ndGg7IGkrKykge1xuICAgIHZhciBzcGEgPSBzcGFQcmVmaXhlc1tpXTtcbiAgICBpZiAodXJpLnN0YXJ0c1dpdGgoc3BhLnByZWZpeCkpIHtcbiAgICAgIC8vIElmIHRoZSBVUkkgZG9lc24ndCBoYXZlIGFuIGV4dGVuc2lvbiAobm8gZmlsZSksIHJld3JpdGUgdG8gaW5kZXguaHRtbFxuICAgICAgdmFyIHVyaVdpdGhvdXRQcmVmaXggPSB1cmkuc3Vic3RyaW5nKHNwYS5wcmVmaXgubGVuZ3RoKTtcbiAgICAgIC8vIENoZWNrIGlmIGl0IGhhcyBhIGZpbGUgZXh0ZW5zaW9uIChjb250YWlucyBhIGRvdCBpbiB0aGUgbGFzdCBwYXRoIHNlZ21lbnQpXG4gICAgICB2YXIgbGFzdFNsYXNoID0gdXJpV2l0aG91dFByZWZpeC5sYXN0SW5kZXhPZignLycpO1xuICAgICAgdmFyIGxhc3RTZWdtZW50ID0gbGFzdFNsYXNoID49IDAgPyB1cmlXaXRob3V0UHJlZml4LnN1YnN0cmluZyhsYXN0U2xhc2ggKyAxKSA6IHVyaVdpdGhvdXRQcmVmaXg7XG4gICAgICBcbiAgICAgIC8vIElmIG5vIGV4dGVuc2lvbiBpbiB0aGUgbGFzdCBzZWdtZW50LCBzZXJ2ZSBpbmRleC5odG1sXG4gICAgICBpZiAobGFzdFNlZ21lbnQuaW5kZXhPZignLicpID09PSAtMSkge1xuICAgICAgICByZXF1ZXN0LnVyaSA9IHNwYS5pbmRleFBhdGg7XG4gICAgICB9XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVxdWVzdDtcbn1cbmAudHJpbSgpO1xufVxuXG4vKipcbiAqIEEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gZm9yIHBhdGgtcm91dGVkIG11bHRpLVNQQSArIEFQSSBkZXBsb3ltZW50cy5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBjcmVhdGVzIGEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gdGhhdCByb3V0ZXMgcmVxdWVzdHMgdG86XG4gKiAtIFNQQSBvcmlnaW5zIChTMyBidWNrZXRzKSBiYXNlZCBvbiBwYXRoIHByZWZpeGVzIChlLmcuLCAvbC8qLCAvYXV0aC8qKVxuICogLSBBUEkgb3JpZ2luIChkZWZhdWx0IGJlaGF2aW9yKSBmb3IgYWxsIG90aGVyIHBhdGhzXG4gKiAtIEFQSSBieXBhc3MgcGF0aHMgZm9yIHNwZWNpZmljIHBhdGhzIHRoYXQgc2hvdWxkIHNraXAgU1BBIHJvdXRpbmdcbiAqXG4gKiBBIENsb3VkRnJvbnQgRnVuY3Rpb24gaGFuZGxlcyB2aWV3ZXItcmVxdWVzdCByZXdyaXRpbmcgZm9yIFNQQSByb3V0aW5nLFxuICogZW5zdXJpbmcgdGhhdCBwYXRocyB3aXRob3V0IGZpbGUgZXh0ZW5zaW9ucyBhcmUgcmV3cml0dGVuIHRvIGluZGV4Lmh0bWwuXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IEZ1bmN0aW9uIGZvciBTUEEgcmV3cml0ZSAoaWYgU1BBIG9yaWdpbnMgYXJlIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBzcGFSZXdyaXRlRnVuY3Rpb24/OiBjbG91ZGZyb250LkZ1bmN0aW9uO1xuXG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgYnVja2V0IChpZiBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjZXJ0aWZpY2F0ZSB1c2VkIGZvciB0aGUgZGlzdHJpYnV0aW9uIChpZiBjdXN0b20gZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kUHJvcHMpIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICBpZiAoIXByb3BzLmFwaU9yaWdpblVybCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIHJlcXVpcmVzIHByb3BzLmFwaU9yaWdpblVybFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgICAgICBjb25zdCBhdXRvRGVsZXRlT2JqZWN0cyA9IHByb3BzLmF1dG9EZWxldGVPYmplY3RzID8/IGZhbHNlO1xuICAgICAgICBjb25zdCBlbmFibGVMb2dnaW5nID0gcHJvcHMuZW5hYmxlTG9nZ2luZyA/PyB0cnVlO1xuXG4gICAgICAgIC8vIENyZWF0ZSBsb2dzIGJ1Y2tldCBpZiBsb2dnaW5nIGlzIGVuYWJsZWRcbiAgICAgICAgaWYgKGVuYWJsZUxvZ2dpbmcpIHtcbiAgICAgICAgICAgIHRoaXMubG9nc0J1Y2tldCA9XG4gICAgICAgICAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICAgICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICAgICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICAgICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgICAgICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBQYXJzZSB0aGUgQVBJIG9yaWdpbiBVUkwgdG8gY3JlYXRlIGFuIEh0dHBPcmlnaW4gKGRvbWFpbiArIG9wdGlvbmFsIG9yaWdpblBhdGgpXG4gICAgICAgIGNvbnN0IGFwaU9yaWdpblBhcnNlZCA9IHRoaXMucGFyc2VPcmlnaW5Gcm9tVXJsKHByb3BzLmFwaU9yaWdpblVybCk7XG4gICAgICAgIGNvbnN0IGFwaU9yaWdpbiA9IG5ldyBvcmlnaW5zLkh0dHBPcmlnaW4oYXBpT3JpZ2luUGFyc2VkLmRvbWFpbk5hbWUsIHtcbiAgICAgICAgICAgIHByb3RvY29sUG9saWN5OiBjbG91ZGZyb250Lk9yaWdpblByb3RvY29sUG9saWN5LkhUVFBTX09OTFksXG4gICAgICAgICAgICAuLi4oYXBpT3JpZ2luUGFyc2VkLm9yaWdpblBhdGggPyB7IG9yaWdpblBhdGg6IGFwaU9yaWdpblBhcnNlZC5vcmlnaW5QYXRoIH0gOiB7fSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vIEhhbmRsZSBkb21haW4gY29uZmlndXJhdGlvblxuICAgICAgICBsZXQgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuICAgICAgICBsZXQgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGUgfCB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgICAgICAgY29uc3QgZG9tYWluTmFtZSA9IFN0cmluZyhwcm9wcy5kb21haW4uZG9tYWluTmFtZSkudHJpbSgpO1xuICAgICAgICAgICAgaWYgKGRvbWFpbk5hbWUpIHtcbiAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25Eb21haW5OYW1lcyA9IFtkb21haW5OYW1lXTtcblxuICAgICAgICAgICAgICAgIGlmIChwcm9wcy5kb21haW4uY2VydGlmaWNhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBwcm9wcy5kb21haW4uY2VydGlmaWNhdGU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4pIHtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcyxcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZUFybixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmRvbWFpbi5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIENyZWF0ZSBhIEROUy12YWxpZGF0ZWQgY2VydGlmaWNhdGVcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBuZXcgYWNtLkRuc1ZhbGlkYXRlZENlcnRpZmljYXRlKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGhvc3RlZFpvbmU6IHByb3BzLmRvbWFpbi5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgICAgICAgICAgcmVnaW9uOiBcInVzLWVhc3QtMVwiLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCByZXF1aXJlcyBkb21haW4uY2VydGlmaWNhdGUsIGRvbWFpbi5jZXJ0aWZpY2F0ZUFybiwgb3IgZG9tYWluLmhvc3RlZFpvbmUgd2hlbiBkb21haW4uZG9tYWluTmFtZSBpcyBzZXRcIixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmNlcnRpZmljYXRlID0gZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU7XG5cbiAgICAgICAgLy8gQ3JlYXRlIENsb3VkRnJvbnQgRnVuY3Rpb24gZm9yIFNQQSByZXdyaXRlIGlmIFNQQSBvcmlnaW5zIGFyZSBjb25maWd1cmVkXG4gICAgICAgIGNvbnN0IHNwYU9yaWdpbnMgPSBwcm9wcy5zcGFPcmlnaW5zID8/IFtdO1xuICAgICAgICBpZiAoc3BhT3JpZ2lucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBjb25zdCBzcGFQYXRoUHJlZml4ZXMgPSBzcGFPcmlnaW5zLm1hcCgoc3BhKSA9PiBzcGEucGF0aFBhdHRlcm4pO1xuICAgICAgICAgICAgY29uc3QgZnVuY3Rpb25Db2RlID0gZ2VuZXJhdGVTcGFSZXdyaXRlRnVuY3Rpb25Db2RlKHNwYVBhdGhQcmVmaXhlcyk7XG5cbiAgICAgICAgICAgIHRoaXMuc3BhUmV3cml0ZUZ1bmN0aW9uID0gbmV3IGNsb3VkZnJvbnQuRnVuY3Rpb24odGhpcywgXCJTcGFSZXdyaXRlRnVuY3Rpb25cIiwge1xuICAgICAgICAgICAgICAgIGNvZGU6IGNsb3VkZnJvbnQuRnVuY3Rpb25Db2RlLmZyb21JbmxpbmUoZnVuY3Rpb25Db2RlKSxcbiAgICAgICAgICAgICAgICBydW50aW1lOiBjbG91ZGZyb250LkZ1bmN0aW9uUnVudGltZS5KU18yXzAsXG4gICAgICAgICAgICAgICAgY29tbWVudDogXCJTUEEgdmlld2VyLXJlcXVlc3QgcmV3cml0ZSBmb3IgcGF0aC1yb3V0ZWQgZnJvbnRlbmRcIixcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQnVpbGQgYWRkaXRpb25hbCBiZWhhdmlvcnNcbiAgICAgICAgY29uc3QgYWRkaXRpb25hbEJlaGF2aW9yczogUmVjb3JkPHN0cmluZywgY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnM+ID0ge307XG5cbiAgICAgICAgLy8gQWRkIEFQSSBieXBhc3MgcGF0aHMgZmlyc3QgKGhpZ2hlciBwcmVjZWRlbmNlIGluIENsb3VkRnJvbnQpXG4gICAgICAgIGZvciAoY29uc3QgYnlwYXNzQ29uZmlnIG9mIHByb3BzLmFwaUJ5cGFzc1BhdGhzID8/IFtdKSB7XG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW2J5cGFzc0NvbmZpZy5wYXRoUGF0dGVybl0gPSB7XG4gICAgICAgICAgICAgICAgb3JpZ2luOiBhcGlPcmlnaW4sXG4gICAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfQUxMLFxuICAgICAgICAgICAgICAgIGNhY2hlUG9saWN5OiBieXBhc3NDb25maWcuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6XG4gICAgICAgICAgICAgICAgICAgIGJ5cGFzc0NvbmZpZy5vcmlnaW5SZXF1ZXN0UG9saWN5ID8/IHByb3BzLmFwaU9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgICAgICAgICAgLi4uKHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeVxuICAgICAgICAgICAgICAgICAgICA/IHsgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyBBZGQgU1BBIG9yaWdpbiBiZWhhdmlvcnNcbiAgICAgICAgZm9yIChjb25zdCBzcGFDb25maWcgb2Ygc3BhT3JpZ2lucykge1xuICAgICAgICAgICAgY29uc3Qgc3BhT3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbChzcGFDb25maWcuYnVja2V0KTtcblxuICAgICAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9yc1tzcGFDb25maWcucGF0aFBhdHRlcm5dID0ge1xuICAgICAgICAgICAgICAgIG9yaWdpbjogc3BhT3JpZ2luLFxuICAgICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IHNwYUNvbmZpZy5jYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfT1BUSU1JWkVELFxuICAgICAgICAgICAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgICAgICAgICAgIC4uLih0aGlzLnNwYVJld3JpdGVGdW5jdGlvblxuICAgICAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uQXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmdW5jdGlvbjogdGhpcy5zcGFSZXdyaXRlRnVuY3Rpb24sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV2ZW50VHlwZTogY2xvdWRmcm9udC5GdW5jdGlvbkV2ZW50VHlwZS5WSUVXRVJfUkVRVUVTVCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICAuLi4ocHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZGlzdHJpYnV0aW9uXG4gICAgICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgICAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICAgICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICAgICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IGFwaU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19ESVNBQkxFRCxcbiAgICAgICAgICAgICAgICBvcmlnaW5SZXF1ZXN0UG9saWN5OiBwcm9wcy5hcGlPcmlnaW5SZXF1ZXN0UG9saWN5LFxuICAgICAgICAgICAgICAgIC4uLihwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3lcbiAgICAgICAgICAgICAgICAgICAgPyB7IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5IH1cbiAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgYWRkaXRpb25hbEJlaGF2aW9ycyxcbiAgICAgICAgICAgIC4uLihwcm9wcy53ZWJBY2xJZCA/IHsgd2ViQWNsSWQ6IHByb3BzLndlYkFjbElkIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMucHJpY2VDbGFzcyA/IHsgcHJpY2VDbGFzczogcHJvcHMucHJpY2VDbGFzcyB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLmNvbW1lbnQgPyB7IGNvbW1lbnQ6IHByb3BzLmNvbW1lbnQgfSA6IHt9KSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgQSByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbj8uZG9tYWluTmFtZSAmJiBwcm9wcy5kb21haW4/Lmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0cyB0aGUgZG9tYWluIG5hbWUgZnJvbSBhIFVSTCAoZS5nLiwgXCJodHRwczovL2FwaS5leGFtcGxlLmNvbS9wYXRoXCIgLT4gXCJhcGkuZXhhbXBsZS5jb21cIikuXG4gICAgICovXG4gICAgcHJpdmF0ZSBwYXJzZU9yaWdpbkZyb21VcmwodXJsOiBzdHJpbmcpOiB7IGRvbWFpbk5hbWU6IHN0cmluZzsgb3JpZ2luUGF0aD86IHN0cmluZyB9IHtcbiAgICAgICAgY29uc3QgdXJsU3RyID0gU3RyaW5nKHVybCA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgIGlmICghdXJsU3RyKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlQYXRoUm91dGVkRnJvbnRlbmQgcmVxdWlyZXMgYSBub24tZW1wdHkgYXBpT3JpZ2luVXJsXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gRnVsbCBVUkwgKHJlY29tbWVuZGVkKTogaHR0cHM6Ly9hcGkuZXhhbXBsZS5jb20vcHJvZFxuICAgICAgICBpZiAodXJsU3RyLmluY2x1ZGVzKFwiOi8vXCIpKSB7XG4gICAgICAgICAgICBjb25zdCBwYXJzZWQgPSBuZXcgVVJMKHVybFN0cik7XG4gICAgICAgICAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHBhcnNlZC5ob3N0bmFtZSA/PyBcIlwiKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoIWRvbWFpbk5hbWUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBjb3VsZCBub3QgcGFyc2UgZG9tYWluIGZyb20gYXBpT3JpZ2luVXJsOiAke3VybFN0cn1gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29uc3QgcGF0aCA9IFN0cmluZyhwYXJzZWQucGF0aG5hbWUgPz8gXCJcIikudHJpbSgpO1xuICAgICAgICAgICAgY29uc3Qgb3JpZ2luUGF0aCA9IHBhdGggJiYgcGF0aCAhPT0gXCIvXCIgPyBwYXRoLnJlcGxhY2UoL1xcLyskLywgXCJcIikgOiB1bmRlZmluZWQ7XG4gICAgICAgICAgICByZXR1cm4geyBkb21haW5OYW1lLCAuLi4ob3JpZ2luUGF0aCA/IHsgb3JpZ2luUGF0aCB9IDoge30pIH07XG4gICAgICAgIH1cblxuICAgICAgICAvLyBCYXJlIGRvbWFpbiAob3IgZG9tYWluICsgcGF0aCk6IGFwaS5leGFtcGxlLmNvbSBvciBhcGkuZXhhbXBsZS5jb20vcHJvZFxuICAgICAgICBjb25zdCB3aXRob3V0UXVlcnkgPSB1cmxTdHIuc3BsaXQoXCI/XCIpWzBdPy5zcGxpdChcIiNcIilbMF0gPz8gdXJsU3RyO1xuICAgICAgICBjb25zdCBmaXJzdFNsYXNoSW5kZXggPSB3aXRob3V0UXVlcnkuaW5kZXhPZihcIi9cIik7XG4gICAgICAgIGNvbnN0IGRvbWFpblBhcnQgPSAoZmlyc3RTbGFzaEluZGV4ID49IDAgPyB3aXRob3V0UXVlcnkuc2xpY2UoMCwgZmlyc3RTbGFzaEluZGV4KSA6IHdpdGhvdXRRdWVyeSlcbiAgICAgICAgICAgIC50cmltKClcbiAgICAgICAgICAgIC5yZXBsYWNlKC86XFxkKyQvLCBcIlwiKTtcbiAgICAgICAgaWYgKCFkb21haW5QYXJ0KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCBjb3VsZCBub3QgcGFyc2UgZG9tYWluIGZyb20gYXBpT3JpZ2luVXJsOiAke3VybFN0cn1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHBhdGhQYXJ0ID0gZmlyc3RTbGFzaEluZGV4ID49IDAgPyB3aXRob3V0UXVlcnkuc2xpY2UoZmlyc3RTbGFzaEluZGV4KSA6IFwiXCI7XG4gICAgICAgIGNvbnN0IG9yaWdpblBhdGggPSBwYXRoUGFydCAmJiBwYXRoUGFydCAhPT0gXCIvXCIgPyBwYXRoUGFydC5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpIDogdW5kZWZpbmVkO1xuICAgICAgICByZXR1cm4geyBkb21haW5OYW1lOiBkb21haW5QYXJ0LCAuLi4ob3JpZ2luUGF0aCA/IHsgb3JpZ2luUGF0aCB9IDoge30pIH07XG4gICAgfVxufVxuIl19