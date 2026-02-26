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
export declare class AppTheoryCodeBuildJobRunner extends Construct {
    readonly project: codebuild.Project;
    readonly role: iam.Role;
    readonly logGroup: logs.ILogGroup;
    readonly stateChangeRule?: events.Rule;
    constructor(scope: Construct, id: string, props: AppTheoryCodeBuildJobRunnerProps);
    /**
     * Grant S3 read permissions to the project.
     */
    grantS3Read(bucket: s3.IBucket): void;
    /**
     * Grant S3 write permissions to the project.
     */
    grantS3Write(bucket: s3.IBucket): void;
    /**
     * Grant DynamoDB read permissions to the project.
     */
    grantDynamoRead(table: dynamodb.ITable): void;
    /**
     * Grant DynamoDB write permissions to the project.
     */
    grantDynamoWrite(table: dynamodb.ITable): void;
    /**
     * Grant Secrets Manager read permissions to the project.
     */
    grantSecretRead(secret: secretsmanager.ISecret): void;
    /**
     * Attach a policy statement to the CodeBuild role.
     */
    addToRolePolicy(statement: iam.PolicyStatement): void;
}
