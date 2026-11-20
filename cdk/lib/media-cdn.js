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
const secure_defaults_1 = require("./private/secure-defaults");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWVkaWEtY2RuLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWVkaWEtY2RuLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBMEQ7QUFDMUQsd0VBQTBEO0FBQzFELHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUMzRCx1REFBeUM7QUFDekMsMkNBQXVDO0FBR3ZDLHlEQUE0RDtBQUM1RCx5RUFBb0U7QUFDcEUsK0RBQTBFO0FBQzFFLGlFQUFnRztBQUdoRyxTQUFTLDJDQUEyQyxDQUFDLEtBQWdCLEVBQUUsYUFBcUI7SUFDeEYsTUFBTSxNQUFNLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQ3RDLElBQUksQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNLEtBQUssV0FBVyxFQUFFLENBQUM7UUFDeEQsT0FBTztJQUNYLENBQUM7SUFFRCxNQUFNLGlCQUFpQixHQUFHLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUM3RSxNQUFNLElBQUksS0FBSyxDQUNYLEdBQUcsYUFBYSx3SEFBd0gsaUJBQWlCLDRHQUE0RyxDQUN4USxDQUFDO0FBQ04sQ0FBQztBQW9ORDs7Ozs7Ozs7Ozs7Ozs7R0FjRztBQUNILE1BQWEsaUJBQWtCLFNBQVEsc0JBQVM7O0lBQzVDOztPQUVHO0lBQ2EsWUFBWSxDQUEwQjtJQUV0RDs7T0FFRztJQUNhLE1BQU0sQ0FBYTtJQUVuQzs7T0FFRztJQUNhLFVBQVUsQ0FBYztJQUV4Qzs7T0FFRztJQUNhLFdBQVcsQ0FBb0I7SUFFL0M7O09BRUc7SUFDYSxRQUFRLENBQXdCO0lBRWhEOztPQUVHO0lBQ2EsU0FBUyxDQUF3QjtJQUVqRCxZ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RCxJQUFJLEtBQUssQ0FBQyxNQUFNLEVBQUUsVUFBVSxJQUFJLEtBQUssQ0FBQyxNQUFNLEVBQUUsVUFBVSxFQUFFLENBQUM7WUFDdkQsSUFBSSxPQUFPLENBQUMsT0FBTyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7Z0JBQ3JDLElBQUksRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVU7Z0JBQzdCLFVBQVUsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVU7Z0JBQ25DLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7YUFDMUYsQ0FBQyxDQUFDO1lBRUgsSUFBSSxLQUFLLENBQUMsTUFBTSxDQUFDLGdCQUFnQixLQUFLLElBQUksRUFBRSxDQUFDO2dCQUN6QyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO29CQUM1QyxJQUFJLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxVQUFVO29CQUM3QixVQUFVLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxVQUFVO29CQUNuQyxNQUFNLEVBQUUsT0FBTyxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUMsSUFBSSxPQUFPLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO2lCQUMxRixDQUFDLENBQUM7WUFDUCxDQUFDO1FBQ0wsQ0FBQztJQUNMLENBQUM7O0FBOU1MLDhDQStNQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQgfSBmcm9tIFwiLi9sb2dnaW5nXCI7XG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24gfSBmcm9tIFwiLi9wcml2YXRlL3NlY3VyZS1kZWZhdWx0c1wiO1xuaW1wb3J0IHsgYnVja2V0TmFtaW5nUHJvcHMsIGVuYWJsZUNsb3VkRnJvbnRTdGFuZGFyZExvZ2dpbmcgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5cbmZ1bmN0aW9uIGFzc2VydENsb3VkRnJvbnRIb3N0ZWRab25lQ2VydGlmaWNhdGVSZWdpb24oc2NvcGU6IENvbnN0cnVjdCwgY29uc3RydWN0TmFtZTogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgcmVnaW9uID0gU3RhY2sub2Yoc2NvcGUpLnJlZ2lvbjtcbiAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pICYmIHJlZ2lvbiA9PT0gXCJ1cy1lYXN0LTFcIikge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcmVnaW9uRGVzY3JpcHRpb24gPSBUb2tlbi5pc1VucmVzb2x2ZWQocmVnaW9uKSA/IFwidW5yZXNvbHZlZFwiIDogcmVnaW9uO1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYCR7Y29uc3RydWN0TmFtZX0gY2Fubm90IGNyZWF0ZSBhIGhvc3RlZC16b25lIENsb3VkRnJvbnQgY2VydGlmaWNhdGUgdW5sZXNzIHRoZSBzdGFjayByZWdpb24gaXMgZXhwbGljaXRseSB1cy1lYXN0LTE7IHN0YWNrIHJlZ2lvbiBpcyAke3JlZ2lvbkRlc2NyaXB0aW9ufS4gUHJvdmlkZSBkb21haW4uY2VydGlmaWNhdGUgb3IgZG9tYWluLmNlcnRpZmljYXRlQXJuIGZvciBzdGFja3MgaW4gb3RoZXIgb3IgZW52aXJvbm1lbnQtYWdub3N0aWMgcmVnaW9ucy5gLFxuICAgICk7XG59XG5cbi8qKlxuICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNZWRpYSBDRE4gZGlzdHJpYnV0aW9uLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIE1lZGlhQ2RuRG9tYWluQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBUaGUgZG9tYWluIG5hbWUgZm9yIHRoZSBkaXN0cmlidXRpb24gKGUuZy4sIFwibWVkaWEuZXhhbXBsZS5jb21cIikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQUNNIGNlcnRpZmljYXRlIGZvciBIVFRQUy4gTXVzdCBiZSBpbiB1cy1lYXN0LTEgZm9yIENsb3VkRnJvbnQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgLyoqXG4gICAgICogQVJOIG9mIGFuIGV4aXN0aW5nIEFDTSBjZXJ0aWZpY2F0ZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIEROUyByZWNvcmQgY3JlYXRpb24uXG4gICAgICogV2hlbiBwcm92aWRlZCwgYW4gQSByZWNvcmQgYWxpYXMgd2lsbCBiZSBjcmVhdGVkIGZvciB0aGUgZG9tYWluLlxuICAgICAqXG4gICAgICogSWYgYGRvbWFpbk5hbWVgIGlzIHNldCB3aXRob3V0IGBjZXJ0aWZpY2F0ZWAgb3IgYGNlcnRpZmljYXRlQXJuYCxcbiAgICAgKiBob3N0ZWQtem9uZSBjZXJ0aWZpY2F0ZSBjcmVhdGlvbiBpcyBhbGxvd2VkIG9ubHkgZm9yIHN0YWNrcyB3aG9zZSByZWdpb25cbiAgICAgKiBpcyBleHBsaWNpdGx5IGB1cy1lYXN0LTFgLiBDbG91ZEZyb250IHJlcXVpcmVzIHZpZXdlciBjZXJ0aWZpY2F0ZXMgaW5cbiAgICAgKiBgdXMtZWFzdC0xYDsgZW52aXJvbm1lbnQtYWdub3N0aWMgb3Igb3RoZXItcmVnaW9uIHN0YWNrcyBtdXN0IHByb3ZpZGUgYW5cbiAgICAgKiBleHBsaWNpdCBjZXJ0aWZpY2F0ZSBpbnB1dC5cbiAgICAgKi9cbiAgICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gY3JlYXRlIGFuIEFBQUEgYWxpYXMgcmVjb3JkIGluIGFkZGl0aW9uIHRvIHRoZSBBIGFsaWFzIHJlY29yZC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNyZWF0ZUFBQUFSZWNvcmQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIHByaXZhdGUgbWVkaWEgYWNjZXNzIHVzaW5nIENsb3VkRnJvbnQgc2lnbmVkIFVSTHMvY29va2llcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcml2YXRlTWVkaWFDb25maWcge1xuICAgIC8qKlxuICAgICAqIEFuIGV4aXN0aW5nIENsb3VkRnJvbnQga2V5IGdyb3VwIHRvIHVzZSBmb3IgdHJ1c3RlZCBrZXkgZ3JvdXBzLlxuICAgICAqIFdoZW4gcHJvdmlkZWQsIHRoZSBkaXN0cmlidXRpb24gd2lsbCByZXF1aXJlIHNpZ25lZCBVUkxzIG9yIHNpZ25lZCBjb29raWVzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGtleUdyb3VwPzogY2xvdWRmcm9udC5JS2V5R3JvdXA7XG5cbiAgICAvKipcbiAgICAgKiBQdWJsaWMga2V5IFBFTSBjb250ZW50IGZvciBjcmVhdGluZyBhIG5ldyBrZXkgZ3JvdXAuXG4gICAgICogT25seSB1c2VkIGlmIGtleUdyb3VwIGlzIG5vdCBwcm92aWRlZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBwdWJsaWNLZXlQZW0/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBOYW1lIGZvciB0aGUgcHVibGljIGtleSB3aGVuIGNyZWF0ZWQgZnJvbSBQRU0uXG4gICAgICogQGRlZmF1bHQgXCJNZWRpYUNkblB1YmxpY0tleVwiXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHVibGljS2V5TmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE5hbWUgZm9yIHRoZSBrZXkgZ3JvdXAgd2hlbiBjcmVhdGVkLlxuICAgICAqIEBkZWZhdWx0IFwiTWVkaWFDZG5LZXlHcm91cFwiXG4gICAgICovXG4gICAgcmVhZG9ubHkga2V5R3JvdXBOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQ29tbWVudC9kZXNjcmlwdGlvbiBmb3IgdGhlIGtleSBncm91cC5cbiAgICAgKi9cbiAgICByZWFkb25seSBrZXlHcm91cENvbW1lbnQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWVkaWFDZG5Qcm9wcyB7XG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgZXhpc3RpbmcgUzMgYnVja2V0IHRvIHVzZSBhcyB0aGUgbWVkaWEgb3JpZ2luLlxuICAgICAqIElmIG5vdCBwcm92aWRlZCwgYSBuZXcgYnVja2V0IHdpbGwgYmUgY3JlYXRlZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBidWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogTmFtZSBmb3IgdGhlIG1lZGlhIGJ1Y2tldCAob25seSB1c2VkIGlmIGJ1Y2tldCBpcyBub3QgcHJvdmlkZWQpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJ1Y2tldE5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgY3VzdG9tIGRvbWFpbiwgY2VydGlmaWNhdGUsIGFuZCBSb3V0ZTUzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbj86IE1lZGlhQ2RuRG9tYWluQ29uZmlnO1xuXG4gICAgLyoqXG4gICAgICogUmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgdG8gYXBwbHkgdG8gdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBQcml2YXRlIG1lZGlhIGNvbmZpZ3VyYXRpb24gZm9yIHNpZ25lZCBVUkxzL2Nvb2tpZXMuXG4gICAgICogV2hlbiBjb25maWd1cmVkLCB0aGUgZGlzdHJpYnV0aW9uIHdpbGwgcmVxdWlyZSBhdXRoZW50aWNhdGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBwcml2YXRlTWVkaWE/OiBQcml2YXRlTWVkaWFDb25maWc7XG5cbiAgICAvKipcbiAgICAgKiBEZWZhdWx0IHJvb3Qgb2JqZWN0IGZvciB0aGUgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlZmF1bHRSb290T2JqZWN0Pzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAgICpcbiAgICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgdGhlIG1lZGlhIGJ1Y2tldCB0YWtlcyBpdHMgbmFtZSBmcm9tIHRoZVxuICAgICAqIGNvbnRyYWN0IGFuZCBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGdvIHRvXG4gICAgICogYGxvZ3MvYWNjZXNzL2Nkbi97bG9naWNhbE5hbWV9YCB0aHJvdWdoIENsb3VkV2F0Y2ggTG9ncyB2ZW5kZWQgZGVsaXZlcnkuXG4gICAgICogUGFzcyBgZW5hYmxlTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQgb2YgdGhlIGRlbGl2ZXJ5LlxuICAgICAqXG4gICAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBkaXN0cmlidXRpb24ncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWRcbiAgICAgKiB3aGVuIGEgbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQ2xvdWRGcm9udCBzdGFuZGFyZC1sb2dnaW5nIG91dHB1dCBmb3JtYXQgZm9yIGEgQ2xvdWRXYXRjaCBMb2dzXG4gICAgICogZGVzdGluYXRpb24uIE9ubHkgdXNlZCB1bmRlciB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlLlxuICAgICAqIEBkZWZhdWx0IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQuSlNPTlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNsb3VkRnJvbnRMb2dGb3JtYXQ/OiBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ2dpbmcuXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgUzMgYnVja2V0IGZvciBDbG91ZEZyb250IGFjY2VzcyBsb2dzLlxuICAgICAqIElmIG5vdCBwcm92aWRlZCBhbmQgZW5hYmxlTG9nZ2luZyBpcyB0cnVlLCBhIG5ldyBidWNrZXQgd2lsbCBiZSBjcmVhdGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIGNyZWF0ZWQgcmVzb3VyY2VzLlxuICAgICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGF1dG8tZGVsZXRlIG9iamVjdHMgaW4gY3JlYXRlZCBidWNrZXRzIG9uIHN0YWNrIGRlbGV0aW9uLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIHJlbW92YWxQb2xpY3kgaXMgREVTVFJPWS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIHdlYiBBQ0wgSUQgZm9yIEFXUyBXQUYgaW50ZWdyYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgd2ViQWNsSWQ/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBQcmljZSBjbGFzcyBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqIEBkZWZhdWx0IFByaWNlQ2xhc3MuUFJJQ0VfQ0xBU1NfQUxMXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHJpY2VDbGFzcz86IGNsb3VkZnJvbnQuUHJpY2VDbGFzcztcblxuICAgIC8qKlxuICAgICAqIEFuIG9wdGlvbmFsIG5hbWUvY29tbWVudCBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjb21tZW50Pzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogTWluaW11bSBUTFMgcHJvdG9jb2wgdmVyc2lvbiBmb3Igdmlld2VycyBvZiBhIGN1c3RvbSBkb21haW4uXG4gICAgICpcbiAgICAgKiBXaXRoIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCBhbmQgYSBjdXN0b20gY2VydGlmaWNhdGUgdGhlIGRlZmF1bHQgaXNcbiAgICAgKiBgVExTX1YxXzJfMjAyNWAsIHRoZSBwb2xpY3kgU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMTUgYWNjZXB0cyB3aXRoIHRoZVxuICAgICAqIHdpZGVzdCBjbGllbnQgc3VwcG9ydC5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IFRMU19WMV8yXzIwMjUgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0IHdpdGggYSBjZXJ0aWZpY2F0ZSxcbiAgICAgKiBvdGhlcndpc2UgdGhlIENsb3VkRnJvbnQgZGVmYXVsdCBmb3IgdGhlIGNlcnRpZmljYXRlXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWluaW11bVByb3RvY29sVmVyc2lvbj86IGNsb3VkZnJvbnQuU2VjdXJpdHlQb2xpY3lQcm90b2NvbDtcblxuICAgIC8qKlxuICAgICAqIENhY2hlIHBvbGljeSBmb3IgdGhlIGRlZmF1bHQgYmVoYXZpb3IuXG4gICAgICogQGRlZmF1bHQgQ2FjaGVQb2xpY3kuQ0FDSElOR19PUFRJTUlaRURcbiAgICAgKi9cbiAgICByZWFkb25seSBjYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogT3JpZ2luIHJlcXVlc3QgcG9saWN5IGZvciB0aGUgZGVmYXVsdCBiZWhhdmlvci5cbiAgICAgKi9cbiAgICByZWFkb25seSBvcmlnaW5SZXF1ZXN0UG9saWN5PzogY2xvdWRmcm9udC5JT3JpZ2luUmVxdWVzdFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIEVycm9yIHJlc3BvbnNlcyBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoZS5nLiwgY3VzdG9tIDQwNCBoYW5kbGluZykuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZXJyb3JSZXNwb25zZXM/OiBjbG91ZGZyb250LkVycm9yUmVzcG9uc2VbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzIGZvciB0aGUgZGlzdHJpYnV0aW9uLlxuICAgICAqIEBkZWZhdWx0IEFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlNcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd2VkTWV0aG9kcz86IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHM7XG59XG5cbi8qKlxuICogQSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiBvcHRpbWl6ZWQgZm9yIHNlcnZpbmcgbWVkaWEgYXNzZXRzIGZyb20gUzMuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgY3JlYXRlcyBvciB3cmFwcyBhbiBTMyBidWNrZXQgd2l0aCBhIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uXG4gKiBjb25maWd1cmVkIGZvciBtZWRpYSBkZWxpdmVyeS4gSXQgc3VwcG9ydHM6XG4gKiAtIEN1c3RvbSBkb21haW4gd2l0aCBjZXJ0aWZpY2F0ZSBhbmQgUm91dGU1MyBpbnRlZ3JhdGlvblxuICogLSBQcml2YXRlIG1lZGlhIGFjY2VzcyB2aWEgc2lnbmVkIFVSTHMvY29va2llcyAodHJ1c3RlZCBrZXkgZ3JvdXBzKVxuICogLSBDdXN0b21pemFibGUgY2FjaGluZyBhbmQgcmVzcG9uc2UgaGVhZGVyc1xuICogLSBBY2Nlc3MgbG9nZ2luZ1xuICpcbiAqIFVzZSBjYXNlczpcbiAqIC0gUHVibGljIG1lZGlhIENETiAoaW1hZ2VzLCB2aWRlb3MsIGRvY3VtZW50cylcbiAqIC0gUHJpdmF0ZS9hdXRoZW50aWNhdGVkIG1lZGlhIGFjY2Vzc1xuICogLSBTdGFnZS1zcGVjaWZpYyBtZWRpYSBzdWJkb21haW5zIChlLmcuLCBtZWRpYS5zdGFnZS5leGFtcGxlLmNvbSlcbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1lZGlhQ2RuIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgUzMgYnVja2V0IGZvciBtZWRpYSBhc3NldHMuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGJ1Y2tldDogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGJ1Y2tldCAoaWYgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgY2VydGlmaWNhdGUgdXNlZCBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoaWYgY3VzdG9tIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGtleSBncm91cCBmb3IgcHJpdmF0ZSBtZWRpYSBhY2Nlc3MgKGlmIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBrZXlHcm91cD86IGNsb3VkZnJvbnQuSUtleUdyb3VwO1xuXG4gICAgLyoqXG4gICAgICogVGhlIHB1YmxpYyBrZXkgY3JlYXRlZCBmb3IgcHJpdmF0ZSBtZWRpYSAoaWYgY3JlYXRlZCBmcm9tIFBFTSkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHB1YmxpY0tleT86IGNsb3VkZnJvbnQuUHVibGljS2V5O1xuXG4gICAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1lZGlhQ2RuUHJvcHMpIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICAgICAgY29uc3QgYXV0b0RlbGV0ZU9iamVjdHMgPSBwcm9wcy5hdXRvRGVsZXRlT2JqZWN0cyA/PyBmYWxzZTtcbiAgICAgICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcbiAgICAgICAgY29uc3QgbmFtaW5nQ29udGV4dCA9IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAobmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgICAgIHJlZnVzZUV4cGxpY2l0TmFtZShcbiAgICAgICAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgICAgICAgICBcIkFwcFRoZW9yeU1lZGlhQ2RuXCIsXG4gICAgICAgICAgICBcImJ1Y2tldE5hbWVcIixcbiAgICAgICAgICAgIFwiczNfYnVja2V0XCIsXG4gICAgICAgICAgICBsb2dpY2FsID8gYCR7bG9naWNhbH0tbWVkaWFgIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgcHJvcHMuYnVja2V0TmFtZSAhPT0gdW5kZWZpbmVkLFxuICAgICAgICApO1xuICAgICAgICBpZiAobmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIHByb3BzLmxvZ3NCdWNrZXQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIFwiQXBwVGhlb3J5TWVkaWFDZG4gY2Fubm90IGhvbm9yIHByb3BzLmxvZ3NCdWNrZXQgdW5kZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZTsgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBnbyB0byB0aGUgY29udHJhY3QgbG9nIGdyb3VwLCBzbyByZW1vdmUgcHJvcHMubG9nc0J1Y2tldCBvciB1c2UgdGhlIGxlZ2FjeSBsb2dnaW5nIHByb2ZpbGVcIixcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc3RhbmRhcmRMb2dnaW5nID0gbmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIGVuYWJsZUxvZ2dpbmc7XG5cbiAgICAgICAgLy8gQ3JlYXRlIG9yIHVzZSB0aGUgcHJvdmlkZWQgbWVkaWEgYnVja2V0XG4gICAgICAgIGlmIChwcm9wcy5idWNrZXQpIHtcbiAgICAgICAgICAgIHRoaXMuYnVja2V0ID0gcHJvcHMuYnVja2V0O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiTWVkaWFCdWNrZXRcIiwge1xuICAgICAgICAgICAgICAgIC4uLihuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgICAgICAgICAgICAgPyBidWNrZXROYW1pbmdQcm9wcyhuYW1pbmdDb250ZXh0LCBgJHtsb2dpY2FsfS1tZWRpYWApXG4gICAgICAgICAgICAgICAgICAgIDogeyBidWNrZXROYW1lOiBwcm9wcy5idWNrZXROYW1lIH0pLFxuICAgICAgICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICAgICAgICBvYmplY3RPd25lcnNoaXA6IHMzLk9iamVjdE93bmVyc2hpcC5CVUNLRVRfT1dORVJfRU5GT1JDRUQsXG4gICAgICAgICAgICAgICAgdmVyc2lvbmVkOiBmYWxzZSxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIGxvZ3MgYnVja2V0IGlmIFMzIGxvZ2dpbmcgaXMgZW5hYmxlZCBhbmQgdGhlIHN0YW5kYXJkIHByb2ZpbGUgaXNcbiAgICAgICAgLy8gbm90IHJlcGxhY2luZyBpdCB3aXRoIENsb3VkV2F0Y2ggTG9ncyBkZWxpdmVyeS5cbiAgICAgICAgaWYgKGVuYWJsZUxvZ2dpbmcgJiYgIXN0YW5kYXJkTG9nZ2luZykge1xuICAgICAgICAgICAgdGhpcy5sb2dzQnVja2V0ID1cbiAgICAgICAgICAgICAgICBwcm9wcy5sb2dzQnVja2V0ID8/XG4gICAgICAgICAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkNsb3VkRnJvbnRMb2dzQnVja2V0XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICAgICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgICAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgICAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICAgICAgICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuT0JKRUNUX1dSSVRFUixcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEhhbmRsZSBwcml2YXRlIG1lZGlhIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgaWYgKHByb3BzLnByaXZhdGVNZWRpYSkge1xuICAgICAgICAgICAgaWYgKHByb3BzLnByaXZhdGVNZWRpYS5rZXlHcm91cCkge1xuICAgICAgICAgICAgICAgIHRoaXMua2V5R3JvdXAgPSBwcm9wcy5wcml2YXRlTWVkaWEua2V5R3JvdXA7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLnByaXZhdGVNZWRpYS5wdWJsaWNLZXlQZW0pIHtcbiAgICAgICAgICAgICAgICAvLyBDcmVhdGUgYSBwdWJsaWMga2V5IGZyb20gdGhlIFBFTVxuICAgICAgICAgICAgICAgIHRoaXMucHVibGljS2V5ID0gbmV3IGNsb3VkZnJvbnQuUHVibGljS2V5KHRoaXMsIFwiUHVibGljS2V5XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgZW5jb2RlZEtleTogcHJvcHMucHJpdmF0ZU1lZGlhLnB1YmxpY0tleVBlbSxcbiAgICAgICAgICAgICAgICAgICAgcHVibGljS2V5TmFtZTogcHJvcHMucHJpdmF0ZU1lZGlhLnB1YmxpY0tleU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbW1lbnQ6IFwiUHVibGljIGtleSBmb3IgTWVkaWEgQ0ROIHNpZ25lZCBVUkxzXCIsXG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAvLyBDcmVhdGUgYSBrZXkgZ3JvdXAgd2l0aCB0aGUgcHVibGljIGtleVxuICAgICAgICAgICAgICAgIHRoaXMua2V5R3JvdXAgPSBuZXcgY2xvdWRmcm9udC5LZXlHcm91cCh0aGlzLCBcIktleUdyb3VwXCIsIHtcbiAgICAgICAgICAgICAgICAgICAga2V5R3JvdXBOYW1lOiBwcm9wcy5wcml2YXRlTWVkaWEua2V5R3JvdXBOYW1lLFxuICAgICAgICAgICAgICAgICAgICBpdGVtczogW3RoaXMucHVibGljS2V5XSxcbiAgICAgICAgICAgICAgICAgICAgY29tbWVudDogcHJvcHMucHJpdmF0ZU1lZGlhLmtleUdyb3VwQ29tbWVudCA/PyBcIktleSBncm91cCBmb3IgTWVkaWEgQ0ROIHByaXZhdGUgYWNjZXNzXCIsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBIYW5kbGUgZG9tYWluIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgICAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluLmRvbWFpbk5hbWUpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG5cbiAgICAgICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4sXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHRoaXMsIFwiQXBwVGhlb3J5TWVkaWFDZG5cIik7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uOiBhY20uQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnMocHJvcHMuZG9tYWluLmhvc3RlZFpvbmUpLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkFwcFRoZW9yeU1lZGlhQ2RuIHJlcXVpcmVzIGRvbWFpbi5jZXJ0aWZpY2F0ZSwgZG9tYWluLmNlcnRpZmljYXRlQXJuLCBvciBkb21haW4uaG9zdGVkWm9uZSB3aGVuIGRvbWFpbi5kb21haW5OYW1lIGlzIHNldFwiLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIFMzIG9yaWdpbiB3aXRoIE9yaWdpbiBBY2Nlc3MgQ29udHJvbFxuICAgICAgICBjb25zdCBtZWRpYUJ1Y2tldE9yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5idWNrZXQpO1xuXG4gICAgICAgIC8vIEJ1aWxkIGRlZmF1bHQgYmVoYXZpb3Igb3B0aW9uc1xuICAgICAgICBjb25zdCBkZWZhdWx0QmVoYXZpb3JPcHRpb25zOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9IHtcbiAgICAgICAgICAgIG9yaWdpbjogbWVkaWFCdWNrZXRPcmlnaW4sXG4gICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBwcm9wcy5hbGxvd2VkTWV0aG9kcyA/PyBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICAgICAgICBjYWNoZVBvbGljeTogcHJvcHMuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRCxcbiAgICAgICAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgICAgICAgLi4uKHByb3BzLm9yaWdpblJlcXVlc3RQb2xpY3kgPyB7IG9yaWdpblJlcXVlc3RQb2xpY3k6IHByb3BzLm9yaWdpblJlcXVlc3RQb2xpY3kgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPyB7IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5IH0gOiB7fSksXG4gICAgICAgICAgICAuLi4odGhpcy5rZXlHcm91cCA/IHsgdHJ1c3RlZEtleUdyb3VwczogW3RoaXMua2V5R3JvdXBdIH0gOiB7fSksXG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBkaXN0cmlidXRpb25cbiAgICAgICAgLy8gU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMTUgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0LlxuICAgICAgICBjb25zdCBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uID0gZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24oXG4gICAgICAgICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgIT09IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHByb3BzLm1pbmltdW1Qcm90b2NvbFZlcnNpb24sXG4gICAgICAgICk7XG4gICAgICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgICAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICAgICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICAgICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAuLi4obWluaW11bVByb3RvY29sVmVyc2lvbiAhPT0gdW5kZWZpbmVkID8geyBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uIH0gOiB7fSksXG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IGRlZmF1bHRCZWhhdmlvck9wdGlvbnMsXG4gICAgICAgICAgICAuLi4ocHJvcHMuZGVmYXVsdFJvb3RPYmplY3QgPyB7IGRlZmF1bHRSb290T2JqZWN0OiBwcm9wcy5kZWZhdWx0Um9vdE9iamVjdCB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLndlYkFjbElkID8geyB3ZWJBY2xJZDogcHJvcHMud2ViQWNsSWQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5wcmljZUNsYXNzID8geyBwcmljZUNsYXNzOiBwcm9wcy5wcmljZUNsYXNzIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMuY29tbWVudCA/IHsgY29tbWVudDogcHJvcHMuY29tbWVudCB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLmVycm9yUmVzcG9uc2VzID8geyBlcnJvclJlc3BvbnNlczogcHJvcHMuZXJyb3JSZXNwb25zZXMgfSA6IHt9KSxcbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHN0YW5kYXJkTG9nZ2luZyAmJiBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwpIHtcbiAgICAgICAgICAgIGVuYWJsZUNsb3VkRnJvbnRTdGFuZGFyZExvZ2dpbmcoe1xuICAgICAgICAgICAgICAgIHNjb3BlOiB0aGlzLFxuICAgICAgICAgICAgICAgIGlkOiBcIkNkbkxvZ2dpbmdcIixcbiAgICAgICAgICAgICAgICBjb250ZXh0OiBuYW1pbmdDb250ZXh0LFxuICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbjogdGhpcy5kaXN0cmlidXRpb24sXG4gICAgICAgICAgICAgICAgbG9naWNhbDogYGxvZ3MvYWNjZXNzL2Nkbi8ke2xvZ2ljYWx9YCxcbiAgICAgICAgICAgICAgICBmb3JtYXQ6IHByb3BzLmNsb3VkRnJvbnRMb2dGb3JtYXQsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSBSb3V0ZTUzIEEgcmVjb3JkIGlmIGhvc3RlZCB6b25lIGlzIHByb3ZpZGVkXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4/LmRvbWFpbk5hbWUgJiYgcHJvcHMuZG9tYWluPy5ob3N0ZWRab25lKSB7XG4gICAgICAgICAgICBuZXcgcm91dGU1My5BUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRcIiwge1xuICAgICAgICAgICAgICAgIHpvbmU6IHByb3BzLmRvbWFpbi5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbi5kb21haW5OYW1lLFxuICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNyZWF0ZUFBQUFSZWNvcmQgPT09IHRydWUpIHtcbiAgICAgICAgICAgICAgICBuZXcgcm91dGU1My5BYWFhUmVjb3JkKHRoaXMsIFwiQWxpYXNSZWNvcmRBQUFBXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZE5hbWU6IHByb3BzLmRvbWFpbi5kb21haW5OYW1lLFxuICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG59XG4iXX0=