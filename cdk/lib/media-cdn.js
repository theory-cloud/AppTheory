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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMediaCdn", version: "7.5.0-rc.1" };
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
                ...(props.serverAccessLogsBucket !== undefined
                    ? {
                        serverAccessLogsBucket: props.serverAccessLogsBucket,
                        ...(props.serverAccessLogsPrefix !== undefined
                            ? { serverAccessLogsPrefix: props.serverAccessLogsPrefix }
                            : {}),
                    }
                    : {}),
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
        // Security Hub CloudFront.15 and CloudFront.1 under a derived naming context.
        const minimumProtocolVersion = (0, secure_defaults_1.defaultMinimumProtocolVersion)(namingContext, distributionCertificate !== undefined, props.minimumProtocolVersion);
        // The default behavior is the S3 media bucket over OAC, so a root object
        // rewrites which object `/` returns without changing the origin.
        const defaultRootObject = props.defaultRootObject !== undefined
            ? props.defaultRootObject
            : (0, secure_defaults_1.secureDefaults)(namingContext)
                ? "index.html"
                : undefined;
        this.distribution = new cloudfront.Distribution(this, "Distribution", {
            ...(enableLogging && this.logsBucket
                ? { enableLogging: true, logBucket: this.logsBucket, logFilePrefix: "cloudfront/" }
                : {}),
            ...(distributionDomainNames && distributionCertificate
                ? { domainNames: distributionDomainNames, certificate: distributionCertificate }
                : {}),
            ...(minimumProtocolVersion !== undefined ? { minimumProtocolVersion } : {}),
            defaultBehavior: defaultBehaviorOptions,
            ...(defaultRootObject ? { defaultRootObject } : {}),
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWVkaWEtY2RuLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWVkaWEtY2RuLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBMEQ7QUFDMUQsd0VBQTBEO0FBQzFELHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUMzRCx1REFBeUM7QUFDekMsMkNBQXVDO0FBR3ZDLHlEQUE0RDtBQUM1RCx5RUFBb0U7QUFDcEUsK0RBQTBGO0FBQzFGLGlFQUFnRztBQUdoRyxTQUFTLDJDQUEyQyxDQUFDLEtBQWdCLEVBQUUsYUFBcUI7SUFDeEYsTUFBTSxNQUFNLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQ3RDLElBQUksQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNLEtBQUssV0FBVyxFQUFFLENBQUM7UUFDeEQsT0FBTztJQUNYLENBQUM7SUFFRCxNQUFNLGlCQUFpQixHQUFHLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUM3RSxNQUFNLElBQUksS0FBSyxDQUNYLEdBQUcsYUFBYSx3SEFBd0gsaUJBQWlCLDRHQUE0RyxDQUN4USxDQUFDO0FBQ04sQ0FBQztBQStPRDs7Ozs7Ozs7Ozs7Ozs7R0FjRztBQUNILE1BQWEsaUJBQWtCLFNBQVEsc0JBQVM7O0lBQzVDOztPQUVHO0lBQ2EsWUFBWSxDQUEwQjtJQUV0RDs7T0FFRztJQUNhLE1BQU0sQ0FBYTtJQUVuQzs7T0FFRztJQUNhLFVBQVUsQ0FBYztJQUV4Qzs7T0FFRztJQUNhLFdBQVcsQ0FBb0I7SUFFL0M7O09BRUc7SUFDYSxRQUFRLENBQXdCO0lBRWhEOztPQUVHO0lBQ2EsU0FBUyxDQUF3QjtJQUVqRCxZ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QzdCLFVBQVUsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVU7b0JBQ25DLE1BQU0sRUFBRSxPQUFPLENBQUMsWUFBWSxDQUFDLFNBQVMsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUM7aUJBQzFGLENBQUMsQ0FBQztZQUNQLENBQUM7UUFDTCxDQUFDO0lBQ0wsQ0FBQzs7QUE5TkwsOENBK05DIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSwgU3RhY2ssIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhY20gZnJvbSBcImF3cy1jZGstbGliL2F3cy1jZXJ0aWZpY2F0ZW1hbmFnZXJcIjtcbmltcG9ydCAqIGFzIGNsb3VkZnJvbnQgZnJvbSBcImF3cy1jZGstbGliL2F3cy1jbG91ZGZyb250XCI7XG5pbXBvcnQgKiBhcyBvcmlnaW5zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udC1vcmlnaW5zXCI7XG5pbXBvcnQgKiBhcyByb3V0ZTUzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mtcm91dGU1M1wiO1xuaW1wb3J0ICogYXMgdGFyZ2V0cyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTMtdGFyZ2V0c1wiO1xuaW1wb3J0ICogYXMgczMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1zM1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdCB9IGZyb20gXCIuL2xvZ2dpbmdcIjtcbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5pbXBvcnQgeyBkZWZhdWx0TWluaW11bVByb3RvY29sVmVyc2lvbiwgc2VjdXJlRGVmYXVsdHMgfSBmcm9tIFwiLi9wcml2YXRlL3NlY3VyZS1kZWZhdWx0c1wiO1xuaW1wb3J0IHsgYnVja2V0TmFtaW5nUHJvcHMsIGVuYWJsZUNsb3VkRnJvbnRTdGFuZGFyZExvZ2dpbmcgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5cbmZ1bmN0aW9uIGFzc2VydENsb3VkRnJvbnRIb3N0ZWRab25lQ2VydGlmaWNhdGVSZWdpb24oc2NvcGU6IENvbnN0cnVjdCwgY29uc3RydWN0TmFtZTogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3QgcmVnaW9uID0gU3RhY2sub2Yoc2NvcGUpLnJlZ2lvbjtcbiAgICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZChyZWdpb24pICYmIHJlZ2lvbiA9PT0gXCJ1cy1lYXN0LTFcIikge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcmVnaW9uRGVzY3JpcHRpb24gPSBUb2tlbi5pc1VucmVzb2x2ZWQocmVnaW9uKSA/IFwidW5yZXNvbHZlZFwiIDogcmVnaW9uO1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYCR7Y29uc3RydWN0TmFtZX0gY2Fubm90IGNyZWF0ZSBhIGhvc3RlZC16b25lIENsb3VkRnJvbnQgY2VydGlmaWNhdGUgdW5sZXNzIHRoZSBzdGFjayByZWdpb24gaXMgZXhwbGljaXRseSB1cy1lYXN0LTE7IHN0YWNrIHJlZ2lvbiBpcyAke3JlZ2lvbkRlc2NyaXB0aW9ufS4gUHJvdmlkZSBkb21haW4uY2VydGlmaWNhdGUgb3IgZG9tYWluLmNlcnRpZmljYXRlQXJuIGZvciBzdGFja3MgaW4gb3RoZXIgb3IgZW52aXJvbm1lbnQtYWdub3N0aWMgcmVnaW9ucy5gLFxuICAgICk7XG59XG5cbi8qKlxuICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNZWRpYSBDRE4gZGlzdHJpYnV0aW9uLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIE1lZGlhQ2RuRG9tYWluQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBUaGUgZG9tYWluIG5hbWUgZm9yIHRoZSBkaXN0cmlidXRpb24gKGUuZy4sIFwibWVkaWEuZXhhbXBsZS5jb21cIikuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZG9tYWluTmFtZTogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQUNNIGNlcnRpZmljYXRlIGZvciBIVFRQUy4gTXVzdCBiZSBpbiB1cy1lYXN0LTEgZm9yIENsb3VkRnJvbnQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgLyoqXG4gICAgICogQVJOIG9mIGFuIGV4aXN0aW5nIEFDTSBjZXJ0aWZpY2F0ZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBjZXJ0aWZpY2F0ZUFybj86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFJvdXRlNTMgaG9zdGVkIHpvbmUgZm9yIEROUyByZWNvcmQgY3JlYXRpb24uXG4gICAgICogV2hlbiBwcm92aWRlZCwgYW4gQSByZWNvcmQgYWxpYXMgd2lsbCBiZSBjcmVhdGVkIGZvciB0aGUgZG9tYWluLlxuICAgICAqXG4gICAgICogSWYgYGRvbWFpbk5hbWVgIGlzIHNldCB3aXRob3V0IGBjZXJ0aWZpY2F0ZWAgb3IgYGNlcnRpZmljYXRlQXJuYCxcbiAgICAgKiBob3N0ZWQtem9uZSBjZXJ0aWZpY2F0ZSBjcmVhdGlvbiBpcyBhbGxvd2VkIG9ubHkgZm9yIHN0YWNrcyB3aG9zZSByZWdpb25cbiAgICAgKiBpcyBleHBsaWNpdGx5IGB1cy1lYXN0LTFgLiBDbG91ZEZyb250IHJlcXVpcmVzIHZpZXdlciBjZXJ0aWZpY2F0ZXMgaW5cbiAgICAgKiBgdXMtZWFzdC0xYDsgZW52aXJvbm1lbnQtYWdub3N0aWMgb3Igb3RoZXItcmVnaW9uIHN0YWNrcyBtdXN0IHByb3ZpZGUgYW5cbiAgICAgKiBleHBsaWNpdCBjZXJ0aWZpY2F0ZSBpbnB1dC5cbiAgICAgKi9cbiAgICByZWFkb25seSBob3N0ZWRab25lPzogcm91dGU1My5JSG9zdGVkWm9uZTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gY3JlYXRlIGFuIEFBQUEgYWxpYXMgcmVjb3JkIGluIGFkZGl0aW9uIHRvIHRoZSBBIGFsaWFzIHJlY29yZC5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNyZWF0ZUFBQUFSZWNvcmQ/OiBib29sZWFuO1xufVxuXG4vKipcbiAqIENvbmZpZ3VyYXRpb24gZm9yIHByaXZhdGUgbWVkaWEgYWNjZXNzIHVzaW5nIENsb3VkRnJvbnQgc2lnbmVkIFVSTHMvY29va2llcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcml2YXRlTWVkaWFDb25maWcge1xuICAgIC8qKlxuICAgICAqIEFuIGV4aXN0aW5nIENsb3VkRnJvbnQga2V5IGdyb3VwIHRvIHVzZSBmb3IgdHJ1c3RlZCBrZXkgZ3JvdXBzLlxuICAgICAqIFdoZW4gcHJvdmlkZWQsIHRoZSBkaXN0cmlidXRpb24gd2lsbCByZXF1aXJlIHNpZ25lZCBVUkxzIG9yIHNpZ25lZCBjb29raWVzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGtleUdyb3VwPzogY2xvdWRmcm9udC5JS2V5R3JvdXA7XG5cbiAgICAvKipcbiAgICAgKiBQdWJsaWMga2V5IFBFTSBjb250ZW50IGZvciBjcmVhdGluZyBhIG5ldyBrZXkgZ3JvdXAuXG4gICAgICogT25seSB1c2VkIGlmIGtleUdyb3VwIGlzIG5vdCBwcm92aWRlZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBwdWJsaWNLZXlQZW0/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBOYW1lIGZvciB0aGUgcHVibGljIGtleSB3aGVuIGNyZWF0ZWQgZnJvbSBQRU0uXG4gICAgICogQGRlZmF1bHQgXCJNZWRpYUNkblB1YmxpY0tleVwiXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHVibGljS2V5TmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE5hbWUgZm9yIHRoZSBrZXkgZ3JvdXAgd2hlbiBjcmVhdGVkLlxuICAgICAqIEBkZWZhdWx0IFwiTWVkaWFDZG5LZXlHcm91cFwiXG4gICAgICovXG4gICAgcmVhZG9ubHkga2V5R3JvdXBOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQ29tbWVudC9kZXNjcmlwdGlvbiBmb3IgdGhlIGtleSBncm91cC5cbiAgICAgKi9cbiAgICByZWFkb25seSBrZXlHcm91cENvbW1lbnQ/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWVkaWFDZG5Qcm9wcyB7XG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgZXhpc3RpbmcgUzMgYnVja2V0IHRvIHVzZSBhcyB0aGUgbWVkaWEgb3JpZ2luLlxuICAgICAqIElmIG5vdCBwcm92aWRlZCwgYSBuZXcgYnVja2V0IHdpbGwgYmUgY3JlYXRlZC5cbiAgICAgKi9cbiAgICByZWFkb25seSBidWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogTmFtZSBmb3IgdGhlIG1lZGlhIGJ1Y2tldCAob25seSB1c2VkIGlmIGJ1Y2tldCBpcyBub3QgcHJvdmlkZWQpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGJ1Y2tldE5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBEb21haW4gY29uZmlndXJhdGlvbiBmb3IgY3VzdG9tIGRvbWFpbiwgY2VydGlmaWNhdGUsIGFuZCBSb3V0ZTUzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbj86IE1lZGlhQ2RuRG9tYWluQ29uZmlnO1xuXG4gICAgLyoqXG4gICAgICogUmVzcG9uc2UgaGVhZGVycyBwb2xpY3kgdG8gYXBwbHkgdG8gdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSByZXNwb25zZUhlYWRlcnNQb2xpY3k/OiBjbG91ZGZyb250LklSZXNwb25zZUhlYWRlcnNQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBQcml2YXRlIG1lZGlhIGNvbmZpZ3VyYXRpb24gZm9yIHNpZ25lZCBVUkxzL2Nvb2tpZXMuXG4gICAgICogV2hlbiBjb25maWd1cmVkLCB0aGUgZGlzdHJpYnV0aW9uIHdpbGwgcmVxdWlyZSBhdXRoZW50aWNhdGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBwcml2YXRlTWVkaWE/OiBQcml2YXRlTWVkaWFDb25maWc7XG5cbiAgICAvKipcbiAgICAgKiBPYmplY3QgQ2xvdWRGcm9udCByZXR1cm5zIGZvciBhIHJlcXVlc3QgdG8gdGhlIGRpc3RyaWJ1dGlvbiByb290LlxuICAgICAqXG4gICAgICogV2l0aCBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQgdGhlIGRlZmF1bHQgaXMgYGluZGV4Lmh0bWxgOiB0aGUgZGVmYXVsdFxuICAgICAqIGJlaGF2aW9yIGFscmVhZHkgc2VuZHMgYC9gIHRvIHRoZSBTMyBidWNrZXQgdGhyb3VnaCBPQUMsIHNvIHRoZSByb290XG4gICAgICogb2JqZWN0IHJld3JpdGUgKGAvYCAtPiBgL2luZGV4Lmh0bWxgKSBjaGFuZ2VzIHdoaWNoIG9iamVjdCB0aGF0IGJlaGF2aW9yXG4gICAgICogcmV0dXJucywgbm90IHdoaWNoIG9yaWdpbiBzZXJ2ZXMgaXQgKFNlY3VyaXR5IEh1YiBDbG91ZEZyb250LjEpLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgXCJpbmRleC5odG1sXCIgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0LCBvdGhlcndpc2UgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgZGVmYXVsdFJvb3RPYmplY3Q/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dC5cbiAgICAgKlxuICAgICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSB0aGUgbWVkaWEgYnVja2V0IHRha2VzIGl0cyBuYW1lIGZyb20gdGhlXG4gICAgICogY29udHJhY3QgYW5kIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG9cbiAgICAgKiBgbG9ncy9hY2Nlc3MvY2RuL3tsb2dpY2FsTmFtZX1gIHRocm91Z2ggQ2xvdWRXYXRjaCBMb2dzIHZlbmRlZCBkZWxpdmVyeS5cbiAgICAgKiBQYXNzIGBlbmFibGVMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dCBvZiB0aGUgZGVsaXZlcnkuXG4gICAgICpcbiAgICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIGRpc3RyaWJ1dGlvbidzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZFxuICAgICAqIHdoZW4gYSBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAgICovXG4gICAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBDbG91ZEZyb250IHN0YW5kYXJkLWxvZ2dpbmcgb3V0cHV0IGZvcm1hdCBmb3IgYSBDbG91ZFdhdGNoIExvZ3NcbiAgICAgKiBkZXN0aW5hdGlvbi4gT25seSB1c2VkIHVuZGVyIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUuXG4gICAgICogQGRlZmF1bHQgQXBwVGhlb3J5Q2xvdWRGcm9udExvZ0Zvcm1hdC5KU09OXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2xvdWRGcm9udExvZ0Zvcm1hdD86IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQ7XG5cbiAgICAvKipcbiAgICAgKiBFbmFibGUgQ2xvdWRGcm9udCBhY2Nlc3MgbG9nZ2luZy5cbiAgICAgKiBAZGVmYXVsdCB0cnVlXG4gICAgICovXG4gICAgcmVhZG9ubHkgZW5hYmxlTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgICAvKipcbiAgICAgKiBPcHRpb25hbCBTMyBidWNrZXQgZm9yIENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MuXG4gICAgICogSWYgbm90IHByb3ZpZGVkIGFuZCBlbmFibGVMb2dnaW5nIGlzIHRydWUsIGEgbmV3IGJ1Y2tldCB3aWxsIGJlIGNyZWF0ZWQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgY3JlYXRlZCByZXNvdXJjZXMuXG4gICAgICogQGRlZmF1bHQgUmVtb3ZhbFBvbGljeS5SRVRBSU5cbiAgICAgKi9cbiAgICByZWFkb25seSByZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIFdoZXRoZXIgdG8gYXV0by1kZWxldGUgb2JqZWN0cyBpbiBjcmVhdGVkIGJ1Y2tldHMgb24gc3RhY2sgZGVsZXRpb24uXG4gICAgICogT25seSBhcHBsaWVzIHdoZW4gcmVtb3ZhbFBvbGljeSBpcyBERVNUUk9ZLlxuICAgICAqIEBkZWZhdWx0IGZhbHNlXG4gICAgICovXG4gICAgcmVhZG9ubHkgYXV0b0RlbGV0ZU9iamVjdHM/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgd2ViIEFDTCBJRCBmb3IgQVdTIFdBRiBpbnRlZ3JhdGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSB3ZWJBY2xJZD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIFByaWNlIGNsYXNzIGZvciB0aGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAgICogQGRlZmF1bHQgUHJpY2VDbGFzcy5QUklDRV9DTEFTU19BTExcbiAgICAgKi9cbiAgICByZWFkb25seSBwcmljZUNsYXNzPzogY2xvdWRmcm9udC5QcmljZUNsYXNzO1xuXG4gICAgLyoqXG4gICAgICogQW4gb3B0aW9uYWwgbmFtZS9jb21tZW50IGZvciB0aGUgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNvbW1lbnQ/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBCdWNrZXQgdGhhdCByZWNlaXZlcyBTMyBzZXJ2ZXIgYWNjZXNzIGxvZ3MgZm9yIHRoZSBtZWRpYSBidWNrZXQgdGhpc1xuICAgICAqIGNvbnN0cnVjdCBjcmVhdGVzLCB3aGljaCBpcyB3aGF0IFNlY3VyaXR5IEh1YiBTMy45IGV2YWx1YXRlcy5cbiAgICAgKlxuICAgICAqIE9mZiBieSBkZWZhdWx0IGJlY2F1c2UgdGhlIGxvZyB0YXJnZXQgYW5kIGl0cyBzdG9yYWdlIGNvc3QgbW9uZXkuIFRoZVxuICAgICAqIHRhcmdldCBidWNrZXQgaXMgeW91cnM6IGl0IHRha2VzIG5vIG5hbWluZyBlbnRyeSAocmVzb3VyY2UtbmFtaW5nXG4gICAgICogY29udHJhY3Qgc2VjdGlvbiA0KS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IG5vIHNlcnZlciBhY2Nlc3MgbG9nZ2luZ1xuICAgICAqL1xuICAgIHJlYWRvbmx5IHNlcnZlckFjY2Vzc0xvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogS2V5IHByZWZpeCBmb3IgdGhlIHNlcnZlciBhY2Nlc3MgbG9ncy4gT25seSB1c2VkIHdpdGhcbiAgICAgKiBgc2VydmVyQWNjZXNzTG9nc0J1Y2tldGAuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBubyBwcmVmaXhcbiAgICAgKi9cbiAgICByZWFkb25seSBzZXJ2ZXJBY2Nlc3NMb2dzUHJlZml4Pzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogTWluaW11bSBUTFMgcHJvdG9jb2wgdmVyc2lvbiBmb3Igdmlld2VycyBvZiBhIGN1c3RvbSBkb21haW4uXG4gICAgICpcbiAgICAgKiBXaXRoIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCBhbmQgYSBjdXN0b20gY2VydGlmaWNhdGUgdGhlIGRlZmF1bHQgaXNcbiAgICAgKiBgVExTX1YxXzJfMjAyNWAsIHRoZSBwb2xpY3kgU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMTUgYWNjZXB0cyB3aXRoIHRoZVxuICAgICAqIHdpZGVzdCBjbGllbnQgc3VwcG9ydC5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IFRMU19WMV8yXzIwMjUgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0IHdpdGggYSBjZXJ0aWZpY2F0ZSxcbiAgICAgKiBvdGhlcndpc2UgdGhlIENsb3VkRnJvbnQgZGVmYXVsdCBmb3IgdGhlIGNlcnRpZmljYXRlXG4gICAgICovXG4gICAgcmVhZG9ubHkgbWluaW11bVByb3RvY29sVmVyc2lvbj86IGNsb3VkZnJvbnQuU2VjdXJpdHlQb2xpY3lQcm90b2NvbDtcblxuICAgIC8qKlxuICAgICAqIENhY2hlIHBvbGljeSBmb3IgdGhlIGRlZmF1bHQgYmVoYXZpb3IuXG4gICAgICogQGRlZmF1bHQgQ2FjaGVQb2xpY3kuQ0FDSElOR19PUFRJTUlaRURcbiAgICAgKi9cbiAgICByZWFkb25seSBjYWNoZVBvbGljeT86IGNsb3VkZnJvbnQuSUNhY2hlUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogT3JpZ2luIHJlcXVlc3QgcG9saWN5IGZvciB0aGUgZGVmYXVsdCBiZWhhdmlvci5cbiAgICAgKi9cbiAgICByZWFkb25seSBvcmlnaW5SZXF1ZXN0UG9saWN5PzogY2xvdWRmcm9udC5JT3JpZ2luUmVxdWVzdFBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIEVycm9yIHJlc3BvbnNlcyBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoZS5nLiwgY3VzdG9tIDQwNCBoYW5kbGluZykuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZXJyb3JSZXNwb25zZXM/OiBjbG91ZGZyb250LkVycm9yUmVzcG9uc2VbXTtcblxuICAgIC8qKlxuICAgICAqIEFsbG93ZWQgSFRUUCBtZXRob2RzIGZvciB0aGUgZGlzdHJpYnV0aW9uLlxuICAgICAqIEBkZWZhdWx0IEFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlNcbiAgICAgKi9cbiAgICByZWFkb25seSBhbGxvd2VkTWV0aG9kcz86IGNsb3VkZnJvbnQuQWxsb3dlZE1ldGhvZHM7XG59XG5cbi8qKlxuICogQSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvbiBvcHRpbWl6ZWQgZm9yIHNlcnZpbmcgbWVkaWEgYXNzZXRzIGZyb20gUzMuXG4gKlxuICogVGhpcyBjb25zdHJ1Y3QgY3JlYXRlcyBvciB3cmFwcyBhbiBTMyBidWNrZXQgd2l0aCBhIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uXG4gKiBjb25maWd1cmVkIGZvciBtZWRpYSBkZWxpdmVyeS4gSXQgc3VwcG9ydHM6XG4gKiAtIEN1c3RvbSBkb21haW4gd2l0aCBjZXJ0aWZpY2F0ZSBhbmQgUm91dGU1MyBpbnRlZ3JhdGlvblxuICogLSBQcml2YXRlIG1lZGlhIGFjY2VzcyB2aWEgc2lnbmVkIFVSTHMvY29va2llcyAodHJ1c3RlZCBrZXkgZ3JvdXBzKVxuICogLSBDdXN0b21pemFibGUgY2FjaGluZyBhbmQgcmVzcG9uc2UgaGVhZGVyc1xuICogLSBBY2Nlc3MgbG9nZ2luZ1xuICpcbiAqIFVzZSBjYXNlczpcbiAqIC0gUHVibGljIG1lZGlhIENETiAoaW1hZ2VzLCB2aWRlb3MsIGRvY3VtZW50cylcbiAqIC0gUHJpdmF0ZS9hdXRoZW50aWNhdGVkIG1lZGlhIGFjY2Vzc1xuICogLSBTdGFnZS1zcGVjaWZpYyBtZWRpYSBzdWJkb21haW5zIChlLmcuLCBtZWRpYS5zdGFnZS5leGFtcGxlLmNvbSlcbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1lZGlhQ2RuIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGRpc3RyaWJ1dGlvbjogY2xvdWRmcm9udC5EaXN0cmlidXRpb247XG5cbiAgICAvKipcbiAgICAgKiBUaGUgUzMgYnVja2V0IGZvciBtZWRpYSBhc3NldHMuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGJ1Y2tldDogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGJ1Y2tldCAoaWYgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgbG9nc0J1Y2tldD86IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgY2VydGlmaWNhdGUgdXNlZCBmb3IgdGhlIGRpc3RyaWJ1dGlvbiAoaWYgY3VzdG9tIGRvbWFpbiBpcyBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkgY2VydGlmaWNhdGU/OiBhY20uSUNlcnRpZmljYXRlO1xuXG4gICAgLyoqXG4gICAgICogVGhlIGtleSBncm91cCBmb3IgcHJpdmF0ZSBtZWRpYSBhY2Nlc3MgKGlmIGNvbmZpZ3VyZWQpLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBrZXlHcm91cD86IGNsb3VkZnJvbnQuSUtleUdyb3VwO1xuXG4gICAgLyoqXG4gICAgICogVGhlIHB1YmxpYyBrZXkgY3JlYXRlZCBmb3IgcHJpdmF0ZSBtZWRpYSAoaWYgY3JlYXRlZCBmcm9tIFBFTSkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IHB1YmxpY0tleT86IGNsb3VkZnJvbnQuUHVibGljS2V5O1xuXG4gICAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1lZGlhQ2RuUHJvcHMpIHtcbiAgICAgICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgICAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMucmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICAgICAgY29uc3QgYXV0b0RlbGV0ZU9iamVjdHMgPSBwcm9wcy5hdXRvRGVsZXRlT2JqZWN0cyA/PyBmYWxzZTtcbiAgICAgICAgY29uc3QgZW5hYmxlTG9nZ2luZyA9IHByb3BzLmVuYWJsZUxvZ2dpbmcgPz8gdHJ1ZTtcbiAgICAgICAgY29uc3QgbmFtaW5nQ29udGV4dCA9IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAobmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgICAgIHJlZnVzZUV4cGxpY2l0TmFtZShcbiAgICAgICAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgICAgICAgICBcIkFwcFRoZW9yeU1lZGlhQ2RuXCIsXG4gICAgICAgICAgICBcImJ1Y2tldE5hbWVcIixcbiAgICAgICAgICAgIFwiczNfYnVja2V0XCIsXG4gICAgICAgICAgICBsb2dpY2FsID8gYCR7bG9naWNhbH0tbWVkaWFgIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgcHJvcHMuYnVja2V0TmFtZSAhPT0gdW5kZWZpbmVkLFxuICAgICAgICApO1xuICAgICAgICBpZiAobmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIHByb3BzLmxvZ3NCdWNrZXQgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgIFwiQXBwVGhlb3J5TWVkaWFDZG4gY2Fubm90IGhvbm9yIHByb3BzLmxvZ3NCdWNrZXQgdW5kZXIgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZTsgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBnbyB0byB0aGUgY29udHJhY3QgbG9nIGdyb3VwLCBzbyByZW1vdmUgcHJvcHMubG9nc0J1Y2tldCBvciB1c2UgdGhlIGxlZ2FjeSBsb2dnaW5nIHByb2ZpbGVcIixcbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3Qgc3RhbmRhcmRMb2dnaW5nID0gbmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIGVuYWJsZUxvZ2dpbmc7XG5cbiAgICAgICAgLy8gQ3JlYXRlIG9yIHVzZSB0aGUgcHJvdmlkZWQgbWVkaWEgYnVja2V0XG4gICAgICAgIGlmIChwcm9wcy5idWNrZXQpIHtcbiAgICAgICAgICAgIHRoaXMuYnVja2V0ID0gcHJvcHMuYnVja2V0O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5idWNrZXQgPSBuZXcgczMuQnVja2V0KHRoaXMsIFwiTWVkaWFCdWNrZXRcIiwge1xuICAgICAgICAgICAgICAgIC4uLihuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgICAgICAgICAgICAgPyBidWNrZXROYW1pbmdQcm9wcyhuYW1pbmdDb250ZXh0LCBgJHtsb2dpY2FsfS1tZWRpYWApXG4gICAgICAgICAgICAgICAgICAgIDogeyBidWNrZXROYW1lOiBwcm9wcy5idWNrZXROYW1lIH0pLFxuICAgICAgICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgICAgICAgIGVuZm9yY2VTU0w6IHRydWUsXG4gICAgICAgICAgICAgICAgLi4uKHByb3BzLnNlcnZlckFjY2Vzc0xvZ3NCdWNrZXQgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHNlcnZlckFjY2Vzc0xvZ3NCdWNrZXQ6IHByb3BzLnNlcnZlckFjY2Vzc0xvZ3NCdWNrZXQsXG4gICAgICAgICAgICAgICAgICAgICAgICAuLi4ocHJvcHMuc2VydmVyQWNjZXNzTG9nc1ByZWZpeCAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgPyB7IHNlcnZlckFjY2Vzc0xvZ3NQcmVmaXg6IHByb3BzLnNlcnZlckFjY2Vzc0xvZ3NQcmVmaXggfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgICAgICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuQlVDS0VUX09XTkVSX0VORk9SQ0VELFxuICAgICAgICAgICAgICAgIHZlcnNpb25lZDogZmFsc2UsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENyZWF0ZSBsb2dzIGJ1Y2tldCBpZiBTMyBsb2dnaW5nIGlzIGVuYWJsZWQgYW5kIHRoZSBzdGFuZGFyZCBwcm9maWxlIGlzXG4gICAgICAgIC8vIG5vdCByZXBsYWNpbmcgaXQgd2l0aCBDbG91ZFdhdGNoIExvZ3MgZGVsaXZlcnkuXG4gICAgICAgIGlmIChlbmFibGVMb2dnaW5nICYmICFzdGFuZGFyZExvZ2dpbmcpIHtcbiAgICAgICAgICAgIHRoaXMubG9nc0J1Y2tldCA9XG4gICAgICAgICAgICAgICAgcHJvcHMubG9nc0J1Y2tldCA/P1xuICAgICAgICAgICAgICAgIG5ldyBzMy5CdWNrZXQodGhpcywgXCJDbG91ZEZyb250TG9nc0J1Y2tldFwiLCB7XG4gICAgICAgICAgICAgICAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsXG4gICAgICAgICAgICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICAgICAgICAgICAgZW5mb3JjZVNTTDogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgICAgICAgICAgICAgYXV0b0RlbGV0ZU9iamVjdHMsXG4gICAgICAgICAgICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLk9CSkVDVF9XUklURVIsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBIYW5kbGUgcHJpdmF0ZSBtZWRpYSBjb25maWd1cmF0aW9uXG4gICAgICAgIGlmIChwcm9wcy5wcml2YXRlTWVkaWEpIHtcbiAgICAgICAgICAgIGlmIChwcm9wcy5wcml2YXRlTWVkaWEua2V5R3JvdXApIHtcbiAgICAgICAgICAgICAgICB0aGlzLmtleUdyb3VwID0gcHJvcHMucHJpdmF0ZU1lZGlhLmtleUdyb3VwO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5wcml2YXRlTWVkaWEucHVibGljS2V5UGVtKSB7XG4gICAgICAgICAgICAgICAgLy8gQ3JlYXRlIGEgcHVibGljIGtleSBmcm9tIHRoZSBQRU1cbiAgICAgICAgICAgICAgICB0aGlzLnB1YmxpY0tleSA9IG5ldyBjbG91ZGZyb250LlB1YmxpY0tleSh0aGlzLCBcIlB1YmxpY0tleVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIGVuY29kZWRLZXk6IHByb3BzLnByaXZhdGVNZWRpYS5wdWJsaWNLZXlQZW0sXG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY0tleU5hbWU6IHByb3BzLnByaXZhdGVNZWRpYS5wdWJsaWNLZXlOYW1lLFxuICAgICAgICAgICAgICAgICAgICBjb21tZW50OiBcIlB1YmxpYyBrZXkgZm9yIE1lZGlhIENETiBzaWduZWQgVVJMc1wiLFxuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgLy8gQ3JlYXRlIGEga2V5IGdyb3VwIHdpdGggdGhlIHB1YmxpYyBrZXlcbiAgICAgICAgICAgICAgICB0aGlzLmtleUdyb3VwID0gbmV3IGNsb3VkZnJvbnQuS2V5R3JvdXAodGhpcywgXCJLZXlHcm91cFwiLCB7XG4gICAgICAgICAgICAgICAgICAgIGtleUdyb3VwTmFtZTogcHJvcHMucHJpdmF0ZU1lZGlhLmtleUdyb3VwTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgaXRlbXM6IFt0aGlzLnB1YmxpY0tleV0sXG4gICAgICAgICAgICAgICAgICAgIGNvbW1lbnQ6IHByb3BzLnByaXZhdGVNZWRpYS5rZXlHcm91cENvbW1lbnQgPz8gXCJLZXkgZ3JvdXAgZm9yIE1lZGlhIENETiBwcml2YXRlIGFjY2Vzc1wiLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gSGFuZGxlIGRvbWFpbiBjb25maWd1cmF0aW9uXG4gICAgICAgIGxldCBkaXN0cmlidXRpb25Eb21haW5OYW1lczogc3RyaW5nW10gfCB1bmRlZmluZWQ7XG4gICAgICAgIGxldCBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTogYWNtLklDZXJ0aWZpY2F0ZSB8IHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAocHJvcHMuZG9tYWluKSB7XG4gICAgICAgICAgICBjb25zdCBkb21haW5OYW1lID0gU3RyaW5nKHByb3BzLmRvbWFpbi5kb21haW5OYW1lKS50cmltKCk7XG4gICAgICAgICAgICBpZiAoZG9tYWluTmFtZSkge1xuICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzID0gW2RvbWFpbk5hbWVdO1xuXG4gICAgICAgICAgICAgICAgaWYgKHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZSkge1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLmRvbWFpbi5jZXJ0aWZpY2F0ZUFybikge1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IGFjbS5DZXJ0aWZpY2F0ZS5mcm9tQ2VydGlmaWNhdGVBcm4oXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJDZXJ0aWZpY2F0ZVwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0Q2xvdWRGcm9udEhvc3RlZFpvbmVDZXJ0aWZpY2F0ZVJlZ2lvbih0aGlzLCBcIkFwcFRoZW9yeU1lZGlhQ2RuXCIpO1xuICAgICAgICAgICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSA9IG5ldyBhY20uQ2VydGlmaWNhdGUodGhpcywgXCJDZXJ0aWZpY2F0ZVwiLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkb21haW5OYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgdmFsaWRhdGlvbjogYWNtLkNlcnRpZmljYXRlVmFsaWRhdGlvbi5mcm9tRG5zKHByb3BzLmRvbWFpbi5ob3N0ZWRab25lKSxcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJBcHBUaGVvcnlNZWRpYUNkbiByZXF1aXJlcyBkb21haW4uY2VydGlmaWNhdGUsIGRvbWFpbi5jZXJ0aWZpY2F0ZUFybiwgb3IgZG9tYWluLmhvc3RlZFpvbmUgd2hlbiBkb21haW4uZG9tYWluTmFtZSBpcyBzZXRcIixcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmNlcnRpZmljYXRlID0gZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGU7XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBTMyBvcmlnaW4gd2l0aCBPcmlnaW4gQWNjZXNzIENvbnRyb2xcbiAgICAgICAgY29uc3QgbWVkaWFCdWNrZXRPcmlnaW4gPSBvcmlnaW5zLlMzQnVja2V0T3JpZ2luLndpdGhPcmlnaW5BY2Nlc3NDb250cm9sKHRoaXMuYnVja2V0KTtcblxuICAgICAgICAvLyBCdWlsZCBkZWZhdWx0IGJlaGF2aW9yIG9wdGlvbnNcbiAgICAgICAgY29uc3QgZGVmYXVsdEJlaGF2aW9yT3B0aW9uczogY2xvdWRmcm9udC5CZWhhdmlvck9wdGlvbnMgPSB7XG4gICAgICAgICAgICBvcmlnaW46IG1lZGlhQnVja2V0T3JpZ2luLFxuICAgICAgICAgICAgdmlld2VyUHJvdG9jb2xQb2xpY3k6IGNsb3VkZnJvbnQuVmlld2VyUHJvdG9jb2xQb2xpY3kuUkVESVJFQ1RfVE9fSFRUUFMsXG4gICAgICAgICAgICBhbGxvd2VkTWV0aG9kczogcHJvcHMuYWxsb3dlZE1ldGhvZHMgPz8gY2xvdWRmcm9udC5BbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TLFxuICAgICAgICAgICAgY2FjaGVQb2xpY3k6IHByb3BzLmNhY2hlUG9saWN5ID8/IGNsb3VkZnJvbnQuQ2FjaGVQb2xpY3kuQ0FDSElOR19PUFRJTUlaRUQsXG4gICAgICAgICAgICBjb21wcmVzczogdHJ1ZSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5vcmlnaW5SZXF1ZXN0UG9saWN5ID8geyBvcmlnaW5SZXF1ZXN0UG9saWN5OiBwcm9wcy5vcmlnaW5SZXF1ZXN0UG9saWN5IH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5ID8geyByZXNwb25zZUhlYWRlcnNQb2xpY3k6IHByb3BzLnJlc3BvbnNlSGVhZGVyc1BvbGljeSB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHRoaXMua2V5R3JvdXAgPyB7IHRydXN0ZWRLZXlHcm91cHM6IFt0aGlzLmtleUdyb3VwXSB9IDoge30pLFxuICAgICAgICB9O1xuXG4gICAgICAgIC8vIENyZWF0ZSB0aGUgZGlzdHJpYnV0aW9uXG4gICAgICAgIC8vIFNlY3VyaXR5IEh1YiBDbG91ZEZyb250LjE1IGFuZCBDbG91ZEZyb250LjEgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0LlxuICAgICAgICBjb25zdCBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uID0gZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24oXG4gICAgICAgICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgICAgICAgZGlzdHJpYnV0aW9uQ2VydGlmaWNhdGUgIT09IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHByb3BzLm1pbmltdW1Qcm90b2NvbFZlcnNpb24sXG4gICAgICAgICk7XG4gICAgICAgIC8vIFRoZSBkZWZhdWx0IGJlaGF2aW9yIGlzIHRoZSBTMyBtZWRpYSBidWNrZXQgb3ZlciBPQUMsIHNvIGEgcm9vdCBvYmplY3RcbiAgICAgICAgLy8gcmV3cml0ZXMgd2hpY2ggb2JqZWN0IGAvYCByZXR1cm5zIHdpdGhvdXQgY2hhbmdpbmcgdGhlIG9yaWdpbi5cbiAgICAgICAgY29uc3QgZGVmYXVsdFJvb3RPYmplY3QgPVxuICAgICAgICAgICAgcHJvcHMuZGVmYXVsdFJvb3RPYmplY3QgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgID8gcHJvcHMuZGVmYXVsdFJvb3RPYmplY3RcbiAgICAgICAgICAgICAgICA6IHNlY3VyZURlZmF1bHRzKG5hbWluZ0NvbnRleHQpXG4gICAgICAgICAgICAgICAgICAgID8gXCJpbmRleC5odG1sXCJcbiAgICAgICAgICAgICAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICAgIHRoaXMuZGlzdHJpYnV0aW9uID0gbmV3IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uKHRoaXMsIFwiRGlzdHJpYnV0aW9uXCIsIHtcbiAgICAgICAgICAgIC4uLihlbmFibGVMb2dnaW5nICYmIHRoaXMubG9nc0J1Y2tldFxuICAgICAgICAgICAgICAgID8geyBlbmFibGVMb2dnaW5nOiB0cnVlLCBsb2dCdWNrZXQ6IHRoaXMubG9nc0J1Y2tldCwgbG9nRmlsZVByZWZpeDogXCJjbG91ZGZyb250L1wiIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIC4uLihkaXN0cmlidXRpb25Eb21haW5OYW1lcyAmJiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZVxuICAgICAgICAgICAgICAgID8geyBkb21haW5OYW1lczogZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMsIGNlcnRpZmljYXRlOiBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSB9XG4gICAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICAuLi4obWluaW11bVByb3RvY29sVmVyc2lvbiAhPT0gdW5kZWZpbmVkID8geyBtaW5pbXVtUHJvdG9jb2xWZXJzaW9uIH0gOiB7fSksXG4gICAgICAgICAgICBkZWZhdWx0QmVoYXZpb3I6IGRlZmF1bHRCZWhhdmlvck9wdGlvbnMsXG4gICAgICAgICAgICAuLi4oZGVmYXVsdFJvb3RPYmplY3QgPyB7IGRlZmF1bHRSb290T2JqZWN0IH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMud2ViQWNsSWQgPyB7IHdlYkFjbElkOiBwcm9wcy53ZWJBY2xJZCB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLnByaWNlQ2xhc3MgPyB7IHByaWNlQ2xhc3M6IHByb3BzLnByaWNlQ2xhc3MgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5jb21tZW50ID8geyBjb21tZW50OiBwcm9wcy5jb21tZW50IH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMuZXJyb3JSZXNwb25zZXMgPyB7IGVycm9yUmVzcG9uc2VzOiBwcm9wcy5lcnJvclJlc3BvbnNlcyB9IDoge30pLFxuICAgICAgICB9KTtcblxuICAgICAgICBpZiAoc3RhbmRhcmRMb2dnaW5nICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCkge1xuICAgICAgICAgICAgZW5hYmxlQ2xvdWRGcm9udFN0YW5kYXJkTG9nZ2luZyh7XG4gICAgICAgICAgICAgICAgc2NvcGU6IHRoaXMsXG4gICAgICAgICAgICAgICAgaWQ6IFwiQ2RuTG9nZ2luZ1wiLFxuICAgICAgICAgICAgICAgIGNvbnRleHQ6IG5hbWluZ0NvbnRleHQsXG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uOiB0aGlzLmRpc3RyaWJ1dGlvbixcbiAgICAgICAgICAgICAgICBsb2dpY2FsOiBgbG9ncy9hY2Nlc3MvY2RuLyR7bG9naWNhbH1gLFxuICAgICAgICAgICAgICAgIGZvcm1hdDogcHJvcHMuY2xvdWRGcm9udExvZ0Zvcm1hdCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIFJvdXRlNTMgQSByZWNvcmQgaWYgaG9zdGVkIHpvbmUgaXMgcHJvdmlkZWRcbiAgICAgICAgaWYgKHByb3BzLmRvbWFpbj8uZG9tYWluTmFtZSAmJiBwcm9wcy5kb21haW4/Lmhvc3RlZFpvbmUpIHtcbiAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZFwiLCB7XG4gICAgICAgICAgICAgICAgem9uZTogcHJvcHMuZG9tYWluLmhvc3RlZFpvbmUsXG4gICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChwcm9wcy5kb21haW4uY3JlYXRlQUFBQVJlY29yZCA9PT0gdHJ1ZSkge1xuICAgICAgICAgICAgICAgIG5ldyByb3V0ZTUzLkFhYWFSZWNvcmQodGhpcywgXCJBbGlhc1JlY29yZEFBQUFcIiwge1xuICAgICAgICAgICAgICAgICAgICB6b25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkTmFtZTogcHJvcHMuZG9tYWluLmRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgIHRhcmdldDogcm91dGU1My5SZWNvcmRUYXJnZXQuZnJvbUFsaWFzKG5ldyB0YXJnZXRzLkNsb3VkRnJvbnRUYXJnZXQodGhpcy5kaXN0cmlidXRpb24pKSxcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cbiJdfQ==