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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWVkaWEtY2RuLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWVkaWEtY2RuLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBMEQ7QUFDMUQsd0VBQTBEO0FBQzFELHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUMzRCx1REFBeUM7QUFDekMsMkNBQXVDO0FBR3ZDLHlEQUE0RDtBQUM1RCx5RUFBb0U7QUFDcEUsaUVBQWdHO0FBR2hHLFNBQVMsMkNBQTJDLENBQUMsS0FBZ0IsRUFBRSxhQUFxQjtJQUN4RixNQUFNLE1BQU0sR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDdEMsSUFBSSxDQUFDLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQU0sS0FBSyxXQUFXLEVBQUUsQ0FBQztRQUN4RCxPQUFPO0lBQ1gsQ0FBQztJQUVELE1BQU0saUJBQWlCLEdBQUcsbUJBQUssQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQzdFLE1BQU0sSUFBSSxLQUFLLENBQ1gsR0FBRyxhQUFhLHdIQUF3SCxpQkFBaUIsNEdBQTRHLENBQ3hRLENBQUM7QUFDTixDQUFDO0FBd01EOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBQ0gsTUFBYSxpQkFBa0IsU0FBUSxzQkFBUzs7SUFDNUM7O09BRUc7SUFDYSxZQUFZLENBQTBCO0lBRXREOztPQUVHO0lBQ2EsTUFBTSxDQUFhO0lBRW5DOztPQUVHO0lBQ2EsVUFBVSxDQUFjO0lBRXhDOztPQUVHO0lBQ2EsV0FBVyxDQUFvQjtJQUUvQzs7T0FFRztJQUNhLFFBQVEsQ0FBd0I7SUFFaEQ7O09BRUc7SUFDYSxTQUFTLENBQXdCO0lBRWpELFlBQVksS0FBZ0IsRUFB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TSxFQUFFLE9BQU8sQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQzthQUMxRixDQUFDLENBQUM7WUFFSCxJQUFJLEtBQUssQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLEtBQUssSUFBSSxFQUFFLENBQUM7Z0JBQ3pDLElBQUksT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7b0JBQzVDLElBQUksRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVU7b0JBQzdCLFVBQVUsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVU7b0JBQ25DLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7aUJBQzFGLENBQUMsQ0FBQztZQUNQLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQzs7QUF2TUwsOENBd01DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdCB9IGZyb20gXCIuL2xvZ2dpbmdcIjtcbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5pbXBvcnQgeyBidWNrZXROYW1pbmdQcm9wcywgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcblxuZnVuY3Rpb24gYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbihzY29wZTogQ29uc3RydWN0LCBjb25zdHJ1Y3ROYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCByZWdpb24gPSBTdGFjay5vZihzY29wZSkucmVnaW9uO1xuICAgIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgJiYgcmVnaW9uID09PSBcInVzLWVhc3QtMVwiKSB7XG4gICAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCByZWdpb25EZXNjcmlwdGlvbiA9IFRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pID8gXCJ1bnJlc29sdmVkXCIgOiByZWdpb247XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgJHtjb25zdHJ1Y3ROYW1lfSBjYW5ub3QgY3JlYXRlIGEgaG9zdGVkLXpvbmUgQ2xvdWRGcm9udCBjZXJ0aWZpY2F0ZSB1bmxlc3MgdGhlIHN0YWNrIHJlZ2lvbiBpcyBleHBsaWNpdGx5IHVzLWVhc3QtMTsgc3RhY2sgcmVnaW9uIGlzICR7cmVnaW9uRGVzY3JpcHRpb259LiBQcm92aWRlIGRvbWFpbi5jZXJ0aWZpY2F0ZSBvciBkb21haW4uY2VydGlmaWNhdGVBcm4gZm9yIHN0YWNrcyBpbiBvdGhlciBvciBlbnZpcm9ubWVudC1hZ25vc3RpYyByZWdpb25zLmAsXG4gICAgKTtcbn1cblxuLyoqXG4gKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgdGhlIE1lZGlhIENETiBkaXN0cmlidXRpb24uXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTWVkaWFDZG5Eb21haW5Db25maWcge1xuICAgIC8qKlxuICAgICAqIFRoZSBkb21haW4gbmFtZSBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoZS5nLiwgXCJtZWRpYS5leGFtcGxlLmNvbVwiKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW5OYW1lOiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBBQ00gY2VydGlmaWNhdGUgZm9yIEhUVFBTLiBNdXN0IGJlIGluIHVzLWVhc3QtMSBmb3IgQ2xvdWRGcm9udC5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBBUk4gb2YgYW4gZXhpc3RpbmcgQUNNIGNlcnRpZmljYXRlLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlQXJuPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogUm91dGU1MyBob3N0ZWQgem9uZSBmb3IgRE5TIHJlY29yZCBjcmVhdGlvbi5cbiAgICAgKiBXaGVuIHByb3ZpZGVkLCBhbiBBIHJlY29yZCBhbGlhcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIHRoZSBkb21haW4uXG4gICAgICpcbiAgICAgKiBJZiBgZG9tYWluTmFtZWAgaXMgc2V0IHdpdGhvdXQgYGNlcnRpZmljYXRlYCBvciBgY2VydGlmaWNhdGVBcm5gLFxuICAgICAqIGhvc3RlZC16b25lIGNlcnRpZmljYXRlIGNyZWF0aW9uIGlzIGFsbG93ZWQgb25seSBmb3Igc3RhY2tzIHdob3NlIHJlZ2lvblxuICAgICAqIGlzIGV4cGxpY2l0bHkgYHVzLWVhc3QtMWAuIENsb3VkRnJvbnQgcmVxdWlyZXMgdmlld2VyIGNlcnRpZmljYXRlcyBpblxuICAgICAqIGB1cy1lYXN0LTFgOyBlbnZpcm9ubWVudC1hZ25vc3RpYyBvciBvdGhlci1yZWdpb24gc3RhY2tzIG11c3QgcHJvdmlkZSBhblxuICAgICAqIGV4cGxpY2l0IGNlcnRpZmljYXRlIGlucHV0LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGhvc3RlZFpvbmU/OiByb3V0ZTUzLklIb3N0ZWRab25lO1xuXG4gICAgLyoqXG4gICAgICogV2hldGhlciB0byBjcmVhdGUgYW4gQUFBQSBhbGlhcyByZWNvcmQgaW4gYWRkaXRpb24gdG8gdGhlIEEgYWxpYXMgcmVjb3JkLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgY3JlYXRlQUFBQVJlY29yZD86IGJvb2xlYW47XG59XG5cbi8qKlxuICogQ29uZmlndXJhdGlvbiBmb3IgcHJpdmF0ZSBtZWRpYSBhY2Nlc3MgdXNpbmcgQ2xvdWRGcm9udCBzaWduZWQgVVJMcy9jb29raWVzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFByaXZhdGVNZWRpYUNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogQW4gZXhpc3RpbmcgQ2xvdWRGcm9udCBrZXkgZ3JvdXAgdG8gdXNlIGZvciB0cnVzdGVkIGtleSBncm91cHMuXG4gICAgICogV2hlbiBwcm92aWRlZCwgdGhlIGRpc3RyaWJ1dGlvbiB3aWxsIHJlcXVpcmUgc2lnbmVkIFVSTHMgb3Igc2lnbmVkIGNvb2tpZXMuXG4gICAgICovXG4gICAgcmVhZG9ubHkga2V5R3JvdXA/OiBjbG91ZGZyb250LklLZXlHcm91cDtcblxuICAgIC8qKlxuICAgICAqIFB1YmxpYyBrZXkgUEVNIGNvbnRlbnQgZm9yIGNyZWF0aW5nIGEgbmV3IGtleSBncm91cC5cbiAgICAgKiBPbmx5IHVzZWQgaWYga2V5R3JvdXAgaXMgbm90IHByb3ZpZGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHB1YmxpY0tleVBlbT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE5hbWUgZm9yIHRoZSBwdWJsaWMga2V5IHdoZW4gY3JlYXRlZCBmcm9tIFBFTS5cbiAgICAgKiBAZGVmYXVsdCBcIk1lZGlhQ2RuUHVibGljS2V5XCJcbiAgICAgKi9cbiAgICByZWFkb25seSBwdWJsaWNLZXlOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogTmFtZSBmb3IgdGhlIGtleSBncm91cCB3aGVuIGNyZWF0ZWQuXG4gICAgICogQGRlZmF1bHQgXCJNZWRpYUNkbktleUdyb3VwXCJcbiAgICAgKi9cbiAgICByZWFkb25seSBrZXlHcm91cE5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBDb21tZW50L2Rlc2NyaXB0aW9uIGZvciB0aGUga2V5IGdyb3VwLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGtleUdyb3VwQ29tbWVudD86IHN0cmluZztcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNZWRpYUNkblByb3BzIHtcbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBleGlzdGluZyBTMyBidWNrZXQgdG8gdXNlIGFzIHRoZSBtZWRpYSBvcmlnaW4uXG4gICAgICogSWYgbm90IHByb3ZpZGVkLCBhIG5ldyBidWNrZXQgd2lsbCBiZSBjcmVhdGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJ1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBOYW1lIGZvciB0aGUgbWVkaWEgYnVja2V0IChvbmx5IHVzZWQgaWYgYnVja2V0IGlzIG5vdCBwcm92aWRlZCkuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYnVja2V0TmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIERvbWFpbiBjb25maWd1cmF0aW9uIGZvciBjdXN0b20gZG9tYWluLCBjZXJ0aWZpY2F0ZSwgYW5kIFJvdXRlNTMuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluPzogTWVkaWFDZG5Eb21haW5Db25maWc7XG5cbiAgICAvKipcbiAgICAgKiBSZXNwb25zZSBoZWFkZXJzIHBvbGljeSB0byBhcHBseSB0byB0aGUgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHJlc3BvbnNlSGVhZGVyc1BvbGljeT86IGNsb3VkZnJvbnQuSVJlc3BvbnNlSGVhZGVyc1BvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFByaXZhdGUgbWVkaWEgY29uZmlndXJhdGlvbiBmb3Igc2lnbmVkIFVSTHMvY29va2llcy5cbiAgICAgKiBXaGVuIGNvbmZpZ3VyZWQsIHRoZSBkaXN0cmlidXRpb24gd2lsbCByZXF1aXJlIGF1dGhlbnRpY2F0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHByaXZhdGVNZWRpYT86IFByaXZhdGVNZWRpYUNvbmZpZztcblxuICAgIC8qKlxuICAgICAqIERlZmF1bHQgcm9vdCBvYmplY3QgZm9yIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVmYXVsdFJvb3RPYmplY3Q/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dC5cbiAgICAgKlxuICAgICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSB0aGUgbWVkaWEgYnVja2V0IHRha2VzIGl0cyBuYW1lIGZyb20gdGhlXG4gICAgICogY29udHJhY3QgYW5kIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG9cbiAgICAgKiBgbG9ncy9hY2Nlc3MvY2RuL3tsb2dpY2FsTmFtZX1gIHRocm91Z2ggQ2xvdWRXYXRjaCBMb2dzIHZlbmRlZCBkZWxpdmVyeS5cbiAgICAgKiBQYXNzIGBlbmFibGVMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dCBvZiB0aGUgZGVsaXZlcnkuXG4gICAgICpcbiAgICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIGRpc3RyaWJ1dGlvbidzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZFxuICAgICAqIHdoZW4gYSBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBDbG91ZEZyb250IHN0YW5kYXJkLWxvZ2dpbmcgb3V0cHV0IGZvcm1hdCBmb3IgYSBDbG91ZFdhdGNoIExvZ3NcbiAgICAgKiBkZXN0aW5hdGlvbi4gT25seSB1c2VkIHVuZGVyIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUuXG4gICAgICogQGRlZmF1bHQgQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdC5KU09OXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2xvdWRGcm9udExvZ0Zvcm1hdD86IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQ7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgQ2xvdWRGcm9udCBhY2Nlc3MgbG9nZ2luZy5cbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5hYmxlTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBTMyBidWNrZXQgZm9yIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MuXG4gICAgICogSWYgbm90IHByb3ZpZGVkIGFuZCBlbmFibGVMb2dnaW5nIGlzIHRydWUsIGEgbmV3IGJ1Y2tldCB3aWxsIGJlIGNyZWF0ZWQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgY3JlYXRlZCByZXNvdXJjZXMuXG4gICAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICAgKi9cbiAgICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gYXV0by1kZWxldGUgb2JqZWN0cyBpbiBjcmVhdGVkIGJ1Y2tldHMgb24gc3RhY2sgZGVsZXRpb24uXG4gICAgICogT25seSBhcHBsaWVzIHdoZW4gcmVtb3ZhbFBvbGljeSBpcyBERVNUUk9ZLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXV0b0RlbGV0ZU9iamVjdHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgd2ViIEFDTCBJRCBmb3IgQVdTIFdBRiBpbnRlZ3JhdGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSB3ZWJBY2xJZD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFByaWNlIGNsYXNzIGZvciB0aGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAgICogQGRlZmF1bHQgUHJpY2VDbGFzcy5QUklDRV9DTEFTU19BTExcbiAgICAgKi9cbiAgICByZWFkb25seSBwcmljZUNsYXNzPzogY2xvdWRmcm9udC5QcmljZUNsYXNzO1xuXG4gICAgLyoqXG4gICAgICogQW4gb3B0aW9uYWwgbmFtZS9jb21tZW50IGZvciB0aGUgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNvbW1lbnQ/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBDYWNoZSBwb2xpY3kgZm9yIHRoZSBkZWZhdWx0IGJlaGF2aW9yLlxuICAgICAqIEBkZWZhdWx0IENhY2hlUG9saWN5LkNBQ0hJTkdfT1BUSU1JWkVEXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIE9yaWdpbiByZXF1ZXN0IHBvbGljeSBmb3IgdGhlIGRlZmF1bHQgYmVoYXZpb3IuXG4gICAgICovXG4gICAgcmVhZG9ubHkgb3JpZ2luUmVxdWVzdFBvbGljeT86IGNsb3VkZnJvbnQuSU9yaWdpblJlcXVlc3RQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBFcnJvciByZXNwb25zZXMgZm9yIHRoZSBkaXN0cmlidXRpb24gKGUuZy4sIGN1c3RvbSA0MDQgaGFuZGxpbmcpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVycm9yUmVzcG9uc2VzPzogY2xvdWRmcm9udC5FcnJvclJlc3BvbnNlW107XG5cbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIEhUVFAgbWV0aG9kcyBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKiBAZGVmYXVsdCBBbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dlZE1ldGhvZHM/OiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzO1xufVxuXG4vKipcbiAqIEEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gb3B0aW1pemVkIGZvciBzZXJ2aW5nIG1lZGlhIGFzc2V0cyBmcm9tIFMzLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGNyZWF0ZXMgb3Igd3JhcHMgYW4gUzMgYnVja2V0IHdpdGggYSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvblxuICogY29uZmlndXJlZCBmb3IgbWVkaWEgZGVsaXZlcnkuIEl0IHN1cHBvcnRzOlxuICogLSBDdXN0b20gZG9tYWluIHdpdGggY2VydGlmaWNhdGUgYW5kIFJvdXRlNTMgaW50ZWdyYXRpb25cbiAqIC0gUHJpdmF0ZSBtZWRpYSBhY2Nlc3MgdmlhIHNpZ25lZCBVUkxzL2Nvb2tpZXMgKHRydXN0ZWQga2V5IGdyb3VwcylcbiAqIC0gQ3VzdG9taXphYmxlIGNhY2hpbmcgYW5kIHJlc3BvbnNlIGhlYWRlcnNcbiAqIC0gQWNjZXNzIGxvZ2dpbmdcbiAqXG4gKiBVc2UgY2FzZXM6XG4gKiAtIFB1YmxpYyBtZWRpYSBDRE4gKGltYWdlcywgdmlkZW9zLCBkb2N1bWVudHMpXG4gKiAtIFByaXZhdGUvYXV0aGVudGljYXRlZCBtZWRpYSBhY2Nlc3NcbiAqIC0gU3RhZ2Utc3BlY2lmaWMgbWVkaWEgc3ViZG9tYWlucyAoZS5nLiwgbWVkaWEuc3RhZ2UuZXhhbXBsZS5jb20pXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNZWRpYUNkbiBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuXG4gICAgLyoqXG4gICAgICogVGhlIFMzIGJ1Y2tldCBmb3IgbWVkaWEgYXNzZXRzLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBidWNrZXQ6IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBidWNrZXQgKGlmIGxvZ2dpbmcgaXMgZW5hYmxlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIGNlcnRpZmljYXRlIHVzZWQgZm9yIHRoZSBkaXN0cmlidXRpb24gKGlmIGN1c3RvbSBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBrZXkgZ3JvdXAgZm9yIHByaXZhdGUgbWVkaWEgYWNjZXNzIChpZiBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkga2V5R3JvdXA/OiBjbG91ZGZyb250LklLZXlHcm91cDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBwdWJsaWMga2V5IGNyZWF0ZWQgZm9yIHByaXZhdGUgbWVkaWEgKGlmIGNyZWF0ZWQgZnJvbSBQRU0pLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBwdWJsaWNLZXk/OiBjbG91ZGZyb250LlB1YmxpY0tleTtcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNZWRpYUNkblByb3BzKSB7XG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAgICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgICAgIGNvbnN0IGVuYWJsZUxvZ2dpbmcgPSBwcm9wcy5lbmFibGVMb2dnaW5nID8/IHRydWU7XG4gICAgICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgICAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgICAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICAgICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgICAgICAgXCJBcHBUaGVvcnlNZWRpYUNkblwiLFxuICAgICAgICAgICAgXCJidWNrZXROYW1lXCIsXG4gICAgICAgICAgICBcInMzX2J1Y2tldFwiLFxuICAgICAgICAgICAgbG9naWNhbCA/IGAke2xvZ2ljYWx9LW1lZGlhYCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHByb3BzLmJ1Y2tldE5hbWUgIT09IHVuZGVmaW5lZCxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBwcm9wcy5sb2dzQnVja2V0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBcIkFwcFRoZW9yeU1lZGlhQ2RuIGNhbm5vdCBob25vciBwcm9wcy5sb2dzQnVja2V0IHVuZGVyIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGU7IENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG8gdGhlIGNvbnRyYWN0IGxvZyBncm91cCwgc28gcmVtb3ZlIHByb3BzLmxvZ3NCdWNrZXQgb3IgdXNlIHRoZSBsZWdhY3kgbG9nZ2luZyBwcm9maWxlXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHN0YW5kYXJkTG9nZ2luZyA9IG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBlbmFibGVMb2dnaW5nO1xuXG4gICAgICAgIC8vIENyZWF0ZSBvciB1c2UgdGhlIHByb3ZpZGVkIG1lZGlhIGJ1Y2tldFxuICAgICAgICBpZiAocHJvcHMuYnVja2V0KSB7XG4gICAgICAgICAgICB0aGlzLmJ1Y2tldCA9IHByb3BzLmJ1Y2tldDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuYnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIk1lZGlhQnVja2V0XCIsIHtcbiAgICAgICAgICAgICAgICAuLi4obmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsXG4gICAgICAgICAgICAgICAgICAgID8gYnVja2V0TmFtaW5nUHJvcHMobmFtaW5nQ29udGV4dCwgYCR7bG9naWNhbH0tbWVkaWFgKVxuICAgICAgICAgICAgICAgICAgICA6IHsgYnVja2V0TmFtZTogcHJvcHMuYnVja2V0TmFtZSB9KSxcbiAgICAgICAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgICAgICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuQlVDS0VUX09XTkVSX0VORk9SQ0VELFxuICAgICAgICAgICAgICAgIHZlcnNpb25lZDogZmFsc2UsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSBsb2dzIGJ1Y2tldCBpZiBTMyBsb2dnaW5nIGlzIGVuYWJsZWQgYW5kIHRoZSBzdGFuZGFyZCBwcm9maWxlIGlzXG4gICAgICAgIC8vIG5vdCByZXBsYWNpbmcgaXQgd2l0aCBDbG91ZFdhdGNoIExvZ3MgZGVsaXZlcnkuXG4gICAgICAgIGlmIChlbmFibGVMb2dnaW5nICYmICFzdGFuZGFyZExvZ2dpbmcpIHtcbiAgICAgICAgICAgIHRoaXMubG9nc0J1Y2tldCA9XG4gICAgICAgICAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICAgICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICAgICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICAgICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgICAgICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBIYW5kbGUgcHJpdmF0ZSBtZWRpYSBjb25maWd1cmF0aW9uXG4gICAgICAgIGlmIChwcm9wcy5wcml2YXRlTWVkaWEpIHtcbiAgICAgICAgICAgIGlmIChwcm9wcy5wcml2YXRlTWVkaWEua2V5R3JvdXApIHtcbiAgICAgICAgICAgICAgICB0aGlzLmtleUdyb3VwID0gcHJvcHMucHJpdmF0ZU1lZGlhLmtleUdyb3VwO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5wcml2YXRlTWVkaWEucHVibGljS2V5UGVtKSB7XG4gICAgICAgICAgICAgICAgLy8gQ3JlYXRlIGEgcHVibGljIGtleSBmcm9tIHRoZSBQRU1cbiAgICAgICAgICAgICAgICB0aGlzLnB1YmxpY0tleSA9IG5ldyBjbG91ZGZyb250LlB1YmxpY0tleSh0aGlzLCBcIlB1YmxpY0tleVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIGVuY29kZWRLZXk6IHByb3BzLnByaXZhdGVNZWRpYS5wdWJsaWNLZXlQZW0sXG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY0tleU5hbWU6IHByb3BzLnByaXZhdGVNZWRpYS5wdWJsaWNLZXlOYW1lLFxuICAgICAgICAgICAgICAgICAgICBjb21tZW50OiBcIlB1YmxpYyBrZXkgZm9yIE1lZGlhIENETiBzaWduZWQgVVJMc1wiLFxuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgLy8gQ3JlYXRlIGEga2V5IGdyb3VwIHdpdGggdGhlIHB1YmxpYyBrZXlcbiAgICAgICAgICAgICAgICB0aGlzLmtleUdyb3VwID0gbmV3IGNsb3VkZnJvbnQuS2V5R3JvdXAodGhpcywgXCJLZXlHcm91cFwiLCB7XG4gICAgICAgICAgICAgICAgICAgIGtleUdyb3VwTmFtZTogcHJvcHMucHJpdmF0ZU1lZGlhLmtleUdyb3VwTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgaXRlbXM6IFt0aGlzLnB1YmxpY0tleV0sXG4gICAgICAgICAgICAgICAgICAgIGNvbW1lbnQ6IHByb3BzLnByaXZhdGVNZWRpYS5rZXlHcm91cENvbW1lbnQgPz8gXCJLZXkgZ3JvdXAgZm9yIE1lZGlhIENETiBwcml2YXRlIGFjY2Vzc1wiLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gSGFuZGxlIGRvbWFpbiBjb25maWd1cmF0aW9uXG4gICAgICAgIGxldCBkaXN0cmlidXRpb25Eb21haW5OYW1lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gICAgICAgIGxldCBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTogYWNtLklDZXJ0aWZpY2F0ZSB8IHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICAgICAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbi5kb21haW5OYW1lKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoZG9tYWluTmFtZSkge1xuICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzID0gW2RvbWFpbk5hbWVdO1xuXG4gICAgICAgICAgICAgICAgaWYgKHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZUFybikge1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4oXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbih0aGlzLCBcIkFwcFRoZW9yeU1lZGlhQ2RuXCIpO1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IG5ldyBhY20uQ2VydGlmaWNhdGUodGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkb21haW5OYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvbjogYWNtLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKHByb3BzLmRvbWFpbi5ob3N0ZWRab25lKSxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJBcHBUaGVvcnlNZWRpYUNkbiByZXF1aXJlcyBkb21haW4uY2VydGlmaWNhdGUsIGRvbWFpbi5jZXJ0aWZpY2F0ZUFybiwgb3IgZG9tYWluLmhvc3RlZFpvbmUgd2hlbiBkb21haW4uZG9tYWluTmFtZSBpcyBzZXRcIixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmNlcnRpZmljYXRlID0gZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU7XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBTMyBvcmlnaW4gd2l0aCBPcmlnaW4gQWNjZXNzIENvbnRyb2xcbiAgICAgICAgY29uc3QgbWVkaWFCdWNrZXRPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuYnVja2V0KTtcblxuICAgICAgICAvLyBCdWlsZCBkZWZhdWx0IGJlaGF2aW9yIG9wdGlvbnNcbiAgICAgICAgY29uc3QgZGVmYXVsdEJlaGF2aW9yT3B0aW9uczogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPSB7XG4gICAgICAgICAgICBvcmlnaW46IG1lZGlhQnVja2V0T3JpZ2luLFxuICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogcHJvcHMuYWxsb3dlZE1ldGhvZHMgPz8gY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgICAgICAgY2FjaGVQb2xpY3k6IHByb3BzLmNhY2hlUG9saWN5ID8/IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19PUFRJTUlaRUQsXG4gICAgICAgICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5vcmlnaW5SZXF1ZXN0UG9saWN5ID8geyBvcmlnaW5SZXF1ZXN0UG9saWN5OiBwcm9wcy5vcmlnaW5SZXF1ZXN0UG9saWN5IH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHRoaXMua2V5R3JvdXAgPyB7IHRydXN0ZWRLZXlHcm91cHM6IFt0aGlzLmtleUdyb3VwXSB9IDoge30pLFxuICAgICAgICB9O1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZGlzdHJpYnV0aW9uXG4gICAgICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgICAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICAgICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICAgICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IGRlZmF1bHRCZWhhdmlvck9wdGlvbnMsXG4gICAgICAgICAgICAuLi4ocHJvcHMuZGVmYXVsdFJvb3RPYmplY3QgPyB7IGRlZmF1bHRSb290T2JqZWN0OiBwcm9wcy5kZWZhdWx0Um9vdE9iamVjdCB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5wcmljZUNsYXNzID8geyBwcmljZUNsYXNzOiBwcm9wcy5wcmljZUNsYXNzIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMuY29tbWVudCA/IHsgY29tbWVudDogcHJvcHMuY29tbWVudCB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLmVycm9yUmVzcG9uc2VzID8geyBlcnJvclJlc3BvbnNlczogcHJvcHMuZXJyb3JSZXNwb25zZXMgfSA6IHt9KSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHN0YW5kYXJkTG9nZ2luZyAmJiBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwpIHtcbiAgICAgICAgICAgIGVuYWJsZUNsb3VkRnJvbnRTdGFuZGFyZExvZ2dpbmcoe1xuICAgICAgICAgICAgICAgIHNjb3BlOiB0aGlzLFxuICAgICAgICAgICAgICAgIGlkOiBcIkNkbkxvZ2dpbmdcIixcbiAgICAgICAgICAgICAgICBjb250ZXh0OiBuYW1pbmdDb250ZXh0LFxuICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbjogdGhpcy5kaXN0cmlidXRpb24sXG4gICAgICAgICAgICAgICAgbG9naWNhbDogYGxvZ3MvYWNjZXNzL2Nkbi8ke2xvZ2ljYWx9YCxcbiAgICAgICAgICAgICAgICBmb3JtYXQ6IHByb3BzLmNsb3VkRnJvbnRMb2dGb3JtYXQsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSBSb3V0ZTUzIEEgcmVjb3JkIGlmIGhvc3RlZCB6b25lIGlzIHByb3ZpZGVkXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4/LmRvbWFpbk5hbWUgJiYgcHJvcHMuZG9tYWluPy5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgICAgICAgIHpvbmU6IHByb3BzLmRvbWFpbi5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbi5kb21haW5OYW1lLFxuICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNyZWF0ZUFBQUFSZWNvcmQgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBuZXcgcm91dGU1My5BYWFhUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRBQUFBXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbi5kb21haW5OYW1lLFxuICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG4iXX0=