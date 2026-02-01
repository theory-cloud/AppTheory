import * as path from "node:path";
import {
    AppTheoryKmsKey,
    AppTheoryLambdaRole,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/**
 * Example stack demonstrating AppTheoryLambdaRole:
 * - Basic Lambda execution role
 * - Role with X-Ray tracing
 * - Role with KMS permissions
 * - Role with custom policy statements
 */
export class LambdaRoleStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // ========================================================================
        // Pattern 1: Basic Lambda Role
        // Baseline permissions for CloudWatch Logs only
        // ========================================================================

        const basicRole = new AppTheoryLambdaRole(this, "BasicRole", {
            roleName: "apptheory-basic-lambda-role",
            description: "Basic Lambda execution role with CloudWatch Logs",
        });

        new lambda.Function(this, "BasicFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            role: basicRole.role,
            description: "Basic Lambda with minimal permissions",
        });

        // ========================================================================
        // Pattern 2: Lambda Role with X-Ray Tracing
        // Enables AWS X-Ray for distributed tracing
        // ========================================================================

        const tracingRole = new AppTheoryLambdaRole(this, "TracingRole", {
            roleName: "apptheory-tracing-lambda-role",
            enableXRay: true,
            tags: {
                Environment: "production",
                Service: "tracing-demo",
            },
        });

        new lambda.Function(this, "TracingFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            role: tracingRole.role,
            tracing: lambda.Tracing.ACTIVE,
            description: "Lambda with X-Ray tracing enabled",
        });

        // ========================================================================
        // Pattern 3: Lambda Role with KMS Permissions
        // For encrypted environment variables and application-level encryption
        // ========================================================================

        // KMS key for Lambda environment variable encryption
        const envKey = new AppTheoryKmsKey(this, "EnvKey", {
            description: "KMS key for Lambda environment encryption",
            aliasName: "alias/lambda-env-key",
        });

        // KMS key for application data encryption
        const dataKey = new AppTheoryKmsKey(this, "DataKey", {
            description: "KMS key for application data encryption",
            aliasName: "alias/lambda-data-key",
        });

        const encryptedRole = new AppTheoryLambdaRole(this, "EncryptedRole", {
            roleName: "apptheory-encrypted-lambda-role",
            enableXRay: true,
            environmentEncryptionKeys: [envKey.key],
            applicationKmsKeys: [dataKey.key],
        });

        new lambda.Function(this, "EncryptedFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "encrypted.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            role: encryptedRole.role,
            environmentEncryption: envKey.key,
            environment: {
                DATA_KEY_ARN: dataKey.keyArn,
                SECRET_VALUE: "encrypted-at-rest",
            },
            tracing: lambda.Tracing.ACTIVE,
            description: "Lambda with encrypted environment and KMS access",
        });

        // ========================================================================
        // Pattern 4: Lambda Role with Custom Permissions
        // Using additionalStatements escape hatch for custom permissions
        // ========================================================================

        // Create an S3 bucket for the Lambda to access
        const dataBucket = new s3.Bucket(this, "DataBucket", {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
        });

        const customRole = new AppTheoryLambdaRole(this, "CustomRole", {
            roleName: "apptheory-custom-lambda-role",
            enableXRay: true,
            additionalStatements: [
                // S3 read/write access
                new iam.PolicyStatement({
                    actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
                    resources: [dataBucket.bucketArn, `${dataBucket.bucketArn}/*`],
                }),
                // SSM Parameter Store access
                new iam.PolicyStatement({
                    actions: ["ssm:GetParameter", "ssm:GetParameters"],
                    resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/app/*`],
                }),
                // Secrets Manager access
                new iam.PolicyStatement({
                    actions: ["secretsmanager:GetSecretValue"],
                    resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:app/*`],
                }),
            ],
        });

        new lambda.Function(this, "CustomFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "custom.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            role: customRole.role,
            environment: {
                BUCKET_NAME: dataBucket.bucketName,
            },
            tracing: lambda.Tracing.ACTIVE,
            description: "Lambda with custom S3, SSM, and Secrets Manager permissions",
        });

        // ========================================================================
        // Pattern 5: Adding Permissions After Construction
        // Use addToPolicy for dynamic permission additions
        // ========================================================================

        const dynamicRole = new AppTheoryLambdaRole(this, "DynamicRole", {
            roleName: "apptheory-dynamic-lambda-role",
        });

        // Add permissions dynamically
        dynamicRole.addToPolicy(
            new iam.PolicyStatement({
                actions: ["sqs:SendMessage", "sqs:ReceiveMessage"],
                resources: ["*"],
            }),
        );

        // Add a managed policy
        dynamicRole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSQSReadOnlyAccess"),
        );

        new lambda.Function(this, "DynamicFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "index.handler",
            code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers")),
            role: dynamicRole.role,
            description: "Lambda with dynamically added permissions",
        });

        // ========================================================================
        // Outputs
        // ========================================================================

        new cdk.CfnOutput(this, "BasicRoleArn", {
            value: basicRole.roleArn,
            description: "Basic Lambda execution role ARN",
        });

        new cdk.CfnOutput(this, "TracingRoleArn", {
            value: tracingRole.roleArn,
            description: "Tracing Lambda execution role ARN",
        });

        new cdk.CfnOutput(this, "EncryptedRoleArn", {
            value: encryptedRole.roleArn,
            description: "Encrypted Lambda execution role ARN",
        });

        new cdk.CfnOutput(this, "CustomRoleArn", {
            value: customRole.roleArn,
            description: "Custom Lambda execution role ARN",
        });

        new cdk.CfnOutput(this, "DataBucketName", {
            value: dataBucket.bucketName,
            description: "Data bucket for custom Lambda",
        });
    }
}
