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
        // Parse the API origin URL to create an HttpOrigin
        const apiOriginDomainName = this.extractDomainFromUrl(props.apiOriginUrl);
        const apiOrigin = new origins.HttpOrigin(apiOriginDomainName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
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
    extractDomainFromUrl(url) {
        // Handle both full URLs and bare domain names
        const urlStr = String(url).trim();
        if (urlStr.includes("://")) {
            const withoutProtocol = urlStr.split("://")[1];
            return (withoutProtocol.split("/")[0] || withoutProtocol).replace(/:\d+$/, "");
        }
        // Already a domain name
        return urlStr.split("/")[0].replace(/:\d+$/, "");
    }
}
exports.AppTheoryPathRoutedFrontend = AppTheoryPathRoutedFrontend;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryPathRoutedFrontend[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryPathRoutedFrontend", version: "0.5.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicGF0aC1yb3V0ZWQtZnJvbnRlbmQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJwYXRoLXJvdXRlZC1mcm9udGVuZC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7OztBQUFBLDZDQUE0QztBQUM1QywwREFBMEQ7QUFDMUQseURBQXlEO0FBQ3pELDhEQUE4RDtBQUM5RCxtREFBbUQ7QUFDbkQsMkRBQTJEO0FBQzNELHlDQUF5QztBQUN6QywyQ0FBdUM7QUFrSnZDOzs7R0FHRztBQUNILFNBQVMsOEJBQThCLENBQUMsZUFBeUI7SUFDN0QsTUFBTSxhQUFhLEdBQUcsZUFBZTtTQUNoQyxHQUFHLENBQUMsQ0FBQyxNQUFNLEVBQUUsRUFBRTtRQUNaLE1BQU0sV0FBVyxHQUFHLE1BQU0sQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ2hELE9BQU8sY0FBYyxXQUFXLG1CQUFtQixXQUFXLGdCQUFnQixDQUFDO0lBQ25GLENBQUMsQ0FBQztTQUNELElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUV2QixPQUFPOzs7Ozs7O1FBT0gsYUFBYTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F1QnBCLENBQUMsSUFBSSxFQUFFLENBQUM7QUFDVCxDQUFDO0FBRUQ7Ozs7Ozs7Ozs7R0FVRztBQUNILE1BQWEsMkJBQTRCLFNBQVEsc0JBQVM7SUFxQnRELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBdUM7UUFDN0UsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixJQUFJLENBQUMsS0FBSyxDQUFDLFlBQVksRUFBRSxDQUFDO1lBQ3RCLE1BQU0sSUFBSSxLQUFLLENBQUMseURBQXlELENBQUMsQ0FBQztRQUMvRSxDQUFDO1FBRUQsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsSUFBSSwyQkFBYSxDQUFDLE1BQU0sQ0FBQztRQUNsRSxNQUFNLGlCQUFpQixHQUFHLEtBQUssQ0FBQyxpQkFBaUIs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SSxPQUFPLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO2FBQzFGLENBQUMsQ0FBQztRQUNQLENBQUM7SUFDTCxDQUFDO0lBRUQ7O09BRUc7SUFDSyxvQkFBb0IsQ0FBQyxHQUFXO1FBQ3BDLDhDQUE4QztRQUM5QyxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7UUFDbEMsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7WUFDekIsTUFBTSxlQUFlLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztZQUMvQyxPQUFPLENBQUMsZUFBZSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxlQUFlLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBQ25GLENBQUM7UUFDRCx3QkFBd0I7UUFDeEIsT0FBTyxNQUFNLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUM7SUFDckQsQ0FBQzs7QUE3TEwsa0VBOExDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbi8qKlxuICogQ29uZmlndXJhdGlvbiBmb3IgYW4gU1BBIG9yaWdpbiByb3V0ZWQgYnkgcGF0aCBwcmVmaXguXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3BhT3JpZ2luQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBTMyBidWNrZXQgY29udGFpbmluZyB0aGUgU1BBIGFzc2V0cy5cbiAgICAgKi9cbiAgICByZWFkb25seSBidWNrZXQ6IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBQYXRoIHBhdHRlcm4gdG8gcm91dGUgdG8gdGhpcyBTUEEgKGUuZy4sIFwiL2wvKlwiLCBcIi9hdXRoLypcIikuXG4gICAgICogTXVzdCBpbmNsdWRlIHRoZSB0cmFpbGluZyB3aWxkY2FyZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBwYXRoUGF0dGVybjogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgY2FjaGUgcG9saWN5IG92ZXJyaWRlLiBEZWZhdWx0cyB0byBDQUNISU5HX09QVElNSVpFRC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xufVxuXG4vKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIHBhdGggcGF0dGVybnMgdGhhdCBzaG91bGQgYnlwYXNzIFNQQSByb3V0aW5nIGFuZCBnbyBkaXJlY3RseSB0byB0aGUgQVBJIG9yaWdpbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcGlCeXBhc3NDb25maWcge1xuICAgIC8qKlxuICAgICAqIFBhdGggcGF0dGVybiB0aGF0IHNob3VsZCByb3V0ZSB0byB0aGUgQVBJIG9yaWdpbiBpbnN0ZWFkIG9mIFNQQSAoZS5nLiwgXCIvYXV0aC93YWxsZXQvKlwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBwYXRoUGF0dGVybjogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgY2FjaGUgcG9saWN5IG92ZXJyaWRlLiBEZWZhdWx0cyB0byBDQUNISU5HX0RJU0FCTEVELlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBvcmlnaW4gcmVxdWVzdCBwb2xpY3kgb3ZlcnJpZGUuXG4gICAgICovXG4gICAgcmVhZG9ubHkgb3JpZ2luUmVxdWVzdFBvbGljeT86IGNsb3VkZnJvbnQuSU9yaWdpblJlcXVlc3RQb2xpY3k7XG59XG5cbi8qKlxuICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQYXRoUm91dGVkRnJvbnRlbmREb21haW5Db25maWcge1xuICAgIC8qKlxuICAgICAqIFRoZSBkb21haW4gbmFtZSBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoZS5nLiwgXCJhcHAuZXhhbXBsZS5jb21cIikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQUNNIGNlcnRpZmljYXRlIGZvciBIVFRQUy4gTXVzdCBiZSBpbiB1cy1lYXN0LTEgZm9yIENsb3VkRnJvbnQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgLyoqXG4gICAgICogQVJOIG9mIGFuIGV4aXN0aW5nIEFDTSBjZXJ0aWZpY2F0ZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIEROUyByZWNvcmQgY3JlYXRpb24uXG4gICAgICogV2hlbiBwcm92aWRlZCwgYW4gQSByZWNvcmQgYWxpYXMgd2lsbCBiZSBjcmVhdGVkIGZvciB0aGUgZG9tYWluLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZFByb3BzIHtcbiAgICAvKipcbiAgICAgKiBUaGUgcHJpbWFyeSBBUEkgb3JpZ2luIFVSTCAoZS5nLiwgdGhlIEFQSSBHYXRld2F5IGludm9rZSBVUkwgb3IgTGFtYmRhIGZ1bmN0aW9uIFVSTCkuXG4gICAgICogVGhpcyBpcyB1c2VkIGZvciB0aGUgZGVmYXVsdCBiZWhhdmlvciBhbmQgYW55IEFQSSBieXBhc3MgcGF0aHMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpT3JpZ2luVXJsOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBTUEEgb3JpZ2lucyB3aXRoIHRoZWlyIHBhdGggcGF0dGVybnMuXG4gICAgICogRWFjaCBTUEEgd2lsbCBiZSBzZXJ2ZWQgdmlhIENsb3VkRnJvbnQgd2l0aCBTUEEgcmV3cml0ZSBzdXBwb3J0LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHNwYU9yaWdpbnM/OiBTcGFPcmlnaW5Db25maWdbXTtcblxuICAgIC8qKlxuICAgICAqIEFQSSBieXBhc3MgY29uZmlndXJhdGlvbnMgZm9yIHBhdGhzIHRoYXQgc2hvdWxkIGdvIGRpcmVjdGx5IHRvIHRoZSBBUEkgb3JpZ2luXG4gICAgICogZXZlbiB0aG91Z2ggdGhleSBtaWdodCBtYXRjaCBhbiBTUEEgcGF0aCBwcmVmaXguXG4gICAgICogVGhlc2UgYXJlIGV2YWx1YXRlZCBiZWZvcmUgU1BBIHBhdGhzIGR1ZSB0byBDbG91ZEZyb250IGJlaGF2aW9yIHByZWNlZGVuY2UuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXBpQnlwYXNzUGF0aHM/OiBBcGlCeXBhc3NDb25maWdbXTtcblxuICAgIC8qKlxuICAgICAqIERvbWFpbiBjb25maWd1cmF0aW9uIGZvciBjdXN0b20gZG9tYWluLCBjZXJ0aWZpY2F0ZSwgYW5kIFJvdXRlNTMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluPzogUGF0aFJvdXRlZEZyb250ZW5kRG9tYWluQ29uZmlnO1xuXG4gICAgLyoqXG4gICAgICogUmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgdG8gYXBwbHkgdG8gYWxsIGJlaGF2aW9ycy5cbiAgICAgKi9cbiAgICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBPcmlnaW4gcmVxdWVzdCBwb2xpY3kgZm9yIHRoZSBBUEkgb3JpZ2luIChkZWZhdWx0IGJlaGF2aW9yKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBhcGlPcmlnaW5SZXF1ZXN0UG9saWN5PzogY2xvdWRmcm9udC5JT3JpZ2luUmVxdWVzdFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBDbG91ZEZyb250IGFjY2VzcyBsb2dnaW5nLlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmFibGVMb2dnaW5nPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIFMzIGJ1Y2tldCBmb3IgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncy5cbiAgICAgKiBJZiBub3QgcHJvdmlkZWQgYW5kIGVuYWJsZUxvZ2dpbmcgaXMgdHJ1ZSwgYSBuZXcgYnVja2V0IHdpbGwgYmUgY3JlYXRlZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFJlbW92YWwgcG9saWN5IGZvciBjcmVhdGVkIHJlc291cmNlcy5cbiAgICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBhdXRvLWRlbGV0ZSBvYmplY3RzIGluIGNyZWF0ZWQgYnVja2V0cyBvbiBzdGFjayBkZWxldGlvbi5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiByZW1vdmFsUG9saWN5IGlzIERFU1RST1kuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhdXRvRGVsZXRlT2JqZWN0cz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCB3ZWIgQUNMIElEIGZvciBBV1MgV0FGIGludGVncmF0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHdlYkFjbElkPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUHJpY2UgY2xhc3MgZm9yIHRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICAgKiBAZGVmYXVsdCBQcmljZUNsYXNzLlBSSUNFX0NMQVNTX0FMTFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHByaWNlQ2xhc3M/OiBjbG91ZGZyb250LlByaWNlQ2xhc3M7XG5cbiAgICAvKipcbiAgICAgKiBBbiBvcHRpb25hbCBuYW1lL2NvbW1lbnQgZm9yIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgY29tbWVudD86IHN0cmluZztcbn1cblxuLyoqXG4gKiBDbG91ZEZyb250IEZ1bmN0aW9uIGNvZGUgZm9yIFNQQSB2aWV3ZXItcmVxdWVzdCByZXdyaXRlLlxuICogUmV3cml0ZXMgcmVxdWVzdHMgd2l0aG91dCBmaWxlIGV4dGVuc2lvbnMgdG8gdGhlIGluZGV4Lmh0bWwgd2l0aGluIHRoZSBwcmVmaXguXG4gKi9cbmZ1bmN0aW9uIGdlbmVyYXRlU3BhUmV3cml0ZUZ1bmN0aW9uQ29kZShzcGFQYXRoUHJlZml4ZXM6IHN0cmluZ1tdKTogc3RyaW5nIHtcbiAgICBjb25zdCBwcmVmaXhNYXRjaGVzID0gc3BhUGF0aFByZWZpeGVzXG4gICAgICAgIC5tYXAoKHByZWZpeCkgPT4ge1xuICAgICAgICAgICAgY29uc3QgY2xlYW5QcmVmaXggPSBwcmVmaXgucmVwbGFjZSgvXFwvXFwqJC8sIFwiXCIpO1xuICAgICAgICAgICAgcmV0dXJuIGB7IHByZWZpeDogJyR7Y2xlYW5QcmVmaXh9LycsIGluZGV4UGF0aDogJyR7Y2xlYW5QcmVmaXh9L2luZGV4Lmh0bWwnIH1gO1xuICAgICAgICB9KVxuICAgICAgICAuam9pbihcIixcXG4gICAgICBcIik7XG5cbiAgICByZXR1cm4gYFxuZnVuY3Rpb24gaGFuZGxlcihldmVudCkge1xuICB2YXIgcmVxdWVzdCA9IGV2ZW50LnJlcXVlc3Q7XG4gIHZhciB1cmkgPSByZXF1ZXN0LnVyaTtcblxuICAvLyBTUEEgcHJlZml4IGNvbmZpZ3VyYXRpb25zXG4gIHZhciBzcGFQcmVmaXhlcyA9IFtcbiAgICAgICR7cHJlZml4TWF0Y2hlc31cbiAgXTtcblxuICAvLyBDaGVjayBpZiB0aGlzIGlzIGFuIFNQQSBwYXRoXG4gIGZvciAodmFyIGkgPSAwOyBpIDwgc3BhUHJlZml4ZXMubGVuZ3RoOyBpKyspIHtcbiAgICB2YXIgc3BhID0gc3BhUHJlZml4ZXNbaV07XG4gICAgaWYgKHVyaS5zdGFydHNXaXRoKHNwYS5wcmVmaXgpKSB7XG4gICAgICAvLyBJZiB0aGUgVVJJIGRvZXNuJ3QgaGF2ZSBhbiBleHRlbnNpb24gKG5vIGZpbGUpLCByZXdyaXRlIHRvIGluZGV4Lmh0bWxcbiAgICAgIHZhciB1cmlXaXRob3V0UHJlZml4ID0gdXJpLnN1YnN0cmluZyhzcGEucHJlZml4Lmxlbmd0aCk7XG4gICAgICAvLyBDaGVjayBpZiBpdCBoYXMgYSBmaWxlIGV4dGVuc2lvbiAoY29udGFpbnMgYSBkb3QgaW4gdGhlIGxhc3QgcGF0aCBzZWdtZW50KVxuICAgICAgdmFyIGxhc3RTbGFzaCA9IHVyaVdpdGhvdXRQcmVmaXgubGFzdEluZGV4T2YoJy8nKTtcbiAgICAgIHZhciBsYXN0U2VnbWVudCA9IGxhc3RTbGFzaCA+PSAwID8gdXJpV2l0aG91dFByZWZpeC5zdWJzdHJpbmcobGFzdFNsYXNoICsgMSkgOiB1cmlXaXRob3V0UHJlZml4O1xuICAgICAgXG4gICAgICAvLyBJZiBubyBleHRlbnNpb24gaW4gdGhlIGxhc3Qgc2VnbWVudCwgc2VydmUgaW5kZXguaHRtbFxuICAgICAgaWYgKGxhc3RTZWdtZW50LmluZGV4T2YoJy4nKSA9PT0gLTEpIHtcbiAgICAgICAgcmVxdWVzdC51cmkgPSBzcGEuaW5kZXhQYXRoO1xuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHJlcXVlc3Q7XG59XG5gLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBBIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIGZvciBwYXRoLXJvdXRlZCBtdWx0aS1TUEEgKyBBUEkgZGVwbG95bWVudHMuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgY3JlYXRlcyBhIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIHRoYXQgcm91dGVzIHJlcXVlc3RzIHRvOlxuICogLSBTUEEgb3JpZ2lucyAoUzMgYnVja2V0cykgYmFzZWQgb24gcGF0aCBwcmVmaXhlcyAoZS5nLiwgL2wvKiwgL2F1dGgvKilcbiAqIC0gQVBJIG9yaWdpbiAoZGVmYXVsdCBiZWhhdmlvcikgZm9yIGFsbCBvdGhlciBwYXRoc1xuICogLSBBUEkgYnlwYXNzIHBhdGhzIGZvciBzcGVjaWZpYyBwYXRocyB0aGF0IHNob3VsZCBza2lwIFNQQSByb3V0aW5nXG4gKlxuICogQSBDbG91ZEZyb250IEZ1bmN0aW9uIGhhbmRsZXMgdmlld2VyLXJlcXVlc3QgcmV3cml0aW5nIGZvciBTUEEgcm91dGluZyxcbiAqIGVuc3VyaW5nIHRoYXQgcGF0aHMgd2l0aG91dCBmaWxlIGV4dGVuc2lvbnMgYXJlIHJld3JpdHRlbiB0byBpbmRleC5odG1sLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBGdW5jdGlvbiBmb3IgU1BBIHJld3JpdGUgKGlmIFNQQSBvcmlnaW5zIGFyZSBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgc3BhUmV3cml0ZUZ1bmN0aW9uPzogY2xvdWRmcm9udC5GdW5jdGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGJ1Y2tldCAoaWYgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgY2VydGlmaWNhdGUgdXNlZCBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoaWYgY3VzdG9tIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZFByb3BzKSB7XG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAgICAgaWYgKCFwcm9wcy5hcGlPcmlnaW5VcmwpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVBhdGhSb3V0ZWRGcm9udGVuZCByZXF1aXJlcyBwcm9wcy5hcGlPcmlnaW5VcmxcIik7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICAgICAgY29uc3QgYXV0b0RlbGV0ZU9iamVjdHMgPSBwcm9wcy5hdXRvRGVsZXRlT2JqZWN0cyA/PyBmYWxzZTtcbiAgICAgICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcblxuICAgICAgICAvLyBDcmVhdGUgbG9ncyBidWNrZXQgaWYgbG9nZ2luZyBpcyBlbmFibGVkXG4gICAgICAgIGlmIChlbmFibGVMb2dnaW5nKSB7XG4gICAgICAgICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICAgICAgICAgIHByb3BzLmxvZ3NCdWNrZXQgPz9cbiAgICAgICAgICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgICAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgICAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgICAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5PQkpFQ1RfV1JJVEVSLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gUGFyc2UgdGhlIEFQSSBvcmlnaW4gVVJMIHRvIGNyZWF0ZSBhbiBIdHRwT3JpZ2luXG4gICAgICAgIGNvbnN0IGFwaU9yaWdpbkRvbWFpbk5hbWUgPSB0aGlzLmV4dHJhY3REb21haW5Gcm9tVXJsKHByb3BzLmFwaU9yaWdpblVybCk7XG4gICAgICAgIGNvbnN0IGFwaU9yaWdpbiA9IG5ldyBvcmlnaW5zLkh0dHBPcmlnaW4oYXBpT3JpZ2luRG9tYWluTmFtZSwge1xuICAgICAgICAgICAgcHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuT3JpZ2luUHJvdG9jb2xQb2xpY3kuSFRUUFNfT05MWSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy8gSGFuZGxlIGRvbWFpbiBjb25maWd1cmF0aW9uXG4gICAgICAgIGxldCBkaXN0cmlidXRpb25Eb21haW5OYW1lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gICAgICAgIGxldCBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTogYWNtLklDZXJ0aWZpY2F0ZSB8IHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICAgICAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbi5kb21haW5OYW1lKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoZG9tYWluTmFtZSkge1xuICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzID0gW2RvbWFpbk5hbWVdO1xuXG4gICAgICAgICAgICAgICAgaWYgKHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZUFybikge1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4oXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gQ3JlYXRlIGEgRE5TLXZhbGlkYXRlZCBjZXJ0aWZpY2F0ZVxuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IG5ldyBhY20uRG5zVmFsaWRhdGVkQ2VydGlmaWNhdGUodGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkb21haW5OYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgaG9zdGVkWm9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgICAgICAgICByZWdpb246IFwidXMtZWFzdC0xXCIsXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiQXBwVGhlb3J5UGF0aFJvdXRlZEZyb250ZW5kIHJlcXVpcmVzIGRvbWFpbi5jZXJ0aWZpY2F0ZSwgZG9tYWluLmNlcnRpZmljYXRlQXJuLCBvciBkb21haW4uaG9zdGVkWm9uZSB3aGVuIGRvbWFpbi5kb21haW5OYW1lIGlzIHNldFwiLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTtcblxuICAgICAgICAvLyBDcmVhdGUgQ2xvdWRGcm9udCBGdW5jdGlvbiBmb3IgU1BBIHJld3JpdGUgaWYgU1BBIG9yaWdpbnMgYXJlIGNvbmZpZ3VyZWRcbiAgICAgICAgY29uc3Qgc3BhT3JpZ2lucyA9IHByb3BzLnNwYU9yaWdpbnMgPz8gW107XG4gICAgICAgIGlmIChzcGFPcmlnaW5zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IHNwYVBhdGhQcmVmaXhlcyA9IHNwYU9yaWdpbnMubWFwKChzcGEpID0+IHNwYS5wYXRoUGF0dGVybik7XG4gICAgICAgICAgICBjb25zdCBmdW5jdGlvbkNvZGUgPSBnZW5lcmF0ZVNwYVJld3JpdGVGdW5jdGlvbkNvZGUoc3BhUGF0aFByZWZpeGVzKTtcblxuICAgICAgICAgICAgdGhpcy5zcGFSZXdyaXRlRnVuY3Rpb24gPSBuZXcgY2xvdWRmcm9udC5GdW5jdGlvbih0aGlzLCBcIlNwYVJld3JpdGVGdW5jdGlvblwiLCB7XG4gICAgICAgICAgICAgICAgY29kZTogY2xvdWRmcm9udC5GdW5jdGlvbkNvZGUuZnJvbUlubGluZShmdW5jdGlvbkNvZGUpLFxuICAgICAgICAgICAgICAgIHJ1bnRpbWU6IGNsb3VkZnJvbnQuRnVuY3Rpb25SdW50aW1lLkpTXzJfMCxcbiAgICAgICAgICAgICAgICBjb21tZW50OiBcIlNQQSB2aWV3ZXItcmVxdWVzdCByZXdyaXRlIGZvciBwYXRoLXJvdXRlZCBmcm9udGVuZFwiLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBCdWlsZCBhZGRpdGlvbmFsIGJlaGF2aW9yc1xuICAgICAgICBjb25zdCBhZGRpdGlvbmFsQmVoYXZpb3JzOiBSZWNvcmQ8c3RyaW5nLCBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucz4gPSB7fTtcblxuICAgICAgICAvLyBBZGQgQVBJIGJ5cGFzcyBwYXRocyBmaXJzdCAoaGlnaGVyIHByZWNlZGVuY2UgaW4gQ2xvdWRGcm9udClcbiAgICAgICAgZm9yIChjb25zdCBieXBhc3NDb25maWcgb2YgcHJvcHMuYXBpQnlwYXNzUGF0aHMgPz8gW10pIHtcbiAgICAgICAgICAgIGFkZGl0aW9uYWxCZWhhdmlvcnNbYnlwYXNzQ29uZmlnLnBhdGhQYXR0ZXJuXSA9IHtcbiAgICAgICAgICAgICAgICBvcmlnaW46IGFwaU9yaWdpbixcbiAgICAgICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19BTEwsXG4gICAgICAgICAgICAgICAgY2FjaGVQb2xpY3k6IGJ5cGFzc0NvbmZpZy5jYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfRElTQUJMRUQsXG4gICAgICAgICAgICAgICAgb3JpZ2luUmVxdWVzdFBvbGljeTpcbiAgICAgICAgICAgICAgICAgICAgYnlwYXNzQ29uZmlnLm9yaWdpblJlcXVlc3RQb2xpY3kgPz8gcHJvcHMuYXBpT3JpZ2luUmVxdWVzdFBvbGljeSxcbiAgICAgICAgICAgICAgICAuLi4ocHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5XG4gICAgICAgICAgICAgICAgICAgID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFkZCBTUEEgb3JpZ2luIGJlaGF2aW9yc1xuICAgICAgICBmb3IgKGNvbnN0IHNwYUNvbmZpZyBvZiBzcGFPcmlnaW5zKSB7XG4gICAgICAgICAgICBjb25zdCBzcGFPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHNwYUNvbmZpZy5idWNrZXQpO1xuXG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzW3NwYUNvbmZpZy5wYXRoUGF0dGVybl0gPSB7XG4gICAgICAgICAgICAgICAgb3JpZ2luOiBzcGFPcmlnaW4sXG4gICAgICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgICAgICAgICAgICBjYWNoZVBvbGljeTogc3BhQ29uZmlnLmNhY2hlUG9saWN5ID8/IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19PUFRJTUlaRUQsXG4gICAgICAgICAgICAgICAgY29tcHJlc3M6IHRydWUsXG4gICAgICAgICAgICAgICAgLi4uKHRoaXMuc3BhUmV3cml0ZUZ1bmN0aW9uXG4gICAgICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgZnVuY3Rpb25Bc3NvY2lhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZ1bmN0aW9uOiB0aGlzLnNwYVJld3JpdGVGdW5jdGlvbixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZXZlbnRUeXBlOiBjbG91ZGZyb250LkZ1bmN0aW9uRXZlbnRUeXBlLlZJRVdFUl9SRVFVRVNULFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICBdLFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgIC4uLihwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3lcbiAgICAgICAgICAgICAgICAgICAgPyB7IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5IH1cbiAgICAgICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBkaXN0cmlidXRpb25cbiAgICAgICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgXCJEaXN0cmlidXRpb25cIiwge1xuICAgICAgICAgICAgLi4uKGVuYWJsZUxvZ2dpbmcgJiYgdGhpcy5sb2dzQnVja2V0XG4gICAgICAgICAgICAgICAgPyB7IGVuYWJsZUxvZ2dpbmc6IHRydWUsIGxvZ0J1Y2tldDogdGhpcy5sb2dzQnVja2V0LCBsb2dGaWxlUHJlZml4OiBcImNsb3VkZnJvbnQvXCIgfVxuICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgLi4uKGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzICYmIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlXG4gICAgICAgICAgICAgICAgPyB7IGRvbWFpbk5hbWVzOiBkaXN0cmlidXRpb25Eb21haW5OYW1lcywgY2VydGlmaWNhdGU6IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIGRlZmF1bHRCZWhhdmlvcjoge1xuICAgICAgICAgICAgICAgIG9yaWdpbjogYXBpT3JpZ2luLFxuICAgICAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0FMTCxcbiAgICAgICAgICAgICAgICBjYWNoZVBvbGljeTogY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX0RJU0FCTEVELFxuICAgICAgICAgICAgICAgIG9yaWdpblJlcXVlc3RQb2xpY3k6IHByb3BzLmFwaU9yaWdpblJlcXVlc3RQb2xpY3ksXG4gICAgICAgICAgICAgICAgLi4uKHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeVxuICAgICAgICAgICAgICAgICAgICA/IHsgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBhZGRpdGlvbmFsQmVoYXZpb3JzLFxuICAgICAgICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5wcmljZUNsYXNzID8geyBwcmljZUNsYXNzOiBwcm9wcy5wcmljZUNsYXNzIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMuY29tbWVudCA/IHsgY29tbWVudDogcHJvcHMuY29tbWVudCB9IDoge30pLFxuICAgICAgICB9KTtcblxuICAgICAgICAvLyBDcmVhdGUgUm91dGU1MyBBIHJlY29yZCBpZiBob3N0ZWQgem9uZSBpcyBwcm92aWRlZFxuICAgICAgICBpZiAocHJvcHMuZG9tYWluPy5kb21haW5OYW1lICYmIHByb3BzLmRvbWFpbj8uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgICAgICAgICB6b25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW4uZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3RzIHRoZSBkb21haW4gbmFtZSBmcm9tIGEgVVJMIChlLmcuLCBcImh0dHBzOi8vYXBpLmV4YW1wbGUuY29tL3BhdGhcIiAtPiBcImFwaS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICBwcml2YXRlIGV4dHJhY3REb21haW5Gcm9tVXJsKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgICAgICAgLy8gSGFuZGxlIGJvdGggZnVsbCBVUkxzIGFuZCBiYXJlIGRvbWFpbiBuYW1lc1xuICAgICAgICBjb25zdCB1cmxTdHIgPSBTdHJpbmcodXJsKS50cmltKCk7XG4gICAgICAgIGlmICh1cmxTdHIuaW5jbHVkZXMoXCI6Ly9cIikpIHtcbiAgICAgICAgICAgIGNvbnN0IHdpdGhvdXRQcm90b2NvbCA9IHVybFN0ci5zcGxpdChcIjovL1wiKVsxXTtcbiAgICAgICAgICAgIHJldHVybiAod2l0aG91dFByb3RvY29sLnNwbGl0KFwiL1wiKVswXSB8fCB3aXRob3V0UHJvdG9jb2wpLnJlcGxhY2UoLzpcXGQrJC8sIFwiXCIpO1xuICAgICAgICB9XG4gICAgICAgIC8vIEFscmVhZHkgYSBkb21haW4gbmFtZVxuICAgICAgICByZXR1cm4gdXJsU3RyLnNwbGl0KFwiL1wiKVswXS5yZXBsYWNlKC86XFxkKyQvLCBcIlwiKTtcbiAgICB9XG59XG4iXX0=