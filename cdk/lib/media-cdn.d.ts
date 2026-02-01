import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
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
     */
    readonly hostedZone?: route53.IHostedZone;
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
export declare class AppTheoryMediaCdn extends Construct {
    /**
     * The CloudFront distribution.
     */
    readonly distribution: cloudfront.Distribution;
    /**
     * The S3 bucket for media assets.
     */
    readonly bucket: s3.IBucket;
    /**
     * The CloudFront access logs bucket (if logging is enabled).
     */
    readonly logsBucket?: s3.IBucket;
    /**
     * The certificate used for the distribution (if custom domain is configured).
     */
    readonly certificate?: acm.ICertificate;
    /**
     * The key group for private media access (if configured).
     */
    readonly keyGroup?: cloudfront.IKeyGroup;
    /**
     * The public key created for private media (if created from PEM).
     */
    readonly publicKey?: cloudfront.PublicKey;
    constructor(scope: Construct, id: string, props: AppTheoryMediaCdnProps);
}
