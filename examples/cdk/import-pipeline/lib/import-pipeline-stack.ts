import { execSync } from "node:child_process";
import * as path from "node:path";

import {
  AppTheoryCodeBuildJobRunner,
  AppTheoryEventBridgeRuleTarget,
  AppTheoryFunction,
  AppTheoryJobsTable,
  AppTheoryQueue,
  AppTheoryQueueConsumer,
  AppTheoryS3Ingest,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

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

export class ImportPipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const tenantId = "demo";

    const jobs = new AppTheoryJobsTable(this, "Jobs");

    const ingest = new AppTheoryS3Ingest(this, "Ingest", {
      enableEventBridge: true,
    });

    const workQueue = new AppTheoryQueue(this, "WorkQueue", {
      queueName: "import-records",
      enableDlq: true,
    });

    const ingestFn = new AppTheoryFunction(this, "IngestHandler", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: goBootstrapCode(path.join(__dirname, "..", "handlers", "ingest")),
      environment: {
        TENANT_ID: tenantId,
        WORK_QUEUE_URL: workQueue.queueUrl,
        INGEST_BUCKET: ingest.bucket.bucketName,
      },
    });

    const workerFn = new AppTheoryFunction(this, "WorkerHandler", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: goBootstrapCode(path.join(__dirname, "..", "handlers", "worker")),
      environment: {
        TENANT_ID: tenantId,
      },
    });

    jobs.bindEnvironment(ingestFn.fn);
    jobs.bindEnvironment(workerFn.fn);
    jobs.grantReadWriteTo(ingestFn.fn);
    jobs.grantReadWriteTo(workerFn.fn);

    ingest.bucket.grantRead(ingestFn.fn);
    workQueue.grantSendMessages(ingestFn.fn);

    new AppTheoryQueueConsumer(this, "WorkConsumer", {
      queue: workQueue.queue,
      consumer: workerFn.fn,
      reportBatchItemFailures: true,
    });

    new AppTheoryEventBridgeRuleTarget(this, "IngestRule", {
      handler: ingestFn.fn,
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created"],
        detail: {
          bucket: {
            name: [ingest.bucket.bucketName],
          },
          object: {
            key: [{ prefix: "incoming/" }],
          },
        },
      },
    });

    new AppTheoryCodeBuildJobRunner(this, "BatchStep", {
      enableStateChangeRule: true,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          build: {
            commands: ["echo batch step placeholder"],
          },
        },
      }),
    });
  }
}
