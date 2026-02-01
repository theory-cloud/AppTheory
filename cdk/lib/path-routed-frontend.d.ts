import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
/**
 * Configuration for an SPA origin routed by path prefix.
 */
export interface SpaOriginConfig {
    /**
     * S3 bucket containing the SPA assets.
     */
    readonly bucket: s3.IBucket;
    /**
     * Path pattern to route to this SPA (e.g., "/l/*", "/auth/*").
     * Must include the trailing wildcard.
     */
    readonly pathPattern: string;
    /**
     * Optional cache policy override. Defaults to CACHING_OPTIMIZED.
     */
    readonly cachePolicy?: cloudfront.ICachePolicy;
}
/**
 * Configuration for path patterns that should bypass SPA routing and go directly to the API origin.
 */
export interface ApiBypassConfig {
    /**
     * Path pattern that should route to the API origin instead of SPA (e.g., "/auth/wallet/*").
     */
    readonly pathPattern: string;
    /**
     * Optional cache policy override. Defaults to CACHING_DISABLED.
     */
    readonly cachePolicy?: cloudfront.ICachePolicy;
    /**
     * Optional origin request policy override.
     */
    readonly originRequestPolicy?: cloudfront.IOriginRequestPolicy;
}
/**
 * Domain configuration for the CloudFront distribution.
 */
export interface PathRoutedFrontendDomainConfig {
    /**
     * The domain name for the distribution (e.g., "app.example.com").
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
export interface AppTheoryPathRoutedFrontendProps {
    /**
     * The primary API origin URL (e.g., the API Gateway invoke URL or Lambda function URL).
     * This is used for the default behavior and any API bypass paths.
     */
    readonly apiOriginUrl: string;
    /**
     * SPA origins with their path patterns.
     * Each SPA will be served via CloudFront with SPA rewrite support.
     */
    readonly spaOrigins?: SpaOriginConfig[];
    /**
     * API bypass configurations for paths that should go directly to the API origin
     * even though they might match an SPA path prefix.
     * These are evaluated before SPA paths due to CloudFront behavior precedence.
     */
    readonly apiBypassPaths?: ApiBypassConfig[];
    /**
     * Domain configuration for custom domain, certificate, and Route53.
     */
    readonly domain?: PathRoutedFrontendDomainConfig;
    /**
     * Response headers policy to apply to all behaviors.
     */
    readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;
    /**
     * Origin request policy for the API origin (default behavior).
     */
    readonly apiOriginRequestPolicy?: cloudfront.IOriginRequestPolicy;
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
export declare class AppTheoryPathRoutedFrontend extends Construct {
    /**
     * The CloudFront distribution.
     */
    readonly distribution: cloudfront.Distribution;
    /**
     * The CloudFront Function for SPA rewrite (if SPA origins are configured).
     */
    readonly spaRewriteFunction?: cloudfront.Function;
    /**
     * The CloudFront access logs bucket (if logging is enabled).
     */
    readonly logsBucket?: s3.IBucket;
    /**
     * The certificate used for the distribution (if custom domain is configured).
     */
    readonly certificate?: acm.ICertificate;
    constructor(scope: Construct, id: string, props: AppTheoryPathRoutedFrontendProps);
    /**
     * Extracts the domain name from a URL (e.g., "https://api.example.com/path" -> "api.example.com").
     */
    private parseOriginFromUrl;
}
