import { RemovalPolicy, Stack, Token } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import { AppTheoryCloudFrontLogFormat } from "./logging";
import { defaultLogicalName } from "./private/logical-name";
import { refuseExplicitName } from "./private/refuse-explicit-name";
import { defaultMinimumProtocolVersion } from "./private/secure-defaults";
import { bucketNamingProps, enableCloudFrontStandardLogging } from "./private/standard-logging";
import type { AppTheoryNamingContext } from "./naming-context";

function assertCloudFrontHostedZoneCertificateRegion(scope: Construct, constructName: string): void {
    const region = Stack.of(scope).region;
    if (!Token.isUnresolved(region) && region === "us-east-1") {
        return;
    }

    const regionDescription = Token.isUnresolved(region) ? "unresolved" : region;
    throw new Error(
        `${constructName} cannot create a hosted-zone CloudFront certificate unless the stack region is explicitly us-east-1; stack region is ${regionDescription}. Provide domain.certificate or domain.certificateArn for stacks in other or environment-agnostic regions.`,
    );
}

/**
 * Domain configuration for the Media CDN distribution.
 */
export interface MediaCdnDomainConfig {
    /**
     * The domain name for the distribution (e.g., "media.example.com").
     */
    readonly domainName: string;

    /**
     * ACM certificate for HTTPS. Must be in us-east-1 for CloudFront.
     */
    readonly certificate?: acm.ICertificate;

    /**
     * ARN of an existing ACM certificate.
     */
    readonly certificateArn?: string;

    /**
     * Route53 hosted zone for DNS record creation.
     * When provided, an A record alias will be created for the domain.
     *
     * If `domainName` is set without `certificate` or `certificateArn`,
     * hosted-zone certificate creation is allowed only for stacks whose region
     * is explicitly `us-east-1`. CloudFront requires viewer certificates in
     * `us-east-1`; environment-agnostic or other-region stacks must provide an
     * explicit certificate input.
     */
    readonly hostedZone?: route53.IHostedZone;

    /**
     * Whether to create an AAAA alias record in addition to the A alias record.
     * @default false
     */
    readonly createAAAARecord?: boolean;
}

/**
 * Configuration for private media access using CloudFront signed URLs/cookies.
 */
export interface PrivateMediaConfig {
    /**
     * An existing CloudFront key group to use for trusted key groups.
     * When provided, the distribution will require signed URLs or signed cookies.
     */
    readonly keyGroup?: cloudfront.IKeyGroup;

    /**
     * Public key PEM content for creating a new key group.
     * Only used if keyGroup is not provided.
     */
    readonly publicKeyPem?: string;

    /**
     * Name for the public key when created from PEM.
     * @default "MediaCdnPublicKey"
     */
    readonly publicKeyName?: string;

    /**
     * Name for the key group when created.
     * @default "MediaCdnKeyGroup"
     */
    readonly keyGroupName?: string;

    /**
     * Comment/description for the key group.
     */
    readonly keyGroupComment?: string;
}

export interface AppTheoryMediaCdnProps {
    /**
     * Optional existing S3 bucket to use as the media origin.
     * If not provided, a new bucket will be created.
     */
    readonly bucket?: s3.IBucket;

    /**
     * Name for the media bucket (only used if bucket is not provided).
     */
    readonly bucketName?: string;

    /**
     * Domain configuration for custom domain, certificate, and Route53.
     */
    readonly domain?: MediaCdnDomainConfig;

    /**
     * Response headers policy to apply to the distribution.
     */
    readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

    /**
     * Private media configuration for signed URLs/cookies.
     * When configured, the distribution will require authentication.
     */
    readonly privateMedia?: PrivateMediaConfig;

    /**
     * Default root object for the distribution.
     */
    readonly defaultRootObject?: string;

    /**
     * Optional naming and logging context.
     *
     * With the standard logging profile the media bucket takes its name from the
     * contract and CloudFront access logs go to
     * `logs/access/cdn/{logicalName}` through CloudWatch Logs vended delivery.
     * Pass `enableLogging: false` to opt out of the delivery.
     *
     * With no context the construct synthesizes exactly as before.
     *
     * @default undefined
     */
    readonly namingContext?: AppTheoryNamingContext;

    /**
     * The distribution's logical name. Defaults to the kebab-cased construct id
     * when a naming context is present.
     *
     * @default undefined
     */
    readonly logicalName?: string;

    /**
     * CloudFront standard-logging output format for a CloudWatch Logs
     * destination. Only used under the standard logging profile.
     * @default AppTheoryCloudFrontLogFormat.JSON
     */
    readonly cloudFrontLogFormat?: AppTheoryCloudFrontLogFormat;

    /**
     * Enable CloudFront access logging.
     * @default true
     */
    readonly enableLogging?: boolean;

    /**
     * Optional S3 bucket for CloudFront access logs.
     * If not provided and enableLogging is true, a new bucket will be created.
     */
    readonly logsBucket?: s3.IBucket;

    /**
     * Removal policy for created resources.
     * @default RemovalPolicy.RETAIN
     */
    readonly removalPolicy?: RemovalPolicy;

    /**
     * Whether to auto-delete objects in created buckets on stack deletion.
     * Only applies when removalPolicy is DESTROY.
     * @default false
     */
    readonly autoDeleteObjects?: boolean;

    /**
     * Optional web ACL ID for AWS WAF integration.
     */
    readonly webAclId?: string;

    /**
     * Price class for the CloudFront distribution.
     * @default PriceClass.PRICE_CLASS_ALL
     */
    readonly priceClass?: cloudfront.PriceClass;

    /**
     * An optional name/comment for the distribution.
     */
    readonly comment?: string;

    /**
     * Minimum TLS protocol version for viewers of a custom domain.
     *
     * With a derived naming context and a custom certificate the default is
     * `TLS_V1_2_2025`, the policy Security Hub CloudFront.15 accepts with the
     * widest client support.
     *
     * @default TLS_V1_2_2025 under a derived naming context with a certificate,
     * otherwise the CloudFront default for the certificate
     */
    readonly minimumProtocolVersion?: cloudfront.SecurityPolicyProtocol;

    /**
     * Cache policy for the default behavior.
     * @default CachePolicy.CACHING_OPTIMIZED
     */
    readonly cachePolicy?: cloudfront.ICachePolicy;

    /**
     * Origin request policy for the default behavior.
     */
    readonly originRequestPolicy?: cloudfront.IOriginRequestPolicy;

    /**
     * Error responses for the distribution (e.g., custom 404 handling).
     */
    readonly errorResponses?: cloudfront.ErrorResponse[];

    /**
     * Allowed HTTP methods for the distribution.
     * @default AllowedMethods.ALLOW_GET_HEAD_OPTIONS
     */
    readonly allowedMethods?: cloudfront.AllowedMethods;
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
export class AppTheoryMediaCdn extends Construct {
    /**
     * The CloudFront distribution.
     */
    public readonly distribution: cloudfront.Distribution;

    /**
     * The S3 bucket for media assets.
     */
    public readonly bucket: s3.IBucket;

    /**
     * The CloudFront access logs bucket (if logging is enabled).
     */
    public readonly logsBucket?: s3.IBucket;

    /**
     * The certificate used for the distribution (if custom domain is configured).
     */
    public readonly certificate?: acm.ICertificate;

    /**
     * The key group for private media access (if configured).
     */
    public readonly keyGroup?: cloudfront.IKeyGroup;

    /**
     * The public key created for private media (if created from PEM).
     */
    public readonly publicKey?: cloudfront.PublicKey;

    constructor(scope: Construct, id: string, props: AppTheoryMediaCdnProps) {
        super(scope, id);

        const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
        const autoDeleteObjects = props.autoDeleteObjects ?? false;
        const enableLogging = props.enableLogging ?? true;
        const namingContext = props.namingContext;
        const logical = props.logicalName ?? (namingContext ? defaultLogicalName(this) : undefined);
        refuseExplicitName(
            namingContext,
            "AppTheoryMediaCdn",
            "bucketName",
            "s3_bucket",
            logical ? `${logical}-media` : undefined,
            props.bucketName !== undefined,
        );
        if (namingContext?.standardLogging === true && props.logsBucket !== undefined) {
            throw new Error(
                "AppTheoryMediaCdn cannot honor props.logsBucket under the standard logging profile; CloudFront access logs go to the contract log group, so remove props.logsBucket or use the legacy logging profile",
            );
        }
        const standardLogging = namingContext?.standardLogging === true && enableLogging;

        // Create or use the provided media bucket
        if (props.bucket) {
            this.bucket = props.bucket;
        } else {
            this.bucket = new s3.Bucket(this, "MediaBucket", {
                ...(namingContext && logical
                    ? bucketNamingProps(namingContext, `${logical}-media`)
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
            } else if (props.privateMedia.publicKeyPem) {
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
        let distributionDomainNames: string[] | undefined;
        let distributionCertificate: acm.ICertificate | undefined;

        if (props.domain) {
            const domainName = String(props.domain.domainName).trim();
            if (domainName) {
                distributionDomainNames = [domainName];

                if (props.domain.certificate) {
                    distributionCertificate = props.domain.certificate;
                } else if (props.domain.certificateArn) {
                    distributionCertificate = acm.Certificate.fromCertificateArn(
                        this,
                        "Certificate",
                        props.domain.certificateArn,
                    );
                } else if (props.domain.hostedZone) {
                    assertCloudFrontHostedZoneCertificateRegion(this, "AppTheoryMediaCdn");
                    distributionCertificate = new acm.Certificate(this, "Certificate", {
                        domainName,
                        validation: acm.CertificateValidation.fromDns(props.domain.hostedZone),
                    });
                } else {
                    throw new Error(
                        "AppTheoryMediaCdn requires domain.certificate, domain.certificateArn, or domain.hostedZone when domain.domainName is set",
                    );
                }
            }
        }

        this.certificate = distributionCertificate;

        // Create the S3 origin with Origin Access Control
        const mediaBucketOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket);

        // Build default behavior options
        const defaultBehaviorOptions: cloudfront.BehaviorOptions = {
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
        const minimumProtocolVersion = defaultMinimumProtocolVersion(
            namingContext,
            distributionCertificate !== undefined,
            props.minimumProtocolVersion,
        );
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
            enableCloudFrontStandardLogging({
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
