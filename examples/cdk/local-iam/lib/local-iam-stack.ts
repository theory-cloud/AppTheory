import path from "node:path";

import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Construct } from "constructs";

/**
 * The local IAM example: one REST API, one HTTP API and one Function URL whose
 * calls are authorized by AWS_IAM, plus the roles a local run must resolve.
 *
 * Every route is a real gateway route with a real authorization type; the local
 * runner verifies the Signature Version 4 signature, resolves the caller
 * principal and evaluates the API's resource policy and the caller's identity
 * policies under AWS's combination rule.
 *
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html
 */
export class LocalIamStack extends cdk.Stack {
  public readonly callerRole: iam.Role;
  public readonly otherRole: iam.Role;
  public readonly vendingRole: iam.Role;

  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, props);

    const account = this.account;

    const identityCode = [
      "exports.handler = async (event) => {",
      "  const context = event.requestContext || {};",
      "  const identity = context.identity || {};",
      "  const authorizer = context.authorizer || {};",
      "  const iam = authorizer.iam || {};",
      "  return {",
      '    statusCode: 200,',
      '    headers: { "content-type": "application/json" },',
      "    body: JSON.stringify({",
      '      route: event.routeKey || event.httpMethod || "function-url",',
      "      caller: identity.caller || iam.callerId || null,",
      "      userArn: identity.userArn || iam.userArn || null,",
      "      accountId: identity.accountId || iam.accountId || null,",
      "      accessKey: identity.accessKey || iam.accessKey || null,",
      "      accountIdHeader: context.accountId || null,",
      "    }),",
      "  };",
      "};",
    ].join("\n");

    const identityFn = new lambda.Function(this, "IdentityFn", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "Identity echo: reports the caller the gateway resolved",
      timeout: cdk.Duration.seconds(10),
      code: lambda.Code.fromInline(identityCode),
    });

    // The caller role signs execute-api and Function URL calls with the
    // credentials the local run issues it. Its identity policy is the only
    // grant the identity-policy-only route has.
    this.callerRole = new iam.Role(this, "CallerRole", {
      roleName: "local-iam-caller",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    this.otherRole = new iam.Role(this, "OtherRole", {
      roleName: "local-iam-other",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    // A role a caller assumes through STS. Its trust policy alone decides the
    // AssumeRole locally; its identity policy is what the assumed session then
    // uses for the call it makes.
    this.vendingRole = new iam.Role(this, "VendingRole", {
      roleName: "local-iam-vending",
      assumedBy: new iam.AccountPrincipal(account),
    });

    const goBundle = {
      image: lambda.Runtime.PROVIDED_AL2023.bundlingImage,
      command: [
        "bash",
        "-c",
        [
          "set -euo pipefail",
          "cd /asset-input",
          "GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /asset-output/bootstrap .",
        ].join(" && "),
      ],
      local: {
        tryBundle(outputDir: string) {
          execSync(
            `go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o ${JSON.stringify(path.join(outputDir, "bootstrap"))} .`,
            {
              cwd: path.join(__dirname, "..", "handlers", "go"),
              stdio: "inherit",
              env: { ...process.env, GOOS: "linux", GOARCH: "arm64", CGO_ENABLED: "0" },
            },
          );
          return true;
        },
      },
    };

    // A second caller bound to the role no statement grants, which is what the
    // wrong-principal row signs with.
    const callerOther = new lambda.Function(this, "CallerOther", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      role: this.otherRole,
      timeout: cdk.Duration.seconds(30),
      environment: { APPTHEORY_LOCAL_IAM_ROLE: "caller-other" },
      description: "A caller bound to a role no policy grants",
      code: lambda.Code.fromInline(
        readFileSync(path.join(__dirname, "..", "handlers", "node", "caller.js"), "utf8"),
      ),
    });

    const identityIntegration = new apigw.LambdaIntegration(identityFn);
    const api = new apigw.RestApi(this, "IamApi", {
      restApiName: "local-iam",
      deployOptions: { stageName: "lab" },
    });

    const route = (pathPart: string, method: string, auth: apigw.AuthorizationType = apigw.AuthorizationType.IAM) => {
      const resource = api.root.addResource(pathPart);
      resource.addMethod(method, identityIntegration, { authorizationType: auth });
      return resource;
    };

    route("open", "GET", apigw.AuthorizationType.NONE);
    route("protected", "GET");
    route("identity-only", "GET");
    route("root", "GET");
    route("conditioned", "GET");
    route("denied", "GET");
    route("outside", "GET");
    route("vending", "GET");
    const pathResource = api.root.addResource("path");
    const idResource = pathResource.addResource("{id}");
    idResource.addMethod("GET", identityIntegration, { authorizationType: apigw.AuthorizationType.IAM });

    // Every resource a policy names is the exact ARN the run builds: the API id
    // is the template's Ref, which the local resolver maps to the same id the
    // verifier compares.
    const routeARN = (stage: string, method: string, routePath: string) =>
      `arn:aws:execute-api:${this.region}:${account}:${api.restApiId}/${stage}/${method}/${routePath}`;

    this.vendingRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [routeARN("lab", "GET", "vending")],
      }),
    );

    const callerGo = new lambda.Function(this, "CallerGo", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      role: this.callerRole,
      timeout: cdk.Duration.seconds(30),
      environment: { APPTHEORY_LOCAL_IAM_ROLE: "caller-go" },
      description: "Go caller: signs an execute-api call with the AWS SDK for Go v2",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "go"), { bundling: goBundle }),
    });

    // The nodejs24.x image carries the AWS SDK for JavaScript v3 under
    // /var/runtime/node_modules, which is not on a /var/task handler's
    // resolution path; NODE_PATH is how the image exposes it, and the handler
    // also requires the SDK by that absolute path.
    const callerNode = new lambda.Function(this, "CallerNode", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      role: this.callerRole,
      timeout: cdk.Duration.seconds(30),
      environment: {
        APPTHEORY_LOCAL_IAM_ROLE: "caller-node",
      },
      description: "Node caller: signs an execute-api call with the AWS SDK for JavaScript v3",
      // The handler is inline: the file in handlers/node is the source of
      // truth and the CDK app inlines it, which is how the local runner
      // materializes a Node handler it can start.
      code: lambda.Code.fromInline(
        readFileSync(path.join(__dirname, "..", "handlers", "node", "caller.js"), "utf8"),
      ),
    });

    const callerPython = new lambda.Function(this, "CallerPython", {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "caller.handler",
      role: this.callerRole,
      timeout: cdk.Duration.seconds(30),
      environment: { APPTHEORY_LOCAL_IAM_ROLE: "caller-py" },
      description: "Python caller: signs an execute-api call with botocore's SigV4Auth",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "python"), {
        exclude: ["__pycache__", "**/__pycache__", "*.pyc", "**/*.pyc"],
      }),
    });

    // The API's resource policy is the one policy kind a REST API carries. Each
    // statement names the exact shape the local subset evaluates.
    api.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        principals: [new iam.ArnPrincipal(this.callerRole.roleArn)],
        resources: ["execute-api:/lab/GET/protected"],
      }),
    );
    api.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        principals: [new iam.AccountRootPrincipal()],
        resources: ["execute-api:/lab/GET/root"],
      }),
    );
    api.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        principals: [new iam.AccountRootPrincipal()],
        resources: ["execute-api:/lab/GET/conditioned"],
        conditions: { StringEquals: { "aws:PrincipalArn": this.callerRole.roleArn } },
      }),
    );
    api.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        principals: [new iam.AccountRootPrincipal()],
        resources: ["execute-api:/lab/GET/path/*"],
      }),
    );
    api.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ["execute-api:Invoke"],
        principals: [new iam.ArnPrincipal(this.callerRole.roleArn)],
        resources: ["execute-api:/lab/GET/denied"],
      }),
    );
    api.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        principals: [new iam.AccountRootPrincipal()],
        resources: ["execute-api:/lab/GET/outside"],
        conditions: { StringLike: { "aws:PrincipalArn": this.callerRole.roleArn } },
      }),
    );

    // The caller's identity policy: the identity-policy-only route has no
    // resource statement, so only this grant can allow it.
    this.callerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [routeARN("lab", "GET", "identity-only")],
      }),
    );

    // An HTTP API route authorized by AWS_IAM. An HTTP API carries no resource
    // policy, so the caller's identity policy is what allows it.
    // The L2 HttpRoute construct models a CUSTOM or JWT authorizer, not
    // AWS_IAM, so the route and its integration are declared with the resource
    // types a real template carries: an AWS::ApiGatewayV2::Route whose
    // AuthorizationType is AWS_IAM.
    // https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-apigatewayv2-route.html
    const httpApi = new apigwv2.HttpApi(this, "IamHttpApi", { apiName: "local-iam-http" });
    const httpIntegration = new apigwv2.CfnIntegration(this, "HttpIamIntegration", {
      apiId: httpApi.apiId,
      integrationType: "AWS_PROXY",
      integrationUri:
        `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/` +
        `${identityFn.functionArn}/invocations`,
      payloadFormatVersion: "2.0",
    });
    new apigwv2.CfnRoute(this, "HttpIamRoute", {
      apiId: httpApi.apiId,
      routeKey: "GET /http-iam",
      authorizationType: "AWS_IAM",
      target: `integrations/${httpIntegration.ref}`,
    });
    identityFn.addPermission("HttpIamInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${account}:${httpApi.apiId}/*`,
    });
    this.callerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["execute-api:Invoke"],
        resources: [
          `arn:aws:execute-api:${this.region}:${account}:${httpApi.apiId}/$default/GET/http-iam`,
        ],
      }),
    );

    // An AWS_IAM Function URL. Lambda requires both lambda:InvokeFunctionUrl and
    // lambda:InvokeFunction, granted either in the caller's identity policy or
    // in the function's resource-based policy.
    // https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
    const urlFn = new lambda.Function(this, "UrlFn", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "AWS_IAM Function URL target",
      timeout: cdk.Duration.seconds(10),
      code: lambda.Code.fromInline(identityCode),
    });
    const fnUrl = urlFn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    urlFn.addPermission("UrlInvokeUrl", {
      principal: new iam.AccountPrincipal(account),
      action: "lambda:InvokeFunctionUrl",
      functionUrlAuthType: lambda.FunctionUrlAuthType.AWS_IAM,
    });
    urlFn.addPermission("UrlInvokeFunction", {
      principal: new iam.AccountPrincipal(account),
      action: "lambda:InvokeFunction",
    });
    this.callerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunctionUrl", "lambda:InvokeFunction"],
        resources: [urlFn.functionArn],
      }),
    );

    new cdk.CfnOutput(this, "IamApiId", { value: api.restApiId });
    new cdk.CfnOutput(this, "IamApiStage", { value: api.deploymentStage.stageName });
    new cdk.CfnOutput(this, "FunctionUrlHost", { value: cdk.Fn.select(2, cdk.Fn.split("/", fnUrl.url)) });
    new cdk.CfnOutput(this, "CallerRoleArn", { value: this.callerRole.roleArn });
    new cdk.CfnOutput(this, "OtherRoleArn", { value: this.otherRole.roleArn });
    new cdk.CfnOutput(this, "VendingRoleArn", { value: this.vendingRole.roleArn });
    new cdk.CfnOutput(this, "VendCallerOther", { value: callerOther.functionName });
    new cdk.CfnOutput(this, "VendCallerGo", { value: callerGo.functionName });
    new cdk.CfnOutput(this, "VendCallerNode", { value: callerNode.functionName });
    new cdk.CfnOutput(this, "VendCallerPy", { value: callerPython.functionName });
  }
}
