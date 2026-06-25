import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import type { IAppTheoryMicrovmImage } from "./microvm-image";
import { type IAppTheoryMicrovmNetworkConnector } from "./microvm-network-connector";
/**
 * Stage configuration for the MicroVM controller HTTP API.
 */
export interface AppTheoryMicrovmControllerStageOptions {
    /**
     * Stage name.
     *
     * @default "$default"
     */
    readonly stageName?: string;
    /**
     * Enable CloudWatch access logging for the stage.
     *
     * @default false
     */
    readonly accessLogging?: boolean;
    /**
     * Retention period for auto-created access log group.
     * Only applies when accessLogging is true.
     *
     * @default logs.RetentionDays.ONE_MONTH
     */
    readonly accessLogRetention?: logs.RetentionDays;
    /**
     * Throttling rate limit (requests per second) for the stage.
     *
     * @default undefined (no throttling)
     */
    readonly throttlingRateLimit?: number;
    /**
     * Throttling burst limit for the stage.
     *
     * @default undefined (no throttling)
     */
    readonly throttlingBurstLimit?: number;
}
/**
 * Packaging and runtime configuration for the AppTheory MicroVM controller Lambda.
 *
 * AppTheory creates the Lambda function so it can wire the canonical session table,
 * MicroVM image/network references, and fail-closed auth environment consistently.
 * The caller supplies only the handler package details and any ordinary Lambda
 * FunctionProps.
 */
export interface AppTheoryMicrovmControllerFunctionProps extends lambda.FunctionProps {
}
/**
 * Props for AppTheoryMicrovmController.
 */
export interface AppTheoryMicrovmControllerProps {
    /**
     * Controller Lambda packaging and configuration.
     *
     * The handler code must use AppTheory's MicroVM runtime/controller primitives.
     * This construct does not implement a product control-plane service.
     */
    readonly controller: AppTheoryMicrovmControllerFunctionProps;
    /**
     * Lambda request authorizer required for every controller route.
     *
     * The construct fails closed when this is omitted; unauthenticated controller routes
     * are not synthesized.
     */
    readonly authorizer: lambda.IFunction;
    /**
     * The MicroVM image the controller is permitted to run.
     */
    readonly microvmImage: IAppTheoryMicrovmImage;
    /**
     * Ingress network connectors the controller is permitted to pass to Lambda MicroVMs.
     *
     * At least one connector reference is required and no more than 10 may be supplied.
     * Use AppTheoryMicrovmNetworkConnector.allIngress/noIngress or an explicitly typed
     * imported ingress connector reference; AppTheory does not hide an ingress default.
     */
    readonly ingressNetworkConnectors: IAppTheoryMicrovmNetworkConnector[];
    /**
     * Egress network connectors the controller is permitted to pass to Lambda MicroVMs.
     *
     * At least one connector reference is required and no more than 10 may be supplied.
     */
    readonly egressNetworkConnectors: IAppTheoryMicrovmNetworkConnector[];
    /**
     * Shell ingress connector required for shell-auth-token support.
     *
     * Use AppTheoryMicrovmNetworkConnector.shellIngress or an explicitly typed shell-ingress
     * connector reference. The shell-auth-token route is part of the real M16 controller
     * surface, so this reference is required instead of being silently defaulted.
     */
    readonly shellIngressNetworkConnector: IAppTheoryMicrovmNetworkConnector;
    /**
     * Optional MicroVM execution role passed to RunMicrovm.
     *
     * When supplied, AppTheory grants the controller Lambda iam:PassRole for this role
     * and exposes the ARN as APPTHEORY_MICROVM_EXECUTION_ROLE_ARN.
     *
     * @default undefined
     */
    readonly executionRole?: iam.IRole;
    /**
     * Optional API name.
     *
     * @default undefined
     */
    readonly apiName?: string;
    /**
     * Optional stage configuration.
     *
     * @default undefined (default HTTP API stage)
     */
    readonly stage?: AppTheoryMicrovmControllerStageOptions;
    /**
     * Name for the durable MicroVM session registry DynamoDB table.
     *
     * @default undefined (CloudFormation-generated)
     */
    readonly sessionTableName?: string;
    /**
     * Billing mode for the session registry table.
     *
     * @default PAY_PER_REQUEST
     */
    readonly sessionTableBillingMode?: dynamodb.BillingMode;
    /**
     * Removal policy for the session registry table.
     *
     * @default RemovalPolicy.RETAIN
     */
    readonly sessionTableRemovalPolicy?: RemovalPolicy;
    /**
     * Whether deletion protection should be enabled for the session registry table.
     *
     * @default - AWS default (no deletion protection)
     */
    readonly sessionTableDeletionProtection?: boolean;
    /**
     * Whether point-in-time recovery should be enabled for the session registry table.
     *
     * @default true
     */
    readonly enableSessionTablePointInTimeRecovery?: boolean;
    /**
     * Session registry table encryption setting.
     *
     * @default AWS_MANAGED
     */
    readonly sessionTableEncryption?: dynamodb.TableEncryption;
    /**
     * Customer-managed KMS key for the session registry table.
     *
     * Required when sessionTableEncryption is CUSTOMER_MANAGED.
     */
    readonly sessionTableEncryptionKey?: kms.IKey;
    /**
     * Provisioned read capacity when sessionTableBillingMode is PROVISIONED.
     *
     * @default 5
     */
    readonly sessionTableReadCapacity?: number;
    /**
     * Provisioned write capacity when sessionTableBillingMode is PROVISIONED.
     *
     * @default 5
     */
    readonly sessionTableWriteCapacity?: number;
    /**
     * Header used as the identity source for controller authorization.
     *
     * @default "Authorization"
     */
    readonly authorizerHeaderName?: string;
    /**
     * Friendly authorizer name.
     *
     * @default undefined
     */
    readonly authorizerName?: string;
    /**
     * Lambda authorizer result cache TTL.
     *
     * Defaults to disabled so stale auth cannot silently broaden controller access.
     *
     * @default Duration.seconds(0)
     */
    readonly authorizerCacheTtl?: Duration;
}
/**
 * AppTheory CDK construct for the first-class Lambda MicroVM controller deployment surface.
 *
 * The construct provisions the protected HTTP API routes from the M16 real controller contract,
 * the controller Lambda, the canonical durable session registry table, IAM grants, and
 * fail-closed auth environment wiring. Runtime command handling remains in the AppTheory
 * runtime contract; this construct only wires the deployment path.
 */
export declare class AppTheoryMicrovmController extends Construct {
    /**
     * The underlying HTTP API Gateway v2 API.
     */
    readonly api: apigwv2.HttpApi;
    /**
     * The API Gateway stage.
     */
    readonly stage: apigwv2.IStage;
    /**
     * Lambda request authorizer attached to every controller route.
     */
    readonly routeAuthorizer: apigwv2Authorizers.HttpLambdaAuthorizer;
    /**
     * The controller Lambda function created by this construct.
     */
    readonly controllerFunction: lambda.Function;
    /**
     * The durable TableTheory-shaped session registry DynamoDB table.
     */
    readonly sessionTable: dynamodb.Table;
    /**
     * The controller base endpoint (`/microvms`).
     */
    readonly endpoint: string;
    /**
     * The access log group (if access logging is enabled).
     */
    readonly accessLogGroup?: logs.ILogGroup;
    constructor(scope: Construct, id: string, props: AppTheoryMicrovmControllerProps);
    private createSessionTable;
    private createStage;
    private createControllerFunction;
    private grantMicrovmControlPlane;
    private addControllerRoutes;
}
