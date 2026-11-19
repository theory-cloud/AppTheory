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
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryMediaCdn", "bucketName", "s3_bucket", logical, props.bucketName !== undefined);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWVkaWEtY2RuLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWVkaWEtY2RuLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBMEQ7QUFDMUQsd0VBQTBEO0FBQzFELHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUMzRCx1REFBeUM7QUFDekMsMkNBQXVDO0FBR3ZDLHlEQUE0RDtBQUM1RCx5RUFBb0U7QUFDcEUsaUVBQWdHO0FBR2hHLFNBQVMsMkNBQTJDLENBQUMsS0FBZ0IsRUFBRSxhQUFxQjtJQUN4RixNQUFNLE1BQU0sR0FBRyxtQkFBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUM7SUFDdEMsSUFBSSxDQUFDLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxJQUFJLE1BQU0sS0FBSyxXQUFXLEVBQUUsQ0FBQztRQUN4RCxPQUFPO0lBQ1gsQ0FBQztJQUVELE1BQU0saUJBQWlCLEdBQUcsbUJBQUssQ0FBQyxZQUFZLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQzdFLE1BQU0sSUFBSSxLQUFLLENBQ1gsR0FBRyxhQUFhLHdIQUF3SCxpQkFBaUIsNEdBQTRHLENBQ3hRLENBQUM7QUFDTixDQUFDO0FBd01EOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBQ0gsTUFBYSxpQkFBa0IsU0FBUSxzQkFBUzs7SUFDNUM7O09BRUc7SUFDYSxZQUFZLENBQTBCO0lBRXREOztPQUVHO0lBQ2EsTUFBTSxDQUFhO0lBRW5DOztPQUVHO0lBQ2EsVUFBVSxDQUFjO0lBRXhDOztPQUVHO0lBQ2EsV0FBVyxDQUFvQjtJQUUvQzs7T0FFRztJQUNhLFFBQVEsQ0FBd0I7SUFFaEQ7O09BRUc7SUFDYSxTQUFTLENBQXdCO0lBRWpELFlBQVksS0FBZ0IsRUFB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Z0JBQWdCLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO2FBQzFGLENBQUMsQ0FBQztZQUVILElBQUksS0FBSyxDQUFDLE1BQU0sQ0FBQyxnQkFBZ0IsS0FBSyxJQUFJLEVBQUUsQ0FBQztnQkFDekMsSUFBSSxPQUFPLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtvQkFDNUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsVUFBVTtvQkFDN0IsVUFBVSxFQUFFLEtBQUssQ0FBQyxNQUFNLENBQUMsVUFBVTtvQkFDbkMsTUFBTSxFQUFFLE9BQU8sQ0FBQyxZQUFZLENBQUMsU0FBUyxDQUFDLElBQUksT0FBTyxDQUFDLGdCQUFnQixDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztpQkFDMUYsQ0FBQyxDQUFDO1lBQ1AsQ0FBQztRQUNMLENBQUM7SUFDTCxDQUFDOztBQWhNTCw4Q0FpTUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5LCBTdGFjaywgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFjbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNlcnRpZmljYXRlbWFuYWdlclwiO1xuaW1wb3J0ICogYXMgY2xvdWRmcm9udCBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnRcIjtcbmltcG9ydCAqIGFzIG9yaWdpbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250LW9yaWdpbnNcIjtcbmltcG9ydCAqIGFzIHJvdXRlNTMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzXCI7XG5pbXBvcnQgKiBhcyB0YXJnZXRzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1My10YXJnZXRzXCI7XG5pbXBvcnQgKiBhcyBzMyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXMzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0IH0gZnJvbSBcIi4vbG9nZ2luZ1wiO1xuaW1wb3J0IHsgZGVmYXVsdExvZ2ljYWxOYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2dpY2FsLW5hbWVcIjtcbmltcG9ydCB7IHJlZnVzZUV4cGxpY2l0TmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvcmVmdXNlLWV4cGxpY2l0LW5hbWVcIjtcbmltcG9ydCB7IGJ1Y2tldE5hbWluZ1Byb3BzLCBlbmFibGVDbG91ZEZyb250U3RhbmRhcmRMb2dnaW5nIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdGFuZGFyZC1sb2dnaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuXG5mdW5jdGlvbiBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHNjb3BlOiBDb25zdHJ1Y3QsIGNvbnN0cnVjdE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHJlZ2lvbiA9IFN0YWNrLm9mKHNjb3BlKS5yZWdpb247XG4gICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQocmVnaW9uKSAmJiByZWdpb24gPT09IFwidXMtZWFzdC0xXCIpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHJlZ2lvbkRlc2NyaXB0aW9uID0gVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgPyBcInVucmVzb2x2ZWRcIiA6IHJlZ2lvbjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGAke2NvbnN0cnVjdE5hbWV9IGNhbm5vdCBjcmVhdGUgYSBob3N0ZWQtem9uZSBDbG91ZEZyb250IGNlcnRpZmljYXRlIHVubGVzcyB0aGUgc3RhY2sgcmVnaW9uIGlzIGV4cGxpY2l0bHkgdXMtZWFzdC0xOyBzdGFjayByZWdpb24gaXMgJHtyZWdpb25EZXNjcmlwdGlvbn0uIFByb3ZpZGUgZG9tYWluLmNlcnRpZmljYXRlIG9yIGRvbWFpbi5jZXJ0aWZpY2F0ZUFybiBmb3Igc3RhY2tzIGluIG90aGVyIG9yIGVudmlyb25tZW50LWFnbm9zdGljIHJlZ2lvbnMuYCxcbiAgICApO1xufVxuXG4vKipcbiAqIERvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgTWVkaWEgQ0ROIGRpc3RyaWJ1dGlvbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZWRpYUNkbkRvbWFpbkNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogVGhlIGRvbWFpbiBuYW1lIGZvciB0aGUgZGlzdHJpYnV0aW9uIChlLmcuLCBcIm1lZGlhLmV4YW1wbGUuY29tXCIpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgSFRUUFMuIE11c3QgYmUgaW4gdXMtZWFzdC0xIGZvciBDbG91ZEZyb250LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIEFSTiBvZiBhbiBleGlzdGluZyBBQ00gY2VydGlmaWNhdGUuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgICAqIFdoZW4gcHJvdmlkZWQsIGFuIEEgcmVjb3JkIGFsaWFzIHdpbGwgYmUgY3JlYXRlZCBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKlxuICAgICAqIElmIGBkb21haW5OYW1lYCBpcyBzZXQgd2l0aG91dCBgY2VydGlmaWNhdGVgIG9yIGBjZXJ0aWZpY2F0ZUFybmAsXG4gICAgICogaG9zdGVkLXpvbmUgY2VydGlmaWNhdGUgY3JlYXRpb24gaXMgYWxsb3dlZCBvbmx5IGZvciBzdGFja3Mgd2hvc2UgcmVnaW9uXG4gICAgICogaXMgZXhwbGljaXRseSBgdXMtZWFzdC0xYC4gQ2xvdWRGcm9udCByZXF1aXJlcyB2aWV3ZXIgY2VydGlmaWNhdGVzIGluXG4gICAgICogYHVzLWVhc3QtMWA7IGVudmlyb25tZW50LWFnbm9zdGljIG9yIG90aGVyLXJlZ2lvbiBzdGFja3MgbXVzdCBwcm92aWRlIGFuXG4gICAgICogZXhwbGljaXQgY2VydGlmaWNhdGUgaW5wdXQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhbiBBQUFBIGFsaWFzIHJlY29yZCBpbiBhZGRpdGlvbiB0byB0aGUgQSBhbGlhcyByZWNvcmQuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBjcmVhdGVBQUFBUmVjb3JkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBwcml2YXRlIG1lZGlhIGFjY2VzcyB1c2luZyBDbG91ZEZyb250IHNpZ25lZCBVUkxzL2Nvb2tpZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJpdmF0ZU1lZGlhQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBBbiBleGlzdGluZyBDbG91ZEZyb250IGtleSBncm91cCB0byB1c2UgZm9yIHRydXN0ZWQga2V5IGdyb3Vwcy5cbiAgICAgKiBXaGVuIHByb3ZpZGVkLCB0aGUgZGlzdHJpYnV0aW9uIHdpbGwgcmVxdWlyZSBzaWduZWQgVVJMcyBvciBzaWduZWQgY29va2llcy5cbiAgICAgKi9cbiAgICByZWFkb25seSBrZXlHcm91cD86IGNsb3VkZnJvbnQuSUtleUdyb3VwO1xuXG4gICAgLyoqXG4gICAgICogUHVibGljIGtleSBQRU0gY29udGVudCBmb3IgY3JlYXRpbmcgYSBuZXcga2V5IGdyb3VwLlxuICAgICAqIE9ubHkgdXNlZCBpZiBrZXlHcm91cCBpcyBub3QgcHJvdmlkZWQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHVibGljS2V5UGVtPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogTmFtZSBmb3IgdGhlIHB1YmxpYyBrZXkgd2hlbiBjcmVhdGVkIGZyb20gUEVNLlxuICAgICAqIEBkZWZhdWx0IFwiTWVkaWFDZG5QdWJsaWNLZXlcIlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHB1YmxpY0tleU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBOYW1lIGZvciB0aGUga2V5IGdyb3VwIHdoZW4gY3JlYXRlZC5cbiAgICAgKiBAZGVmYXVsdCBcIk1lZGlhQ2RuS2V5R3JvdXBcIlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGtleUdyb3VwTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIENvbW1lbnQvZGVzY3JpcHRpb24gZm9yIHRoZSBrZXkgZ3JvdXAuXG4gICAgICovXG4gICAgcmVhZG9ubHkga2V5R3JvdXBDb21tZW50Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1lZGlhQ2RuUHJvcHMge1xuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIGV4aXN0aW5nIFMzIGJ1Y2tldCB0byB1c2UgYXMgdGhlIG1lZGlhIG9yaWdpbi5cbiAgICAgKiBJZiBub3QgcHJvdmlkZWQsIGEgbmV3IGJ1Y2tldCB3aWxsIGJlIGNyZWF0ZWQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIE5hbWUgZm9yIHRoZSBtZWRpYSBidWNrZXQgKG9ubHkgdXNlZCBpZiBidWNrZXQgaXMgbm90IHByb3ZpZGVkKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBidWNrZXROYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGN1c3RvbSBkb21haW4sIGNlcnRpZmljYXRlLCBhbmQgUm91dGU1My5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBNZWRpYUNkbkRvbWFpbkNvbmZpZztcblxuICAgIC8qKlxuICAgICAqIFJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IHRvIGFwcGx5IHRvIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogUHJpdmF0ZSBtZWRpYSBjb25maWd1cmF0aW9uIGZvciBzaWduZWQgVVJMcy9jb29raWVzLlxuICAgICAqIFdoZW4gY29uZmlndXJlZCwgdGhlIGRpc3RyaWJ1dGlvbiB3aWxsIHJlcXVpcmUgYXV0aGVudGljYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHJpdmF0ZU1lZGlhPzogUHJpdmF0ZU1lZGlhQ29uZmlnO1xuXG4gICAgLyoqXG4gICAgICogRGVmYXVsdCByb290IG9iamVjdCBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBkZWZhdWx0Um9vdE9iamVjdD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgICAqXG4gICAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIHRoZSBtZWRpYSBidWNrZXQgdGFrZXMgaXRzIG5hbWUgZnJvbSB0aGVcbiAgICAgKiBjb250cmFjdCBhbmQgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBnbyB0b1xuICAgICAqIGBsb2dzL2FjY2Vzcy9jZG4ve2xvZ2ljYWxOYW1lfWAgdGhyb3VnaCBDbG91ZFdhdGNoIExvZ3MgdmVuZGVkIGRlbGl2ZXJ5LlxuICAgICAqIFBhc3MgYGVuYWJsZUxvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0IG9mIHRoZSBkZWxpdmVyeS5cbiAgICAgKlxuICAgICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgZGlzdHJpYnV0aW9uJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkXG4gICAgICogd2hlbiBhIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIENsb3VkRnJvbnQgc3RhbmRhcmQtbG9nZ2luZyBvdXRwdXQgZm9ybWF0IGZvciBhIENsb3VkV2F0Y2ggTG9nc1xuICAgICAqIGRlc3RpbmF0aW9uLiBPbmx5IHVzZWQgdW5kZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZS5cbiAgICAgKiBAZGVmYXVsdCBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0LlczQ1xuICAgICAqL1xuICAgIHJlYWRvbmx5IGNsb3VkRnJvbnRMb2dGb3JtYXQ/OiBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ2dpbmcuXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgUzMgYnVja2V0IGZvciBDbG91ZEZyb250IGFjY2VzcyBsb2dzLlxuICAgICAqIElmIG5vdCBwcm92aWRlZCBhbmQgZW5hYmxlTG9nZ2luZyBpcyB0cnVlLCBhIG5ldyBidWNrZXQgd2lsbCBiZSBjcmVhdGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIGNyZWF0ZWQgcmVzb3VyY2VzLlxuICAgICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGF1dG8tZGVsZXRlIG9iamVjdHMgaW4gY3JlYXRlZCBidWNrZXRzIG9uIHN0YWNrIGRlbGV0aW9uLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIHJlbW92YWxQb2xpY3kgaXMgREVTVFJPWS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIHdlYiBBQ0wgSUQgZm9yIEFXUyBXQUYgaW50ZWdyYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgd2ViQWNsSWQ/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBQcmljZSBjbGFzcyBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqIEBkZWZhdWx0IFByaWNlQ2xhc3MuUFJJQ0VfQ0xBU1NfQUxMXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHJpY2VDbGFzcz86IGNsb3VkZnJvbnQuUHJpY2VDbGFzcztcblxuICAgIC8qKlxuICAgICAqIEFuIG9wdGlvbmFsIG5hbWUvY29tbWVudCBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjb21tZW50Pzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQ2FjaGUgcG9saWN5IGZvciB0aGUgZGVmYXVsdCBiZWhhdmlvci5cbiAgICAgKiBAZGVmYXVsdCBDYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNhY2hlUG9saWN5PzogY2xvdWRmcm9udC5JQ2FjaGVQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBPcmlnaW4gcmVxdWVzdCBwb2xpY3kgZm9yIHRoZSBkZWZhdWx0IGJlaGF2aW9yLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IG9yaWdpblJlcXVlc3RQb2xpY3k/OiBjbG91ZGZyb250LklPcmlnaW5SZXF1ZXN0UG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogRXJyb3IgcmVzcG9uc2VzIGZvciB0aGUgZGlzdHJpYnV0aW9uIChlLmcuLCBjdXN0b20gNDA0IGhhbmRsaW5nKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBlcnJvclJlc3BvbnNlcz86IGNsb3VkZnJvbnQuRXJyb3JSZXNwb25zZVtdO1xuXG4gICAgLyoqXG4gICAgICogQWxsb3dlZCBIVFRQIG1ldGhvZHMgZm9yIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICogQGRlZmF1bHQgQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OU1xuICAgICAqL1xuICAgIHJlYWRvbmx5IGFsbG93ZWRNZXRob2RzPzogY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcztcbn1cblxuLyoqXG4gKiBBIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uIG9wdGltaXplZCBmb3Igc2VydmluZyBtZWRpYSBhc3NldHMgZnJvbSBTMy5cbiAqXG4gKiBUaGlzIGNvbnN0cnVjdCBjcmVhdGVzIG9yIHdyYXBzIGFuIFMzIGJ1Y2tldCB3aXRoIGEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb25cbiAqIGNvbmZpZ3VyZWQgZm9yIG1lZGlhIGRlbGl2ZXJ5LiBJdCBzdXBwb3J0czpcbiAqIC0gQ3VzdG9tIGRvbWFpbiB3aXRoIGNlcnRpZmljYXRlIGFuZCBSb3V0ZTUzIGludGVncmF0aW9uXG4gKiAtIFByaXZhdGUgbWVkaWEgYWNjZXNzIHZpYSBzaWduZWQgVVJMcy9jb29raWVzICh0cnVzdGVkIGtleSBncm91cHMpXG4gKiAtIEN1c3RvbWl6YWJsZSBjYWNoaW5nIGFuZCByZXNwb25zZSBoZWFkZXJzXG4gKiAtIEFjY2VzcyBsb2dnaW5nXG4gKlxuICogVXNlIGNhc2VzOlxuICogLSBQdWJsaWMgbWVkaWEgQ0ROIChpbWFnZXMsIHZpZGVvcywgZG9jdW1lbnRzKVxuICogLSBQcml2YXRlL2F1dGhlbnRpY2F0ZWQgbWVkaWEgYWNjZXNzXG4gKiAtIFN0YWdlLXNwZWNpZmljIG1lZGlhIHN1YmRvbWFpbnMgKGUuZy4sIG1lZGlhLnN0YWdlLmV4YW1wbGUuY29tKVxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWVkaWFDZG4gZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgZGlzdHJpYnV0aW9uOiBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbjtcblxuICAgIC8qKlxuICAgICAqIFRoZSBTMyBidWNrZXQgZm9yIG1lZGlhIGFzc2V0cy5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgYnVja2V0OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgYnVja2V0IChpZiBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBsb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBjZXJ0aWZpY2F0ZSB1c2VkIGZvciB0aGUgZGlzdHJpYnV0aW9uIChpZiBjdXN0b20gZG9tYWluIGlzIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBjZXJ0aWZpY2F0ZT86IGFjbS5JQ2VydGlmaWNhdGU7XG5cbiAgICAvKipcbiAgICAgKiBUaGUga2V5IGdyb3VwIGZvciBwcml2YXRlIG1lZGlhIGFjY2VzcyAoaWYgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGtleUdyb3VwPzogY2xvdWRmcm9udC5JS2V5R3JvdXA7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgcHVibGljIGtleSBjcmVhdGVkIGZvciBwcml2YXRlIG1lZGlhIChpZiBjcmVhdGVkIGZyb20gUEVNKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgcHVibGljS2V5PzogY2xvdWRmcm9udC5QdWJsaWNLZXk7XG5cbiAgICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWVkaWFDZG5Qcm9wcykge1xuICAgICAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5yZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgICAgICBjb25zdCBhdXRvRGVsZXRlT2JqZWN0cyA9IHByb3BzLmF1dG9EZWxldGVPYmplY3RzID8/IGZhbHNlO1xuICAgICAgICBjb25zdCBlbmFibGVMb2dnaW5nID0gcHJvcHMuZW5hYmxlTG9nZ2luZyA/PyB0cnVlO1xuICAgICAgICBjb25zdCBuYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICAgICAgY29uc3QgbG9naWNhbCA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChuYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICAgICAgcmVmdXNlRXhwbGljaXROYW1lKG5hbWluZ0NvbnRleHQsIFwiQXBwVGhlb3J5TWVkaWFDZG5cIiwgXCJidWNrZXROYW1lXCIsIFwiczNfYnVja2V0XCIsIGxvZ2ljYWwsIHByb3BzLmJ1Y2tldE5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgICAgIGlmIChuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgcHJvcHMubG9nc0J1Y2tldCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgXCJBcHBUaGVvcnlNZWRpYUNkbiBjYW5ub3QgaG9ub3IgcHJvcHMubG9nc0J1Y2tldCB1bmRlciB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlOyBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGdvIHRvIHRoZSBjb250cmFjdCBsb2cgZ3JvdXAsIHNvIHJlbW92ZSBwcm9wcy5sb2dzQnVja2V0IG9yIHVzZSB0aGUgbGVnYWN5IGxvZ2dpbmcgcHJvZmlsZVwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBzdGFuZGFyZExvZ2dpbmcgPSBuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgZW5hYmxlTG9nZ2luZztcblxuICAgICAgICAvLyBDcmVhdGUgb3IgdXNlIHRoZSBwcm92aWRlZCBtZWRpYSBidWNrZXRcbiAgICAgICAgaWYgKHByb3BzLmJ1Y2tldCkge1xuICAgICAgICAgICAgdGhpcy5idWNrZXQgPSBwcm9wcy5idWNrZXQ7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLmJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgXCJNZWRpYUJ1Y2tldFwiLCB7XG4gICAgICAgICAgICAgICAgLi4uKG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICAgICAgICAgICAgICA/IGJ1Y2tldE5hbWluZ1Byb3BzKG5hbWluZ0NvbnRleHQsIGAke2xvZ2ljYWx9LW1lZGlhYClcbiAgICAgICAgICAgICAgICAgICAgOiB7IGJ1Y2tldE5hbWU6IHByb3BzLmJ1Y2tldE5hbWUgfSksXG4gICAgICAgICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLkJVQ0tFVF9PV05FUl9FTkZPUkNFRCxcbiAgICAgICAgICAgICAgICB2ZXJzaW9uZWQ6IGZhbHNlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgbG9ncyBidWNrZXQgaWYgUzMgbG9nZ2luZyBpcyBlbmFibGVkIGFuZCB0aGUgc3RhbmRhcmQgcHJvZmlsZSBpc1xuICAgICAgICAvLyBub3QgcmVwbGFjaW5nIGl0IHdpdGggQ2xvdWRXYXRjaCBMb2dzIGRlbGl2ZXJ5LlxuICAgICAgICBpZiAoZW5hYmxlTG9nZ2luZyAmJiAhc3RhbmRhcmRMb2dnaW5nKSB7XG4gICAgICAgICAgICB0aGlzLmxvZ3NCdWNrZXQgPVxuICAgICAgICAgICAgICAgIHByb3BzLmxvZ3NCdWNrZXQgPz9cbiAgICAgICAgICAgICAgICBuZXcgczMuQnVja2V0KHRoaXMsIFwiQ2xvdWRGcm9udExvZ3NCdWNrZXRcIiwge1xuICAgICAgICAgICAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgICAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgICAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5PQkpFQ1RfV1JJVEVSLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gSGFuZGxlIHByaXZhdGUgbWVkaWEgY29uZmlndXJhdGlvblxuICAgICAgICBpZiAocHJvcHMucHJpdmF0ZU1lZGlhKSB7XG4gICAgICAgICAgICBpZiAocHJvcHMucHJpdmF0ZU1lZGlhLmtleUdyb3VwKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5rZXlHcm91cCA9IHByb3BzLnByaXZhdGVNZWRpYS5rZXlHcm91cDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMucHJpdmF0ZU1lZGlhLnB1YmxpY0tleVBlbSkge1xuICAgICAgICAgICAgICAgIC8vIENyZWF0ZSBhIHB1YmxpYyBrZXkgZnJvbSB0aGUgUEVNXG4gICAgICAgICAgICAgICAgdGhpcy5wdWJsaWNLZXkgPSBuZXcgY2xvdWRmcm9udC5QdWJsaWNLZXkodGhpcywgXCJQdWJsaWNLZXlcIiwge1xuICAgICAgICAgICAgICAgICAgICBlbmNvZGVkS2V5OiBwcm9wcy5wcml2YXRlTWVkaWEucHVibGljS2V5UGVtLFxuICAgICAgICAgICAgICAgICAgICBwdWJsaWNLZXlOYW1lOiBwcm9wcy5wcml2YXRlTWVkaWEucHVibGljS2V5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgY29tbWVudDogXCJQdWJsaWMga2V5IGZvciBNZWRpYSBDRE4gc2lnbmVkIFVSTHNcIixcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIC8vIENyZWF0ZSBhIGtleSBncm91cCB3aXRoIHRoZSBwdWJsaWMga2V5XG4gICAgICAgICAgICAgICAgdGhpcy5rZXlHcm91cCA9IG5ldyBjbG91ZGZyb250LktleUdyb3VwKHRoaXMsIFwiS2V5R3JvdXBcIiwge1xuICAgICAgICAgICAgICAgICAgICBrZXlHcm91cE5hbWU6IHByb3BzLnByaXZhdGVNZWRpYS5rZXlHcm91cE5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGl0ZW1zOiBbdGhpcy5wdWJsaWNLZXldLFxuICAgICAgICAgICAgICAgICAgICBjb21tZW50OiBwcm9wcy5wcml2YXRlTWVkaWEua2V5R3JvdXBDb21tZW50ID8/IFwiS2V5IGdyb3VwIGZvciBNZWRpYSBDRE4gcHJpdmF0ZSBhY2Nlc3NcIixcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEhhbmRsZSBkb21haW4gY29uZmlndXJhdGlvblxuICAgICAgICBsZXQgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXM6IHN0cmluZ1tdIHwgdW5kZWZpbmVkO1xuICAgICAgICBsZXQgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU6IGFjbS5JQ2VydGlmaWNhdGUgfCB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbikge1xuICAgICAgICAgICAgY29uc3QgZG9tYWluTmFtZSA9IFN0cmluZyhwcm9wcy5kb21haW4uZG9tYWluTmFtZSkudHJpbSgpO1xuICAgICAgICAgICAgaWYgKGRvbWFpbk5hbWUpIHtcbiAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25Eb21haW5OYW1lcyA9IFtkb21haW5OYW1lXTtcblxuICAgICAgICAgICAgICAgIGlmIChwcm9wcy5kb21haW4uY2VydGlmaWNhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBwcm9wcy5kb21haW4uY2VydGlmaWNhdGU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4pIHtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBhY20uQ2VydGlmaWNhdGUuZnJvbUNlcnRpZmljYXRlQXJuKFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcyxcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiQ2VydGlmaWNhdGVcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZUFybixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmRvbWFpbi5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydENsb3VkRnJvbnRIb3N0ZWRab25lQ2VydGlmaWNhdGVSZWdpb24odGhpcywgXCJBcHBUaGVvcnlNZWRpYUNkblwiKTtcbiAgICAgICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgPSBuZXcgYWNtLkNlcnRpZmljYXRlKHRoaXMsIFwiQ2VydGlmaWNhdGVcIiwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHZhbGlkYXRpb246IGFjbS5DZXJ0aWZpY2F0ZVZhbGlkYXRpb24uZnJvbURucyhwcm9wcy5kb21haW4uaG9zdGVkWm9uZSksXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiQXBwVGhlb3J5TWVkaWFDZG4gcmVxdWlyZXMgZG9tYWluLmNlcnRpZmljYXRlLCBkb21haW4uY2VydGlmaWNhdGVBcm4sIG9yIGRvbWFpbi5ob3N0ZWRab25lIHdoZW4gZG9tYWluLmRvbWFpbk5hbWUgaXMgc2V0XCIsXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5jZXJ0aWZpY2F0ZSA9IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlO1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgUzMgb3JpZ2luIHdpdGggT3JpZ2luIEFjY2VzcyBDb250cm9sXG4gICAgICAgIGNvbnN0IG1lZGlhQnVja2V0T3JpZ2luID0gb3JpZ2lucy5TM0J1Y2tldE9yaWdpbi53aXRoT3JpZ2luQWNjZXNzQ29udHJvbCh0aGlzLmJ1Y2tldCk7XG5cbiAgICAgICAgLy8gQnVpbGQgZGVmYXVsdCBiZWhhdmlvciBvcHRpb25zXG4gICAgICAgIGNvbnN0IGRlZmF1bHRCZWhhdmlvck9wdGlvbnM6IGNsb3VkZnJvbnQuQmVoYXZpb3JPcHRpb25zID0ge1xuICAgICAgICAgICAgb3JpZ2luOiBtZWRpYUJ1Y2tldE9yaWdpbixcbiAgICAgICAgICAgIHZpZXdlclByb3RvY29sUG9saWN5OiBjbG91ZGZyb250LlZpZXdlclByb3RvY29sUG9saWN5LlJFRElSRUNUX1RPX0hUVFBTLFxuICAgICAgICAgICAgYWxsb3dlZE1ldGhvZHM6IHByb3BzLmFsbG93ZWRNZXRob2RzID8/IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHMuQUxMT1dfR0VUX0hFQURfT1BUSU9OUyxcbiAgICAgICAgICAgIGNhY2hlUG9saWN5OiBwcm9wcy5jYWNoZVBvbGljeSA/PyBjbG91ZGZyb250LkNhY2hlUG9saWN5LkNBQ0hJTkdfT1BUSU1JWkVELFxuICAgICAgICAgICAgY29tcHJlc3M6IHRydWUsXG4gICAgICAgICAgICAuLi4ocHJvcHMub3JpZ2luUmVxdWVzdFBvbGljeSA/IHsgb3JpZ2luUmVxdWVzdFBvbGljeTogcHJvcHMub3JpZ2luUmVxdWVzdFBvbGljeSB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSA/IHsgcmVzcG9uc2VIZWFkZXJzUG9saWN5OiBwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLih0aGlzLmtleUdyb3VwID8geyB0cnVzdGVkS2V5R3JvdXBzOiBbdGhpcy5rZXlHcm91cF0gfSA6IHt9KSxcbiAgICAgICAgfTtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIGRpc3RyaWJ1dGlvblxuICAgICAgICB0aGlzLmRpc3RyaWJ1dGlvbiA9IG5ldyBjbG91ZGZyb250LkRpc3RyaWJ1dGlvbih0aGlzLCBcIkRpc3RyaWJ1dGlvblwiLCB7XG4gICAgICAgICAgICAuLi4oZW5hYmxlTG9nZ2luZyAmJiB0aGlzLmxvZ3NCdWNrZXRcbiAgICAgICAgICAgICAgICA/IHsgZW5hYmxlTG9nZ2luZzogdHJ1ZSwgbG9nQnVja2V0OiB0aGlzLmxvZ3NCdWNrZXQsIGxvZ0ZpbGVQcmVmaXg6IFwiY2xvdWRmcm9udC9cIiB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAuLi4oZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgJiYgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGVcbiAgICAgICAgICAgICAgICA/IHsgZG9tYWluTmFtZXM6IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzLCBjZXJ0aWZpY2F0ZTogZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgfVxuICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgZGVmYXVsdEJlaGF2aW9yOiBkZWZhdWx0QmVoYXZpb3JPcHRpb25zLFxuICAgICAgICAgICAgLi4uKHByb3BzLmRlZmF1bHRSb290T2JqZWN0ID8geyBkZWZhdWx0Um9vdE9iamVjdDogcHJvcHMuZGVmYXVsdFJvb3RPYmplY3QgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy53ZWJBY2xJZCA/IHsgd2ViQWNsSWQ6IHByb3BzLndlYkFjbElkIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMucHJpY2VDbGFzcyA/IHsgcHJpY2VDbGFzczogcHJvcHMucHJpY2VDbGFzcyB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLmNvbW1lbnQgPyB7IGNvbW1lbnQ6IHByb3BzLmNvbW1lbnQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5lcnJvclJlc3BvbnNlcyA/IHsgZXJyb3JSZXNwb25zZXM6IHByb3BzLmVycm9yUmVzcG9uc2VzIH0gOiB7fSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChzdGFuZGFyZExvZ2dpbmcgJiYgbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsKSB7XG4gICAgICAgICAgICBlbmFibGVDbG91ZEZyb250U3RhbmRhcmRMb2dnaW5nKHtcbiAgICAgICAgICAgICAgICBzY29wZTogdGhpcyxcbiAgICAgICAgICAgICAgICBpZDogXCJDZG5Mb2dnaW5nXCIsXG4gICAgICAgICAgICAgICAgY29udGV4dDogbmFtaW5nQ29udGV4dCxcbiAgICAgICAgICAgICAgICBkaXN0cmlidXRpb246IHRoaXMuZGlzdHJpYnV0aW9uLFxuICAgICAgICAgICAgICAgIGxvZ2ljYWw6IGBsb2dzL2FjY2Vzcy9jZG4vJHtsb2dpY2FsfWAsXG4gICAgICAgICAgICAgICAgZm9ybWF0OiBwcm9wcy5jbG91ZEZyb250TG9nRm9ybWF0LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgUm91dGU1MyBBIHJlY29yZCBpZiBob3N0ZWQgem9uZSBpcyBwcm92aWRlZFxuICAgICAgICBpZiAocHJvcHMuZG9tYWluPy5kb21haW5OYW1lICYmIHByb3BzLmRvbWFpbj8uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgICAgICAgICB6b25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW4uZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHByb3BzLmRvbWFpbi5jcmVhdGVBQUFBUmVjb3JkID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkQUFBQVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIHpvbmU6IHByb3BzLmRvbWFpbi5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW4uZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuIl19