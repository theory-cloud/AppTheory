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
exports.AppTheoryMediaCdn = void 0;
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
const refuse_explicit_name_1 = require("./private/refuse-explicit-name");
const standard_logging_1 = require("./private/standard-logging");
function assertCloudFrontHostedZoneCertificateRegion(scope, constructName) {
    const region = aws_cdk_lib_1.Stack.of(scope).region;
    if (!aws_cdk_lib_1.Token.isUnresolved(region) && region === "us-east-1") {
        return;
    }
    const regionDescription = aws_cdk_lib_1.Token.isUnresolved(region) ? "unresolved" : region;
    throw new Error(`${constructName} cannot create a hosted-zone CloudFront certificate unless the stack region is explicitly us-east-1; stack region is ${regionDescription}. Provide domain.certificate or domain.certificateArn for stacks in other or environment-agnostic regions.`);
}
/**
 * A CloudFront distribution optimized for serving media assets from S3.
 *
 * This construct creates or wraps an S3 bucket with a CloudFront distribution
 * configured for media delivery. It supports:
 * - Custom domain with certificate and Route53 integration
 * - Private media access via signed URLs/cookies (trusted key groups)
 * - Customizable caching and response headers
 * - Access logging
 *
 * Use cases:
 * - Public media CDN (images, videos, documents)
 * - Private/authenticated media access
 * - Stage-specific media subdomains (e.g., media.stage.example.com)
 */
class AppTheoryMediaCdn extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMediaCdn", version: "7.4.0" };
    /**
     * The CloudFront distribution.
     */
    distribution;
    /**
     * The S3 bucket for media assets.
     */
    bucket;
    /**
     * The CloudFront access logs bucket (if logging is enabled).
     */
    logsBucket;
    /**
     * The certificate used for the distribution (if custom domain is configured).
     */
    certificate;
    /**
     * The key group for private media access (if configured).
     */
    keyGroup;
    /**
     * The public key created for private media (if created from PEM).
     */
    publicKey;
    constructor(scope, id, props) {
        super(scope, id);
        const removalPolicy = props.removalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const autoDeleteObjects = props.autoDeleteObjects ?? false;
        const enableLogging = props.enableLogging ?? true;
        const namingContext = props.namingContext;
        const logical = props.logicalName ?? (namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryMediaCdn", "bucketName", "s3_bucket", logical ? `${logical}-media` : undefined, props.bucketName !== undefined);
        if (namingContext?.standardLogging === true && props.logsBucket !== undefined) {
            throw new Error("AppTheoryMediaCdn cannot honor props.logsBucket under the standard logging profile; CloudFront access logs go to the contract log group, so remove props.logsBucket or use the legacy logging profile");
        }
        const standardLogging = namingContext?.standardLogging === true && enableLogging;
        // Create or use the provided media bucket
        if (props.bucket) {
            this.bucket = props.bucket;
        }
        else {
            this.bucket = new s3.Bucket(this, "MediaBucket", {
                ...(namingContext && logical
                    ? (0, standard_logging_1.bucketNamingProps)(namingContext, `${logical}-media`)
                    : { bucketName: props.bucketName }),
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                encryption: s3.BucketEncryption.S3_MANAGED,
                enforceSSL: true,
                removalPolicy,
                autoDeleteObjects,
                objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
                versioned: false,
            });
        }
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
        // Handle private media configuration
        if (props.privateMedia) {
            if (props.privateMedia.keyGroup) {
                this.keyGroup = props.privateMedia.keyGroup;
            }
            else if (props.privateMedia.publicKeyPem) {
                // Create a public key from the PEM
                this.publicKey = new cloudfront.PublicKey(this, "PublicKey", {
                    encodedKey: props.privateMedia.publicKeyPem,
                    publicKeyName: props.privateMedia.publicKeyName,
                    comment: "Public key for Media CDN signed URLs",
                });
                // Create a key group with the public key
                this.keyGroup = new cloudfront.KeyGroup(this, "KeyGroup", {
                    keyGroupName: props.privateMedia.keyGroupName,
                    items: [this.publicKey],
                    comment: props.privateMedia.keyGroupComment ?? "Key group for Media CDN private access",
                });
            }
        }
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
                    assertCloudFrontHostedZoneCertificateRegion(this, "AppTheoryMediaCdn");
                    distributionCertificate = new acm.Certificate(this, "Certificate", {
                        domainName,
                        validation: acm.CertificateValidation.fromDns(props.domain.hostedZone),
                    });
                }
                else {
                    throw new Error("AppTheoryMediaCdn requires domain.certificate, domain.certificateArn, or domain.hostedZone when domain.domainName is set");
                }
            }
        }
        this.certificate = distributionCertificate;
        // Create the S3 origin with Origin Access Control
        const mediaBucketOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);
        // Build default behavior options
        const defaultBehaviorOptions = {
            origin: mediaBucketOrigin,
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            allowedMethods: props.allowedMethods ?? cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
            cachePolicy: props.cachePolicy ?? cloudfront.CachePolicy.CACHING_OPTIMIZED,
            compress: true,
            ...(props.originRequestPolicy ? { originRequestPolicy: props.originRequestPolicy } : {}),
            ...(props.responseHeadersPolicy ? { responseHeadersPolicy: props.responseHeadersPolicy } : {}),
            ...(this.keyGroup ? { trustedKeyGroups: [this.keyGroup] } : {}),
        };
        // Create the distribution
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            ...(enableLogging && this.logsBucket
                ? { enableLogging: true, logBucket: this.logsBucket, logFilePrefix: "cloudfront/" }
                : {}),
            ...(distributionDomainNames && distributionCertificate
                ? { domainNames: distributionDomainNames, certificate: distributionCertificate }
                : {}),
            defaultBehavior: defaultBehaviorOptions,
            ...(props.defaultRootObject ? { defaultRootObject: props.defaultRootObject } : {}),
            ...(props.webAclId ? { webAclId: props.webAclId } : {}),
            ...(props.priceClass ? { priceClass: props.priceClass } : {}),
            ...(props.comment ? { comment: props.comment } : {}),
            ...(props.errorResponses ? { errorResponses: props.errorResponses } : {}),
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
}
exports.AppTheoryMediaCdn = AppTheoryMediaCdn;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWVkaWEtY2RuLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWVkaWEtY2RuLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBMEQ7QUFDMUQsd0VBQTBEO0FBQzFELHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUMzRCx1REFBeUM7QUFDekMsMkNBQXVDO0FBR3ZDLHlEQUE0RDtBQUM1RCx5RUFBb0U7QUFDcEUsaUVBQWdHO0FBR2hHLFNBQVMsMkNBQTJDLENBQUMsS0FBZ0IsRUFBRSxhQUFxQjtJQUN4RixNQUFNLE1BQU0sR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDdEMsSUFBSSxDQUFDLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQU0sS0FBSyxXQUFXLEVBQUUsQ0FBQztRQUN4RCxPQUFPO0lBQ1gsQ0FBQztJQUVELE1BQU0saUJBQWlCLEdBQUcsbUJBQUssQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQzdFLE1BQU0sSUFBSSxLQUFLLENBQ1gsR0FBRyxhQUFhLHdIQUF3SCxpQkFBaUIsNEdBQTRHLENBQ3hRLENBQUM7QUFDTixDQUFDO0FBd01EOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBQ0gsTUFBYSxpQkFBa0IsU0FBUSxzQkFBUzs7SUFDNUM7O09BRUc7SUFDYSxZQUFZLENBQTBCO0lBRXREOztPQUVHO0lBQ2EsTUFBTSxDQUFhO0lBRW5DOztPQUVHO0lBQ2EsVUFBVSxDQUFjO0lBRXhDOztPQUVHO0lBQ2EsV0FBVyxDQUFvQjtJQUUvQzs7T0FFRztJQUNhLFFBQVEsQ0FBd0I7SUFFaEQ7O09BRUc7SUFDYSxTQUFTLENBQXdCO0lBRWpELFlBQVksS0FBZ0IsRUFB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TSxFQUFFLE9BQU8sQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQzthQUMxRixDQUFDLENBQUM7WUFFSCxJQUFJLEtBQUssQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLEtBQUssSUFBSSxFQUFFLENBQUM7Z0JBQ3pDLElBQUksT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7b0JBQzVDLElBQUksRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVU7b0JBQzdCLFVBQVUsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVU7b0JBQ25DLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7aUJBQzFGLENBQUMsQ0FBQztZQUNQLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQzs7QUF2TUwsOENBd01DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdCB9IGZyb20gXCIuL2xvZ2dpbmdcIjtcbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5pbXBvcnQgeyBidWNrZXROYW1pbmdQcm9wcywgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcblxuZnVuY3Rpb24gYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbihzY29wZTogQ29uc3RydWN0LCBjb25zdHJ1Y3ROYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCByZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgJiYgcmVnaW9uID09PSBcInVzLWVhc3QtMVwiKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCByZWdpb25EZXNjcmlwdGlvbiA9IFRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pID8gXCJ1bnJlc29sdmVkXCIgOiByZWdpb247XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgJHtjb25zdHJ1Y3ROYW1lfSBjYW5ub3QgY3JlYXRlIGEgaG9zdGVkLXpvbmUgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB1bmxlc3MgdGhlIHN0YWNrIHJlZ2lvbiBpcyBleHBsaWNpdGx5IHVzLWVhc3QtMTsgc3RhY2sgcmVnaW9uIGlzICR7cmVnaW9uRGVzY3JpcHRpb259LiBQcm92aWRlIGRvbWFpbi5jZXJ0aWZpY2F0ZSBvciBkb21haW4uY2VydGlmaWNhdGVBcm4gZm9yIHN0YWNrcyBpbiBvdGhlciBvciBlbnZpcm9ubWVudC1hZ25vc3RpYyByZWdpb25zLmAsXG4gICAgKTtcbn1cblxuLyoqXG4gKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgdGhlIE1lZGlhIENETiBkaXN0cmlidXRpb24uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWVkaWFDZG5Eb21haW5Db25maWcge1xuICAgIC8qKlxuICAgICAqIFRoZSBkb21haW4gbmFtZSBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoZS5nLiwgXCJtZWRpYS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIEhUVFBTLiBNdXN0IGJlIGluIHVzLWVhc3QtMSBmb3IgQ2xvdWRGcm9udC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBUk4gb2YgYW4gZXhpc3RpbmcgQUNNIGNlcnRpZmljYXRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICAgKiBXaGVuIHByb3ZpZGVkLCBhbiBBIHJlY29yZCBhbGlhcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIHRoZSBkb21haW4uXG4gICAgICpcbiAgICAgKiBJZiBgZG9tYWluTmFtZWAgaXMgc2V0IHdpdGhvdXQgYGNlcnRpZmljYXRlYCBvciBgY2VydGlmaWNhdGVBcm5gLFxuICAgICAqIGhvc3RlZC16b25lIGNlcnRpZmljYXRlIGNyZWF0aW9uIGlzIGFsbG93ZWQgb25seSBmb3Igc3RhY2tzIHdob3NlIHJlZ2lvblxuICAgICAqIGlzIGV4cGxpY2l0bHkgYHVzLWVhc3QtMWAuIENsb3VkRnJvbnQgcmVxdWlyZXMgdmlld2VyIGNlcnRpZmljYXRlcyBpblxuICAgICAqIGB1cy1lYXN0LTFgOyBlbnZpcm9ubWVudC1hZ25vc3RpYyBvciBvdGhlci1yZWdpb24gc3RhY2tzIG11c3QgcHJvdmlkZSBhblxuICAgICAqIGV4cGxpY2l0IGNlcnRpZmljYXRlIGlucHV0LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogQ29uZmlndXJhdGlvbiBmb3IgcHJpdmF0ZSBtZWRpYSBhY2Nlc3MgdXNpbmcgQ2xvdWRGcm9udCBzaWduZWQgVVJMcy9jb29raWVzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFByaXZhdGVNZWRpYUNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogQW4gZXhpc3RpbmcgQ2xvdWRGcm9udCBrZXkgZ3JvdXAgdG8gdXNlIGZvciB0cnVzdGVkIGtleSBncm91cHMuXG4gICAgICogV2hlbiBwcm92aWRlZCwgdGhlIGRpc3RyaWJ1dGlvbiB3aWxsIHJlcXVpcmUgc2lnbmVkIFVSTHMgb3Igc2lnbmVkIGNvb2tpZXMuXG4gICAgICovXG4gICAgcmVhZG9ubHkga2V5R3JvdXA/OiBjbG91ZGZyb250LklLZXlHcm91cDtcblxuICAgIC8qKlxuICAgICAqIFB1YmxpYyBrZXkgUEVNIGNvbnRlbnQgZm9yIGNyZWF0aW5nIGEgbmV3IGtleSBncm91cC5cbiAgICAgKiBPbmx5IHVzZWQgaWYga2V5R3JvdXAgaXMgbm90IHByb3ZpZGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHB1YmxpY0tleVBlbT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE5hbWUgZm9yIHRoZSBwdWJsaWMga2V5IHdoZW4gY3JlYXRlZCBmcm9tIFBFTS5cbiAgICAgKiBAZGVmYXVsdCBcIk1lZGlhQ2RuUHVibGljS2V5XCJcbiAgICAgKi9cbiAgICByZWFkb25seSBwdWJsaWNLZXlOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogTmFtZSBmb3IgdGhlIGtleSBncm91cCB3aGVuIGNyZWF0ZWQuXG4gICAgICogQGRlZmF1bHQgXCJNZWRpYUNkbktleUdyb3VwXCJcbiAgICAgKi9cbiAgICByZWFkb25seSBrZXlHcm91cE5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBDb21tZW50L2Rlc2NyaXB0aW9uIGZvciB0aGUga2V5IGdyb3VwLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGtleUdyb3VwQ29tbWVudD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNZWRpYUNkblByb3BzIHtcbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBleGlzdGluZyBTMyBidWNrZXQgdG8gdXNlIGFzIHRoZSBtZWRpYSBvcmlnaW4uXG4gICAgICogSWYgbm90IHByb3ZpZGVkLCBhIG5ldyBidWNrZXQgd2lsbCBiZSBjcmVhdGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJ1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBOYW1lIGZvciB0aGUgbWVkaWEgYnVja2V0IChvbmx5IHVzZWQgaWYgYnVja2V0IGlzIG5vdCBwcm92aWRlZCkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYnVja2V0TmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIERvbWFpbiBjb25maWd1cmF0aW9uIGZvciBjdXN0b20gZG9tYWluLCBjZXJ0aWZpY2F0ZSwgYW5kIFJvdXRlNTMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluPzogTWVkaWFDZG5Eb21haW5Db25maWc7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSB0byBhcHBseSB0byB0aGUgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFByaXZhdGUgbWVkaWEgY29uZmlndXJhdGlvbiBmb3Igc2lnbmVkIFVSTHMvY29va2llcy5cbiAgICAgKiBXaGVuIGNvbmZpZ3VyZWQsIHRoZSBkaXN0cmlidXRpb24gd2lsbCByZXF1aXJlIGF1dGhlbnRpY2F0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHByaXZhdGVNZWRpYT86IFByaXZhdGVNZWRpYUNvbmZpZztcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcm9vdCBvYmplY3QgZm9yIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVmYXVsdFJvb3RPYmplY3Q/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dC5cbiAgICAgKlxuICAgICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSB0aGUgbWVkaWEgYnVja2V0IHRha2VzIGl0cyBuYW1lIGZyb20gdGhlXG4gICAgICogY29udHJhY3QgYW5kIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG9cbiAgICAgKiBgbG9ncy9hY2Nlc3MvY2RuL3tsb2dpY2FsTmFtZX1gIHRocm91Z2ggQ2xvdWRXYXRjaCBMb2dzIHZlbmRlZCBkZWxpdmVyeS5cbiAgICAgKiBQYXNzIGBlbmFibGVMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dCBvZiB0aGUgZGVsaXZlcnkuXG4gICAgICpcbiAgICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIGRpc3RyaWJ1dGlvbidzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZFxuICAgICAqIHdoZW4gYSBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBDbG91ZEZyb250IHN0YW5kYXJkLWxvZ2dpbmcgb3V0cHV0IGZvcm1hdCBmb3IgYSBDbG91ZFdhdGNoIExvZ3NcbiAgICAgKiBkZXN0aW5hdGlvbi4gT25seSB1c2VkIHVuZGVyIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUuXG4gICAgICogQGRlZmF1bHQgQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdC5XM0NcbiAgICAgKi9cbiAgICByZWFkb25seSBjbG91ZEZyb250TG9nRm9ybWF0PzogQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdDtcblxuICAgIC8qKlxuICAgICAqIEVuYWJsZSBDbG91ZEZyb250IGFjY2VzcyBsb2dnaW5nLlxuICAgICAqIEBkZWZhdWx0IHRydWVcbiAgICAgKi9cbiAgICByZWFkb25seSBlbmFibGVMb2dnaW5nPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIFMzIGJ1Y2tldCBmb3IgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncy5cbiAgICAgKiBJZiBub3QgcHJvdmlkZWQgYW5kIGVuYWJsZUxvZ2dpbmcgaXMgdHJ1ZSwgYSBuZXcgYnVja2V0IHdpbGwgYmUgY3JlYXRlZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFJlbW92YWwgcG9saWN5IGZvciBjcmVhdGVkIHJlc291cmNlcy5cbiAgICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBhdXRvLWRlbGV0ZSBvYmplY3RzIGluIGNyZWF0ZWQgYnVja2V0cyBvbiBzdGFjayBkZWxldGlvbi5cbiAgICAgKiBPbmx5IGFwcGxpZXMgd2hlbiByZW1vdmFsUG9saWN5IGlzIERFU1RST1kuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBhdXRvRGVsZXRlT2JqZWN0cz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCB3ZWIgQUNMIElEIGZvciBBV1MgV0FGIGludGVncmF0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHdlYkFjbElkPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUHJpY2UgY2xhc3MgZm9yIHRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICAgKiBAZGVmYXVsdCBQcmljZUNsYXNzLlBSSUNFX0NMQVNTX0FMTFxuICAgICAqL1xuICAgIHJlYWRvbmx5IHByaWNlQ2xhc3M/OiBjbG91ZGZyb250LlByaWNlQ2xhc3M7XG5cbiAgICAvKipcbiAgICAgKiBBbiBvcHRpb25hbCBuYW1lL2NvbW1lbnQgZm9yIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgY29tbWVudD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIENhY2hlIHBvbGljeSBmb3IgdGhlIGRlZmF1bHQgYmVoYXZpb3IuXG4gICAgICogQGRlZmF1bHQgQ2FjaGVQb2xpY3kuQ0FDSElOR19PUFRJTUlaRURcbiAgICAgKi9cbiAgICByZWFkb25seSBjYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogT3JpZ2luIHJlcXVlc3QgcG9saWN5IGZvciB0aGUgZGVmYXVsdCBiZWhhdmlvci5cbiAgICAgKi9cbiAgICByZWFkb25seSBvcmlnaW5SZXF1ZXN0UG9saWN5PzogY2xvdWRmcm9udC5JT3JpZ2luUmVxdWVzdFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIEVycm9yIHJlc3BvbnNlcyBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoZS5nLiwgY3VzdG9tIDQwNCBoYW5kbGluZykuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZXJyb3JSZXNwb25zZXM/OiBjbG91ZGZyb250LkVycm9yUmVzcG9uc2VbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzIGZvciB0aGUgZGlzdHJpYnV0aW9uLlxuICAgICAqIEBkZWZhdWx0IEFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlNcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd2VkTWV0aG9kcz86IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHM7XG59XG5cbi8qKlxuICogQSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiBvcHRpbWl6ZWQgZm9yIHNlcnZpbmcgbWVkaWEgYXNzZXRzIGZyb20gUzMuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgY3JlYXRlcyBvciB3cmFwcyBhbiBTMyBidWNrZXQgd2l0aCBhIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uXG4gKiBjb25maWd1cmVkIGZvciBtZWRpYSBkZWxpdmVyeS4gSXQgc3VwcG9ydHM6XG4gKiAtIEN1c3RvbSBkb21haW4gd2l0aCBjZXJ0aWZpY2F0ZSBhbmQgUm91dGU1MyBpbnRlZ3JhdGlvblxuICogLSBQcml2YXRlIG1lZGlhIGFjY2VzcyB2aWEgc2lnbmVkIFVSTHMvY29va2llcyAodHJ1c3RlZCBrZXkgZ3JvdXBzKVxuICogLSBDdXN0b21pemFibGUgY2FjaGluZyBhbmQgcmVzcG9uc2UgaGVhZGVyc1xuICogLSBBY2Nlc3MgbG9nZ2luZ1xuICpcbiAqIFVzZSBjYXNlczpcbiAqIC0gUHVibGljIG1lZGlhIENETiAoaW1hZ2VzLCB2aWRlb3MsIGRvY3VtZW50cylcbiAqIC0gUHJpdmF0ZS9hdXRoZW50aWNhdGVkIG1lZGlhIGFjY2Vzc1xuICogLSBTdGFnZS1zcGVjaWZpYyBtZWRpYSBzdWJkb21haW5zIChlLmcuLCBtZWRpYS5zdGFnZS5leGFtcGxlLmNvbSlcbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1lZGlhQ2RuIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgUzMgYnVja2V0IGZvciBtZWRpYSBhc3NldHMuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGJ1Y2tldDogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGJ1Y2tldCAoaWYgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgY2VydGlmaWNhdGUgdXNlZCBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoaWYgY3VzdG9tIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGtleSBncm91cCBmb3IgcHJpdmF0ZSBtZWRpYSBhY2Nlc3MgKGlmIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBrZXlHcm91cD86IGNsb3VkZnJvbnQuSUtleUdyb3VwO1xuXG4gICAgLyoqXG4gICAgICogVGhlIHB1YmxpYyBrZXkgY3JlYXRlZCBmb3IgcHJpdmF0ZSBtZWRpYSAoaWYgY3JlYXRlZCBmcm9tIFBFTSkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHB1YmxpY0tleT86IGNsb3VkZnJvbnQuUHVibGljS2V5O1xuXG4gICAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1lZGlhQ2RuUHJvcHMpIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICAgICAgY29uc3QgYXV0b0RlbGV0ZU9iamVjdHMgPSBwcm9wcy5hdXRvRGVsZXRlT2JqZWN0cyA/PyBmYWxzZTtcbiAgICAgICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcbiAgICAgICAgY29uc3QgbmFtaW5nQ29udGV4dCA9IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAobmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgICAgIHJlZnVzZUV4cGxpY2l0TmFtZShcbiAgICAgICAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgICAgICAgICBcIkFwcFRoZW9yeU1lZGlhQ2RuXCIsXG4gICAgICAgICAgICBcImJ1Y2tldE5hbWVcIixcbiAgICAgICAgICAgIFwiczNfYnVja2V0XCIsXG4gICAgICAgICAgICBsb2dpY2FsID8gYCR7bG9naWNhbH0tbWVkaWFgIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgcHJvcHMuYnVja2V0TmFtZSAhPT0gdW5kZWZpbmVkLFxuICAgICAgICApO1xuICAgICAgICBpZiAobmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIHByb3BzLmxvZ3NCdWNrZXQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIFwiQXBwVGhlb3J5TWVkaWFDZG4gY2Fubm90IGhvbm9yIHByb3BzLmxvZ3NCdWNrZXQgdW5kZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZTsgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBnbyB0byB0aGUgY29udHJhY3QgbG9nIGdyb3VwLCBzbyByZW1vdmUgcHJvcHMubG9nc0J1Y2tldCBvciB1c2UgdGhlIGxlZ2FjeSBsb2dnaW5nIHByb2ZpbGVcIixcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc3RhbmRhcmRMb2dnaW5nID0gbmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIGVuYWJsZUxvZ2dpbmc7XG5cbiAgICAgICAgLy8gQ3JlYXRlIG9yIHVzZSB0aGUgcHJvdmlkZWQgbWVkaWEgYnVja2V0XG4gICAgICAgIGlmIChwcm9wcy5idWNrZXQpIHtcbiAgICAgICAgICAgIHRoaXMuYnVja2V0ID0gcHJvcHMuYnVja2V0O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiTWVkaWFCdWNrZXRcIiwge1xuICAgICAgICAgICAgICAgIC4uLihuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgICAgICAgICAgICAgPyBidWNrZXROYW1pbmdQcm9wcyhuYW1pbmdDb250ZXh0LCBgJHtsb2dpY2FsfS1tZWRpYWApXG4gICAgICAgICAgICAgICAgICAgIDogeyBidWNrZXROYW1lOiBwcm9wcy5idWNrZXROYW1lIH0pLFxuICAgICAgICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5CVUNLRVRfT1dORVJfRU5GT1JDRUQsXG4gICAgICAgICAgICAgICAgdmVyc2lvbmVkOiBmYWxzZSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIGxvZ3MgYnVja2V0IGlmIFMzIGxvZ2dpbmcgaXMgZW5hYmxlZCBhbmQgdGhlIHN0YW5kYXJkIHByb2ZpbGUgaXNcbiAgICAgICAgLy8gbm90IHJlcGxhY2luZyBpdCB3aXRoIENsb3VkV2F0Y2ggTG9ncyBkZWxpdmVyeS5cbiAgICAgICAgaWYgKGVuYWJsZUxvZ2dpbmcgJiYgIXN0YW5kYXJkTG9nZ2luZykge1xuICAgICAgICAgICAgdGhpcy5sb2dzQnVja2V0ID1cbiAgICAgICAgICAgICAgICBwcm9wcy5sb2dzQnVja2V0ID8/XG4gICAgICAgICAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkNsb3VkRnJvbnRMb2dzQnVja2V0XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICAgICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgICAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgICAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICAgICAgICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuT0JKRUNUX1dSSVRFUixcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEhhbmRsZSBwcml2YXRlIG1lZGlhIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgaWYgKHByb3BzLnByaXZhdGVNZWRpYSkge1xuICAgICAgICAgICAgaWYgKHByb3BzLnByaXZhdGVNZWRpYS5rZXlHcm91cCkge1xuICAgICAgICAgICAgICAgIHRoaXMua2V5R3JvdXAgPSBwcm9wcy5wcml2YXRlTWVkaWEua2V5R3JvdXA7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLnByaXZhdGVNZWRpYS5wdWJsaWNLZXlQZW0pIHtcbiAgICAgICAgICAgICAgICAvLyBDcmVhdGUgYSBwdWJsaWMga2V5IGZyb20gdGhlIFBFTVxuICAgICAgICAgICAgICAgIHRoaXMucHVibGljS2V5ID0gbmV3IGNsb3VkZnJvbnQuUHVibGljS2V5KHRoaXMsIFwiUHVibGljS2V5XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgZW5jb2RlZEtleTogcHJvcHMucHJpdmF0ZU1lZGlhLnB1YmxpY0tleVBlbSxcbiAgICAgICAgICAgICAgICAgICAgcHVibGljS2V5TmFtZTogcHJvcHMucHJpdmF0ZU1lZGlhLnB1YmxpY0tleU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbW1lbnQ6IFwiUHVibGljIGtleSBmb3IgTWVkaWEgQ0ROIHNpZ25lZCBVUkxzXCIsXG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAvLyBDcmVhdGUgYSBrZXkgZ3JvdXAgd2l0aCB0aGUgcHVibGljIGtleVxuICAgICAgICAgICAgICAgIHRoaXMua2V5R3JvdXAgPSBuZXcgY2xvdWRmcm9udC5LZXlHcm91cCh0aGlzLCBcIktleUdyb3VwXCIsIHtcbiAgICAgICAgICAgICAgICAgICAga2V5R3JvdXBOYW1lOiBwcm9wcy5wcml2YXRlTWVkaWEua2V5R3JvdXBOYW1lLFxuICAgICAgICAgICAgICAgICAgICBpdGVtczogW3RoaXMucHVibGljS2V5XSxcbiAgICAgICAgICAgICAgICAgICAgY29tbWVudDogcHJvcHMucHJpdmF0ZU1lZGlhLmtleUdyb3VwQ29tbWVudCA/PyBcIktleSBncm91cCBmb3IgTWVkaWEgQ0ROIHByaXZhdGUgYWNjZXNzXCIsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBIYW5kbGUgZG9tYWluIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgICAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluLmRvbWFpbk5hbWUpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG5cbiAgICAgICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4sXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHRoaXMsIFwiQXBwVGhlb3J5TWVkaWFDZG5cIik7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uOiBhY20uQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnMocHJvcHMuZG9tYWluLmhvc3RlZFpvbmUpLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkFwcFRoZW9yeU1lZGlhQ2RuIHJlcXVpcmVzIGRvbWFpbi5jZXJ0aWZpY2F0ZSwgZG9tYWluLmNlcnRpZmljYXRlQXJuLCBvciBkb21haW4uaG9zdGVkWm9uZSB3aGVuIGRvbWFpbi5kb21haW5OYW1lIGlzIHNldFwiLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIFMzIG9yaWdpbiB3aXRoIE9yaWdpbiBBY2Nlc3MgQ29udHJvbFxuICAgICAgICBjb25zdCBtZWRpYUJ1Y2tldE9yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5idWNrZXQpO1xuXG4gICAgICAgIC8vIEJ1aWxkIGRlZmF1bHQgYmVoYXZpb3Igb3B0aW9uc1xuICAgICAgICBjb25zdCBkZWZhdWx0QmVoYXZpb3JPcHRpb25zOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9IHtcbiAgICAgICAgICAgIG9yaWdpbjogbWVkaWFCdWNrZXRPcmlnaW4sXG4gICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBwcm9wcy5hbGxvd2VkTWV0aG9kcyA/PyBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICAgICAgICBjYWNoZVBvbGljeTogcHJvcHMuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRCxcbiAgICAgICAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgICAgICAgLi4uKHByb3BzLm9yaWdpblJlcXVlc3RQb2xpY3kgPyB7IG9yaWdpblJlcXVlc3RQb2xpY3k6IHByb3BzLm9yaWdpblJlcXVlc3RQb2xpY3kgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPyB7IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5IH0gOiB7fSksXG4gICAgICAgICAgICAuLi4odGhpcy5rZXlHcm91cCA/IHsgdHJ1c3RlZEtleUdyb3VwczogW3RoaXMua2V5R3JvdXBdIH0gOiB7fSksXG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBkaXN0cmlidXRpb25cbiAgICAgICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgXCJEaXN0cmlidXRpb25cIiwge1xuICAgICAgICAgICAgLi4uKGVuYWJsZUxvZ2dpbmcgJiYgdGhpcy5sb2dzQnVja2V0XG4gICAgICAgICAgICAgICAgPyB7IGVuYWJsZUxvZ2dpbmc6IHRydWUsIGxvZ0J1Y2tldDogdGhpcy5sb2dzQnVja2V0LCBsb2dGaWxlUHJlZml4OiBcImNsb3VkZnJvbnQvXCIgfVxuICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgLi4uKGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzICYmIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlXG4gICAgICAgICAgICAgICAgPyB7IGRvbWFpbk5hbWVzOiBkaXN0cmlidXRpb25Eb21haW5OYW1lcywgY2VydGlmaWNhdGU6IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIGRlZmF1bHRCZWhhdmlvcjogZGVmYXVsdEJlaGF2aW9yT3B0aW9ucyxcbiAgICAgICAgICAgIC4uLihwcm9wcy5kZWZhdWx0Um9vdE9iamVjdCA/IHsgZGVmYXVsdFJvb3RPYmplY3Q6IHByb3BzLmRlZmF1bHRSb290T2JqZWN0IH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMud2ViQWNsSWQgPyB7IHdlYkFjbElkOiBwcm9wcy53ZWJBY2xJZCB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLnByaWNlQ2xhc3MgPyB7IHByaWNlQ2xhc3M6IHByb3BzLnByaWNlQ2xhc3MgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5jb21tZW50ID8geyBjb21tZW50OiBwcm9wcy5jb21tZW50IH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMuZXJyb3JSZXNwb25zZXMgPyB7IGVycm9yUmVzcG9uc2VzOiBwcm9wcy5lcnJvclJlc3BvbnNlcyB9IDoge30pLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoc3RhbmRhcmRMb2dnaW5nICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCkge1xuICAgICAgICAgICAgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyh7XG4gICAgICAgICAgICAgICAgc2NvcGU6IHRoaXMsXG4gICAgICAgICAgICAgICAgaWQ6IFwiQ2RuTG9nZ2luZ1wiLFxuICAgICAgICAgICAgICAgIGNvbnRleHQ6IG5hbWluZ0NvbnRleHQsXG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uOiB0aGlzLmRpc3RyaWJ1dGlvbixcbiAgICAgICAgICAgICAgICBsb2dpY2FsOiBgbG9ncy9hY2Nlc3MvY2RuLyR7bG9naWNhbH1gLFxuICAgICAgICAgICAgICAgIGZvcm1hdDogcHJvcHMuY2xvdWRGcm9udExvZ0Zvcm1hdCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgQSByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbj8uZG9tYWluTmFtZSAmJiBwcm9wcy5kb21haW4/Lmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChwcm9wcy5kb21haW4uY3JlYXRlQUFBQVJlY29yZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZEFBQUFcIiwge1xuICAgICAgICAgICAgICAgICAgICB6b25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cbiJdfQ==