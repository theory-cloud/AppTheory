import * as path from "node:path";

import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

import { AppTheorySsrSite, AppTheorySsrSiteMode } from "@theory-cloud/apptheory-cdk";

export class SsrSiteStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const ssrFn = new lambda.Function(this, "SsrFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      timeout: Duration.seconds(10),
      memorySize: 512,
      code: lambda.Code.fromInline(
        [
          "exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {",
          "  const path = event.rawPath || '/';",
          "  const method = event.requestContext && event.requestContext.http ? event.requestContext.http.method : 'GET';",
          "  const isAction = path.startsWith('/actions/');",
          "  const body = isAction",
          "    ? JSON.stringify({ method, path })",
          "    : '<h1>Hello from AppTheory SSR Site</h1>';",
          "  const stream = awslambda.HttpResponseStream.from(responseStream, {",
          "    statusCode: 200,",
          "    headers: isAction",
          '      ? { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" }',
          '      : { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" },',
          "  });",
          "  stream.write(body);",
          "  stream.end();",
        "});",
          "",
        ].join("\n"),
      ),
    });

    const isrBucket = new s3.Bucket(this, "IsrBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const isrMetadataTable = new dynamodb.Table(this, "IsrMetadataTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const site = new AppTheorySsrSite(this, "Site", {
      ssrFunction: ssrFn,
      mode: AppTheorySsrSiteMode.SSG_ISR,
      // This example includes public POST routes under /actions/*, so it uses a public
      // Function URL origin instead of the signed read-only Lambda origin shape.
      ssrUrlAuthType: lambda.FunctionUrlAuthType.NONE,
      assetsPath: path.join(__dirname, "..", "assets"),
      htmlStoreBucket: isrBucket,
      htmlStoreKeyPrefix: "isr",
      isrMetadataTable,
      staticPathPatterns: ["/marketing/*"],
      ssrPathPatterns: ["/actions/*"],
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, "HtmlStoreDeployment", {
      sources: [
        s3deploy.Source.data("marketing/index.html", "<h1>Marketing from AppTheory S3</h1>\n"),
        s3deploy.Source.data("marketing/about/index.html", "<h1>Marketing About from AppTheory S3</h1>\n"),
      ],
      destinationBucket: isrBucket,
      destinationKeyPrefix: "isr",
      prune: false,
    });

    new s3deploy.BucketDeployment(this, "HydrationDeployment", {
      sources: [s3deploy.Source.data("home.json", '{"route":"home"}\n')],
      destinationBucket: site.assetsBucket,
      destinationKeyPrefix: "_facetheory/data",
      prune: false,
    });

    new CfnOutput(this, "CloudFrontUrl", { value: `https://${site.distribution.domainName}` });
    new CfnOutput(this, "CloudFrontDistributionId", { value: site.distribution.distributionId });
    new CfnOutput(this, "AssetsBucketName", { value: site.assetsBucket.bucketName });
    new CfnOutput(this, "AssetsKeyPrefix", { value: site.assetsKeyPrefix });
    new CfnOutput(this, "AssetsManifestKey", { value: site.assetsManifestKey });
    new CfnOutput(this, "IsrBucketName", { value: isrBucket.bucketName });
    new CfnOutput(this, "IsrMetadataTableName", { value: isrMetadataTable.tableName });
    new CfnOutput(this, "SsrFunctionUrl", { value: site.ssrUrl.url });
  }
}
