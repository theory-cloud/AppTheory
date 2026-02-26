import { Duration } from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface AppTheoryCodeBuildJobRunnerProps {
  /**
   * Optional project name.
   * @default - CloudFormation-generated name
   */
  readonly projectName?: string;

  /**
   * Optional description.
   */
  readonly description?: string;

  /**
   * Build specification.
   */
  readonly buildSpec: codebuild.BuildSpec;

  /**
   * CodeBuild source configuration.
   * @default - NoSource
   */
  readonly source?: codebuild.ISource;

  /**
   * Build image.
   * @default codebuild.LinuxBuildImage.STANDARD_7_0
   */
  readonly buildImage?: codebuild.IBuildImage;

  /**
   * Compute type.
   * @default codebuild.ComputeType.SMALL
   */
  readonly computeType?: codebuild.ComputeType;

  /**
   * Timeout for a single build.
   * @default Duration.minutes(60)
   */
  readonly timeout?: Duration;

  /**
   * Environment variables.
   */
  readonly environmentVariables?: Record<string, codebuild.BuildEnvironmentVariable>;

  /**
   * Optional KMS key for encrypting build artifacts/logs.
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * Additional IAM policy statements to attach to the CodeBuild role.
   */
  readonly additionalStatements?: iam.PolicyStatement[];

  /**
   * Optional log group to use for CodeBuild logs.
   */
  readonly logGroup?: logs.ILogGroup;

  /**
   * Retention for auto-managed log group.
   * @default logs.RetentionDays.ONE_MONTH
   */
  readonly logRetention?: logs.RetentionDays;

  /**
   * Whether to create an EventBridge rule for build state changes.
   * @default false
   */
  readonly enableStateChangeRule?: boolean;

  /**
   * Optional rule name for the state change rule.
   * @default - CloudFormation-generated name
   */
  readonly stateChangeRuleName?: string;

  /**
   * Optional rule description for the state change rule.
   */
  readonly stateChangeRuleDescription?: string;

  /**
   * Whether the state change rule should be enabled.
   * @default true
   */
  readonly stateChangeRuleEnabled?: boolean;

  /**
   * Optional EventBus for the state change rule.
   * @default - Default event bus
   */
  readonly stateChangeEventBus?: events.IEventBus;
}

/**
 * Opinionated CodeBuild wrapper for running import/batch jobs outside Lambda.
 *
 * This construct creates a CodeBuild project with:
 * - safe defaults for image/compute/timeout
 * - deterministic log group retention (auto-managed by default)
 * - an optional EventBridge state-change rule hook
 * - ergonomic grant helpers for common AWS resources
 */
export class AppTheoryCodeBuildJobRunner extends Construct {
  public readonly project: codebuild.Project;
  public readonly role: iam.Role;
  public readonly logGroup: logs.ILogGroup;
  public readonly stateChangeRule?: events.Rule;

  constructor(scope: Construct, id: string, props: AppTheoryCodeBuildJobRunnerProps) {
    super(scope, id);

    this.role = new iam.Role(this, "Role", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    this.logGroup =
      props.logGroup ??
      new logs.LogGroup(this, "LogGroup", {
        retention: props.logRetention ?? logs.RetentionDays.ONE_MONTH,
      });
    this.logGroup.grantWrite(this.role);

    this.project = new codebuild.Project(this, "Project", {
      role: this.role,
      projectName: props.projectName,
      description: props.description,
      ...(props.source ? { source: props.source } : {}),
      buildSpec: props.buildSpec,
      timeout: props.timeout ?? Duration.minutes(60),
      environment: {
        buildImage: props.buildImage ?? codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: props.computeType ?? codebuild.ComputeType.SMALL,
        environmentVariables: props.environmentVariables,
      },
      encryptionKey: props.encryptionKey,
      logging: {
        cloudWatch: {
          logGroup: this.logGroup,
        },
      },
    });

    for (const statement of props.additionalStatements ?? []) {
      this.role.addToPolicy(statement);
    }

    if (props.enableStateChangeRule) {
      this.stateChangeRule = new events.Rule(this, "StateChangeRule", {
        ruleName: props.stateChangeRuleName,
        description: props.stateChangeRuleDescription,
        enabled: props.stateChangeRuleEnabled ?? true,
        eventBus: props.stateChangeEventBus,
        eventPattern: {
          source: ["aws.codebuild"],
          detailType: ["CodeBuild Build State Change"],
          detail: {
            "project-name": [this.project.projectName],
          },
        },
      });
    }
  }

  /**
   * Grant S3 read permissions to the project.
   */
  public grantS3Read(bucket: s3.IBucket): void {
    bucket.grantRead(this.project);
  }

  /**
   * Grant S3 write permissions to the project.
   */
  public grantS3Write(bucket: s3.IBucket): void {
    bucket.grantWrite(this.project);
  }

  /**
   * Grant DynamoDB read permissions to the project.
   */
  public grantDynamoRead(table: dynamodb.ITable): void {
    table.grantReadData(this.project);
  }

  /**
   * Grant DynamoDB write permissions to the project.
   */
  public grantDynamoWrite(table: dynamodb.ITable): void {
    table.grantWriteData(this.project);
  }

  /**
   * Grant Secrets Manager read permissions to the project.
   */
  public grantSecretRead(secret: secretsmanager.ISecret): void {
    secret.grantRead(this.project);
  }

  /**
   * Attach a policy statement to the CodeBuild role.
   */
  public addToRolePolicy(statement: iam.PolicyStatement): void {
    this.role.addToPolicy(statement);
  }
}
