import { Duration, RemovalPolicy, Token } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as kms from "aws-cdk-lib/aws-kms";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import type { AppTheoryMicrovmImageLogging, IAppTheoryMicrovmImage } from "./microvm-image";
import {
  AppTheoryMicrovmNetworkConnectorKind,
  type IAppTheoryMicrovmNetworkConnector,
} from "./microvm-network-connector";

const MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm";
const MICROVM_CONTRACT_VERSION = "m16.microvm/v1";
const CONTROLLER_AUTH_REQUIRED = "true";
const CONTROLLER_AUTH_DEFAULT = "deny";
const CONTROLLER_OPERATIONS = [
  "run",
  "get",
  "list",
  "suspend",
  "resume",
  "terminate",
  "invoke",
  "auth-token",
  "shell-auth-token",
];
const CONTROLLER_ROUTE_DEFINITIONS: Array<{ id: string; method: apigwv2.HttpMethod; path: string }> = [
  { id: "RunMicrovm", method: apigwv2.HttpMethod.POST, path: "/microvms" },
  { id: "ListMicrovms", method: apigwv2.HttpMethod.GET, path: "/microvms" },
  { id: "GetMicrovm", method: apigwv2.HttpMethod.GET, path: "/microvms/{session_id}" },
  { id: "SuspendMicrovm", method: apigwv2.HttpMethod.POST, path: "/microvms/{session_id}/suspend" },
  { id: "ResumeMicrovm", method: apigwv2.HttpMethod.POST, path: "/microvms/{session_id}/resume" },
  { id: "TerminateMicrovm", method: apigwv2.HttpMethod.DELETE, path: "/microvms/{session_id}" },
  { id: "InvokeMicrovmRoot", method: apigwv2.HttpMethod.ANY, path: "/microvms/{session_id}/invoke" },
  { id: "InvokeMicrovmProxy", method: apigwv2.HttpMethod.ANY, path: "/microvms/{session_id}/invoke/{proxy+}" },
  { id: "CreateMicrovmAuthToken", method: apigwv2.HttpMethod.POST, path: "/microvms/{session_id}/auth-token" },
  {
    id: "CreateMicrovmShellAuthToken",
    method: apigwv2.HttpMethod.POST,
    path: "/microvms/{session_id}/shell-auth-token",
  },
];

const ENV_CONTRACT_NAME = "APPTHEORY_MICROVM_CONTRACT_NAME";
const ENV_CONTRACT_VERSION = "APPTHEORY_MICROVM_CONTRACT_VERSION";
const ENV_CONTROLLER_ENDPOINT = "APPTHEORY_MICROVM_CONTROLLER_ENDPOINT";
const ENV_CONTROLLER_OPERATIONS = "APPTHEORY_MICROVM_CONTROLLER_OPERATIONS";
const ENV_CONTROLLER_ROUTES = "APPTHEORY_MICROVM_CONTROLLER_ROUTES";
const ENV_CONTROLLER_AUTH_REQUIRED = "APPTHEORY_MICROVM_CONTROLLER_AUTH_REQUIRED";
const ENV_CONTROLLER_AUTH_DEFAULT = "APPTHEORY_MICROVM_CONTROLLER_AUTH_DEFAULT";
const ENV_SESSION_REGISTRY_TABLE = "APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE";
const ENV_IMAGE_REF = "APPTHEORY_MICROVM_IMAGE_REF";
const ENV_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS";
const ENV_INGRESS_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_INGRESS_NETWORK_CONNECTOR_REFS";
const ENV_EGRESS_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_EGRESS_NETWORK_CONNECTOR_REFS";
const ENV_SHELL_INGRESS_NETWORK_CONNECTOR_REF = "APPTHEORY_MICROVM_SHELL_INGRESS_NETWORK_CONNECTOR_REF";
const ENV_EXECUTION_ROLE_ARN = "APPTHEORY_MICROVM_EXECUTION_ROLE_ARN";
const ENV_LOGGING = "APPTHEORY_MICROVM_LOGGING";

const RESERVED_ENV_KEYS = [
  ENV_CONTRACT_NAME,
  ENV_CONTRACT_VERSION,
  ENV_CONTROLLER_ENDPOINT,
  ENV_CONTROLLER_OPERATIONS,
  ENV_CONTROLLER_ROUTES,
  ENV_CONTROLLER_AUTH_REQUIRED,
  ENV_CONTROLLER_AUTH_DEFAULT,
  ENV_SESSION_REGISTRY_TABLE,
  ENV_IMAGE_REF,
  ENV_NETWORK_CONNECTOR_REFS,
  ENV_INGRESS_NETWORK_CONNECTOR_REFS,
  ENV_EGRESS_NETWORK_CONNECTOR_REFS,
  ENV_SHELL_INGRESS_NETWORK_CONNECTOR_REF,
  ENV_EXECUTION_ROLE_ARN,
  ENV_LOGGING,
];

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
export interface AppTheoryMicrovmControllerFunctionProps extends lambda.FunctionProps {}

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
export class AppTheoryMicrovmController extends Construct {
  /**
   * The underlying HTTP API Gateway v2 API.
   */
  public readonly api: apigwv2.HttpApi;

  /**
   * The API Gateway stage.
   */
  public readonly stage: apigwv2.IStage;

  /**
   * Lambda request authorizer attached to every controller route.
   */
  public readonly routeAuthorizer: apigwv2Authorizers.HttpLambdaAuthorizer;

  /**
   * The controller Lambda function created by this construct.
   */
  public readonly controllerFunction: lambda.Function;

  /**
   * The durable TableTheory-shaped session registry DynamoDB table.
   */
  public readonly sessionTable: dynamodb.Table;

  /**
   * The controller base endpoint (`/microvms`).
   */
  public readonly endpoint: string;

  /**
   * The access log group (if access logging is enabled).
   */
  public readonly accessLogGroup?: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: AppTheoryMicrovmControllerProps) {
    super(scope, id);

    if (props === undefined || props === null) {
      throw new Error("AppTheoryMicrovmController requires props");
    }
    validateRequired(props.controller, "controller");
    validateRequired(props.authorizer, "authorizer");
    validateRequired(props.microvmImage, "microvmImage");

    const imageArn = normalizeNoWhitespaceString(props.microvmImage.microvmImageArn, "microvmImage.microvmImageArn", 2048);
    const ingressConnectorArns = normalizeConnectorReferences(
      props.ingressNetworkConnectors,
      "ingressNetworkConnectors",
      AppTheoryMicrovmNetworkConnectorKind.INGRESS,
    );
    const egressConnectorArns = normalizeConnectorReferences(
      props.egressNetworkConnectors,
      "egressNetworkConnectors",
      AppTheoryMicrovmNetworkConnectorKind.EGRESS,
    );
    const shellIngressConnectorArn = normalizeSingleConnectorReference(
      props.shellIngressNetworkConnector,
      "shellIngressNetworkConnector",
      AppTheoryMicrovmNetworkConnectorKind.SHELL_INGRESS,
    );
    const allIngressConnectorArns = dedupeConnectorArns([...ingressConnectorArns, shellIngressConnectorArn]);
    assertNoDuplicates([...allIngressConnectorArns, ...egressConnectorArns], "controller networkConnectorArn");
    const loggingEnvironment = controllerLoggingEnvironment(props.microvmImage.logging, props.executionRole);
    const authorizerHeaderName = normalizeHeaderName(props.authorizerHeaderName ?? "Authorization");
    const stageOpts = props.stage ?? {};
    const stageName = normalizeStageName(stageOpts.stageName ?? "$default");

    this.sessionTable = this.createSessionTable(props);

    this.api = new apigwv2.HttpApi(this, "Api", {
      apiName: props.apiName,
      createDefaultStage: !needsExplicitStage(stageOpts, stageName),
    });

    const stage = this.createStage(stageOpts, stageName);
    if (!stage) {
      throw new Error("AppTheoryMicrovmController: failed to create API stage");
    }
    this.stage = stage;

    this.endpoint = stageName === "$default"
      ? `${stripTrailingSlash(this.api.apiEndpoint)}/microvms`
      : `${stripTrailingSlash(this.api.apiEndpoint)}/${stageName}/microvms`;

    this.controllerFunction = this.createControllerFunction(
      props,
      imageArn,
      allIngressConnectorArns,
      egressConnectorArns,
      shellIngressConnectorArn,
      loggingEnvironment,
    );
    this.sessionTable.grantReadWriteData(this.controllerFunction);
    this.grantMicrovmControlPlane(props);

    this.routeAuthorizer = new apigwv2Authorizers.HttpLambdaAuthorizer("Authorizer", props.authorizer, {
      authorizerName: props.authorizerName,
      identitySource: [`$request.header.${authorizerHeaderName}`],
      resultsCacheTtl: props.authorizerCacheTtl ?? Duration.seconds(0),
      responseTypes: [apigwv2Authorizers.HttpLambdaResponseType.SIMPLE],
    });

    this.addControllerRoutes();
  }

  private createSessionTable(props: AppTheoryMicrovmControllerProps): dynamodb.Table {
    const billingMode = props.sessionTableBillingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
    const removalPolicy = props.sessionTableRemovalPolicy ?? RemovalPolicy.RETAIN;
    const encryption = props.sessionTableEncryption ?? dynamodb.TableEncryption.AWS_MANAGED;
    const enablePITR = props.enableSessionTablePointInTimeRecovery ?? true;

    if (encryption === dynamodb.TableEncryption.CUSTOMER_MANAGED && !props.sessionTableEncryptionKey) {
      throw new Error(
        "AppTheoryMicrovmController requires sessionTableEncryptionKey when sessionTableEncryption is CUSTOMER_MANAGED",
      );
    }

    const tableName = props.sessionTableName === undefined
      ? undefined
      : normalizeRequiredString(props.sessionTableName, "sessionTableName");

    return new dynamodb.Table(this, "SessionTable", {
      tableName,
      billingMode,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: "ttl",
      removalPolicy,
      deletionProtection: props.sessionTableDeletionProtection,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: enablePITR,
      },
      encryption,
      encryptionKey: props.sessionTableEncryptionKey,
      ...(billingMode === dynamodb.BillingMode.PROVISIONED
        ? {
            readCapacity: props.sessionTableReadCapacity ?? 5,
            writeCapacity: props.sessionTableWriteCapacity ?? 5,
          }
        : {}),
    });
  }

  private createStage(
    stageOpts: AppTheoryMicrovmControllerStageOptions,
    stageName: string,
  ): apigwv2.IStage | undefined {
    if (!needsExplicitStage(stageOpts, stageName)) {
      return this.api.defaultStage;
    }

    const stage = new apigwv2.HttpStage(this, "Stage", {
      httpApi: this.api,
      stageName,
      autoDeploy: true,
      throttle: (stageOpts.throttlingRateLimit !== undefined || stageOpts.throttlingBurstLimit !== undefined)
        ? {
            rateLimit: stageOpts.throttlingRateLimit,
            burstLimit: stageOpts.throttlingBurstLimit,
          }
        : undefined,
    });

    if (stageOpts.accessLogging) {
      const logGroup = new logs.LogGroup(this, "AccessLogs", {
        retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
      });
      (this as { accessLogGroup?: logs.ILogGroup }).accessLogGroup = logGroup;

      const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
      cfnStage.accessLogSettings = {
        destinationArn: logGroup.logGroupArn,
        format: JSON.stringify({
          requestId: "$context.requestId",
          ip: "$context.identity.sourceIp",
          requestTime: "$context.requestTime",
          httpMethod: "$context.httpMethod",
          routeKey: "$context.routeKey",
          status: "$context.status",
          protocol: "$context.protocol",
          responseLength: "$context.responseLength",
          integrationLatency: "$context.integrationLatency",
        }),
      };
    }

    return stage;
  }

  private createControllerFunction(
    props: AppTheoryMicrovmControllerProps,
    imageArn: string,
    ingressConnectorArns: string[],
    egressConnectorArns: string[],
    shellIngressConnectorArn: string,
    loggingEnvironment: string,
  ): lambda.Function {
    const controllerProps = props.controller;
    const environment = buildControllerEnvironment(
      controllerProps.environment,
      {
        [ENV_CONTRACT_NAME]: MICROVM_CONTRACT_NAME,
        [ENV_CONTRACT_VERSION]: MICROVM_CONTRACT_VERSION,
        [ENV_CONTROLLER_ENDPOINT]: this.endpoint,
        [ENV_CONTROLLER_OPERATIONS]: CONTROLLER_OPERATIONS.join(","),
        [ENV_CONTROLLER_ROUTES]: CONTROLLER_ROUTE_DEFINITIONS.map((route) => `${route.method} ${route.path}`).join(","),
        [ENV_CONTROLLER_AUTH_REQUIRED]: CONTROLLER_AUTH_REQUIRED,
        [ENV_CONTROLLER_AUTH_DEFAULT]: CONTROLLER_AUTH_DEFAULT,
        [ENV_SESSION_REGISTRY_TABLE]: this.sessionTable.tableName,
        [ENV_IMAGE_REF]: imageArn,
        [ENV_NETWORK_CONNECTOR_REFS]: egressConnectorArns.join(","),
        [ENV_INGRESS_NETWORK_CONNECTOR_REFS]: ingressConnectorArns.join(","),
        [ENV_EGRESS_NETWORK_CONNECTOR_REFS]: egressConnectorArns.join(","),
        [ENV_SHELL_INGRESS_NETWORK_CONNECTOR_REF]: shellIngressConnectorArn,
        [ENV_LOGGING]: loggingEnvironment,
        ...(props.executionRole ? { [ENV_EXECUTION_ROLE_ARN]: props.executionRole.roleArn } : {}),
      },
    );

    return new lambda.Function(this, "ControllerFunction", {
      architecture: controllerProps.architecture ?? lambda.Architecture.ARM_64,
      tracing: controllerProps.tracing ?? lambda.Tracing.ACTIVE,
      memorySize: controllerProps.memorySize ?? 512,
      timeout: controllerProps.timeout ?? Duration.seconds(30),
      ...controllerProps,
      environment,
    });
  }

  private grantMicrovmControlPlane(props: AppTheoryMicrovmControllerProps): void {
    this.controllerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppTheoryMicrovmControlPlane",
        actions: [
          "lambda:CreateMicrovmAuthToken",
          "lambda:CreateMicrovmShellAuthToken",
          "lambda:GetMicrovm",
          "lambda:ResumeMicrovm",
          "lambda:RunMicrovm",
          "lambda:SuspendMicrovm",
          "lambda:TerminateMicrovm",
        ],
        // Lambda MicroVM control-plane operations are currently permission-only
        // actions. AppTheory constrains which image/connectors/role may be used
        // through typed construct props, fail-closed controller env, and scoped
        // iam:PassRole rather than pretending the service supports per-MicroVM
        // resource ARNs for these actions.
        resources: ["*"],
      }),
    );

    this.controllerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppTheoryMicrovmList",
        actions: ["lambda:ListMicrovms"],
        resources: ["*"],
      }),
    );

    this.controllerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "AppTheoryMicrovmPassNetworkConnectors",
        actions: ["lambda:PassNetworkConnector"],
        // Lambda marks PassNetworkConnector as permission-only without resource-level
        // support. AppTheory constrains the permitted connector set through typed props
        // and fail-closed environment wiring instead of accepting raw request strings.
        resources: ["*"],
      }),
    );

    if (props.executionRole) {
      props.executionRole.grantPassRole(this.controllerFunction.grantPrincipal);
    }
  }

  private addControllerRoutes(): void {
    for (const route of CONTROLLER_ROUTE_DEFINITIONS) {
      this.api.addRoutes({
        path: route.path,
        methods: [route.method],
        integration: new apigwv2Integrations.HttpLambdaIntegration(route.id, this.controllerFunction, {
          payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
        }),
        authorizer: this.routeAuthorizer,
      });
    }
  }
}

function needsExplicitStage(stageOpts: AppTheoryMicrovmControllerStageOptions, stageName: string): boolean {
  return stageName !== "$default"
    || stageOpts.accessLogging === true
    || stageOpts.throttlingRateLimit !== undefined
    || stageOpts.throttlingBurstLimit !== undefined;
}

function validateRequired(value: unknown, propName: string): void {
  if (value === undefined || value === null) {
    throw new Error(`AppTheoryMicrovmController requires props.${propName}`);
  }
}

function normalizeRequiredString(value: string | undefined, propName: string): string {
  if (value === undefined || value === null) {
    throw new Error(`AppTheoryMicrovmController requires props.${propName}`);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    throw new Error(`AppTheoryMicrovmController requires props.${propName}`);
  }
  return normalized;
}

function normalizeNoWhitespaceString(value: string | undefined, propName: string, maxLength: number): string {
  const normalized = normalizeRequiredString(value, propName);
  if (!Token.isUnresolved(value) && /\s/.test(normalized)) {
    throw new Error(`AppTheoryMicrovmController: ${propName} must not contain whitespace`);
  }
  if (!Token.isUnresolved(value) && normalized.length > maxLength) {
    throw new Error(`AppTheoryMicrovmController: ${propName} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function controllerLoggingEnvironment(
  logging: AppTheoryMicrovmImageLogging | undefined,
  executionRole: iam.IRole | undefined,
): string {
  if (logging === undefined || logging === null) {
    throw new Error("AppTheoryMicrovmController requires props.microvmImage.logging");
  }
  const hasCloudWatch = logging.cloudWatch !== undefined && logging.cloudWatch !== null;
  const hasDisabled = logging.disabled !== undefined;
  if (hasCloudWatch === hasDisabled) {
    throw new Error(
      "AppTheoryMicrovmController: props.microvmImage.logging must specify exactly one of cloudWatch or disabled",
    );
  }
  if (hasDisabled) {
    if (logging.disabled !== true) {
      throw new Error(
        "AppTheoryMicrovmController: props.microvmImage.logging.disabled must be true when provided",
      );
    }
    return JSON.stringify({ disabled: true });
  }
  if (!executionRole) {
    throw new Error(
      "AppTheoryMicrovmController requires props.executionRole when props.microvmImage.logging.cloudWatch is configured",
    );
  }

  const cloudWatch = logging.cloudWatch;
  if (!cloudWatch) {
    throw new Error("AppTheoryMicrovmController requires props.microvmImage.logging.cloudWatch");
  }
  const normalized: Record<string, string> = {};
  if (cloudWatch.logGroup !== undefined) {
    normalized.log_group = normalizeControllerLogGroup(cloudWatch.logGroup);
  }
  if (cloudWatch.logStream !== undefined) {
    normalized.log_stream = normalizeControllerLogStream(cloudWatch.logStream);
  }
  return JSON.stringify({ cloud_watch: normalized });
}

function normalizeControllerLogGroup(value: string): string {
  const normalized = normalizeRequiredString(value, "microvmImage.logging.cloudWatch.logGroup");
  if (!Token.isUnresolved(value) && !/^[a-zA-Z0-9_\-/.#]{1,512}$/.test(normalized)) {
    throw new Error(
      "AppTheoryMicrovmController: props.microvmImage.logging.cloudWatch.logGroup is outside the CloudWatch Logs pattern",
    );
  }
  return normalized;
}

function normalizeControllerLogStream(value: string): string {
  const normalized = normalizeRequiredString(value, "microvmImage.logging.cloudWatch.logStream");
  if (!Token.isUnresolved(value) && (!/^[^:*]*$/.test(normalized) || normalized.length > 512)) {
    throw new Error(
      "AppTheoryMicrovmController: props.microvmImage.logging.cloudWatch.logStream is outside the CloudWatch Logs pattern",
    );
  }
  return normalized;
}

function normalizeConnectorReferences(
  connectors: readonly IAppTheoryMicrovmNetworkConnector[] | undefined,
  propName: string,
  expectedKind: AppTheoryMicrovmNetworkConnectorKind,
): string[] {
  if (!connectors || connectors.length === 0) {
    throw new Error(`AppTheoryMicrovmController requires at least 1 ${propName} entry`);
  }
  if (connectors.length > 10) {
    throw new Error(`AppTheoryMicrovmController supports at most 10 ${propName} entries`);
  }

  const arns = connectors.map((connector, index) => {
    return normalizeSingleConnectorReference(connector, `${propName}[${index}]`, expectedKind);
  });

  assertNoDuplicates(arns, `${propName} networkConnectorArn`);
  return arns;
}

function normalizeSingleConnectorReference(
  connector: IAppTheoryMicrovmNetworkConnector | undefined,
  propName: string,
  expectedKind: AppTheoryMicrovmNetworkConnectorKind,
): string {
  if (connector === undefined || connector === null) {
    throw new Error(`AppTheoryMicrovmController requires props.${propName}`);
  }
  const actualKind = normalizeConnectorKindForController(connector.networkConnectorKind, propName);
  if (actualKind !== expectedKind) {
    throw new Error(
      `AppTheoryMicrovmController: props.${propName} must be a ${expectedKind} connector reference`,
    );
  }
  return normalizeNoWhitespaceString(connector.networkConnectorArn, `${propName}.networkConnectorArn`, 2048);
}

function normalizeConnectorKindForController(
  kind: AppTheoryMicrovmNetworkConnectorKind | string | undefined,
  propName: string,
): AppTheoryMicrovmNetworkConnectorKind {
  if (kind === undefined) {
    throw new Error(`AppTheoryMicrovmController: props.${propName} must include networkConnectorKind`);
  }
  const normalized = String(kind).trim().toLowerCase().replace(/[_-]/g, "");
  if (normalized === "ingress") {
    return AppTheoryMicrovmNetworkConnectorKind.INGRESS;
  }
  if (normalized === "egress") {
    return AppTheoryMicrovmNetworkConnectorKind.EGRESS;
  }
  if (normalized === "shellingress") {
    return AppTheoryMicrovmNetworkConnectorKind.SHELL_INGRESS;
  }
  throw new Error(
    `AppTheoryMicrovmController: props.${propName}.networkConnectorKind must be ingress, egress, or shell-ingress`,
  );
}

function dedupeConnectorArns(arns: string[]): string[] {
  assertNoDuplicates(arns, "controller networkConnectorArn");
  return arns;
}

function assertNoDuplicates(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (Token.isUnresolved(value)) {
      continue;
    }
    if (seen.has(value)) {
      throw new Error(`AppTheoryMicrovmController does not allow duplicate ${label} values`);
    }
    seen.add(value);
  }
}

function normalizeHeaderName(headerName: string): string {
  const trimmed = String(headerName ?? "").trim();
  if (!trimmed) {
    throw new Error("AppTheoryMicrovmController: authorizerHeaderName is required");
  }
  return trimmed;
}

function normalizeStageName(stageName: string): string {
  const trimmed = String(stageName ?? "").trim();
  if (!trimmed) {
    throw new Error("AppTheoryMicrovmController: stageName is required");
  }
  return trimmed;
}

function buildControllerEnvironment(
  userEnvironment: Record<string, string> | undefined,
  reservedEnvironment: Record<string, string>,
): Record<string, string> {
  const environment: Record<string, string> = { ...(userEnvironment ?? {}) };
  for (const key of RESERVED_ENV_KEYS) {
    if (Object.prototype.hasOwnProperty.call(environment, key)) {
      throw new Error(`AppTheoryMicrovmController: controller.environment cannot override reserved ${key}`);
    }
  }
  return { ...environment, ...reservedEnvironment };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}
