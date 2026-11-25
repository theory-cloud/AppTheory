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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMediaCdn", version: "7.5.0" };
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
            if (namingContext && logical) {
                // Contract section 11.4: declare the resource carrying the composed name.
                namingContext.declareName("s3_bucket", `${logical}-media`, this.bucket);
            }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWVkaWEtY2RuLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWVkaWEtY2RuLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBMEQ7QUFDMUQsd0VBQTBEO0FBQzFELHVFQUF5RDtBQUN6RCw0RUFBOEQ7QUFDOUQsaUVBQW1EO0FBQ25ELHlFQUEyRDtBQUMzRCx1REFBeUM7QUFDekMsMkNBQXVDO0FBR3ZDLHlEQUE0RDtBQUM1RCx5RUFBb0U7QUFDcEUsK0RBQTBGO0FBQzFGLGlFQUFnRztBQUdoRyxTQUFTLDJDQUEyQyxDQUFDLEtBQWdCLEVBQUUsYUFBcUI7SUFDeEYsTUFBTSxNQUFNLEdBQUcsbUJBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxDQUFDO0lBQ3RDLElBQUksQ0FBQyxtQkFBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUMsSUFBSSxNQUFNLEtBQUssV0FBVyxFQUFFLENBQUM7UUFDeEQsT0FBTztJQUNYLENBQUM7SUFFRCxNQUFNLGlCQUFpQixHQUFHLG1CQUFLLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUM3RSxNQUFNLElBQUksS0FBSyxDQUNYLEdBQUcsYUFBYSx3SEFBd0gsaUJBQWlCLDRHQUE0RyxDQUN4USxDQUFDO0FBQ04sQ0FBQztBQStPRDs7Ozs7Ozs7Ozs7Ozs7R0FjRztBQUNILE1BQWEsaUJBQWtCLFNBQVEsc0JBQVM7O0lBQzVDOztPQUVHO0lBQ2EsWUFBWSxDQUEwQjtJQUV0RDs7T0FFRztJQUNhLE1BQU0sQ0FBYTtJQUVuQzs7T0FFRztJQUNhLFVBQVUsQ0FBYztJQUV4Qzs7T0FFRztJQUNhLFdBQVcsQ0FBb0I7SUFFL0M7O09BRUc7SUFDYSxRQUFRLENBQXdCO0lBRWhEOztPQUVHO0lBQ2EsU0FBUyxDQUF3QjtJQUVqRCxZ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LENBQUMsTUFBTSxDQUFDLGdCQUFnQixLQUFLLElBQUksRUFBRSxDQUFDO2dCQUN6QyxJQUFJLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO29CQUM1QyxJQUFJLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxVQUFVO29CQUM3QixVQUFVLEVBQUUsS0FBSyxDQUFDLE1BQU0sQ0FBQyxVQUFVO29CQUNuQyxNQUFNLEVBQUUsT0FBTyxDQUFDLFlBQVksQ0FBQyxTQUFTLENBQUMsSUFBSSxPQUFPLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDO2lCQUMxRixDQUFDLENBQUM7WUFDUCxDQUFDO1FBQ0wsQ0FBQztJQUNMLENBQUM7O0FBbE9MLDhDQW1PQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3ksIFN0YWNrLCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYWNtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2VydGlmaWNhdGVtYW5hZ2VyXCI7XG5pbXBvcnQgKiBhcyBjbG91ZGZyb250IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtY2xvdWRmcm9udFwiO1xuaW1wb3J0ICogYXMgb3JpZ2lucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWNsb3VkZnJvbnQtb3JpZ2luc1wiO1xuaW1wb3J0ICogYXMgcm91dGU1MyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLXJvdXRlNTNcIjtcbmltcG9ydCAqIGFzIHRhcmdldHMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1yb3V0ZTUzLXRhcmdldHNcIjtcbmltcG9ydCAqIGFzIHMzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtczNcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQgfSBmcm9tIFwiLi9sb2dnaW5nXCI7XG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgZGVmYXVsdE1pbmltdW1Qcm90b2NvbFZlcnNpb24sIHNlY3VyZURlZmF1bHRzIH0gZnJvbSBcIi4vcHJpdmF0ZS9zZWN1cmUtZGVmYXVsdHNcIjtcbmltcG9ydCB7IGJ1Y2tldE5hbWluZ1Byb3BzLCBlbmFibGVDbG91ZEZyb250U3RhbmRhcmRMb2dnaW5nIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdGFuZGFyZC1sb2dnaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuXG5mdW5jdGlvbiBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHNjb3BlOiBDb25zdHJ1Y3QsIGNvbnN0cnVjdE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IHJlZ2lvbiA9IFN0YWNrLm9mKHNjb3BlKS5yZWdpb247XG4gICAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQocmVnaW9uKSAmJiByZWdpb24gPT09IFwidXMtZWFzdC0xXCIpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHJlZ2lvbkRlc2NyaXB0aW9uID0gVG9rZW4uaXNVbnJlc29sdmVkKHJlZ2lvbikgPyBcInVucmVzb2x2ZWRcIiA6IHJlZ2lvbjtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIGAke2NvbnN0cnVjdE5hbWV9IGNhbm5vdCBjcmVhdGUgYSBob3N0ZWQtem9uZSBDbG91ZEZyb250IGNlcnRpZmljYXRlIHVubGVzcyB0aGUgc3RhY2sgcmVnaW9uIGlzIGV4cGxpY2l0bHkgdXMtZWFzdC0xOyBzdGFjayByZWdpb24gaXMgJHtyZWdpb25EZXNjcmlwdGlvbn0uIFByb3ZpZGUgZG9tYWluLmNlcnRpZmljYXRlIG9yIGRvbWFpbi5jZXJ0aWZpY2F0ZUFybiBmb3Igc3RhY2tzIGluIG90aGVyIG9yIGVudmlyb25tZW50LWFnbm9zdGljIHJlZ2lvbnMuYCxcbiAgICApO1xufVxuXG4vKipcbiAqIERvbWFpbiBjb25maWd1cmF0aW9uIGZvciB0aGUgTWVkaWEgQ0ROIGRpc3RyaWJ1dGlvbi5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZWRpYUNkbkRvbWFpbkNvbmZpZyB7XG4gICAgLyoqXG4gICAgICogVGhlIGRvbWFpbiBuYW1lIGZvciB0aGUgZGlzdHJpYnV0aW9uIChlLmcuLCBcIm1lZGlhLmV4YW1wbGUuY29tXCIpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRvbWFpbk5hbWU6IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIEFDTSBjZXJ0aWZpY2F0ZSBmb3IgSFRUUFMuIE11c3QgYmUgaW4gdXMtZWFzdC0xIGZvciBDbG91ZEZyb250LlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIEFSTiBvZiBhbiBleGlzdGluZyBBQ00gY2VydGlmaWNhdGUuXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2VydGlmaWNhdGVBcm4/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBSb3V0ZTUzIGhvc3RlZCB6b25lIGZvciBETlMgcmVjb3JkIGNyZWF0aW9uLlxuICAgICAqIFdoZW4gcHJvdmlkZWQsIGFuIEEgcmVjb3JkIGFsaWFzIHdpbGwgYmUgY3JlYXRlZCBmb3IgdGhlIGRvbWFpbi5cbiAgICAgKlxuICAgICAqIElmIGBkb21haW5OYW1lYCBpcyBzZXQgd2l0aG91dCBgY2VydGlmaWNhdGVgIG9yIGBjZXJ0aWZpY2F0ZUFybmAsXG4gICAgICogaG9zdGVkLXpvbmUgY2VydGlmaWNhdGUgY3JlYXRpb24gaXMgYWxsb3dlZCBvbmx5IGZvciBzdGFja3Mgd2hvc2UgcmVnaW9uXG4gICAgICogaXMgZXhwbGljaXRseSBgdXMtZWFzdC0xYC4gQ2xvdWRGcm9udCByZXF1aXJlcyB2aWV3ZXIgY2VydGlmaWNhdGVzIGluXG4gICAgICogYHVzLWVhc3QtMWA7IGVudmlyb25tZW50LWFnbm9zdGljIG9yIG90aGVyLXJlZ2lvbiBzdGFja3MgbXVzdCBwcm92aWRlIGFuXG4gICAgICogZXhwbGljaXQgY2VydGlmaWNhdGUgaW5wdXQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgaG9zdGVkWm9uZT86IHJvdXRlNTMuSUhvc3RlZFpvbmU7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGNyZWF0ZSBhbiBBQUFBIGFsaWFzIHJlY29yZCBpbiBhZGRpdGlvbiB0byB0aGUgQSBhbGlhcyByZWNvcmQuXG4gICAgICogQGRlZmF1bHQgZmFsc2VcbiAgICAgKi9cbiAgICByZWFkb25seSBjcmVhdGVBQUFBUmVjb3JkPzogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBDb25maWd1cmF0aW9uIGZvciBwcml2YXRlIG1lZGlhIGFjY2VzcyB1c2luZyBDbG91ZEZyb250IHNpZ25lZCBVUkxzL2Nvb2tpZXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJpdmF0ZU1lZGlhQ29uZmlnIHtcbiAgICAvKipcbiAgICAgKiBBbiBleGlzdGluZyBDbG91ZEZyb250IGtleSBncm91cCB0byB1c2UgZm9yIHRydXN0ZWQga2V5IGdyb3Vwcy5cbiAgICAgKiBXaGVuIHByb3ZpZGVkLCB0aGUgZGlzdHJpYnV0aW9uIHdpbGwgcmVxdWlyZSBzaWduZWQgVVJMcyBvciBzaWduZWQgY29va2llcy5cbiAgICAgKi9cbiAgICByZWFkb25seSBrZXlHcm91cD86IGNsb3VkZnJvbnQuSUtleUdyb3VwO1xuXG4gICAgLyoqXG4gICAgICogUHVibGljIGtleSBQRU0gY29udGVudCBmb3IgY3JlYXRpbmcgYSBuZXcga2V5IGdyb3VwLlxuICAgICAqIE9ubHkgdXNlZCBpZiBrZXlHcm91cCBpcyBub3QgcHJvdmlkZWQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHVibGljS2V5UGVtPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogTmFtZSBmb3IgdGhlIHB1YmxpYyBrZXkgd2hlbiBjcmVhdGVkIGZyb20gUEVNLlxuICAgICAqIEBkZWZhdWx0IFwiTWVkaWFDZG5QdWJsaWNLZXlcIlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHB1YmxpY0tleU5hbWU/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBOYW1lIGZvciB0aGUga2V5IGdyb3VwIHdoZW4gY3JlYXRlZC5cbiAgICAgKiBAZGVmYXVsdCBcIk1lZGlhQ2RuS2V5R3JvdXBcIlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGtleUdyb3VwTmFtZT86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIENvbW1lbnQvZGVzY3JpcHRpb24gZm9yIHRoZSBrZXkgZ3JvdXAuXG4gICAgICovXG4gICAgcmVhZG9ubHkga2V5R3JvdXBDb21tZW50Pzogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1lZGlhQ2RuUHJvcHMge1xuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIGV4aXN0aW5nIFMzIGJ1Y2tldCB0byB1c2UgYXMgdGhlIG1lZGlhIG9yaWdpbi5cbiAgICAgKiBJZiBub3QgcHJvdmlkZWQsIGEgbmV3IGJ1Y2tldCB3aWxsIGJlIGNyZWF0ZWQuXG4gICAgICovXG4gICAgcmVhZG9ubHkgYnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIE5hbWUgZm9yIHRoZSBtZWRpYSBidWNrZXQgKG9ubHkgdXNlZCBpZiBidWNrZXQgaXMgbm90IHByb3ZpZGVkKS5cbiAgICAgKi9cbiAgICByZWFkb25seSBidWNrZXROYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogRG9tYWluIGNvbmZpZ3VyYXRpb24gZm9yIGN1c3RvbSBkb21haW4sIGNlcnRpZmljYXRlLCBhbmQgUm91dGU1My5cbiAgICAgKi9cbiAgICByZWFkb25seSBkb21haW4/OiBNZWRpYUNkbkRvbWFpbkNvbmZpZztcblxuICAgIC8qKlxuICAgICAqIFJlc3BvbnNlIGhlYWRlcnMgcG9saWN5IHRvIGFwcGx5IHRvIHRoZSBkaXN0cmlidXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVzcG9uc2VIZWFkZXJzUG9saWN5PzogY2xvdWRmcm9udC5JUmVzcG9uc2VIZWFkZXJzUG9saWN5O1xuXG4gICAgLyoqXG4gICAgICogUHJpdmF0ZSBtZWRpYSBjb25maWd1cmF0aW9uIGZvciBzaWduZWQgVVJMcy9jb29raWVzLlxuICAgICAqIFdoZW4gY29uZmlndXJlZCwgdGhlIGRpc3RyaWJ1dGlvbiB3aWxsIHJlcXVpcmUgYXV0aGVudGljYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHJpdmF0ZU1lZGlhPzogUHJpdmF0ZU1lZGlhQ29uZmlnO1xuXG4gICAgLyoqXG4gICAgICogT2JqZWN0IENsb3VkRnJvbnQgcmV0dXJucyBmb3IgYSByZXF1ZXN0IHRvIHRoZSBkaXN0cmlidXRpb24gcm9vdC5cbiAgICAgKlxuICAgICAqIFdpdGggYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0IHRoZSBkZWZhdWx0IGlzIGBpbmRleC5odG1sYDogdGhlIGRlZmF1bHRcbiAgICAgKiBiZWhhdmlvciBhbHJlYWR5IHNlbmRzIGAvYCB0byB0aGUgUzMgYnVja2V0IHRocm91Z2ggT0FDLCBzbyB0aGUgcm9vdFxuICAgICAqIG9iamVjdCByZXdyaXRlIChgL2AgLT4gYC9pbmRleC5odG1sYCkgY2hhbmdlcyB3aGljaCBvYmplY3QgdGhhdCBiZWhhdmlvclxuICAgICAqIHJldHVybnMsIG5vdCB3aGljaCBvcmlnaW4gc2VydmVzIGl0IChTZWN1cml0eSBIdWIgQ2xvdWRGcm9udC4xKS5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IFwiaW5kZXguaHRtbFwiIHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCwgb3RoZXJ3aXNlIHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGRlZmF1bHRSb290T2JqZWN0Pzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAgICpcbiAgICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgdGhlIG1lZGlhIGJ1Y2tldCB0YWtlcyBpdHMgbmFtZSBmcm9tIHRoZVxuICAgICAqIGNvbnRyYWN0IGFuZCBDbG91ZEZyb250IGFjY2VzcyBsb2dzIGdvIHRvXG4gICAgICogYGxvZ3MvYWNjZXNzL2Nkbi97bG9naWNhbE5hbWV9YCB0aHJvdWdoIENsb3VkV2F0Y2ggTG9ncyB2ZW5kZWQgZGVsaXZlcnkuXG4gICAgICogUGFzcyBgZW5hYmxlTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQgb2YgdGhlIGRlbGl2ZXJ5LlxuICAgICAqXG4gICAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICAgKi9cbiAgICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBkaXN0cmlidXRpb24ncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWRcbiAgICAgKiB3aGVuIGEgbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICAgKlxuICAgICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQ2xvdWRGcm9udCBzdGFuZGFyZC1sb2dnaW5nIG91dHB1dCBmb3JtYXQgZm9yIGEgQ2xvdWRXYXRjaCBMb2dzXG4gICAgICogZGVzdGluYXRpb24uIE9ubHkgdXNlZCB1bmRlciB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlLlxuICAgICAqIEBkZWZhdWx0IEFwcFRoZW9yeUNsb3VkRnJvbnRMb2dGb3JtYXQuSlNPTlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGNsb3VkRnJvbnRMb2dGb3JtYXQ/OiBBcHBUaGVvcnlDbG91ZEZyb250TG9nRm9ybWF0O1xuXG4gICAgLyoqXG4gICAgICogRW5hYmxlIENsb3VkRnJvbnQgYWNjZXNzIGxvZ2dpbmcuXG4gICAgICogQGRlZmF1bHQgdHJ1ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVuYWJsZUxvZ2dpbmc/OiBib29sZWFuO1xuXG4gICAgLyoqXG4gICAgICogT3B0aW9uYWwgUzMgYnVja2V0IGZvciBDbG91ZEZyb250IGFjY2VzcyBsb2dzLlxuICAgICAqIElmIG5vdCBwcm92aWRlZCBhbmQgZW5hYmxlTG9nZ2luZyBpcyB0cnVlLCBhIG5ldyBidWNrZXQgd2lsbCBiZSBjcmVhdGVkLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIGNyZWF0ZWQgcmVzb3VyY2VzLlxuICAgICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAgICovXG4gICAgcmVhZG9ubHkgcmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBXaGV0aGVyIHRvIGF1dG8tZGVsZXRlIG9iamVjdHMgaW4gY3JlYXRlZCBidWNrZXRzIG9uIHN0YWNrIGRlbGV0aW9uLlxuICAgICAqIE9ubHkgYXBwbGllcyB3aGVuIHJlbW92YWxQb2xpY3kgaXMgREVTVFJPWS5cbiAgICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IGF1dG9EZWxldGVPYmplY3RzPzogYm9vbGVhbjtcblxuICAgIC8qKlxuICAgICAqIE9wdGlvbmFsIHdlYiBBQ0wgSUQgZm9yIEFXUyBXQUYgaW50ZWdyYXRpb24uXG4gICAgICovXG4gICAgcmVhZG9ubHkgd2ViQWNsSWQ/OiBzdHJpbmc7XG5cbiAgICAvKipcbiAgICAgKiBQcmljZSBjbGFzcyBmb3IgdGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqIEBkZWZhdWx0IFByaWNlQ2xhc3MuUFJJQ0VfQ0xBU1NfQUxMXG4gICAgICovXG4gICAgcmVhZG9ubHkgcHJpY2VDbGFzcz86IGNsb3VkZnJvbnQuUHJpY2VDbGFzcztcblxuICAgIC8qKlxuICAgICAqIEFuIG9wdGlvbmFsIG5hbWUvY29tbWVudCBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKi9cbiAgICByZWFkb25seSBjb21tZW50Pzogc3RyaW5nO1xuXG4gICAgLyoqXG4gICAgICogQnVja2V0IHRoYXQgcmVjZWl2ZXMgUzMgc2VydmVyIGFjY2VzcyBsb2dzIGZvciB0aGUgbWVkaWEgYnVja2V0IHRoaXNcbiAgICAgKiBjb25zdHJ1Y3QgY3JlYXRlcywgd2hpY2ggaXMgd2hhdCBTZWN1cml0eSBIdWIgUzMuOSBldmFsdWF0ZXMuXG4gICAgICpcbiAgICAgKiBPZmYgYnkgZGVmYXVsdCBiZWNhdXNlIHRoZSBsb2cgdGFyZ2V0IGFuZCBpdHMgc3RvcmFnZSBjb3N0IG1vbmV5LiBUaGVcbiAgICAgKiB0YXJnZXQgYnVja2V0IGlzIHlvdXJzOiBpdCB0YWtlcyBubyBuYW1pbmcgZW50cnkgKHJlc291cmNlLW5hbWluZ1xuICAgICAqIGNvbnRyYWN0IHNlY3Rpb24gNCkuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBubyBzZXJ2ZXIgYWNjZXNzIGxvZ2dpbmdcbiAgICAgKi9cbiAgICByZWFkb25seSBzZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0PzogczMuSUJ1Y2tldDtcblxuICAgIC8qKlxuICAgICAqIEtleSBwcmVmaXggZm9yIHRoZSBzZXJ2ZXIgYWNjZXNzIGxvZ3MuIE9ubHkgdXNlZCB3aXRoXG4gICAgICogYHNlcnZlckFjY2Vzc0xvZ3NCdWNrZXRgLlxuICAgICAqXG4gICAgICogQGRlZmF1bHQgbm8gcHJlZml4XG4gICAgICovXG4gICAgcmVhZG9ubHkgc2VydmVyQWNjZXNzTG9nc1ByZWZpeD86IHN0cmluZztcblxuICAgIC8qKlxuICAgICAqIE1pbmltdW0gVExTIHByb3RvY29sIHZlcnNpb24gZm9yIHZpZXdlcnMgb2YgYSBjdXN0b20gZG9tYWluLlxuICAgICAqXG4gICAgICogV2l0aCBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQgYW5kIGEgY3VzdG9tIGNlcnRpZmljYXRlIHRoZSBkZWZhdWx0IGlzXG4gICAgICogYFRMU19WMV8yXzIwMjVgLCB0aGUgcG9saWN5IFNlY3VyaXR5IEh1YiBDbG91ZEZyb250LjE1IGFjY2VwdHMgd2l0aCB0aGVcbiAgICAgKiB3aWRlc3QgY2xpZW50IHN1cHBvcnQuXG4gICAgICpcbiAgICAgKiBAZGVmYXVsdCBUTFNfVjFfMl8yMDI1IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dCB3aXRoIGEgY2VydGlmaWNhdGUsXG4gICAgICogb3RoZXJ3aXNlIHRoZSBDbG91ZEZyb250IGRlZmF1bHQgZm9yIHRoZSBjZXJ0aWZpY2F0ZVxuICAgICAqL1xuICAgIHJlYWRvbmx5IG1pbmltdW1Qcm90b2NvbFZlcnNpb24/OiBjbG91ZGZyb250LlNlY3VyaXR5UG9saWN5UHJvdG9jb2w7XG5cbiAgICAvKipcbiAgICAgKiBDYWNoZSBwb2xpY3kgZm9yIHRoZSBkZWZhdWx0IGJlaGF2aW9yLlxuICAgICAqIEBkZWZhdWx0IENhY2hlUG9saWN5LkNBQ0hJTkdfT1BUSU1JWkVEXG4gICAgICovXG4gICAgcmVhZG9ubHkgY2FjaGVQb2xpY3k/OiBjbG91ZGZyb250LklDYWNoZVBvbGljeTtcblxuICAgIC8qKlxuICAgICAqIE9yaWdpbiByZXF1ZXN0IHBvbGljeSBmb3IgdGhlIGRlZmF1bHQgYmVoYXZpb3IuXG4gICAgICovXG4gICAgcmVhZG9ubHkgb3JpZ2luUmVxdWVzdFBvbGljeT86IGNsb3VkZnJvbnQuSU9yaWdpblJlcXVlc3RQb2xpY3k7XG5cbiAgICAvKipcbiAgICAgKiBFcnJvciByZXNwb25zZXMgZm9yIHRoZSBkaXN0cmlidXRpb24gKGUuZy4sIGN1c3RvbSA0MDQgaGFuZGxpbmcpLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IGVycm9yUmVzcG9uc2VzPzogY2xvdWRmcm9udC5FcnJvclJlc3BvbnNlW107XG5cbiAgICAvKipcbiAgICAgKiBBbGxvd2VkIEhUVFAgbWV0aG9kcyBmb3IgdGhlIGRpc3RyaWJ1dGlvbi5cbiAgICAgKiBAZGVmYXVsdCBBbGxvd2VkTWV0aG9kcy5BTExPV19HRVRfSEVBRF9PUFRJT05TXG4gICAgICovXG4gICAgcmVhZG9ubHkgYWxsb3dlZE1ldGhvZHM/OiBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzO1xufVxuXG4vKipcbiAqIEEgQ2xvdWRGcm9udCBkaXN0cmlidXRpb24gb3B0aW1pemVkIGZvciBzZXJ2aW5nIG1lZGlhIGFzc2V0cyBmcm9tIFMzLlxuICpcbiAqIFRoaXMgY29uc3RydWN0IGNyZWF0ZXMgb3Igd3JhcHMgYW4gUzMgYnVja2V0IHdpdGggYSBDbG91ZEZyb250IGRpc3RyaWJ1dGlvblxuICogY29uZmlndXJlZCBmb3IgbWVkaWEgZGVsaXZlcnkuIEl0IHN1cHBvcnRzOlxuICogLSBDdXN0b20gZG9tYWluIHdpdGggY2VydGlmaWNhdGUgYW5kIFJvdXRlNTMgaW50ZWdyYXRpb25cbiAqIC0gUHJpdmF0ZSBtZWRpYSBhY2Nlc3MgdmlhIHNpZ25lZCBVUkxzL2Nvb2tpZXMgKHRydXN0ZWQga2V5IGdyb3VwcylcbiAqIC0gQ3VzdG9taXphYmxlIGNhY2hpbmcgYW5kIHJlc3BvbnNlIGhlYWRlcnNcbiAqIC0gQWNjZXNzIGxvZ2dpbmdcbiAqXG4gKiBVc2UgY2FzZXM6XG4gKiAtIFB1YmxpYyBtZWRpYSBDRE4gKGltYWdlcywgdmlkZW9zLCBkb2N1bWVudHMpXG4gKiAtIFByaXZhdGUvYXV0aGVudGljYXRlZCBtZWRpYSBhY2Nlc3NcbiAqIC0gU3RhZ2Utc3BlY2lmaWMgbWVkaWEgc3ViZG9tYWlucyAoZS5nLiwgbWVkaWEuc3RhZ2UuZXhhbXBsZS5jb20pXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNZWRpYUNkbiBleHRlbmRzIENvbnN0cnVjdCB7XG4gICAgLyoqXG4gICAgICogVGhlIENsb3VkRnJvbnQgZGlzdHJpYnV0aW9uLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBkaXN0cmlidXRpb246IGNsb3VkZnJvbnQuRGlzdHJpYnV0aW9uO1xuXG4gICAgLyoqXG4gICAgICogVGhlIFMzIGJ1Y2tldCBmb3IgbWVkaWEgYXNzZXRzLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBidWNrZXQ6IHMzLklCdWNrZXQ7XG5cbiAgICAvKipcbiAgICAgKiBUaGUgQ2xvdWRGcm9udCBhY2Nlc3MgbG9ncyBidWNrZXQgKGlmIGxvZ2dpbmcgaXMgZW5hYmxlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGxvZ3NCdWNrZXQ/OiBzMy5JQnVja2V0O1xuXG4gICAgLyoqXG4gICAgICogVGhlIGNlcnRpZmljYXRlIHVzZWQgZm9yIHRoZSBkaXN0cmlidXRpb24gKGlmIGN1c3RvbSBkb21haW4gaXMgY29uZmlndXJlZCkuXG4gICAgICovXG4gICAgcHVibGljIHJlYWRvbmx5IGNlcnRpZmljYXRlPzogYWNtLklDZXJ0aWZpY2F0ZTtcblxuICAgIC8qKlxuICAgICAqIFRoZSBrZXkgZ3JvdXAgZm9yIHByaXZhdGUgbWVkaWEgYWNjZXNzIChpZiBjb25maWd1cmVkKS5cbiAgICAgKi9cbiAgICBwdWJsaWMgcmVhZG9ubHkga2V5R3JvdXA/OiBjbG91ZGZyb250LklLZXlHcm91cDtcblxuICAgIC8qKlxuICAgICAqIFRoZSBwdWJsaWMga2V5IGNyZWF0ZWQgZm9yIHByaXZhdGUgbWVkaWEgKGlmIGNyZWF0ZWQgZnJvbSBQRU0pLlxuICAgICAqL1xuICAgIHB1YmxpYyByZWFkb25seSBwdWJsaWNLZXk/OiBjbG91ZGZyb250LlB1YmxpY0tleTtcblxuICAgIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNZWRpYUNkblByb3BzKSB7XG4gICAgICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICAgICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgICAgIGNvbnN0IGF1dG9EZWxldGVPYmplY3RzID0gcHJvcHMuYXV0b0RlbGV0ZU9iamVjdHMgPz8gZmFsc2U7XG4gICAgICAgIGNvbnN0IGVuYWJsZUxvZ2dpbmcgPSBwcm9wcy5lbmFibGVMb2dnaW5nID8/IHRydWU7XG4gICAgICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgICAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgICAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICAgICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgICAgICAgXCJBcHBUaGVvcnlNZWRpYUNkblwiLFxuICAgICAgICAgICAgXCJidWNrZXROYW1lXCIsXG4gICAgICAgICAgICBcInMzX2J1Y2tldFwiLFxuICAgICAgICAgICAgbG9naWNhbCA/IGAke2xvZ2ljYWx9LW1lZGlhYCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHByb3BzLmJ1Y2tldE5hbWUgIT09IHVuZGVmaW5lZCxcbiAgICAgICAgKTtcbiAgICAgICAgaWYgKG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBwcm9wcy5sb2dzQnVja2V0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgICAgICBcIkFwcFRoZW9yeU1lZGlhQ2RuIGNhbm5vdCBob25vciBwcm9wcy5sb2dzQnVja2V0IHVuZGVyIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGU7IENsb3VkRnJvbnQgYWNjZXNzIGxvZ3MgZ28gdG8gdGhlIGNvbnRyYWN0IGxvZyBncm91cCwgc28gcmVtb3ZlIHByb3BzLmxvZ3NCdWNrZXQgb3IgdXNlIHRoZSBsZWdhY3kgbG9nZ2luZyBwcm9maWxlXCIsXG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHN0YW5kYXJkTG9nZ2luZyA9IG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiBlbmFibGVMb2dnaW5nO1xuXG4gICAgICAgIC8vIENyZWF0ZSBvciB1c2UgdGhlIHByb3ZpZGVkIG1lZGlhIGJ1Y2tldFxuICAgICAgICBpZiAocHJvcHMuYnVja2V0KSB7XG4gICAgICAgICAgICB0aGlzLmJ1Y2tldCA9IHByb3BzLmJ1Y2tldDtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuYnVja2V0ID0gbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIk1lZGlhQnVja2V0XCIsIHtcbiAgICAgICAgICAgICAgICAuLi4obmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsXG4gICAgICAgICAgICAgICAgICAgID8gYnVja2V0TmFtaW5nUHJvcHMobmFtaW5nQ29udGV4dCwgYCR7bG9naWNhbH0tbWVkaWFgKVxuICAgICAgICAgICAgICAgICAgICA6IHsgYnVja2V0TmFtZTogcHJvcHMuYnVja2V0TmFtZSB9KSxcbiAgICAgICAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgICAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCxcbiAgICAgICAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgICAgICAgIC4uLihwcm9wcy5zZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0ICE9PSB1bmRlZmluZWRcbiAgICAgICAgICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0OiBwcm9wcy5zZXJ2ZXJBY2Nlc3NMb2dzQnVja2V0LFxuICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHByb3BzLnNlcnZlckFjY2Vzc0xvZ3NQcmVmaXggIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgID8geyBzZXJ2ZXJBY2Nlc3NMb2dzUHJlZml4OiBwcm9wcy5zZXJ2ZXJBY2Nlc3NMb2dzUHJlZml4IH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgICAgICAgIGF1dG9EZWxldGVPYmplY3RzLFxuICAgICAgICAgICAgICAgIG9iamVjdE93bmVyc2hpcDogczMuT2JqZWN0T3duZXJzaGlwLkJVQ0tFVF9PV05FUl9FTkZPUkNFRCxcbiAgICAgICAgICAgICAgICB2ZXJzaW9uZWQ6IGZhbHNlLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBpZiAobmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsKSB7XG4gICAgICAgICAgICAgICAgLy8gQ29udHJhY3Qgc2VjdGlvbiAxMS40OiBkZWNsYXJlIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgY29tcG9zZWQgbmFtZS5cbiAgICAgICAgICAgICAgICBuYW1pbmdDb250ZXh0LmRlY2xhcmVOYW1lKFwiczNfYnVja2V0XCIsIGAke2xvZ2ljYWx9LW1lZGlhYCwgdGhpcy5idWNrZXQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ3JlYXRlIGxvZ3MgYnVja2V0IGlmIFMzIGxvZ2dpbmcgaXMgZW5hYmxlZCBhbmQgdGhlIHN0YW5kYXJkIHByb2ZpbGUgaXNcbiAgICAgICAgLy8gbm90IHJlcGxhY2luZyBpdCB3aXRoIENsb3VkV2F0Y2ggTG9ncyBkZWxpdmVyeS5cbiAgICAgICAgaWYgKGVuYWJsZUxvZ2dpbmcgJiYgIXN0YW5kYXJkTG9nZ2luZykge1xuICAgICAgICAgICAgdGhpcy5sb2dzQnVja2V0ID1cbiAgICAgICAgICAgICAgICBwcm9wcy5sb2dzQnVja2V0ID8/XG4gICAgICAgICAgICAgICAgbmV3IHMzLkJ1Y2tldCh0aGlzLCBcIkNsb3VkRnJvbnRMb2dzQnVja2V0XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgYmxvY2tQdWJsaWNBY2Nlc3M6IHMzLkJsb2NrUHVibGljQWNjZXNzLkJMT0NLX0FMTCxcbiAgICAgICAgICAgICAgICAgICAgZW5jcnlwdGlvbjogczMuQnVja2V0RW5jcnlwdGlvbi5TM19NQU5BR0VELFxuICAgICAgICAgICAgICAgICAgICBlbmZvcmNlU1NMOiB0cnVlLFxuICAgICAgICAgICAgICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICAgICAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0cyxcbiAgICAgICAgICAgICAgICAgICAgb2JqZWN0T3duZXJzaGlwOiBzMy5PYmplY3RPd25lcnNoaXAuT0JKRUNUX1dSSVRFUixcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEhhbmRsZSBwcml2YXRlIG1lZGlhIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgaWYgKHByb3BzLnByaXZhdGVNZWRpYSkge1xuICAgICAgICAgICAgaWYgKHByb3BzLnByaXZhdGVNZWRpYS5rZXlHcm91cCkge1xuICAgICAgICAgICAgICAgIHRoaXMua2V5R3JvdXAgPSBwcm9wcy5wcml2YXRlTWVkaWEua2V5R3JvdXA7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHByb3BzLnByaXZhdGVNZWRpYS5wdWJsaWNLZXlQZW0pIHtcbiAgICAgICAgICAgICAgICAvLyBDcmVhdGUgYSBwdWJsaWMga2V5IGZyb20gdGhlIFBFTVxuICAgICAgICAgICAgICAgIHRoaXMucHVibGljS2V5ID0gbmV3IGNsb3VkZnJvbnQuUHVibGljS2V5KHRoaXMsIFwiUHVibGljS2V5XCIsIHtcbiAgICAgICAgICAgICAgICAgICAgZW5jb2RlZEtleTogcHJvcHMucHJpdmF0ZU1lZGlhLnB1YmxpY0tleVBlbSxcbiAgICAgICAgICAgICAgICAgICAgcHVibGljS2V5TmFtZTogcHJvcHMucHJpdmF0ZU1lZGlhLnB1YmxpY0tleU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIGNvbW1lbnQ6IFwiUHVibGljIGtleSBmb3IgTWVkaWEgQ0ROIHNpZ25lZCBVUkxzXCIsXG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAvLyBDcmVhdGUgYSBrZXkgZ3JvdXAgd2l0aCB0aGUgcHVibGljIGtleVxuICAgICAgICAgICAgICAgIHRoaXMua2V5R3JvdXAgPSBuZXcgY2xvdWRmcm9udC5LZXlHcm91cCh0aGlzLCBcIktleUdyb3VwXCIsIHtcbiAgICAgICAgICAgICAgICAgICAga2V5R3JvdXBOYW1lOiBwcm9wcy5wcml2YXRlTWVkaWEua2V5R3JvdXBOYW1lLFxuICAgICAgICAgICAgICAgICAgICBpdGVtczogW3RoaXMucHVibGljS2V5XSxcbiAgICAgICAgICAgICAgICAgICAgY29tbWVudDogcHJvcHMucHJpdmF0ZU1lZGlhLmtleUdyb3VwQ29tbWVudCA/PyBcIktleSBncm91cCBmb3IgTWVkaWEgQ0ROIHByaXZhdGUgYWNjZXNzXCIsXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBIYW5kbGUgZG9tYWluIGNvbmZpZ3VyYXRpb25cbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzOiBzdHJpbmdbXSB8IHVuZGVmaW5lZDtcbiAgICAgICAgbGV0IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlOiBhY20uSUNlcnRpZmljYXRlIHwgdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChwcm9wcy5kb21haW4pIHtcbiAgICAgICAgICAgIGNvbnN0IGRvbWFpbk5hbWUgPSBTdHJpbmcocHJvcHMuZG9tYWluLmRvbWFpbk5hbWUpLnRyaW0oKTtcbiAgICAgICAgICAgIGlmIChkb21haW5OYW1lKSB7XG4gICAgICAgICAgICAgICAgZGlzdHJpYnV0aW9uRG9tYWluTmFtZXMgPSBbZG9tYWluTmFtZV07XG5cbiAgICAgICAgICAgICAgICBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gcHJvcHMuZG9tYWluLmNlcnRpZmljYXRlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocHJvcHMuZG9tYWluLmNlcnRpZmljYXRlQXJuKSB7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gYWNtLkNlcnRpZmljYXRlLmZyb21DZXJ0aWZpY2F0ZUFybihcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkNlcnRpZmljYXRlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9wcy5kb21haW4uY2VydGlmaWNhdGVBcm4sXG4gICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChwcm9wcy5kb21haW4uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnRDbG91ZEZyb250SG9zdGVkWm9uZUNlcnRpZmljYXRlUmVnaW9uKHRoaXMsIFwiQXBwVGhlb3J5TWVkaWFDZG5cIik7XG4gICAgICAgICAgICAgICAgICAgIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlID0gbmV3IGFjbS5DZXJ0aWZpY2F0ZSh0aGlzLCBcIkNlcnRpZmljYXRlXCIsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRvbWFpbk5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB2YWxpZGF0aW9uOiBhY20uQ2VydGlmaWNhdGVWYWxpZGF0aW9uLmZyb21EbnMocHJvcHMuZG9tYWluLmhvc3RlZFpvbmUpLFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBcIkFwcFRoZW9yeU1lZGlhQ2RuIHJlcXVpcmVzIGRvbWFpbi5jZXJ0aWZpY2F0ZSwgZG9tYWluLmNlcnRpZmljYXRlQXJuLCBvciBkb21haW4uaG9zdGVkWm9uZSB3aGVuIGRvbWFpbi5kb21haW5OYW1lIGlzIHNldFwiLFxuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuY2VydGlmaWNhdGUgPSBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZTtcblxuICAgICAgICAvLyBDcmVhdGUgdGhlIFMzIG9yaWdpbiB3aXRoIE9yaWdpbiBBY2Nlc3MgQ29udHJvbFxuICAgICAgICBjb25zdCBtZWRpYUJ1Y2tldE9yaWdpbiA9IG9yaWdpbnMuUzNCdWNrZXRPcmlnaW4ud2l0aE9yaWdpbkFjY2Vzc0NvbnRyb2wodGhpcy5idWNrZXQpO1xuXG4gICAgICAgIC8vIEJ1aWxkIGRlZmF1bHQgYmVoYXZpb3Igb3B0aW9uc1xuICAgICAgICBjb25zdCBkZWZhdWx0QmVoYXZpb3JPcHRpb25zOiBjbG91ZGZyb250LkJlaGF2aW9yT3B0aW9ucyA9IHtcbiAgICAgICAgICAgIG9yaWdpbjogbWVkaWFCdWNrZXRPcmlnaW4sXG4gICAgICAgICAgICB2aWV3ZXJQcm90b2NvbFBvbGljeTogY2xvdWRmcm9udC5WaWV3ZXJQcm90b2NvbFBvbGljeS5SRURJUkVDVF9UT19IVFRQUyxcbiAgICAgICAgICAgIGFsbG93ZWRNZXRob2RzOiBwcm9wcy5hbGxvd2VkTWV0aG9kcyA/PyBjbG91ZGZyb250LkFsbG93ZWRNZXRob2RzLkFMTE9XX0dFVF9IRUFEX09QVElPTlMsXG4gICAgICAgICAgICBjYWNoZVBvbGljeTogcHJvcHMuY2FjaGVQb2xpY3kgPz8gY2xvdWRmcm9udC5DYWNoZVBvbGljeS5DQUNISU5HX09QVElNSVpFRCxcbiAgICAgICAgICAgIGNvbXByZXNzOiB0cnVlLFxuICAgICAgICAgICAgLi4uKHByb3BzLm9yaWdpblJlcXVlc3RQb2xpY3kgPyB7IG9yaWdpblJlcXVlc3RQb2xpY3k6IHByb3BzLm9yaWdpblJlcXVlc3RQb2xpY3kgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5yZXNwb25zZUhlYWRlcnNQb2xpY3kgPyB7IHJlc3BvbnNlSGVhZGVyc1BvbGljeTogcHJvcHMucmVzcG9uc2VIZWFkZXJzUG9saWN5IH0gOiB7fSksXG4gICAgICAgICAgICAuLi4odGhpcy5rZXlHcm91cCA/IHsgdHJ1c3RlZEtleUdyb3VwczogW3RoaXMua2V5R3JvdXBdIH0gOiB7fSksXG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gQ3JlYXRlIHRoZSBkaXN0cmlidXRpb25cbiAgICAgICAgLy8gU2VjdXJpdHkgSHViIENsb3VkRnJvbnQuMTUgYW5kIENsb3VkRnJvbnQuMSB1bmRlciBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQuXG4gICAgICAgIGNvbnN0IG1pbmltdW1Qcm90b2NvbFZlcnNpb24gPSBkZWZhdWx0TWluaW11bVByb3RvY29sVmVyc2lvbihcbiAgICAgICAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgICAgICAgICBkaXN0cmlidXRpb25DZXJ0aWZpY2F0ZSAhPT0gdW5kZWZpbmVkLFxuICAgICAgICAgICAgcHJvcHMubWluaW11bVByb3RvY29sVmVyc2lvbixcbiAgICAgICAgKTtcbiAgICAgICAgLy8gVGhlIGRlZmF1bHQgYmVoYXZpb3IgaXMgdGhlIFMzIG1lZGlhIGJ1Y2tldCBvdmVyIE9BQywgc28gYSByb290IG9iamVjdFxuICAgICAgICAvLyByZXdyaXRlcyB3aGljaCBvYmplY3QgYC9gIHJldHVybnMgd2l0aG91dCBjaGFuZ2luZyB0aGUgb3JpZ2luLlxuICAgICAgICBjb25zdCBkZWZhdWx0Um9vdE9iamVjdCA9XG4gICAgICAgICAgICBwcm9wcy5kZWZhdWx0Um9vdE9iamVjdCAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgPyBwcm9wcy5kZWZhdWx0Um9vdE9iamVjdFxuICAgICAgICAgICAgICAgIDogc2VjdXJlRGVmYXVsdHMobmFtaW5nQ29udGV4dClcbiAgICAgICAgICAgICAgICAgICAgPyBcImluZGV4Lmh0bWxcIlxuICAgICAgICAgICAgICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgICAgdGhpcy5kaXN0cmlidXRpb24gPSBuZXcgY2xvdWRmcm9udC5EaXN0cmlidXRpb24odGhpcywgXCJEaXN0cmlidXRpb25cIiwge1xuICAgICAgICAgICAgLi4uKGVuYWJsZUxvZ2dpbmcgJiYgdGhpcy5sb2dzQnVja2V0XG4gICAgICAgICAgICAgICAgPyB7IGVuYWJsZUxvZ2dpbmc6IHRydWUsIGxvZ0J1Y2tldDogdGhpcy5sb2dzQnVja2V0LCBsb2dGaWxlUHJlZml4OiBcImNsb3VkZnJvbnQvXCIgfVxuICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgLi4uKGRpc3RyaWJ1dGlvbkRvbWFpbk5hbWVzICYmIGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlXG4gICAgICAgICAgICAgICAgPyB7IGRvbWFpbk5hbWVzOiBkaXN0cmlidXRpb25Eb21haW5OYW1lcywgY2VydGlmaWNhdGU6IGRpc3RyaWJ1dGlvbkNlcnRpZmljYXRlIH1cbiAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgIC4uLihtaW5pbXVtUHJvdG9jb2xWZXJzaW9uICE9PSB1bmRlZmluZWQgPyB7IG1pbmltdW1Qcm90b2NvbFZlcnNpb24gfSA6IHt9KSxcbiAgICAgICAgICAgIGRlZmF1bHRCZWhhdmlvcjogZGVmYXVsdEJlaGF2aW9yT3B0aW9ucyxcbiAgICAgICAgICAgIC4uLihkZWZhdWx0Um9vdE9iamVjdCA/IHsgZGVmYXVsdFJvb3RPYmplY3QgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy53ZWJBY2xJZCA/IHsgd2ViQWNsSWQ6IHByb3BzLndlYkFjbElkIH0gOiB7fSksXG4gICAgICAgICAgICAuLi4ocHJvcHMucHJpY2VDbGFzcyA/IHsgcHJpY2VDbGFzczogcHJvcHMucHJpY2VDbGFzcyB9IDoge30pLFxuICAgICAgICAgICAgLi4uKHByb3BzLmNvbW1lbnQgPyB7IGNvbW1lbnQ6IHByb3BzLmNvbW1lbnQgfSA6IHt9KSxcbiAgICAgICAgICAgIC4uLihwcm9wcy5lcnJvclJlc3BvbnNlcyA/IHsgZXJyb3JSZXNwb25zZXM6IHByb3BzLmVycm9yUmVzcG9uc2VzIH0gOiB7fSksXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGlmIChzdGFuZGFyZExvZ2dpbmcgJiYgbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsKSB7XG4gICAgICAgICAgICBlbmFibGVDbG91ZEZyb250U3RhbmRhcmRMb2dnaW5nKHtcbiAgICAgICAgICAgICAgICBzY29wZTogdGhpcyxcbiAgICAgICAgICAgICAgICBpZDogXCJDZG5Mb2dnaW5nXCIsXG4gICAgICAgICAgICAgICAgY29udGV4dDogbmFtaW5nQ29udGV4dCxcbiAgICAgICAgICAgICAgICBkaXN0cmlidXRpb246IHRoaXMuZGlzdHJpYnV0aW9uLFxuICAgICAgICAgICAgICAgIGxvZ2ljYWw6IGBsb2dzL2FjY2Vzcy9jZG4vJHtsb2dpY2FsfWAsXG4gICAgICAgICAgICAgICAgZm9ybWF0OiBwcm9wcy5jbG91ZEZyb250TG9nRm9ybWF0LFxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDcmVhdGUgUm91dGU1MyBBIHJlY29yZCBpZiBob3N0ZWQgem9uZSBpcyBwcm92aWRlZFxuICAgICAgICBpZiAocHJvcHMuZG9tYWluPy5kb21haW5OYW1lICYmIHByb3BzLmRvbWFpbj8uaG9zdGVkWm9uZSkge1xuICAgICAgICAgICAgbmV3IHJvdXRlNTMuQVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkXCIsIHtcbiAgICAgICAgICAgICAgICB6b25lOiBwcm9wcy5kb21haW4uaG9zdGVkWm9uZSxcbiAgICAgICAgICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW4uZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICB0YXJnZXQ6IHJvdXRlNTMuUmVjb3JkVGFyZ2V0LmZyb21BbGlhcyhuZXcgdGFyZ2V0cy5DbG91ZEZyb250VGFyZ2V0KHRoaXMuZGlzdHJpYnV0aW9uKSksXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHByb3BzLmRvbWFpbi5jcmVhdGVBQUFBUmVjb3JkID09PSB0cnVlKSB7XG4gICAgICAgICAgICAgICAgbmV3IHJvdXRlNTMuQWFhYVJlY29yZCh0aGlzLCBcIkFsaWFzUmVjb3JkQUFBQVwiLCB7XG4gICAgICAgICAgICAgICAgICAgIHpvbmU6IHByb3BzLmRvbWFpbi5ob3N0ZWRab25lLFxuICAgICAgICAgICAgICAgICAgICByZWNvcmROYW1lOiBwcm9wcy5kb21haW4uZG9tYWluTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgdGFyZ2V0OiByb3V0ZTUzLlJlY29yZFRhcmdldC5mcm9tQWxpYXMobmV3IHRhcmdldHMuQ2xvdWRGcm9udFRhcmdldCh0aGlzLmRpc3RyaWJ1dGlvbikpLFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufVxuIl19