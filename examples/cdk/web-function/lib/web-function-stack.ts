import * as path from "node:path";

import { AppTheoryWebFunction } from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

/**
 * Two Web Functions over one application, so both sides of the endpoint authorization decision
 * are visible in one synthesized stack.
 *
 * The application in `app/` starts its own HTTP server and reads AWS_LAMBDA_HTTP_ENDPOINT for the
 * address to listen on. Nothing here sets that variable: the Lambda service does.
 */
export class WebFunctionStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const code = lambda.WebFunctionCode.fromAssetToManagedBucket(path.join(__dirname, "..", "app"));

    // The default: the endpoint requires IAM authorization. Requests must be SigV4-signed (with
    // X-Amz-Content-SHA256, even without a body), so this is the shape to deploy.
    const privateFunction = new AppTheoryWebFunction(this, "Private", {
      code,
      runtime: lambda.WebFunctionRuntime.NODEJS_24_X,
      entryPoint: "server.mjs",
      description: "AppTheory Web Function example, IAM-authorized endpoint",
      endpoint: {
        endpointName: "private",
        description: "IAM-authorized endpoint: every request must be SigV4-signed",
      },
    });

    // The explicit opt-in. `APPLICATION_MANAGED` makes the endpoint public and leaves
    // authorization to the application, and aws-cdk-lib warns about it at synthesis time:
    //
    //   WebFunction endpoint uses APPLICATION_MANAGED auth. The Lambda service will not enforce
    //   authentication; ensure your handler code validates every request.
    //
    // The example application below performs no authentication of its own, which is exactly why
    // this endpoint is the documented wrong place to expose anything but a demonstration.
    const publicFunction = new AppTheoryWebFunction(this, "Public", {
      code,
      runtime: lambda.WebFunctionRuntime.NODEJS_24_X,
      entryPoint: "server.mjs",
      description: "AppTheory Web Function example, application-managed endpoint",
      authType: lambda.WebFunctionAuthType.APPLICATION_MANAGED,
      endpoint: {
        endpointName: "public",
        description: "Application-managed endpoint: public, and this application authenticates nothing",
      },
    });

    new CfnOutput(this, "PrivateDomainName", { value: privateFunction.domainName });
    new CfnOutput(this, "PrivateRevisionId", { value: privateFunction.revisionId });
    new CfnOutput(this, "PrivateEndpointAuthType", {
      value: privateFunction.endpoint.authType,
    });
    new CfnOutput(this, "PublicDomainName", { value: publicFunction.domainName });
    new CfnOutput(this, "PublicRevisionId", { value: publicFunction.revisionId });
    new CfnOutput(this, "PublicEndpointAuthType", {
      value: publicFunction.endpoint.authType,
    });
  }
}
