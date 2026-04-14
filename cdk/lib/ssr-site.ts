import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

import { trimRepeatedChar, trimRepeatedCharStart } from "./private/string-utils";

const apptheoryOriginalUriHeader = "x-apptheory-original-uri";
const facetheoryOriginalUriHeader = "x-facetheory-original-uri";
const apptheoryOriginalHostHeader = "x-apptheory-original-host";
const facetheoryOriginalHostHeader = "x-facetheory-original-host";
const ssrOriginalUriHeaders = [apptheoryOriginalUriHeader, facetheoryOriginalUriHeader] as const;
const ssrOriginalHostHeaders = [apptheoryOriginalHostHeader, facetheoryOriginalHostHeader] as const;
const ssgIsrHydrationPathPattern = "/_facetheory/data/*";
const defaultIsrHtmlStoreKeyPrefix = "isr";
const maxDefaultCacheKeyHeaders = 10;

export enum AppTheorySsrSiteMode {
  /**
   * Lambda Function URL is the default origin. Direct S3 behaviors are used only for
   * immutable assets and any explicitly configured static path patterns.
   *
   * Because this mode exposes Lambda as the default viewer surface with write methods,
   * omitted `ssrUrlAuthType` resolves to `NONE`.
   */
  SSR_ONLY = "ssr-only",

  /**
   * S3 is the primary HTML origin and Lambda SSR/ISR is the fallback. FaceTheory hydration
   * data routes are kept on S3 and the edge rewrites extensionless paths to `/index.html`.
   */
  SSG_ISR = "ssg-isr",
}

function pathPatternToUriPrefix(pattern: string): string {
  const normalized = trimRepeatedCharStart(String(pattern).trim(), "/").replace(/\/\*$/, "");
  return normalized ? `/${normalized}` : "/";
}

function normalizePathPatterns(patterns: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (Array.isArray(patterns) ? patterns : [])
        .map((pattern) => trimRepeatedCharStart(String(pattern).trim(), "/"))
        .filter((pattern) => pattern.length > 0),
    ),
  );
}

function expandBehaviorPathPatterns(patterns: string[]): string[] {
  const expanded = new Set<string>();

  for (const pattern of patterns) {
    const normalized = trimRepeatedCharStart(String(pattern).trim(), "/");
    if (!normalized) continue;

    expanded.add(normalized);
    if (normalized.endsWith("/*")) {
      const rootPattern = normalized.slice(0, -2);
      if (rootPattern) {
        expanded.add(rootPattern);
      }
    }
  }

  return Array.from(expanded);
}

function assertNoConflictingBehaviorPatterns(
  label: string,
  patterns: string[],
  seenOwners: Map<string, string>,
): void {
  for (const pattern of expandBehaviorPathPatterns(patterns)) {
    const owner = seenOwners.get(pattern);
    if (owner && owner !== label) {
      throw new Error(`AppTheorySsrSite received overlapping path pattern "${pattern}" for ${owner} and ${label}`);
    }
    seenOwners.set(pattern, label);
  }
}

function generateSsrViewerRequestFunctionCode(
  mode: AppTheorySsrSiteMode,
  rawS3PathPatterns: string[],
  lambdaPassthroughPathPatterns: string[],
): string {
  const rawS3Prefixes = rawS3PathPatterns.map(pathPatternToUriPrefix).sort((a, b) => b.length - a.length);
  const rawS3PrefixList = rawS3Prefixes.map((prefix) => `'${prefix}'`).join(",\n      ");
  const lambdaPassthroughPrefixes = lambdaPassthroughPathPatterns
    .map(pathPatternToUriPrefix)
    .sort((a, b) => b.length - a.length);
  const lambdaPassthroughPrefixList = lambdaPassthroughPrefixes.map((prefix) => `'${prefix}'`).join(",\n      ");

  return `
	function handler(event) {
	  var request = event.request;
	  var headers = request.headers;
	  var uri = request.uri || '/';
	  var requestIdHeader = headers['x-request-id'];
	  var requestId = requestIdHeader && requestIdHeader.value ? requestIdHeader.value.trim() : '';

	  if (!requestId) {
	    requestId = event.context && event.context.requestId ? String(event.context.requestId).trim() : '';
	  }

	  if (!requestId) {
	    requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
	  }

	  headers['x-request-id'] = { value: requestId };
	  headers['${apptheoryOriginalUriHeader}'] = { value: uri };
	  headers['${facetheoryOriginalUriHeader}'] = { value: uri };

	  if (headers.host && headers.host.value) {
	    headers['${apptheoryOriginalHostHeader}'] = { value: headers.host.value };
	    headers['${facetheoryOriginalHostHeader}'] = { value: headers.host.value };
	  }

	  if ('${mode}' === '${AppTheorySsrSiteMode.SSG_ISR}') {
	    var rawS3Prefixes = [
	      ${rawS3PrefixList}
	    ];
	    var lambdaPassthroughPrefixes = [
	      ${lambdaPassthroughPrefixList}
	    ];
	    var isLambdaPassthroughPath = false;

	    for (var i = 0; i < lambdaPassthroughPrefixes.length; i++) {
	      var prefix = lambdaPassthroughPrefixes[i];
	      if (uri === prefix || uri.startsWith(prefix + '/')) {
	        isLambdaPassthroughPath = true;
	        break;
	      }
	    }

	    if (!isLambdaPassthroughPath) {
	      var isRawS3Path = false;

	      for (var j = 0; j < rawS3Prefixes.length; j++) {
	        var rawPrefix = rawS3Prefixes[j];
	        if (uri === rawPrefix || uri.startsWith(rawPrefix + '/')) {
	          isRawS3Path = true;
	          break;
	        }
	      }

	      var lastSlash = uri.lastIndexOf('/');
	      var lastSegment = lastSlash >= 0 ? uri.substring(lastSlash + 1) : uri;

	      if (!isRawS3Path && lastSegment.indexOf('.') === -1) {
	        request.uri = uri.endsWith('/') ? uri + 'index.html' : uri + '/index.html';
	      }
	    }
	  }

	  return request;
	}
	`.trim();
}

function generateSsrViewerResponseFunctionCode(): string {
  return `
	function handler(event) {
	  var request = event.request;
	  var response = event.response;
	  var requestIdHeader = request.headers['x-request-id'];
	  var requestId = requestIdHeader && requestIdHeader.value ? requestIdHeader.value.trim() : '';

	  if (!requestId) {
	    requestId = event.context && event.context.requestId ? String(event.context.requestId).trim() : '';
	  }

	  if (requestId) {
	    response.headers = response.headers || {};
	    if (!response.headers['x-request-id']) {
	      response.headers['x-request-id'] = { value: requestId };
	    }
	  }

	  return response;
	}
	`.trim();
}

export interface AppTheorySsrSiteProps {
  readonly ssrFunction: lambda.IFunction;

  /**
   * Explicit deployment mode for the site topology.
   *
   * - `ssr-only`: Lambda Function URL is the default origin
   * - `ssg-isr`: S3 is the primary HTML origin and Lambda is the fallback
   *
   * Existing implicit behavior maps to `ssr-only`.
   * @default AppTheorySsrSiteMode.SSR_ONLY
   */
  readonly mode?: AppTheorySsrSiteMode;

  /**
   * Lambda Function URL invoke mode for the SSR origin.
   * @default lambda.InvokeMode.RESPONSE_STREAM
   */
  readonly invokeMode?: lambda.InvokeMode;

  /**
   * Function URL auth type for the SSR origin.
   *
   * If omitted, AppTheory auto-selects the auth model based on the exposed
   * Lambda-backed surface:
   *
   * - `AWS_IAM` for read-only Lambda traffic (`GET` / `HEAD` / `OPTIONS`)
   * - `NONE` when Lambda-backed behaviors expose browser-facing write methods
   *
   * Set this explicitly to force a specific Function URL auth mode.
   * @default derived from exposed Lambda methods
   */
  readonly ssrUrlAuthType?: lambda.FunctionUrlAuthType;

  readonly assetsBucket?: s3.IBucket;
  readonly assetsPath?: string;
  readonly assetsKeyPrefix?: string;
  readonly assetsManifestKey?: string;

  /**
   * Optional S3 bucket used by FaceTheory ISR HTML storage (`S3HtmlStore`).
   *
   * When provided, AppTheory grants the SSR function read/write access and wires:
   * - `FACETHEORY_ISR_BUCKET`
   * - `FACETHEORY_ISR_PREFIX`
   */
  readonly htmlStoreBucket?: s3.IBucket;

  /**
   * S3 key prefix used by FaceTheory ISR HTML storage.
   * @default isr
   */
  readonly htmlStoreKeyPrefix?: string;

  /**
   * Additional extensionless HTML section path patterns to route directly to the primary HTML S3 origin.
   *
   * Requests like `/marketing` and `/marketing/...` are rewritten to `/index.html`
   * within the section and stay on S3 instead of falling back to Lambda.
   *
   * Example direct-S3 HTML section path: "/marketing/*"
   */
  readonly staticPathPatterns?: string[];

  /**
   * Additional raw S3 object/data path patterns that should bypass extensionless HTML rewrites.
   *
   * In `ssg-isr` mode, `/_facetheory/data/*` is added automatically.
   * Example direct-S3 object path: "/feeds/*"
   */
  readonly directS3PathPatterns?: string[];

  /**
   * Additional path patterns that should bypass the `ssg-isr` origin group and route directly
   * to the Lambda Function URL with full method support.
   *
   * Use this for same-origin dynamic paths such as auth callbacks, actions, or form posts.
   * When `ssrUrlAuthType` is omitted, adding these patterns makes AppTheory select
   * `NONE` so browser-facing write methods keep working through CloudFront.
   * Example direct-SSR path: "/actions/*"
   */
  readonly ssrPathPatterns?: string[];

  /**
   * Optional TableTheory/DynamoDB table used for FaceTheory ISR metadata and lease coordination.
   *
   * When provided, AppTheory grants the SSR function read/write access and wires the
   * metadata table aliases expected by the documented FaceTheory deployment shape.
   */
  readonly isrMetadataTable?: dynamodb.ITable;

  /**
   * Optional ISR/cache metadata table name to wire when you are not passing `isrMetadataTable`.
   *
   * Prefer `isrMetadataTable` when AppTheory should also grant access to the SSR Lambda.
   */
  readonly isrMetadataTableName?: string;

  /**
   * Legacy alias for `isrMetadataTableName`.
   * @deprecated prefer `isrMetadataTable` or `isrMetadataTableName`
   */
  readonly cacheTableName?: string;

  // When true (default), AppTheory wires recommended runtime environment variables onto the SSR function.
  readonly wireRuntimeEnv?: boolean;

  /**
   * Additional headers to forward to the SSR origin (Lambda Function URL) via the origin request policy.
   *
   * The default AppTheory/FaceTheory-safe edge contract forwards only:
   * - `cloudfront-forwarded-proto`
   * - `cloudfront-viewer-address`
   * - `x-apptheory-original-host`
   * - `x-apptheory-original-uri`
   * - `x-facetheory-original-host`
   * - `x-facetheory-original-uri`
   * - `x-request-id`
   * - `x-tenant-id`
   *
   * Use this to opt in to additional app-specific headers such as
   * `x-facetheory-tenant`. `host` and `x-forwarded-proto` are rejected because
   * they break or bypass the supported origin model.
   */
  readonly ssrForwardHeaders?: string[];

  readonly enableLogging?: boolean;
  readonly logsBucket?: s3.IBucket;

  /**
   * CloudFront response headers policy applied to SSR and direct-S3 behaviors.
   *
   * If omitted, AppTheory provisions a FaceTheory-aligned baseline policy at the CDN
   * layer: HSTS, nosniff, frame-options, referrer-policy, XSS protection, and a
   * restrictive permissions-policy. Content-Security-Policy remains origin-defined.
   */
  readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;

  /**
   * Cache policy applied to direct Lambda-backed SSR behaviors.
   *
   * The default is `CACHING_DISABLED` so dynamic Lambda routes stay safe unless you
   * intentionally opt into a cache policy that matches your app's variance model.
   * @default cloudfront.CachePolicy.CACHING_DISABLED
   */
  readonly ssrCachePolicy?: cloudfront.ICachePolicy;

  /**
   * Cache policy applied to the cacheable HTML behavior in `ssg-isr` mode.
   *
   * The default AppTheory policy keys on query strings plus the stable public HTML
   * variant headers (`x-*-original-host`, `x-tenant-id`, and any extra forwarded
   * headers you opt into) while leaving cookies out of the cache key.
   */
  readonly htmlCachePolicy?: cloudfront.ICachePolicy;

  readonly removalPolicy?: RemovalPolicy;
  readonly autoDeleteObjects?: boolean;

  readonly domainName?: string;
  readonly hostedZone?: route53.IHostedZone;
  readonly certificateArn?: string;

  readonly webAclId?: string;
}

export class AppTheorySsrSite extends Construct {
  public readonly assetsBucket: s3.IBucket;
  public readonly assetsKeyPrefix: string;
  public readonly assetsManifestKey: string;
  public readonly htmlStoreBucket?: s3.IBucket;
  public readonly htmlStoreKeyPrefix?: string;
  public readonly isrMetadataTable?: dynamodb.ITable;
  public readonly logsBucket?: s3.IBucket;
  public readonly ssrUrl: lambda.FunctionUrl;
  public readonly distribution: cloudfront.Distribution;
  public readonly certificate?: acm.ICertificate;
  public readonly responseHeadersPolicy: cloudfront.IResponseHeadersPolicy;

  constructor(scope: Construct, id: string, props: AppTheorySsrSiteProps) {
    super(scope, id);

    if (!props?.ssrFunction) {
      throw new Error("AppTheorySsrSite requires props.ssrFunction");
    }

    const siteMode = props.mode ?? AppTheorySsrSiteMode.SSR_ONLY;
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const autoDeleteObjects = props.autoDeleteObjects ?? false;
    const wireRuntimeEnv = props.wireRuntimeEnv ?? true;

    this.assetsBucket =
      props.assetsBucket ??
      new s3.Bucket(this, "AssetsBucket", {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        removalPolicy,
        autoDeleteObjects,
      });

    const enableLogging = props.enableLogging ?? true;
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

    const assetsPrefixRaw = trimRepeatedChar(String(props.assetsKeyPrefix ?? "assets").trim(), "/");
    const assetsKeyPrefix = assetsPrefixRaw || "assets";

    const manifestRaw = String(props.assetsManifestKey ?? `${assetsKeyPrefix}/manifest.json`).trim();
    const manifestKey = trimRepeatedChar(manifestRaw, "/");
    const assetsManifestKey = manifestKey || `${assetsKeyPrefix}/manifest.json`;

    this.assetsKeyPrefix = assetsKeyPrefix;
    this.assetsManifestKey = assetsManifestKey;

    const htmlStoreKeyPrefixInput = String(props.htmlStoreKeyPrefix ?? "").trim();
    const shouldConfigureHtmlStore = Boolean(props.htmlStoreBucket) || htmlStoreKeyPrefixInput.length > 0;
    if (shouldConfigureHtmlStore) {
      const htmlStorePrefixRaw = trimRepeatedChar(
        String(props.htmlStoreKeyPrefix ?? defaultIsrHtmlStoreKeyPrefix).trim(),
        "/",
      );
      this.htmlStoreKeyPrefix = htmlStorePrefixRaw || defaultIsrHtmlStoreKeyPrefix;
      this.htmlStoreBucket =
        props.htmlStoreBucket ??
        new s3.Bucket(this, "HtmlStoreBucket", {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          removalPolicy,
          autoDeleteObjects,
        });
    }

    this.isrMetadataTable = props.isrMetadataTable;

    const explicitIsrMetadataTableName = String(props.isrMetadataTableName ?? "").trim();
    const legacyCacheTableName = String(props.cacheTableName ?? "").trim();
    const resourceIsrMetadataTableName = String(this.isrMetadataTable?.tableName ?? "").trim();

    const configuredIsrMetadataTableNames = Array.from(
      new Set(
        [resourceIsrMetadataTableName, explicitIsrMetadataTableName, legacyCacheTableName].filter(
          (name) => String(name).trim().length > 0,
        ),
      ),
    );

    if (configuredIsrMetadataTableNames.length > 1) {
      throw new Error(
        `AppTheorySsrSite received conflicting ISR metadata table names: ${configuredIsrMetadataTableNames.join(", ")}`,
      );
    }

    const isrMetadataTableName = configuredIsrMetadataTableNames[0] ?? "";

    if (props.assetsPath) {
      new s3deploy.BucketDeployment(this, "AssetsDeployment", {
        sources: [s3deploy.Source.asset(props.assetsPath)],
        destinationBucket: this.assetsBucket,
        destinationKeyPrefix: assetsKeyPrefix,
        prune: true,
      });
    }

    const staticPathPatterns = normalizePathPatterns(props.staticPathPatterns);
    const directS3PathPatterns = normalizePathPatterns([
      ...(siteMode === AppTheorySsrSiteMode.SSG_ISR ? [ssgIsrHydrationPathPattern] : []),
      ...(Array.isArray(props.directS3PathPatterns) ? props.directS3PathPatterns : []),
    ]);
    const ssrPathPatterns = normalizePathPatterns(props.ssrPathPatterns);
    const behaviorPatternOwners = new Map<string, string>();
    const hasWritableLambdaSurface = siteMode === AppTheorySsrSiteMode.SSR_ONLY || ssrPathPatterns.length > 0;

    const ssrUrlAuthType =
      props.ssrUrlAuthType ??
      (hasWritableLambdaSurface ? lambda.FunctionUrlAuthType.NONE : lambda.FunctionUrlAuthType.AWS_IAM);

    this.ssrUrl = new lambda.FunctionUrl(this, "SsrUrl", {
      function: props.ssrFunction,
      authType: ssrUrlAuthType,
      invokeMode: props.invokeMode ?? lambda.InvokeMode.RESPONSE_STREAM,
    });

    const ssrOrigin =
      ssrUrlAuthType === lambda.FunctionUrlAuthType.AWS_IAM
        ? origins.FunctionUrlOrigin.withOriginAccessControl(this.ssrUrl)
        : new origins.FunctionUrlOrigin(this.ssrUrl);

    const assetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.assetsBucket);
    const htmlOriginBucket = this.htmlStoreBucket ?? this.assetsBucket;
    const htmlOrigin = origins.S3BucketOrigin.withOriginAccessControl(
      htmlOriginBucket,
      this.htmlStoreBucket && this.htmlStoreKeyPrefix
        ? {
            originPath: `/${this.htmlStoreKeyPrefix}`,
          }
        : undefined,
    );

    const baseSsrForwardHeaders = [
      "cloudfront-forwarded-proto",
      "cloudfront-viewer-address",
      ...ssrOriginalHostHeaders,
      ...ssrOriginalUriHeaders,
      "x-request-id",
      "x-tenant-id",
    ];

    const disallowedSsrForwardHeaders = new Set(["host", "x-forwarded-proto"]);

    const extraSsrForwardHeaders = Array.isArray(props.ssrForwardHeaders)
      ? props.ssrForwardHeaders
          .map((header) => String(header).trim().toLowerCase())
          .filter((header) => header.length > 0)
      : [];

    const requestedDisallowedSsrForwardHeaders = Array.from(
      new Set(extraSsrForwardHeaders.filter((header) => disallowedSsrForwardHeaders.has(header))),
    ).sort();

    if (requestedDisallowedSsrForwardHeaders.length > 0) {
      throw new Error(
        `AppTheorySsrSite disallows ssrForwardHeaders: ${requestedDisallowedSsrForwardHeaders.join(", ")}`,
      );
    }

    const ssrForwardHeaders = Array.from(
      new Set(
        [...baseSsrForwardHeaders, ...extraSsrForwardHeaders].filter(
          (header) => !disallowedSsrForwardHeaders.has(header),
        ),
      ),
    );
    const htmlCacheKeyExcludedHeaders = new Set([
      "cloudfront-forwarded-proto",
      "cloudfront-viewer-address",
      ...ssrOriginalUriHeaders,
      "x-request-id",
    ]);
    const htmlCacheKeyHeaders = Array.from(
      new Set(ssrForwardHeaders.filter((header) => !htmlCacheKeyExcludedHeaders.has(header))),
    );

    if (!props.htmlCachePolicy && htmlCacheKeyHeaders.length > maxDefaultCacheKeyHeaders) {
      throw new Error(
        `AppTheorySsrSite default htmlCachePolicy supports at most ${maxDefaultCacheKeyHeaders} cache-key headers; received ${htmlCacheKeyHeaders.length}`,
      );
    }

    const ssrOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "SsrOriginRequestPolicy", {
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...ssrForwardHeaders),
    });
    const htmlOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "HtmlOriginRequestPolicy", {
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...ssrForwardHeaders),
    });
    const ssrCachePolicy = props.ssrCachePolicy ?? cloudfront.CachePolicy.CACHING_DISABLED;
    const htmlCachePolicy =
      props.htmlCachePolicy ??
      new cloudfront.CachePolicy(this, "HtmlCachePolicy", {
        comment: "FaceTheory HTML cache policy keyed by query strings and stable public variant headers",
        minTtl: Duration.seconds(0),
        defaultTtl: Duration.seconds(0),
        maxTtl: Duration.days(365),
        cookieBehavior: cloudfront.CacheCookieBehavior.none(),
        headerBehavior: cloudfront.CacheHeaderBehavior.allowList(...htmlCacheKeyHeaders),
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
        enableAcceptEncodingBrotli: true,
        enableAcceptEncodingGzip: true,
      });

    assertNoConflictingBehaviorPatterns("direct S3 paths", [`${assetsKeyPrefix}/*`, ...directS3PathPatterns], behaviorPatternOwners);
    assertNoConflictingBehaviorPatterns("static HTML paths", staticPathPatterns, behaviorPatternOwners);
    assertNoConflictingBehaviorPatterns("direct SSR paths", ssrPathPatterns, behaviorPatternOwners);

    const viewerRequestFunction = new cloudfront.Function(this, "SsrViewerRequestFunction", {
      code: cloudfront.FunctionCode.fromInline(
        generateSsrViewerRequestFunctionCode(siteMode, [`${assetsKeyPrefix}/*`, ...directS3PathPatterns], ssrPathPatterns),
      ),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment:
        siteMode === AppTheorySsrSiteMode.SSG_ISR
          ? "FaceTheory viewer-request edge context and HTML rewrite for SSR site"
          : "FaceTheory viewer-request edge context for SSR site",
    });

    const viewerResponseFunction = new cloudfront.Function(this, "SsrViewerResponseFunction", {
      code: cloudfront.FunctionCode.fromInline(generateSsrViewerResponseFunctionCode()),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: "FaceTheory viewer-response request-id echo for SSR site",
    });

    const createEdgeFunctionAssociations = (): cloudfront.FunctionAssociation[] => [
      {
        function: viewerRequestFunction,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      },
      {
        function: viewerResponseFunction,
        eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
      },
    ];

    const domainName = String(props.domainName ?? "").trim();

    let distributionCertificate: acm.ICertificate | undefined;
    let distributionDomainNames: string[] | undefined;

    if (domainName) {
      distributionDomainNames = [domainName];
      const certArn = String(props.certificateArn ?? "").trim();
      if (certArn) {
        distributionCertificate = acm.Certificate.fromCertificateArn(this, "Certificate", certArn);
      } else if (props.hostedZone) {
        distributionCertificate = new acm.DnsValidatedCertificate(this, "Certificate", {
          domainName,
          hostedZone: props.hostedZone,
          region: "us-east-1",
        });
      } else {
        throw new Error("AppTheorySsrSite requires props.certificateArn or props.hostedZone when props.domainName is set");
      }
    }

    this.certificate = distributionCertificate;

    this.responseHeadersPolicy =
      props.responseHeadersPolicy ??
      new cloudfront.ResponseHeadersPolicy(this, "ResponseHeadersPolicy", {
        comment: "FaceTheory baseline security headers (CSP stays origin-defined)",
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(365 * 2),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          xssProtection: {
            protection: true,
            modeBlock: true,
            override: true,
          },
        },
        customHeadersBehavior: {
          customHeaders: [
            {
              header: "permissions-policy",
              value: "camera=(), microphone=(), geolocation=()",
              override: true,
            },
          ],
        },
      });

    const createStaticBehavior = (): cloudfront.BehaviorOptions => ({
      origin: assetsOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.USE_ORIGIN_CACHE_CONTROL_HEADERS,
      compress: true,
      responseHeadersPolicy: this.responseHeadersPolicy,
      functionAssociations: createEdgeFunctionAssociations(),
    });
    const createStaticHtmlBehavior = (): cloudfront.BehaviorOptions => ({
      origin: htmlOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: htmlCachePolicy,
      originRequestPolicy: htmlOriginRequestPolicy,
      compress: true,
      responseHeadersPolicy: this.responseHeadersPolicy,
      functionAssociations: createEdgeFunctionAssociations(),
    });
    const createSsrBehavior = (): cloudfront.BehaviorOptions => ({
      origin: ssrOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: ssrCachePolicy,
      originRequestPolicy: ssrOriginRequestPolicy,
      responseHeadersPolicy: this.responseHeadersPolicy,
      functionAssociations: createEdgeFunctionAssociations(),
    });

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    const addExpandedBehavior = (patterns: string[], factory: () => cloudfront.BehaviorOptions): void => {
      for (const pattern of expandBehaviorPathPatterns(patterns)) {
        additionalBehaviors[pattern] = factory();
      }
    };

    addExpandedBehavior([`${assetsKeyPrefix}/*`], createStaticBehavior);
    addExpandedBehavior(directS3PathPatterns, createStaticBehavior);
    addExpandedBehavior(staticPathPatterns, createStaticHtmlBehavior);
    addExpandedBehavior(ssrPathPatterns, createSsrBehavior);

    const defaultOrigin =
      siteMode === AppTheorySsrSiteMode.SSG_ISR
        ? new origins.OriginGroup({
            primaryOrigin: htmlOrigin,
            fallbackOrigin: ssrOrigin,
            fallbackStatusCodes: [403, 404],
          })
        : ssrOrigin;
    const defaultAllowedMethods =
      siteMode === AppTheorySsrSiteMode.SSG_ISR
        ? cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS
        : cloudfront.AllowedMethods.ALLOW_ALL;

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      ...(enableLogging && this.logsBucket
        ? { enableLogging: true, logBucket: this.logsBucket, logFilePrefix: "cloudfront/" }
        : {}),
      ...(distributionDomainNames && distributionCertificate
        ? { domainNames: distributionDomainNames, certificate: distributionCertificate }
        : {}),
      defaultBehavior: {
        origin: defaultOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: defaultAllowedMethods,
        cachePolicy: siteMode === AppTheorySsrSiteMode.SSG_ISR ? htmlCachePolicy : ssrCachePolicy,
        originRequestPolicy: siteMode === AppTheorySsrSiteMode.SSG_ISR ? htmlOriginRequestPolicy : ssrOriginRequestPolicy,
        responseHeadersPolicy: this.responseHeadersPolicy,
        functionAssociations: createEdgeFunctionAssociations(),
      },
      additionalBehaviors,
      ...(props.webAclId ? { webAclId: props.webAclId } : {}),
    });

    if (ssrUrlAuthType === lambda.FunctionUrlAuthType.AWS_IAM) {
      props.ssrFunction.addPermission("AllowCloudFrontInvokeFunctionViaUrl", {
        action: "lambda:InvokeFunction",
        principal: new iam.ServicePrincipal("cloudfront.amazonaws.com"),
        sourceArn: this.distribution.distributionArn,
        invokedViaFunctionUrl: true,
      });
    }

    if (this.htmlStoreBucket) {
      this.htmlStoreBucket.grantReadWrite(props.ssrFunction);
    }

    if (this.isrMetadataTable) {
      this.isrMetadataTable.grantReadWriteData(props.ssrFunction);
    }

    if (wireRuntimeEnv) {
      this.assetsBucket.grantRead(props.ssrFunction);

      const ssrFunctionAny = props.ssrFunction as any;
      if (typeof ssrFunctionAny.addEnvironment !== "function") {
        throw new Error(
          "AppTheorySsrSite wireRuntimeEnv requires props.ssrFunction to support addEnvironment; pass a lambda.Function or set wireRuntimeEnv=false and set env vars manually",
        );
      }

      ssrFunctionAny.addEnvironment("APPTHEORY_ASSETS_BUCKET", this.assetsBucket.bucketName);
      ssrFunctionAny.addEnvironment("APPTHEORY_ASSETS_PREFIX", assetsKeyPrefix);
      ssrFunctionAny.addEnvironment("APPTHEORY_ASSETS_MANIFEST_KEY", assetsManifestKey);

      if (this.htmlStoreBucket && this.htmlStoreKeyPrefix) {
        ssrFunctionAny.addEnvironment("FACETHEORY_ISR_BUCKET", this.htmlStoreBucket.bucketName);
        ssrFunctionAny.addEnvironment("FACETHEORY_ISR_PREFIX", this.htmlStoreKeyPrefix);
      }
      if (isrMetadataTableName) {
        ssrFunctionAny.addEnvironment("APPTHEORY_CACHE_TABLE_NAME", isrMetadataTableName);
        ssrFunctionAny.addEnvironment("FACETHEORY_CACHE_TABLE_NAME", isrMetadataTableName);
        ssrFunctionAny.addEnvironment("CACHE_TABLE_NAME", isrMetadataTableName);
        ssrFunctionAny.addEnvironment("CACHE_TABLE", isrMetadataTableName);
      }
    }

    if (domainName && props.hostedZone) {
      new route53.ARecord(this, "AliasRecord", {
        zone: props.hostedZone,
        recordName: domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution)),
      });
    }

  }
}
