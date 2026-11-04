import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import {
    AppTheoryKmsKey,
    AppTheoryLambdaRole,
} from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
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
        // JWT and Cognito authorizers: the runner validates a real token minted by
        // the local Cognito pool and exposes the documented claims to the
        // integration. The HTTP API declares a JWT authorizer whose issuer names
        // the pool; the REST API declares a COGNITO_USER_POOLS authorizer with an
        // access-token scope per route.
        // https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html
        // https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-integrate-with-cognito.html
        // ========================================================================

        // A second client of the same pool mints tokens whose audience the HTTP
        // JWT authorizer does not accept, and a second pool mints tokens whose
        // issuer it does not accept. Both are fixtures for the refusal rows.
        const otherClient = new cognito.CfnUserPoolClient(this, "OtherCognitoClient", {
            userPoolId: cognitoPool.ref,
            clientName: "apptheory-local-other-client",
            generateSecret: false,
        });
        const foreignPool = new cognito.CfnUserPool(this, "ForeignCognitoPool", {
            userPoolName: "apptheory-local-foreign-pool",
        });
        const foreignClient = new cognito.CfnUserPoolClient(this, "ForeignCognitoClient", {
            userPoolId: foreignPool.ref,
            clientName: "apptheory-local-foreign-client",
            generateSecret: false,
        });

        const authorizerFn = new lambda.Function(this, "AuthorizerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "authorizer.handler",
            code: handlerCode,
            timeout: cdk.Duration.seconds(10),
            description: "Echoes the authorizer context the integration received",
        });

        const issuer = cdk.Fn.join("", [
            "https://cognito-idp.",
            cdk.Aws.REGION,
            ".amazonaws.com/",
            cognitoPool.ref,
        ]);
        const jwtAuthorizer = new apigwv2Authorizers.HttpJwtAuthorizer("JwtAuthorizer", issuer, {
            jwtAudience: [cognitoClient.ref],
            identitySource: ["$request.header.Authorization"],
        });
        const authorizedHttpApi = new apigwv2.HttpApi(this, "AuthorizedHttpApi", {
            apiName: "apptheory-local-authorized-http",
        });
        authorizedHttpApi.addRoutes({
            path: "/protected",
            methods: [apigwv2.HttpMethod.GET],
            integration: new apigwv2Integrations.HttpLambdaIntegration("AuthorizedHttpIntegration", authorizerFn),
            authorizer: jwtAuthorizer,
        });

        // The REST authorizer resolves the pool through its ARN. The L1 pool has
        // no IUserPool, so the ARN is imported.
        const poolForAuthorizer = cognito.UserPool.fromUserPoolArn(
            this,
            "CognitoPoolForAuthorizer",
            cdk.Fn.getAtt("CognitoPool", "Arn").toString(),
        );
        const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "CognitoAuthorizer", {
            cognitoUserPools: [poolForAuthorizer],
            authorizerName: "apptheory-local-cognito",
            identitySource: "method.request.header.Authorization",
        });
        const authorizedRestApi = new apigateway.RestApi(this, "AuthorizedRestApi", {
            restApiName: "apptheory-local-authorized-rest",
        });
        const restIntegration = new apigateway.LambdaIntegration(authorizerFn);
        authorizedRestApi.root.addResource("protected").addMethod("GET", restIntegration, {
            authorizationType: apigateway.AuthorizationType.COGNITO,
            authorizer: cognitoAuthorizer,
            authorizationScopes: ["aws.cognito.signin.user.admin"],
        });
        authorizedRestApi.root.addResource("admin").addMethod("GET", restIntegration, {
            authorizationType: apigateway.AuthorizationType.COGNITO,
            authorizer: cognitoAuthorizer,
            authorizationScopes: ["api/admin"],
        });

        // ========================================================================
        // Lambda authorizers that return an IAM policy: a REST TOKEN authorizer,
        // a REST REQUEST authorizer over two identity sources, and an HTTP API
        // REQUEST authorizer with an IAM-policy response. The policy function
        // counts its own invocations and returns the count in the authorizer
        // context, so the harness can prove a cached decision did not invoke it.
        // The REST authorizers are L1 resources because the L2 constructs do not
        // expose AuthorizerResultTtlInSeconds or IdentityValidationExpression.
        // https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-use-lambda-authorizer.html
        // https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-lambda-authorizer.html
        // ========================================================================

        const policyAuthorizerFn = new lambda.Function(this, "PolicyAuthorizerFn", {
            runtime: lambda.Runtime.NODEJS_24_X,
            handler: "policy-authorizer.handler",
            code: handlerCode,
            timeout: cdk.Duration.seconds(10),
            description: "Returns an IAM policy and counts its own invocations",
        });
        const restAuthorizerUri = cdk.Fn.join("", [
            "arn:",
            cdk.Aws.PARTITION,
            ":apigateway:",
            cdk.Aws.REGION,
            ":lambda:path/2015-03-31/functions/",
            policyAuthorizerFn.functionArn,
            "/invocations",
        ]);
        const tokenAuthorizer = new apigateway.CfnAuthorizer(this, "TokenAuthorizer", {
            restApiId: authorizedRestApi.restApiId,
            name: "apptheory-local-token",
            type: "TOKEN",
            identitySource: "method.request.header.Authorization",
            authorizerResultTtlInSeconds: 60,
            authorizerUri: restAuthorizerUri,
        });
        const requestAuthorizer = new apigateway.CfnAuthorizer(this, "RequestAuthorizer", {
            restApiId: authorizedRestApi.restApiId,
            name: "apptheory-local-request",
            type: "REQUEST",
            identitySource: "method.request.header.X-Tenant, method.request.querystring.scope",
            authorizerResultTtlInSeconds: 60,
            authorizerUri: restAuthorizerUri,
        });
        policyAuthorizerFn.addPermission("RestAuthorizerInvoke", {
            principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
            sourceArn: cdk.Fn.join("", [
                "arn:",
                cdk.Aws.PARTITION,
                ":execute-api:",
                cdk.Aws.REGION,
                ":",
                cdk.Aws.ACCOUNT_ID,
                ":",
                authorizedRestApi.restApiId,
                "/authorizers/*",
            ]),
        });
        authorizedRestApi.root.addResource("token").addMethod("GET", restIntegration, {
            authorizationType: apigateway.AuthorizationType.CUSTOM,
            authorizer: tokenAuthorizerRef(tokenAuthorizer),
        });
        authorizedRestApi.root.addResource("request").addMethod("GET", restIntegration, {
            authorizationType: apigateway.AuthorizationType.CUSTOM,
            authorizer: tokenAuthorizerRef(requestAuthorizer),
        });

        const policyHttpApi = new apigwv2.HttpApi(this, "PolicyHttpApi", {
            apiName: "apptheory-local-policy-http",
        });
        const policyHttpAuthorizer = new apigwv2Authorizers.HttpLambdaAuthorizer(
            "PolicyHttpAuthorizer",
            policyAuthorizerFn,
            {
                authorizerName: "apptheory-local-policy",
                identitySource: ["$request.header.Authorization"],
                resultsCacheTtl: cdk.Duration.seconds(60),
                responseTypes: [apigwv2Authorizers.HttpLambdaResponseType.IAM],
            },
        );
        policyHttpApi.addRoutes({
            path: "/policy",
            methods: [apigwv2.HttpMethod.GET],
            integration: new apigwv2Integrations.HttpLambdaIntegration("PolicyHttpIntegration", authorizerFn),
            authorizer: policyHttpAuthorizer,
        });

        new cdk.CfnOutput(this, "PolicyHttpApiUrl", { value: policyHttpApi.apiEndpoint });

        new cdk.CfnOutput(this, "AuthorizedHttpApiUrl", { value: authorizedHttpApi.apiEndpoint });
        new cdk.CfnOutput(this, "AuthorizedRestApiUrl", { value: authorizedRestApi.url });
        new cdk.CfnOutput(this, "OtherClientId", { value: otherClient.ref });
        new cdk.CfnOutput(this, "ForeignPoolId", { value: foreignPool.ref });
        new cdk.CfnOutput(this, "ForeignClientId", { value: foreignClient.ref });

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

/**
 * Wraps an L1 AWS::ApiGateway::Authorizer as the IAuthorizer an L2 Method takes.
 *
 * The L2 authorizer constructs do not expose AuthorizerResultTtlInSeconds or
 * IdentityValidationExpression, so the example declares the L1 resource and
 * passes its id through this adapter. Only the id is needed: the runner, like
 * API Gateway, reads the authorizer resource from the template.
 */
function tokenAuthorizerRef(authorizer: apigateway.CfnAuthorizer): apigateway.IAuthorizer {
    return { authorizerId: authorizer.ref };
}
