import { Fn, RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export interface AppTheorySsrSiteProps {
  readonly ssrFunction: lambda.IFunction;

  readonly invokeMode?: lambda.InvokeMode;

  readonly assetsBucket?: s3.IBucket;
  readonly assetsPath?: string;
  readonly assetsKeyPrefix?: string;
  readonly assetsManifestKey?: string;

  // Additional CloudFront path patterns to route to the static S3 origin.
  // Example (FaceTheory SSG hydration): "/_facetheory/data/*"
  readonly staticPathPatterns?: string[];

  // Optional DynamoDB table name for ISR/cache metadata owned by app code (TableTheory).
  // When set, AppTheory will wire environment variables on the SSR function.
  readonly cacheTableName?: string;

  // When true (default), AppTheory wires recommended runtime environment variables onto the SSR function.
  readonly wireRuntimeEnv?: boolean;

  // Additional headers to forward to the SSR origin (Lambda Function URL) via the origin request policy.
  // Example (FaceTheory multi-tenant): "x-facetheory-tenant"
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

    const assetsPrefixRaw = String(props.assetsKeyPrefix ?? "assets").trim().replace(/^\/+/, "").replace(/\/+$/, "");
    const assetsKeyPrefix = assetsPrefixRaw || "assets";

    const manifestRaw = String(props.assetsManifestKey ?? `${assetsKeyPrefix}/manifest.json`)
      .trim()
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    const assetsManifestKey = manifestRaw || `${assetsKeyPrefix}/manifest.json`;

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

    this.ssrUrl = new lambda.FunctionUrl(this, "SsrUrl", {
      function: props.ssrFunction,
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: props.invokeMode ?? lambda.InvokeMode.RESPONSE_STREAM,
    });

    const ssrDomainName = Fn.select(2, Fn.split("/", this.ssrUrl.url));
    const ssrOrigin = new origins.HttpOrigin(ssrDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const assetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.assetsBucket);

    const baseSsrForwardHeaders = [
      "accept",
      "accept-language",
      "cache-control",
      "host",
      "if-none-match",
      "user-agent",
      "x-forwarded-for",
      "x-forwarded-proto",
      "cloudfront-forwarded-proto",
      "cloudfront-viewer-address",
    ];

    const extraSsrForwardHeaders = Array.isArray(props.ssrForwardHeaders)
      ? props.ssrForwardHeaders
          .map((header) => String(header).trim().toLowerCase())
          .filter((header) => header.length > 0)
      : [];

    const ssrForwardHeaders = Array.from(new Set([...baseSsrForwardHeaders, ...extraSsrForwardHeaders]));

    const ssrOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "SsrOriginRequestPolicy", {
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(...ssrForwardHeaders),
    });

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
    });

    const staticPathPatterns = Array.from(
      new Set(
        Array.isArray(props.staticPathPatterns)
          ? props.staticPathPatterns
              .map((pattern) => String(pattern).trim().replace(/^\/+/, ""))
              .filter((pattern) => pattern.length > 0)
          : [],
      ),
    );

    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {
      [`${assetsKeyPrefix}/*`]: createStaticBehavior(),
    };

    for (const pattern of staticPathPatterns) {
      additionalBehaviors[pattern] = createStaticBehavior();
    }

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      ...(enableLogging && this.logsBucket
        ? { enableLogging: true, logBucket: this.logsBucket, logFilePrefix: "cloudfront/" }
        : {}),
      ...(distributionDomainNames && distributionCertificate
        ? { domainNames: distributionDomainNames, certificate: distributionCertificate }
        : {}),
      defaultBehavior: {
        origin: ssrOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: ssrOriginRequestPolicy,
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
