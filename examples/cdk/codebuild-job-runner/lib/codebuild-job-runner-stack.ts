import { AppTheoryCodeBuildJobRunner, AppTheoryJobsTable } from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

/**
 * Example stack demonstrating AppTheoryCodeBuildJobRunner:
 * - Baseline project with inline buildspec
 * - State change rule hook (EventBridge)
 * - Grant helpers for Jobs table, S3, and Secrets Manager
 */
export class CodeBuildJobRunnerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const jobs = new AppTheoryJobsTable(this, "Jobs");
    const bucket = new s3.Bucket(this, "IngestBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const secret = new secretsmanager.Secret(this, "Secret");

    const runner = new AppTheoryCodeBuildJobRunner(this, "Runner", {
      enableStateChangeRule: true,
      stateChangeRuleName: "import-job-runner-state-changes",
      stateChangeRuleDescription: "CodeBuild build state changes",
      environmentVariables: {
        APPTHEORY_JOBS_TABLE_NAME: { value: jobs.table.tableName },
        INGEST_BUCKET: { value: bucket.bucketName },
        SECRET_ARN: { value: secret.secretArn },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          build: {
            commands: [
              "echo APPTHEORY_JOBS_TABLE_NAME=$APPTHEORY_JOBS_TABLE_NAME",
              "echo INGEST_BUCKET=$INGEST_BUCKET",
              "echo SECRET_ARN=$SECRET_ARN",
            ],
          },
        },
      }),
    });

    runner.grantDynamoRead(jobs.table);
    runner.grantDynamoWrite(jobs.table);
    runner.grantS3Read(bucket);
    runner.grantSecretRead(secret);
  }
}

