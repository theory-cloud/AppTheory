import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

import { trimRepeatedChar, trimRepeatedCharStart } from "./private/string-utils";

const ssrOriginalUriHeader = "x-apptheory-original-uri";
const ssrOriginalHostHeader = "x-apptheory-original-host";
const ssgIsrHydrationPathPattern = "/_facetheory/data/*";

export enum AppTheorySsrSiteMode {
  /**
   * Lambda Function URL is the default origin. Direct S3 behaviors are used only for
   * immutable assets and any explicitly configured static path patterns.
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

function generateSsrViewerRequestFunctionCode(mode: AppTheorySsrSiteMode, directS3PathPatterns: string[]): string {
  const directS3Prefixes = directS3PathPatterns.map(pathPatternToUriPrefix).sort((a, b) => b.length - a.length);
  const prefixList = directS3Prefixes.map((prefix) => `'${prefix}'`).join(",\n      ");

  return `
	function handler(event) {
	  var request = event.request;
	  var headers = request.headers;
	  var uri = request.uri || '/';
	  var requestIdHeader = headers['x-request-id'];
	  var requestId = requestIdHeader && requestIdHeader.value ? requestIdHeader.value.trim() : '';

	  if (!requestId) {
	    requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
	  }

	  headers['x-request-id'] = { value: requestId };
	  headers['${ssrOriginalUriHeader}'] = { value: uri };

	  if (headers.host && headers.host.value) {
	    headers['${ssrOriginalHostHeader}'] = { value: headers.host.value };
	  }

	  if ('${mode}' === '${AppTheorySsrSiteMode.SSG_ISR}') {
	    var directS3Prefixes = [
	      ${prefixList}
	    ];
	    var isDirectS3Path = false;

	    for (var i = 0; i < directS3Prefixes.length; i++) {
	      var prefix = directS3Prefixes[i];
	      if (uri === prefix || uri.startsWith(prefix + '/')) {
	        isDirectS3Path = true;
	        break;
	      }
	    }

	    if (!isDirectS3Path) {
	      var lastSlash = uri.lastIndexOf('/');
	      var lastSegment = lastSlash >= 0 ? uri.substring(lastSlash + 1) : uri;

	      if (lastSegment.indexOf('.') === -1) {
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

	  if (requestIdHeader && requestIdHeader.value) {
	    response.headers['x-request-id'] = { value: requestIdHeader.value };
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
   * AppTheory defaults this to `AWS_IAM` so CloudFront reaches the SSR origin
   * through a signed Origin Access Control path. Set `NONE` only as an explicit
   * compatibility override for legacy public Function URL deployments.
   * @default lambda.FunctionUrlAuthType.AWS_IAM
   */
  readonly ssrUrlAuthType?: lambda.FunctionUrlAuthType;

  readonly assetsBucket?: s3.IBucket;
  readonly assetsPath?: string;
  readonly assetsKeyPrefix?: string;
  readonly assetsManifestKey?: string;

  /**
   * Additional CloudFront path patterns to route directly to the S3 origin.
   *
   * In `ssg-isr` mode, `/_facetheory/data/*` is added automatically.
   * Example custom direct-S3 path: "/marketing/*"
   */
  readonly staticPathPatterns?: string[];

  // Optional DynamoDB table name for ISR/cache metadata owned by app code (TableTheory).
  // When set, AppTheory will wire environment variables on the SSR function.
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
  public readonly logsBucket?: s3.IBucket;
  public readonly ssrUrl: lambda.FunctionUrl;
  public readonly distribution: cloudfront.Distribution;
  public readonly certificate?: acm.ICertificate;

  constructor(scope: Construct, id: string, props: AppTheorySsrSiteProps) {
    super(scope, id);

    if (!props?.ssrFunction) {
      throw new Error("AppTheorySsrSite requires props.ssrFunction");
    }

    const siteMode = props.mode ?? AppTheorySsrSiteMode.SSR_ONLY;
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const autoDeleteObjects = props.autoDeleteObjects ?? false;

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
        });
    }

    const assetsPrefixRaw = trimRepeatedChar(String(props.assetsKeyPrefix ?? "assets").trim(), "/");
    const assetsKeyPrefix = assetsPrefixRaw || "assets";

    const manifestRaw = String(props.assetsManifestKey ?? `${assetsKeyPrefix}/manifest.json`).trim();
    const manifestKey = trimRepeatedChar(manifestRaw, "/");
    const assetsManifestKey = manifestKey || `${assetsKeyPrefix}/manifest.json`;

    this.assetsKeyPrefix = assetsKeyPrefix;
    this.assetsManifestKey = assetsManifestKey;

    if (props.assetsPath) {
      new s3deploy.BucketDeployment(this, "AssetsDeployment", {
        sources: [s3deploy.Source.asset(props.assetsPath)],
        destinationBucket: this.assetsBucket,
        destinationKeyPrefix: assetsKeyPrefix,
        prune: true,
      });
    }

    const ssrUrlAuthType = props.ssrUrlAuthType ?? lambda.FunctionUrlAuthType.AWS_IAM;

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

    const baseSsrForwardHeaders = [
      "cloudfront-forwarded-proto",
      "cloudfront-viewer-address",
      ssrOriginalHostHeader,
      ssrOriginalUriHeader,
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

    const ssrOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "SsrOriginRequestPolicy", {
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...ssrForwardHeaders),
    });

    const staticPathPatterns = Array.from(
      new Set(
        [
          ...(siteMode === AppTheorySsrSiteMode.SSG_ISR ? [ssgIsrHydrationPathPattern] : []),
          ...(Array.isArray(props.staticPathPatterns) ? props.staticPathPatterns : []),
        ]
          .map((pattern) => trimRepeatedCharStart(String(pattern).trim(), "/"))
          .filter((pattern) => pattern.length > 0),
      ),
    );

    const viewerRequestFunction = new cloudfront.Function(this, "SsrViewerRequestFunction", {
      code: cloudfront.FunctionCode.fromInline(
        generateSsrViewerRequestFunctionCode(siteMode, [`/${assetsKeyPrefix}/*`, ...staticPathPatterns]),
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

    const createStaticBehavior = (): cloudfront.BehaviorOptions => ({
      origin: assetsOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      compress: true,
      functionAssociations: createEdgeFunctionAssociations(),
    });

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {
      [`${assetsKeyPrefix}/*`]: createStaticBehavior(),
    };

    for (const pattern of staticPathPatterns) {
      additionalBehaviors[pattern] = createStaticBehavior();
    }

    const defaultOrigin =
      siteMode === AppTheorySsrSiteMode.SSG_ISR
        ? new origins.OriginGroup({
            primaryOrigin: assetsOrigin,
            fallbackOrigin: ssrOrigin,
            fallbackStatusCodes: [403, 404],
          })
        : ssrOrigin;

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
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: ssrOriginRequestPolicy,
        functionAssociations: createEdgeFunctionAssociations(),
      },
      additionalBehaviors,
      ...(props.webAclId ? { webAclId: props.webAclId } : {}),
    });

    if (props.wireRuntimeEnv ?? true) {
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

      const cacheTableName = String(props.cacheTableName ?? "").trim();
      if (cacheTableName) {
        ssrFunctionAny.addEnvironment("APPTHEORY_CACHE_TABLE_NAME", cacheTableName);
        ssrFunctionAny.addEnvironment("FACETHEORY_CACHE_TABLE_NAME", cacheTableName);
        ssrFunctionAny.addEnvironment("CACHE_TABLE_NAME", cacheTableName);
        ssrFunctionAny.addEnvironment("CACHE_TABLE", cacheTableName);
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
