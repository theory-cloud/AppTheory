import * as path from "node:path";

import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

import { AppTheorySsrSite, AppTheorySsrSiteMode } from "@theory-cloud/apptheory-cdk";

const assetsKeyPrefix = "assets";
const knownJsAssetKey = `${assetsKeyPrefix}/app.js`;
const knownCssAssetKey = `${assetsKeyPrefix}/site.css`;
const knownTextAssetKey = `${assetsKeyPrefix}/probe.txt`;

export class SsrOnlyProvidedAssetsSiteStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const providedAssetsBucket = new s3.Bucket(this, "ProvidedAssetsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const ssrFn = new lambda.Function(this, "SsrFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      timeout: Duration.seconds(10),
      memorySize: 512,
      code: lambda.Code.fromInline(
        [
          "exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {",
          "  const headers = event.headers || {};",
          "  const requestId = headers['x-request-id'] || headers['X-Request-Id'] || '';",
          "  const html = [",
          "    '<!doctype html>',",
          "    '<html lang=\"en\">',",
          "    '<head>',",
          "    '  <meta charset=\"utf-8\">',",
          "    '  <title>AppTheory SSR_ONLY provided assets</title>',",
          "    '  <link rel=\"stylesheet\" href=\"/assets/site.css\">',",
          "    '</head>',",
          "    '<body>',",
          "    '  <h1>AppTheory SSR_ONLY provided assets</h1>',",
          "    '  <p id=\"request-id\">' + requestId + '</p>',",
          "    '  <script type=\"module\" src=\"/assets/app.js\"></script>',",
          "    '</body>',",
          "    '</html>',",
          "  ].join('\\n');",
          "  const stream = awslambda.HttpResponseStream.from(responseStream, {",
          "    statusCode: 200,",
          "    headers: {",
          "      'content-type': 'text/html; charset=utf-8',",
          "      'cache-control': 'private, no-store',",
          "    },",
          "  });",
          "  stream.write(html);",
          "  stream.end();",
          "});",
          "",
        ].join("\n"),
      ),
    });

    const site = new AppTheorySsrSite(this, "Site", {
      ssrFunction: ssrFn,
      mode: AppTheorySsrSiteMode.SSR_ONLY,
      // Deliberately omit ssrUrlAuthType: the AppTheory default remains AWS_IAM
      // and CloudFront reaches the Lambda Function URL through Lambda OAC.
      assetsBucket: providedAssetsBucket,
      assetsKeyPrefix,
      // Deliberately omit assetsPath. This example proves the provided-bucket path:
      // assets are deployed below, outside AppTheorySsrSite, into the stack-owned bucket.
      // The smoke stack disables CloudFront logging so late log delivery cannot race
      // bucket auto-delete during deterministic example cleanup.
      enableLogging: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, "ProvidedAssetsDeployment", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "..", "assets"))],
      destinationBucket: providedAssetsBucket,
      destinationKeyPrefix: assetsKeyPrefix,
      prune: false,
    });

    new CfnOutput(this, "AppTheorySsrSiteMode", { value: AppTheorySsrSiteMode.SSR_ONLY });
    new CfnOutput(this, "AppTheorySsrSiteModeName", { value: "SSR_ONLY" });
    new CfnOutput(this, "CloudFrontDomainName", { value: site.distribution.domainName });
    new CfnOutput(this, "CloudFrontUrl", { value: `https://${site.distribution.domainName}` });
    new CfnOutput(this, "CloudFrontDistributionId", { value: site.distribution.distributionId });
    new CfnOutput(this, "AssetsBucketName", { value: providedAssetsBucket.bucketName });
    new CfnOutput(this, "AssetsKeyPrefix", { value: site.assetsKeyPrefix });
    new CfnOutput(this, "KnownJsAssetKey", { value: knownJsAssetKey });
    new CfnOutput(this, "KnownJsAssetPath", { value: `/${knownJsAssetKey}` });
    new CfnOutput(this, "KnownCssAssetKey", { value: knownCssAssetKey });
    new CfnOutput(this, "KnownCssAssetPath", { value: `/${knownCssAssetKey}` });
    new CfnOutput(this, "KnownTextAssetKey", { value: knownTextAssetKey });
    new CfnOutput(this, "KnownTextAssetPath", { value: `/${knownTextAssetKey}` });
    new CfnOutput(this, "SsrFunctionUrlAuthType", { value: "AWS_IAM" });
  }
}
