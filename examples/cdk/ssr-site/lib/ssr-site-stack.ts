import * as path from "node:path";

import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import { AppTheorySsrSite } from "@theory-cloud/apptheory-cdk";

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

    const site = new AppTheorySsrSite(this, "Site", {
      ssrFunction: ssrFn,
      assetsPath: path.join(__dirname, "..", "assets"),
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new CfnOutput(this, "CloudFrontUrl", { value: `https://${site.distribution.domainName}` });
    new CfnOutput(this, "CloudFrontDistributionId", { value: site.distribution.distributionId });
    new CfnOutput(this, "AssetsBucketName", { value: site.assetsBucket.bucketName });
    new CfnOutput(this, "AssetsKeyPrefix", { value: site.assetsKeyPrefix });
    new CfnOutput(this, "AssetsManifestKey", { value: site.assetsManifestKey });
    new CfnOutput(this, "SsrFunctionUrl", { value: site.ssrUrl.url });
  }
}
