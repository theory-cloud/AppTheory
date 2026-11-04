import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import {
    AppTheoryKmsKey,
    AppTheoryLambdaRole,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
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

        // The handlers ship as TypeScript source. Compile them at synth time so
        // every deployed function runs JavaScript. Compiling here instead of
        // through a Docker bundling command keeps checkout-absolute paths out of
        // the CDK asset fingerprint; the deployed bytes depend only on the
        // handler sources and the checked-in compiler.
        const exampleDir = path.join(__dirname, "..");
        const handlersDir = path.join(exampleDir, "handlers");
        const stageDir = path.join(exampleDir, ".cdk-asset-stage", "handler-asset");
        rmSync(stageDir, { force: true, recursive: true });
        mkdirSync(stageDir, { recursive: true });
        execSync(`npx --no-install tsc -p tsconfig.json --outDir ${JSON.stringify(stageDir)}`, {
            cwd: handlersDir,
            stdio: "inherit",
        });
        const handlerCode = lambda.Code.fromAsset(stageDir);

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
            code: handlerCode,
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
            code: handlerCode,
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
            code: handlerCode,
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
                // Cognito user pool access
                new iam.PolicyStatement({
                    actions: ["cognito-idp:DescribeUserPool", "cognito-idp:DescribeUserPoolClient"],
                    resources: ["*"],
                }),
            ],
        });

        // The local runner provisions SSM parameters, Secrets Manager secrets
        // and a Cognito user pool from these resources. The L1 resources are
        // used deliberately: Ref and GetAtt (SSM Type/Value, Cognito
        // Arn/ProviderName/ProviderURL) are the values the runner resolves, and
        // an L2 construct hides the generated logical ids those attributes name.
        const plainParameter = new ssm.CfnParameter(this, "PlainParameter", {
            name: "/app/demo-parameter",
            type: "String",
            value: "local-ssm-value",
            description: "Plain SSM parameter read by the custom handler",
        });
        const secureParameter = new ssm.CfnParameter(this, "SecureParameter", {
            name: "/app/demo-secure",
            type: "SecureString",
            value: "local-secure-value",
            description: "SecureString parameter read with decryption by the custom handler",
        });
        const listParameter = new ssm.CfnParameter(this, "ListParameter", {
            name: "/app/demo-list",
            type: "StringList",
            value: "alpha,beta,gamma",
            description: "StringList parameter read by the custom handler",
        });

        const literalSecret = new secretsmanager.CfnSecret(this, "LiteralSecret", {
            name: "apptheory/local/literal",
            description: "Literal SecretString read by the custom handler",
            secretString: JSON.stringify({ username: "local-user", password: "local-pass" }),
        });
        const generatedSecret = new secretsmanager.CfnSecret(this, "GeneratedSecret", {
            name: "apptheory/local/generated",
            description: "GenerateSecretString secret read by the custom handler",
            generateSecretString: {
                secretStringTemplate: JSON.stringify({ username: "generated-user" }),
                generateStringKey: "password",
                passwordLength: 24,
                excludePunctuation: true,
            },
        });
        new secretsmanager.CfnResourcePolicy(this, "SecretResourcePolicy", {
            secretId: literalSecret.ref,
            resourcePolicy: { Version: "2012-10-17", Statement: [] },
        });

        const cognitoPool = new cognito.CfnUserPool(this, "CognitoPool", {
            userPoolName: "apptheory-local-pool",
        });
        const cognitoClient = new cognito.CfnUserPoolClient(this, "CognitoClient", {
            userPoolId: cognitoPool.ref,
            clientName: "apptheory-local-client",
            generateSecret: false,
        });
        new cognito.CfnUserPoolDomain(this, "CognitoDomain", {
            domain: "apptheory-local-domain",
            userPoolId: cognitoPool.ref,
        });

        new lambda.Function(this, "CustomFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "custom.handler",
            code: handlerCode,
            role: customRole.role,
            environment: {
                BUCKET_NAME: dataBucket.bucketName,
                SSM_PLAIN_NAME: plainParameter.ref,
                SSM_PLAIN_VALUE: cdk.Fn.getAtt("PlainParameter", "Value").toString(),
                SSM_PLAIN_TYPE: cdk.Fn.getAtt("PlainParameter", "Type").toString(),
                SSM_SECURE_NAME: secureParameter.ref,
                SSM_LIST_NAME: listParameter.ref,
                SECRET_ARN: literalSecret.ref,
                GENERATED_SECRET_ARN: generatedSecret.ref,
                COGNITO_POOL_ID: cognitoPool.ref,
                COGNITO_CLIENT_ID: cognitoClient.ref,
                COGNITO_POOL_ARN: cdk.Fn.getAtt("CognitoPool", "Arn").toString(),
                COGNITO_PROVIDER_NAME: cdk.Fn.getAtt("CognitoPool", "ProviderName").toString(),
                COGNITO_PROVIDER_URL: cdk.Fn.getAtt("CognitoPool", "ProviderURL").toString(),
            },
            tracing: lambda.Tracing.ACTIVE,
            description: "Lambda with custom S3, SSM, Secrets Manager, and Cognito permissions",
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
            code: handlerCode,
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
