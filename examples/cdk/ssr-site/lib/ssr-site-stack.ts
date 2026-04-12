import * as path from "node:path";

import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
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
      assetsPath: path.join(__dirname, "..", "assets"),
      htmlStoreBucket: isrBucket,
      htmlStoreKeyPrefix: "isr",
      isrMetadataTable,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
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
