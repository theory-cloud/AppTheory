import { execSync } from "node:child_process";
import * as path from "node:path";

import {
  AppTheoryCloudWatchLogsDestination,
  AppTheoryFunction,
  AppTheoryKinesisStream,
  AppTheoryKinesisStreamMapping,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
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
      image: cdk.DockerImage.fromRegistry("golang:1.26"),
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

    const consumer = new AppTheoryFunction(this, "LogsConsumer", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: goBootstrapCode(path.join(__dirname, "..", "handlers", "go")),
      timeout: cdk.Duration.seconds(30),
      environment: {
        APPTHEORY_KINESIS_STREAM_NAME: logsStream.streamName,
      },
    });

    new AppTheoryKinesisStreamMapping(this, "LogsConsumerMapping", {
      stream: logsStream.stream,
      consumer: consumer.fn,
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

    const subscription = new logs.CfnSubscriptionFilter(this, "ExampleSubscriptionFilter", {
      logGroupName: sourceLogGroup.logGroupName,
      destinationArn: destination.destinationArn,
      filterName: "apptheory-example-all-events",
      filterPattern: "",
      distribution: "ByLogStream",
    });
    subscription.addDependency(destination.destination);

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
