import { execSync } from "node:child_process";
import * as path from "node:path";

import {
  AppTheoryCloudWatchLogsDestination,
  AppTheoryCloudWatchLogsSubscription,
  AppTheoryFunction,
  AppTheoryKinesisStream,
  AppTheoryKinesisStreamMapping,
  AppTheoryKmsKey,
  AppTheoryQueue,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";

const exampleSourceAccountId = "111122223333";
const exampleOrganizationId = "o-example1234";
const exampleStreamName = "apptheory-example-cloudwatch-logs";
const exampleDestinationName = "apptheory-example-cloudwatch-logs";
const exampleSourceLogGroupName = "/aws/apptheory/example/cloudwatch-logs-source";

function goBootstrapCode(handlerDir: string): lambda.Code {
  return lambda.Code.fromAsset(handlerDir, {
    bundling: {
      image: cdk.DockerImage.fromRegistry("golang:1.27"),
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
            "go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o " +
              path.join(outputDir, "bootstrap") +
              " .",
            {
              cwd: handlerDir,
              stdio: "inherit",
              env: {
                ...process.env,
                GOOS: "linux",
                GOARCH: "arm64",
                CGO_ENABLED: "0",
              },
            },
          );
          return true;
        },
      },
    },
  });
}

/**
 * Example stack for CloudWatch Logs -> Kinesis -> AppTheory Lambda.
 *
 * The account and organization IDs are deterministic placeholders used only so
 * the example can synthesize repeatably. Replace them before deployment.
 */
export class KinesisCloudWatchLogsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const logsStream = new AppTheoryKinesisStream(this, "LogsStream", {
      streamName: exampleStreamName,
      retentionPeriod: cdk.Duration.hours(24),
    });

    const consumerReceipts = new AppTheoryQueue(this, "ConsumerReceipts", {
      queueName: "kinesis-consumer-receipts",
      enableDlq: false,
    });
    const consumer = new AppTheoryFunction(this, "LogsConsumer", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: goBootstrapCode(path.join(__dirname, "..", "handlers", "go")),
      timeout: cdk.Duration.seconds(30),
      environment: {
        APPTHEORY_KINESIS_STREAM_NAME: logsStream.streamName,
        APPTHEORY_KINESIS_STREAM_ARN: logsStream.stream.streamArn,
        RECEIPT_QUEUE_URL: consumerReceipts.queueUrl,
      },
    });
    consumerReceipts.grantSendMessages(consumer.fn);

    // A Lambda target for the consumer's own function log. The runner captures
    // the container's stdout/stderr into /aws/lambda/<function name>; this
    // subscription filter delivers that real invocation output to the tap.
    const logTapReceipts = new AppTheoryQueue(this, "LogTapReceipts", {
      queueName: "kinesis-logtap-receipts",
      enableDlq: false,
    });
    const logTap = new AppTheoryFunction(this, "LogTapFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: goBootstrapCode(path.join(__dirname, "..", "handlers", "logtap")),
      timeout: cdk.Duration.seconds(30),
      environment: {
        RECEIPT_QUEUE_URL: logTapReceipts.queueUrl,
      },
    });
    logTapReceipts.grantSendMessages(logTap.fn);
    new AppTheoryCloudWatchLogsSubscription(this, "ConsumerLogSubscription", {
      logGroup: consumer.fn.logGroup,
      destinationArn: logTap.fn.functionArn,
      filterName: "apptheory-consumer-output",
      filterPatternText: "",
    });

    // An asymmetric SIGN_VERIFY key proves KMS Sign, Verify and GetPublicKey
    // through the local runner; the alias is used as the KeyId, which KMS
    // documents as an accepted key identifier.
    const signingKey = new AppTheoryKmsKey(this, "SigningKey", {
      description: "AppTheory local signing key",
      aliasName: "alias/apptheory-local-signing",
      keySpec: kms.KeySpec.RSA_2048,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
    });

    new AppTheoryFunction(this, "SigningFunction", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: goBootstrapCode(path.join(__dirname, "..", "handlers", "signing")),
      timeout: cdk.Duration.seconds(30),
      environment: {
        SIGNING_KEY_ARN: signingKey.keyArn,
        SIGNING_KEY_ALIAS: signingKey.alias?.aliasName ?? "",
      },
    });

    new AppTheoryKinesisStreamMapping(this, "LogsConsumerMapping", {
      stream: logsStream.stream,
      consumer: consumer.fn,
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 100,
      maxBatchingWindow: cdk.Duration.seconds(5),
      retryAttempts: 2,
      bisectBatchOnError: true,
      reportBatchItemFailures: true,
    });

    const destination = new AppTheoryCloudWatchLogsDestination(this, "LogsDestination", {
      stream: logsStream.stream,
      destinationName: exampleDestinationName,
      allowedSourceAccounts: [exampleSourceAccountId],
      allowedOrganizationIds: [exampleOrganizationId],
    });

    const sourceLogGroup = new logs.LogGroup(this, "ExampleSourceLogGroup", {
      logGroupName: exampleSourceLogGroupName,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const subscription = new AppTheoryCloudWatchLogsSubscription(this, "ExampleSubscriptionFilter", {
      logGroup: sourceLogGroup,
      destinationArn: destination.destinationArn,
      filterName: "apptheory-example-all-events",
      filterPatternText: "",
      distribution: logs.Distribution.BY_LOG_STREAM,
    });
    subscription.subscriptionFilter.addResourceDependency(destination.destination);

    new cdk.CfnOutput(this, "KinesisStreamName", {
      value: logsStream.streamName,
      description: "Kinesis stream receiving CloudWatch Logs subscription records",
    });

    new cdk.CfnOutput(this, "CloudWatchLogsDestinationArn", {
      value: destination.destinationArn,
      description: "CloudWatch Logs destination for explicit placeholder source allowlists",
    });

    new cdk.CfnOutput(this, "ConsumerFunctionName", {
      value: consumer.fn.functionName,
      description: "AppTheory Lambda that decodes CloudWatch Logs records from Kinesis",
    });

    new cdk.CfnOutput(this, "ExampleSourceLogGroupName", {
      value: sourceLogGroup.logGroupName,
      description: "Placeholder source log group wired to the destination in this example stack",
    });
  }
}
