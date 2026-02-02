import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export enum AppTheorySpaRewriteMode {
    /**
     * Rewrite extensionless routes to `index.html` within the SPA prefix.
     */
    SPA = "spa",

    /**
     * Do not rewrite routes. Useful for multi-page/static sites.
     */
    NONE = "none",
}

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

    /**
     * Response headers policy for this SPA behavior.
     * Overrides `spaResponseHeadersPolicy` and `responseHeadersPolicy` (legacy).
     */
    readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

    /**
     * Whether to strip the SPA prefix before forwarding to the S3 origin.
     *
     * Example:
     * - Request: `/auth/assets/app.js`
     * - With `stripPrefixBeforeOrigin=true`, S3 receives: `/assets/app.js`
     *
     * This allows laying out the SPA bucket at root while still serving it under a prefix.
     *
     * @default false
     */
    readonly stripPrefixBeforeOrigin?: boolean;

    /**
     * SPA rewrite mode.
     *
     * - `SPA`: rewrite extensionless routes to the SPA's `index.html`
     * - `NONE`: do not rewrite routes (useful for multi-page sites)
     *
     * @default AppTheorySpaRewriteMode.SPA
     */
    readonly rewriteMode?: AppTheorySpaRewriteMode;
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

    /**
     * Response headers policy for this API bypass behavior.
     * Overrides `apiBypassResponseHeadersPolicy` and `responseHeadersPolicy` (legacy).
     */
    readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;
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

    /**
     * Whether to create an AAAA alias record in addition to the A alias record.
     * @default false
     */
    readonly createAAAARecord?: boolean;
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
     * Response headers policy to apply to all behaviors (legacy).
     *
     * Prefer using `apiResponseHeadersPolicy`, `spaResponseHeadersPolicy`, and
     * `apiBypassResponseHeadersPolicy` for behavior-scoped control.
     */
    readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

    /**
     * Response headers policy for the API origin default behavior.
     */
    readonly apiResponseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

    /**
     * Default response headers policy for SPA behaviors.
     * Can be overridden per SPA via `SpaOriginConfig.responseHeadersPolicy`.
     */
    readonly spaResponseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

    /**
     * Default response headers policy for API bypass behaviors.
     * Can be overridden per bypass via `ApiBypassConfig.responseHeadersPolicy`.
     */
    readonly apiBypassResponseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

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
 * CloudFront Function code for SPA viewer-request rewrite.
 * Rewrites requests without file extensions to the index.html within the prefix.
 */
function generateSpaRewriteFunctionCode(
    spaOrigins: SpaOriginConfig[],
): string {
    const configs = spaOrigins
        .map((spa) => {
            const cleanPrefix = spa.pathPattern.replace(/\/\*$/, "");
            const prefix = `${cleanPrefix}/`;
            const rewriteMode = spa.rewriteMode ?? AppTheorySpaRewriteMode.SPA;
            const stripPrefixBeforeOrigin = spa.stripPrefixBeforeOrigin === true;
            const indexPath = `${cleanPrefix}/index.html`;
            return {
                cleanPrefix,
                prefix,
                rewriteMode,
                stripPrefixBeforeOrigin,
                indexPath,
            };
        })
        // Ensure more specific prefixes match first to avoid overlap issues.
        .sort((a, b) => b.cleanPrefix.length - a.cleanPrefix.length);

    const prefixMatches = configs
        .map((cfg) => {
            return `{ cleanPrefix: '${cfg.cleanPrefix}', prefix: '${cfg.prefix}', rewriteMode: '${cfg.rewriteMode}', stripPrefixBeforeOrigin: ${cfg.stripPrefixBeforeOrigin}, indexPath: '${cfg.indexPath}' }`;
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
	      var uriWithoutPrefix = uri.substring(spa.prefix.length);

	      if (spa.rewriteMode === 'spa') {
	        // If the URI doesn't have an extension (no file), rewrite to index.html
	        // Check if it has a file extension (contains a dot in the last path segment)
	        var lastSlash = uriWithoutPrefix.lastIndexOf('/');
	        var lastSegment = lastSlash >= 0 ? uriWithoutPrefix.substring(lastSlash + 1) : uriWithoutPrefix;
	        
	        // If no extension in the last segment, serve index.html
	        if (lastSegment.indexOf('.') === -1) {
	          request.uri = spa.indexPath;
	        }
	      }

	      // Optionally strip the prefix before forwarding to the origin.
	      if (spa.stripPrefixBeforeOrigin) {
	        var cleanPrefixWithSlash = spa.cleanPrefix + '/';
	        if (request.uri.startsWith(cleanPrefixWithSlash)) {
	          request.uri = request.uri.substring(spa.cleanPrefix.length);
	        }
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
export class AppTheoryPathRoutedFrontend extends Construct {
    /**
     * The CloudFront distribution.
     */
    public readonly distribution: cloudfront.Distribution;

    /**
     * The CloudFront Function for SPA rewrite (if SPA origins are configured).
     */
    public readonly spaRewriteFunction?: cloudfront.Function;

    /**
     * The CloudFront access logs bucket (if logging is enabled).
     */
    public readonly logsBucket?: s3.IBucket;

    /**
     * The certificate used for the distribution (if custom domain is configured).
     */
    public readonly certificate?: acm.ICertificate;

    constructor(scope: Construct, id: string, props: AppTheoryPathRoutedFrontendProps) {
        super(scope, id);

        if (!props.apiOriginUrl) {
            throw new Error("AppTheoryPathRoutedFrontend requires props.apiOriginUrl");
        }

        const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
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

        // Parse the API origin URL to create an HttpOrigin (domain + optional originPath)
        const apiOriginParsed = this.parseOriginFromUrl(props.apiOriginUrl);
        const apiOrigin = new origins.HttpOrigin(apiOriginParsed.domainName, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
            ...(apiOriginParsed.originPath ? { originPath: apiOriginParsed.originPath } : {}),
        });

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
                    // Create a DNS-validated certificate
                    distributionCertificate = new acm.DnsValidatedCertificate(this, "Certificate", {
                        domainName,
                        hostedZone: props.domain.hostedZone,
                        region: "us-east-1",
                    });
                } else {
                    throw new Error(
                        "AppTheoryPathRoutedFrontend requires domain.certificate, domain.certificateArn, or domain.hostedZone when domain.domainName is set",
                    );
                }
            }
        }

        this.certificate = distributionCertificate;

        // Create CloudFront Function for SPA rewrite if SPA origins are configured
        const spaOrigins = props.spaOrigins ?? [];
        if (
            spaOrigins.some((spa) => {
                const rewriteMode = spa.rewriteMode ?? AppTheorySpaRewriteMode.SPA;
                return rewriteMode !== AppTheorySpaRewriteMode.NONE || spa.stripPrefixBeforeOrigin === true;
            })
        ) {
            const functionCode = generateSpaRewriteFunctionCode(spaOrigins);

            this.spaRewriteFunction = new cloudfront.Function(this, "SpaRewriteFunction", {
                code: cloudfront.FunctionCode.fromInline(functionCode),
                runtime: cloudfront.FunctionRuntime.JS_2_0,
                comment: "SPA viewer-request rewrite for path-routed frontend",
            });
        }

        // Build additional behaviors
        const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};

        // Add API bypass paths first (higher precedence in CloudFront)
        for (const bypassConfig of props.apiBypassPaths ?? []) {
            const responseHeadersPolicy =
                bypassConfig.responseHeadersPolicy ??
                props.apiBypassResponseHeadersPolicy ??
                props.responseHeadersPolicy;

            additionalBehaviors[bypassConfig.pathPattern] = {
                origin: apiOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachePolicy: bypassConfig.cachePolicy ?? cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy:
                    bypassConfig.originRequestPolicy ?? props.apiOriginRequestPolicy,
                ...(responseHeadersPolicy
                    ? { responseHeadersPolicy }
                    : {}),
            };
        }

        // Add SPA origin behaviors
        for (const spaConfig of spaOrigins) {
            const responseHeadersPolicy =
                spaConfig.responseHeadersPolicy ??
                props.spaResponseHeadersPolicy ??
                props.responseHeadersPolicy;
            const rewriteMode = spaConfig.rewriteMode ?? AppTheorySpaRewriteMode.SPA;
            const needsFunction =
                this.spaRewriteFunction &&
                (rewriteMode !== AppTheorySpaRewriteMode.NONE || spaConfig.stripPrefixBeforeOrigin === true);

            const spaOrigin = origins.S3BucketOrigin.withOriginAccessControl(spaConfig.bucket);

            additionalBehaviors[spaConfig.pathPattern] = {
                origin: spaOrigin,
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                cachePolicy: spaConfig.cachePolicy ?? cloudfront.CachePolicy.CACHING_OPTIMIZED,
                compress: true,
                ...(needsFunction
                    ? {
                        functionAssociations: [
                            {
                                function: this.spaRewriteFunction,
                                eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                            },
                        ],
                    }
                    : {}),
                ...(responseHeadersPolicy
                    ? { responseHeadersPolicy }
                    : {}),
            };
        }

        // Create the distribution
        const defaultResponseHeadersPolicy =
            props.apiResponseHeadersPolicy ??
            props.responseHeadersPolicy;

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
                ...(defaultResponseHeadersPolicy
                    ? { responseHeadersPolicy: defaultResponseHeadersPolicy }
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

            if (props.domain.createAAAARecord === true) {
                new route53.AaaaRecord(this, "AliasRecordAAAA", {
                    zone: props.domain.hostedZone,
                    recordName: props.domain.domainName,
                    target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
                });
            }
        }
    }

    /**
     * Extracts the domain name from a URL (e.g., "https://api.example.com/path" -> "api.example.com").
     */
    private parseOriginFromUrl(url: string): { domainName: string; originPath?: string } {
        const urlStr = String(url ?? "").trim();
        if (!urlStr) {
            throw new Error("AppTheoryPathRoutedFrontend requires a non-empty apiOriginUrl");
        }

        // Full URL (recommended): https://api.example.com/prod
        if (urlStr.includes("://")) {
            const parsed = new URL(urlStr);
            const domainName = String(parsed.hostname ?? "").trim();
            if (!domainName) {
                throw new Error(`AppTheoryPathRoutedFrontend could not parse domain from apiOriginUrl: ${urlStr}`);
            }

            const path = String(parsed.pathname ?? "").trim();
            const originPath = path && path !== "/" ? path.replace(/\/+$/, "") : undefined;
            return { domainName, ...(originPath ? { originPath } : {}) };
        }

        // Bare domain (or domain + path): api.example.com or api.example.com/prod
        const withoutQuery = urlStr.split("?")[0]?.split("#")[0] ?? urlStr;
        const firstSlashIndex = withoutQuery.indexOf("/");
        const domainPart = (firstSlashIndex >= 0 ? withoutQuery.slice(0, firstSlashIndex) : withoutQuery)
            .trim()
            .replace(/:\d+$/, "");
        if (!domainPart) {
            throw new Error(`AppTheoryPathRoutedFrontend could not parse domain from apiOriginUrl: ${urlStr}`);
        }

        const pathPart = firstSlashIndex >= 0 ? withoutQuery.slice(firstSlashIndex) : "";
        const originPath = pathPart && pathPart !== "/" ? pathPart.replace(/\/+$/, "") : undefined;
        return { domainName: domainPart, ...(originPath ? { originPath } : {}) };
    }
}
