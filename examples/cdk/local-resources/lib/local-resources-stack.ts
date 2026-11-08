import path from "node:path";

import * as cdk from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as customResources from "aws-cdk-lib/custom-resources";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";
import { Trigger } from "aws-cdk-lib/triggers";
import { Construct } from "constructs";

/**
 * The resource-type example.
 *
 * It declares every family the runner has to handle for a real application:
 *
 *   - a `Custom::Trigger` (a deploy-time invocation of a function),
 *   - a provider-framework custom resource (`Custom::EnvMigration`),
 *   - a `Custom::AWS` SDK call (an SES receipt rule set created through the
 *     AWS SDK, the shape TMS uses),
 *   - a bucket auto-delete handler (`Custom::S3AutoDeleteObjects`),
 *   - an SES receipt rule with an S3 action and a Lambda action,
 *   - the deploy-time-only resources the runner reports (a custom domain, a
 *     certificate, a Route 53 record, a CloudWatch alarm) and the MicroVM types
 *     it refuses.
 */

// The provider-framework handler: it reads the CloudFormation request, runs its
// migration (a DynamoDB-free stand-in that records the version it saw) and
// reports its result by PUTting the documented response document to the
// request's ResponseURL.
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html
const migrationProviderCode = `
const https = require("https");
const url = require("url");

exports.handler = async (event) => {
  console.log(JSON.stringify({ requestType: event.RequestType, logicalId: event.LogicalResourceId }));
  const version = event.ResourceProperties.MigrationVersion || "0";
  const response = {
    Status: "SUCCESS",
    Reason: "the local provider framework handler ran",
    PhysicalResourceId: event.PhysicalResourceId || "env-migration-" + version,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: { MigrationVersion: version, RanAt: new Date().toISOString() },
  };
  await new Promise((resolve, reject) => {
    const target = url.parse(event.ResponseURL);
    const body = JSON.stringify(response);
    const request = https.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.path,
        method: "PUT",
        headers: { "content-type": "", "content-length": Buffer.byteLength(body) },
      },
      (answer) => {
        answer.resume();
        answer.statusCode && answer.statusCode >= 400 ? reject(new Error("response status " + answer.statusCode)) : resolve();
      },
    );
    request.on("error", reject);
    request.write(body);
    request.end();
  });
  return response;
};
`;

// The trigger target: it records that the deploy-time trigger fired.
// https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.triggers-readme.html
const triggerTargetCode = `
exports.handler = async (event) => {
  console.log(JSON.stringify({ trigger: "genome-propagation", payload: event || {} }));
  return { propagated: true, at: new Date().toISOString() };
};
`;

export class LocalResourcesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps = {}) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, "AutoDeleteBucket", {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const rawMail = new s3.Bucket(this, "RawMailBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const triggerTarget = new lambda.Function(this, "TriggerTarget", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "Custom::Trigger target: reports that the deploy-time trigger fired",
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(triggerTargetCode),
    });

    // A real Custom::Trigger. The construct synthesizes the provider function
    // and a Custom::Trigger resource whose ServiceToken is that function.
    new Trigger(this, "DeployTrigger", {
      handler: triggerTarget,
      executeOnHandlerChange: true,
      timeout: cdk.Duration.seconds(60),
    });

    const provider = new lambda.Function(this, "MigrationProvider", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      description: "Provider-framework custom resource handler",
      timeout: cdk.Duration.seconds(60),
      code: lambda.Code.fromInline(migrationProviderCode),
    });
    new cdk.CustomResource(this, "EnvMigration", {
      resourceType: "Custom::EnvMigration",
      serviceToken: provider.functionArn,
      properties: { MigrationVersion: "1" },
    });

    // A Custom::AWS SDK call, the shape TMS synthesizes for its SES rule set.
    // The pinned moto implements createReceiptRuleSet, so the handler's SDK
    // call reaches a real local answer.
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources-readme.html
    const ruleSet = new customResources.AwsCustomResource(this, "EnsureRuleSet", {
      onCreate: {
        service: "SES",
        action: "createReceiptRuleSet",
        parameters: { RuleSetName: "local-resources-mail" },
        physicalResourceId: customResources.PhysicalResourceId.of("rule-set-local-resources-mail"),
        ignoreErrorCodesMatching: ".*AlreadyExists.*",
      },
      policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: customResources.AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    ruleSet.node.addDependency(provider);

    const mailHandler = new lambda.Function(this, "MailHandler", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      description: "SES receipt-rule Lambda action: renders the received-message record",
      timeout: cdk.Duration.seconds(20),
      environment: { APPTHEORY_LOCAL_RESOURCES_ROLE: "mail" },
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "go"), {
        bundling: {
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
              const { execSync } = require("node:child_process");
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
        },
      }),
    });

    // A receipt rule with the two actions the runner serves: the raw message
    // lands in the bucket and the Lambda action receives the documented record.
    const ruleSetResource = new ses.ReceiptRuleSet(this, "ReceiptRuleSet", {
      receiptRuleSetName: "local-resources-mail",
    });
    ruleSetResource.addRule("Inbound", {
      recipients: ["ingress@local-resources.test"],
      actions: [
        new sesActions.S3({ bucket: rawMail, objectKeyPrefix: "mail/" }),
        new sesActions.Lambda({ function: mailHandler, invocationType: sesActions.LambdaInvocationType.EVENT }),
      ],
      scanEnabled: true,
      enabled: true,
    });

    // An SES identity: a deploy-time-only type the runner reports.
    new ses.EmailIdentity(this, "MailIdentity", {
      identity: ses.Identity.domain("local-resources.test"),
    });

    // The API the mail handler's state is read through, so the row can assert
    // what the handler recorded without a session-only shortcut.
    const api = new apigw.RestApi(this, "StateApi", { restApiName: "local-resources" });
    api.root.addResource("state").addMethod("GET", new apigw.LambdaIntegration(mailHandler), {
      authorizationType: apigw.AuthorizationType.NONE,
    });

    // Deploy-time-only resources: the runner reports each with a docs/125
    // true-limit reason instead of silently ignoring it.
    new cdk.CfnResource(this, "ReportedDomain", {
      type: "AWS::ApiGateway::DomainName",
      properties: {
        DomainName: "api.local-resources.test",
        EndpointConfiguration: { Types: ["REGIONAL"] },
      },
    });
    new cdk.CfnResource(this, "ReportedCertificate", {
      type: "AWS::CertificateManager::Certificate",
      properties: { DomainName: "api.local-resources.test", ValidationMethod: "DNS" },
    });
    new cdk.CfnResource(this, "ReportedRecord", {
      type: "AWS::Route53::RecordSet",
      properties: {
        HostedZoneName: "local-resources.test.",
        Name: "api.local-resources.test.",
        Type: "A",
        TTL: "60",
        ResourceRecords: ["127.0.0.1"],
      },
    });
    new cdk.CfnResource(this, "ReportedAlarm", {
      type: "AWS::CloudWatch::Alarm",
      properties: {
        AlarmName: "local-resources-mail-handler-errors",
        ComparisonOperator: "GreaterThanThreshold",
        EvaluationPeriods: 1,
        MetricName: "Errors",
        Namespace: "AWS/Lambda",
        Period: 300,
        Statistic: "Sum",
        Threshold: 0,
      },
    });

    // The MicroVM managed provider: a docs/125 true limit the runner refuses by
    // name, including the custom resource that supports the image.
    const microvmImage = new cdk.CfnResource(this, "RefusedMicrovmImage", {
      type: "AWS::Lambda::MicrovmImage",
      properties: { Name: "local-resources-refused" },
    });
    const prune = new cdk.CfnCustomResource(this, "RefusedMicrovmPrune", {
      serviceToken: provider.functionArn,
    });
    prune.addPropertyOverride("MicrovmImageName", microvmImage.ref);

    new cdk.CfnOutput(this, "AutoDeleteBucketName", { value: bucket.bucketName });
    new cdk.CfnOutput(this, "RawMailBucketName", { value: rawMail.bucketName });
    new cdk.CfnOutput(this, "StateApiId", { value: api.restApiId });

    // The mail handler reads the bucket and table names from its environment.
    mailHandler.addEnvironment("RAW_MAIL_BUCKET", rawMail.bucketName);
    mailHandler.addEnvironment("AUTO_DELETE_BUCKET", bucket.bucketName);
    mailHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [bucket.bucketArn, bucket.bucketArn + "/*", rawMail.bucketArn, rawMail.bucketArn + "/*"],
      }),
    );
  }
}
