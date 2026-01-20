import * as path from "node:path";

import { CfnOutput, Duration, Fn, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export class SsrSiteStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const logsBucket = new s3.Bucket(this, "CloudFrontLogsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, "AssetsDeployment", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "..", "assets"))],
      destinationBucket: assetsBucket,
      destinationKeyPrefix: "assets",
      prune: true,
    });

    const ssrFn = new lambda.Function(this, "SsrFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      timeout: Duration.seconds(10),
      memorySize: 512,
      code: lambda.Code.fromInline(
        [
          "exports.handler = awslambda.streamifyResponse(async (_event, responseStream) => {",
          "  const stream = awslambda.HttpResponseStream.from(responseStream, {",
          "    statusCode: 200,",
          '    headers: { "content-type": "text/html; charset=utf-8" },',
          "  });",
          "  stream.write('<h1>Hello from AppTheory SSR Site</h1>');",
          "  stream.end();",
          "});",
          "",
        ].join("\n"),
      ),
    });

    const ssrUrl = ssrFn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    const ssrDomainName = Fn.select(2, Fn.split("/", ssrUrl.url));

    const ssrOrigin = new origins.HttpOrigin(ssrDomainName, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });

    const assetsOrigin = origins.S3BucketOrigin.withOriginAccessControl(assetsBucket);

    const ssrOriginRequestPolicy = new cloudfront.OriginRequestPolicy(this, "SsrOriginRequestPolicy", {
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.all(),
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
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
      ),
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      enableLogging: true,
      logBucket: logsBucket,
      logFilePrefix: "cloudfront/",
      defaultBehavior: {
        origin: ssrOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: ssrOriginRequestPolicy,
      },
      additionalBehaviors: {
        "assets/*": {
          origin: assetsOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
    });

    new CfnOutput(this, "CloudFrontUrl", { value: `https://${distribution.domainName}` });
    new CfnOutput(this, "AssetsBucketName", { value: assetsBucket.bucketName });
    new CfnOutput(this, "SsrFunctionUrl", { value: ssrUrl.url });
  }
}
