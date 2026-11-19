"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMicrovmController = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigwv2Authorizers = __importStar(require("aws-cdk-lib/aws-apigatewayv2-authorizers"));
const apigwv2Integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const constructs_1 = require("constructs");
const logical_name_1 = require("./private/logical-name");
const refuse_explicit_name_1 = require("./private/refuse-explicit-name");
const standard_logging_1 = require("./private/standard-logging");
const microvm_network_connector_1 = require("./microvm-network-connector");
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
const CONTROLLER_ROUTE_DEFINITIONS = [
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
 * AppTheory CDK construct for the first-class Lambda MicroVM controller deployment surface.
 *
 * The construct provisions the protected HTTP API routes from the M16 real controller contract,
 * the controller Lambda, the canonical durable session registry table, IAM grants, and
 * fail-closed auth environment wiring. Runtime command handling remains in the AppTheory
 * runtime contract; this construct only wires the deployment path.
 */
class AppTheoryMicrovmController extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmController", version: "7.4.0" };
    /**
     * The underlying HTTP API Gateway v2 API.
     */
    api;
    /**
     * The API Gateway stage.
     */
    stage;
    /**
     * Lambda request authorizer attached to every controller route.
     */
    routeAuthorizer;
    /**
     * The controller Lambda function created by this construct.
     */
    controllerFunction;
    /**
     * The durable TableTheory-shaped session registry DynamoDB table.
     */
    sessionTable;
    /**
     * The controller base endpoint (`/microvms`).
     */
    endpoint;
    /**
     * The access log group (if access logging is enabled).
     */
    accessLogGroup;
    scopePermissionToRoute;
    constructor(scope, id, props) {
        super(scope, id);
        if (props === undefined || props === null) {
            throw new Error("AppTheoryMicrovmController requires props");
        }
        validateRequired(props.controller, "controller");
        validateRequired(props.authorizer, "authorizer");
        validateRequired(props.microvmImage, "microvmImage");
        this.scopePermissionToRoute = props.scopePermissionToRoute ?? true;
        const imageArn = normalizeNoWhitespaceString(props.microvmImage.microvmImageArn, "microvmImage.microvmImageArn", 2048);
        const ingressConnectorArns = normalizeConnectorReferences(props.ingressNetworkConnectors, "ingressNetworkConnectors", microvm_network_connector_1.AppTheoryMicrovmNetworkConnectorKind.INGRESS);
        const egressConnectorArns = normalizeConnectorReferences(props.egressNetworkConnectors, "egressNetworkConnectors", microvm_network_connector_1.AppTheoryMicrovmNetworkConnectorKind.EGRESS);
        const shellIngressConnectorArn = normalizeSingleConnectorReference(props.shellIngressNetworkConnector, "shellIngressNetworkConnector", microvm_network_connector_1.AppTheoryMicrovmNetworkConnectorKind.SHELL_INGRESS);
        const allIngressConnectorArns = dedupeConnectorArns([...ingressConnectorArns, shellIngressConnectorArn]);
        assertNoDuplicates([...allIngressConnectorArns, ...egressConnectorArns], "controller networkConnectorArn");
        const loggingEnvironment = controllerLoggingEnvironment(props.microvmImage.logging, props.executionRole);
        const authorizerHeaderName = normalizeHeaderName(props.authorizerHeaderName ?? "Authorization");
        const namingContext = props.namingContext;
        const logical = props.logicalName ?? (namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryMicrovmController", "apiName", "api_http", logical, props.apiName !== undefined);
        if (namingContext && props.sessionTableName !== undefined) {
            // v0.1 names only the controller API through the contract. Refusing the
            // hand-built table name keeps section 4's explicit-name rule; the table
            // stays CloudFormation-generated until a contract revision adds its name.
            throw new Error("AppTheoryMicrovmController cannot honor props.sessionTableName when a naming context is present; the construct names only its API under the naming contract in v0.1, so remove the name and let CloudFormation generate the session table name");
        }
        const derivedApiName = namingContext && logical ? namingContext.physicalName("api_http", logical) : undefined;
        const stageOpts = effectiveStageOptions(props.stage ?? {}, namingContext);
        const stageName = normalizeStageName(stageOpts.stageName ?? "$default");
        this.sessionTable = this.createSessionTable(props);
        this.api = new apigwv2.HttpApi(this, "Api", {
            apiName: derivedApiName && !derivedApiName.generated ? derivedApiName.name : props.apiName,
            createDefaultStage: !needsExplicitStage(stageOpts, stageName),
        });
        const stage = this.createStage(stageOpts, stageName, namingContext, logical);
        if (!stage) {
            throw new Error("AppTheoryMicrovmController: failed to create API stage");
        }
        this.stage = stage;
        this.endpoint = stageName === "$default"
            ? `${stripTrailingSlash(this.api.apiEndpoint)}/microvms`
            : `${stripTrailingSlash(this.api.apiEndpoint)}/${stageName}/microvms`;
        this.controllerFunction = this.createControllerFunction(props, imageArn, allIngressConnectorArns, egressConnectorArns, shellIngressConnectorArn, loggingEnvironment);
        this.sessionTable.grantReadWriteData(this.controllerFunction);
        this.grantMicrovmControlPlane(props);
        this.routeAuthorizer = new apigwv2Authorizers.HttpLambdaAuthorizer("Authorizer", props.authorizer, {
            authorizerName: props.authorizerName,
            identitySource: [`$request.header.${authorizerHeaderName}`],
            resultsCacheTtl: props.authorizerCacheTtl ?? aws_cdk_lib_1.Duration.seconds(0),
            responseTypes: [apigwv2Authorizers.HttpLambdaResponseType.SIMPLE],
        });
        this.addControllerRoutes();
    }
    createSessionTable(props) {
        const billingMode = props.sessionTableBillingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
        const removalPolicy = props.sessionTableRemovalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
        const encryption = props.sessionTableEncryption ?? dynamodb.TableEncryption.AWS_MANAGED;
        const enablePITR = props.enableSessionTablePointInTimeRecovery ?? true;
        if (encryption === dynamodb.TableEncryption.CUSTOMER_MANAGED && !props.sessionTableEncryptionKey) {
            throw new Error("AppTheoryMicrovmController requires sessionTableEncryptionKey when sessionTableEncryption is CUSTOMER_MANAGED");
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
    createStage(stageOpts, stageName, namingContext, logical) {
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
            const standard = namingContext?.standardLogging === true && logical !== undefined;
            if (namingContext?.standardLogging === true && !logical) {
                throw new Error("AppTheoryMicrovmController standard logging requires a logical name");
            }
            // The construct-created access-log group is a logging resource: under the
            // standard profile it takes the contract log-source name, and under the
            // legacy profile it keeps today's CloudFormation-generated name and
            // consumes no naming entry (r3, ADV-1312-1).
            const logGroup = standard && logical
                ? new logs.LogGroup(this, "AccessLogs", {
                    logGroupName: namingContext.logGroupName(`logs/access/api/${logical}`),
                    retention: (0, standard_logging_1.retentionFor)(namingContext.retentionDays),
                })
                : new logs.LogGroup(this, "AccessLogs", {
                    retention: stageOpts.accessLogRetention ?? logs.RetentionDays.ONE_MONTH,
                });
            this.accessLogGroup = logGroup;
            const cfnStage = stage.node.defaultChild;
            cfnStage.accessLogSettings = {
                destinationArn: logGroup.logGroupArn,
                format: standard ? (0, standard_logging_1.httpApiAccessLogFormat)() : legacyAccessLogFormat(),
            };
        }
        return stage;
    }
    createControllerFunction(props, imageArn, ingressConnectorArns, egressConnectorArns, shellIngressConnectorArn, loggingEnvironment) {
        const controllerProps = props.controller;
        const environment = buildControllerEnvironment(controllerProps.environment, {
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
        });
        return new lambda.Function(this, "ControllerFunction", {
            architecture: controllerProps.architecture ?? lambda.Architecture.ARM_64,
            tracing: controllerProps.tracing ?? lambda.Tracing.ACTIVE,
            memorySize: controllerProps.memorySize ?? 512,
            timeout: controllerProps.timeout ?? aws_cdk_lib_1.Duration.seconds(30),
            ...controllerProps,
            environment,
        });
    }
    grantMicrovmControlPlane(props) {
        this.controllerFunction.addToRolePolicy(new iam.PolicyStatement({
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
            // Lambda MicroVM resource-level IAM scoping for these actions remains
            // untested, so the grant stays on "*". The one live observation (the
            // image-version list/delete operations) shows the control plane
            // authorizes the canonical colon-form image ARN (`...:microvm-image:<name>`)
            // and rejects the slash form with HTTP 403 AccessDenied regardless of
            // IAM (live-verified). AppTheory constrains which image/connectors/role
            // may be used through typed construct props, fail-closed controller env,
            // and scoped iam:PassRole rather than re-scoping these resource grants.
            resources: ["*"],
        }));
        this.controllerFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: "AppTheoryMicrovmList",
            actions: ["lambda:ListMicrovms"],
            resources: ["*"],
        }));
        this.controllerFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: "AppTheoryMicrovmPassNetworkConnectors",
            actions: ["lambda:PassNetworkConnector"],
            // Lambda marks PassNetworkConnector as permission-only without resource-level
            // support. AppTheory constrains the permitted connector set through typed props
            // and fail-closed environment wiring instead of accepting raw request strings.
            resources: ["*"],
        }));
        if (props.executionRole) {
            props.executionRole.grantPassRole(this.controllerFunction.grantPrincipal);
        }
    }
    addControllerRoutes() {
        for (const route of CONTROLLER_ROUTE_DEFINITIONS) {
            this.api.addRoutes({
                path: route.path,
                methods: [route.method],
                integration: new apigwv2Integrations.HttpLambdaIntegration(route.id, this.controllerFunction, {
                    payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
                    scopePermissionToRoute: this.scopePermissionToRoute,
                }),
                authorizer: this.routeAuthorizer,
            });
        }
    }
}
exports.AppTheoryMicrovmController = AppTheoryMicrovmController;
function legacyAccessLogFormat() {
    return JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        routeKey: "$context.routeKey",
        status: "$context.status",
        protocol: "$context.protocol",
        responseLength: "$context.responseLength",
        integrationLatency: "$context.integrationLatency",
    });
}
/**
 * Apply the standard logging profile's default-on access logging. An explicit
 * `accessLogging` value, including `false`, always wins.
 */
function effectiveStageOptions(stage, namingContext) {
    if (namingContext?.standardLogging === true && stage.accessLogging === undefined) {
        return { ...stage, accessLogging: true };
    }
    return stage;
}
function needsExplicitStage(stageOpts, stageName) {
    return stageName !== "$default"
        || stageOpts.accessLogging === true
        || stageOpts.throttlingRateLimit !== undefined
        || stageOpts.throttlingBurstLimit !== undefined;
}
function validateRequired(value, propName) {
    if (value === undefined || value === null) {
        throw new Error(`AppTheoryMicrovmController requires props.${propName}`);
    }
}
function normalizeRequiredString(value, propName) {
    if (value === undefined || value === null) {
        throw new Error(`AppTheoryMicrovmController requires props.${propName}`);
    }
    const normalized = String(value).trim();
    if (!normalized) {
        throw new Error(`AppTheoryMicrovmController requires props.${propName}`);
    }
    return normalized;
}
function normalizeNoWhitespaceString(value, propName, maxLength) {
    const normalized = normalizeRequiredString(value, propName);
    if (!aws_cdk_lib_1.Token.isUnresolved(value) && /\s/.test(normalized)) {
        throw new Error(`AppTheoryMicrovmController: ${propName} must not contain whitespace`);
    }
    if (!aws_cdk_lib_1.Token.isUnresolved(value) && normalized.length > maxLength) {
        throw new Error(`AppTheoryMicrovmController: ${propName} must be at most ${maxLength} characters`);
    }
    return normalized;
}
function controllerLoggingEnvironment(logging, executionRole) {
    if (logging === undefined || logging === null) {
        throw new Error("AppTheoryMicrovmController requires props.microvmImage.logging");
    }
    const hasCloudWatch = logging.cloudWatch !== undefined && logging.cloudWatch !== null;
    const hasDisabled = logging.disabled !== undefined;
    if (hasCloudWatch === hasDisabled) {
        throw new Error("AppTheoryMicrovmController: props.microvmImage.logging must specify exactly one of cloudWatch or disabled");
    }
    if (hasDisabled) {
        if (logging.disabled !== true) {
            throw new Error("AppTheoryMicrovmController: props.microvmImage.logging.disabled must be true when provided");
        }
        return JSON.stringify({ disabled: true });
    }
    if (!executionRole) {
        throw new Error("AppTheoryMicrovmController requires props.executionRole when props.microvmImage.logging.cloudWatch is configured");
    }
    const cloudWatch = logging.cloudWatch;
    if (!cloudWatch) {
        throw new Error("AppTheoryMicrovmController requires props.microvmImage.logging.cloudWatch");
    }
    const normalized = {};
    if (cloudWatch.logGroup !== undefined) {
        normalized.log_group = normalizeControllerLogGroup(cloudWatch.logGroup);
    }
    if (cloudWatch.logStream !== undefined) {
        normalized.log_stream = normalizeControllerLogStream(cloudWatch.logStream);
    }
    return JSON.stringify({ cloud_watch: normalized });
}
function normalizeControllerLogGroup(value) {
    const normalized = normalizeRequiredString(value, "microvmImage.logging.cloudWatch.logGroup");
    if (!aws_cdk_lib_1.Token.isUnresolved(value) && !/^[a-zA-Z0-9_\-/.#]{1,512}$/.test(normalized)) {
        throw new Error("AppTheoryMicrovmController: props.microvmImage.logging.cloudWatch.logGroup is outside the CloudWatch Logs pattern");
    }
    return normalized;
}
function normalizeControllerLogStream(value) {
    const normalized = normalizeRequiredString(value, "microvmImage.logging.cloudWatch.logStream");
    if (!aws_cdk_lib_1.Token.isUnresolved(value) && (!/^[^:*]*$/.test(normalized) || normalized.length > 512)) {
        throw new Error("AppTheoryMicrovmController: props.microvmImage.logging.cloudWatch.logStream is outside the CloudWatch Logs pattern");
    }
    return normalized;
}
function normalizeConnectorReferences(connectors, propName, expectedKind) {
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
function normalizeSingleConnectorReference(connector, propName, expectedKind) {
    if (connector === undefined || connector === null) {
        throw new Error(`AppTheoryMicrovmController requires props.${propName}`);
    }
    const actualKind = normalizeConnectorKindForController(connector.networkConnectorKind, propName);
    if (actualKind !== expectedKind) {
        throw new Error(`AppTheoryMicrovmController: props.${propName} must be a ${expectedKind} connector reference`);
    }
    return normalizeNoWhitespaceString(connector.networkConnectorArn, `${propName}.networkConnectorArn`, 2048);
}
function normalizeConnectorKindForController(kind, propName) {
    if (kind === undefined) {
        throw new Error(`AppTheoryMicrovmController: props.${propName} must include networkConnectorKind`);
    }
    const normalized = String(kind).trim().toLowerCase().replace(/[_-]/g, "");
    if (normalized === "ingress") {
        return microvm_network_connector_1.AppTheoryMicrovmNetworkConnectorKind.INGRESS;
    }
    if (normalized === "egress") {
        return microvm_network_connector_1.AppTheoryMicrovmNetworkConnectorKind.EGRESS;
    }
    if (normalized === "shellingress") {
        return microvm_network_connector_1.AppTheoryMicrovmNetworkConnectorKind.SHELL_INGRESS;
    }
    throw new Error(`AppTheoryMicrovmController: props.${propName}.networkConnectorKind must be ingress, egress, or shell-ingress`);
}
function dedupeConnectorArns(arns) {
    assertNoDuplicates(arns, "controller networkConnectorArn");
    return arns;
}
function assertNoDuplicates(values, label) {
    const seen = new Set();
    for (const value of values) {
        if (aws_cdk_lib_1.Token.isUnresolved(value)) {
            continue;
        }
        if (seen.has(value)) {
            throw new Error(`AppTheoryMicrovmController does not allow duplicate ${label} values`);
        }
        seen.add(value);
    }
}
function normalizeHeaderName(headerName) {
    const trimmed = String(headerName ?? "").trim();
    if (!trimmed) {
        throw new Error("AppTheoryMicrovmController: authorizerHeaderName is required");
    }
    return trimmed;
}
function normalizeStageName(stageName) {
    const trimmed = String(stageName ?? "").trim();
    if (!trimmed) {
        throw new Error("AppTheoryMicrovmController: stageName is required");
    }
    return trimmed;
}
function buildControllerEnvironment(userEnvironment, reservedEnvironment) {
    const environment = { ...(userEnvironment ?? {}) };
    for (const key of RESERVED_ENV_KEYS) {
        if (Object.prototype.hasOwnProperty.call(environment, key)) {
            throw new Error(`AppTheoryMicrovmController: controller.environment cannot override reserved ${key}`);
        }
    }
    return { ...environment, ...reservedEnvironment };
}
function stripTrailingSlash(url) {
    return url.replace(/\/$/, "");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1jb250cm9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1jb250cm9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkQ7QUFDN0Qsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBQ3JELHlEQUEyQztBQUUzQywrREFBaUQ7QUFDakQsMkRBQTZDO0FBQzdDLDJDQUF1QztBQUV2Qyx5REFBNEQ7QUFDNUQseUVBQW9FO0FBQ3BFLGlFQUFrRjtBQUdsRiwyRUFHcUM7QUFFckMsTUFBTSxxQkFBcUIsR0FBRywwQkFBMEIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLGdCQUFnQixDQUFDO0FBQ2xELE1BQU0sd0JBQXdCLEdBQUcsTUFBTSxDQUFDO0FBQ3hDLE1BQU0sdUJBQXVCLEdBQUcsTUFBTSxDQUFDO0FBQ3ZDLE1BQU0scUJBQXFCLEdBQUc7SUFDNUIsS0FBSztJQUNMLEtBQUs7SUFDTCxNQUFNO0lBQ04sU0FBUztJQUNULFFBQVE7SUFDUixXQUFXO0lBQ1gsUUFBUTtJQUNSLFlBQVk7SUFDWixrQkFBa0I7Q0FDbkIsQ0FBQztBQUNGLE1BQU0sNEJBQTRCLEdBQW9FO0lBQ3BHLEVBQUUsRUFBRSxFQUFFLFlBQVksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLFdBQVcsRUFBRTtJQUN4RSxFQUFFLEVBQUUsRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUU7SUFDekUsRUFBRSxFQUFFLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsd0JBQXdCLEVBQUU7SUFDcEYsRUFBRSxFQUFF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RSxHQUFHLG1CQUFtQixFQUFFLENBQUM7QUFDcEQsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsR0FBVztJQUNyQyxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ2hDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMga21zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgaHR0cEFwaUFjY2Vzc0xvZ0Zvcm1hdCwgcmV0ZW50aW9uRm9yIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdGFuZGFyZC1sb2dnaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nLCBJQXBwVGhlb3J5TWljcm92bUltYWdlIH0gZnJvbSBcIi4vbWljcm92bS1pbWFnZVwiO1xuaW1wb3J0IHtcbiAgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuICB0eXBlIElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvcixcbn0gZnJvbSBcIi4vbWljcm92bS1uZXR3b3JrLWNvbm5lY3RvclwiO1xuXG5jb25zdCBNSUNST1ZNX0NPTlRSQUNUX05BTUUgPSBcImFwcHRoZW9yeS5sYW1iZGFfbWljcm92bVwiO1xuY29uc3QgTUlDUk9WTV9DT05UUkFDVF9WRVJTSU9OID0gXCJtMTYubWljcm92bS92MVwiO1xuY29uc3QgQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEID0gXCJ0cnVlXCI7XG5jb25zdCBDT05UUk9MTEVSX0FVVEhfREVGQVVMVCA9IFwiZGVueVwiO1xuY29uc3QgQ09OVFJPTExFUl9PUEVSQVRJT05TID0gW1xuICBcInJ1blwiLFxuICBcImdldFwiLFxuICBcImxpc3RcIixcbiAgXCJzdXNwZW5kXCIsXG4gIFwicmVzdW1lXCIsXG4gIFwidGVybWluYXRlXCIsXG4gIFwiaW52b2tlXCIsXG4gIFwiYXV0aC10b2tlblwiLFxuICBcInNoZWxsLWF1dGgtdG9rZW5cIixcbl07XG5jb25zdCBDT05UUk9MTEVSX1JPVVRFX0RFRklOSVRJT05TOiBBcnJheTx7IGlkOiBzdHJpbmc7IG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kOyBwYXRoOiBzdHJpbmcgfT4gPSBbXG4gIHsgaWQ6IFwiUnVuTWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztc1wiIH0sXG4gIHsgaWQ6IFwiTGlzdE1pY3Jvdm1zXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogXCIvbWljcm92bXNcIiB9LFxuICB7IGlkOiBcIkdldE1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH1cIiB9LFxuICB7IGlkOiBcIlN1c3BlbmRNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9zdXNwZW5kXCIgfSxcbiAgeyBpZDogXCJSZXN1bWVNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9yZXN1bWVcIiB9LFxuICB7IGlkOiBcIlRlcm1pbmF0ZU1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFLCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH1cIiB9LFxuICB7IGlkOiBcIkludm9rZU1pY3Jvdm1Sb290XCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L2ludm9rZVwiIH0sXG4gIHsgaWQ6IFwiSW52b2tlTWljcm92bVByb3h5XCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L2ludm9rZS97cHJveHkrfVwiIH0sXG4gIHsgaWQ6IFwiQ3JlYXRlTWljcm92bUF1dGhUb2tlblwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vYXV0aC10b2tlblwiIH0sXG4gIHtcbiAgICBpZDogXCJDcmVhdGVNaWNyb3ZtU2hlbGxBdXRoVG9rZW5cIixcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULFxuICAgIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9zaGVsbC1hdXRoLXRva2VuXCIsXG4gIH0sXG5dO1xuXG5jb25zdCBFTlZfQ09OVFJBQ1RfTkFNRSA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJBQ1RfTkFNRVwiO1xuY29uc3QgRU5WX0NPTlRSQUNUX1ZFUlNJT04gPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRSQUNUX1ZFUlNJT05cIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0VORFBPSU5UID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0VORFBPSU5UXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9PUEVSQVRJT05TID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX09QRVJBVElPTlNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX1JPVVRFUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9ST1VURVNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRFwiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0FVVEhfREVGQVVMVFwiO1xuY29uc3QgRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEUgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX1NFU1NJT05fUkVHSVNUUllfVEFCTEVcIjtcbmNvbnN0IEVOVl9JTUFHRV9SRUYgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX1JFRlwiO1xuY29uc3QgRU5WX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX05FVFdPUktfQ09OTkVDVE9SX1JFRlNcIjtcbmNvbnN0IEVOVl9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTID0gXCJBUFBUSEVPUllfTUlDUk9WTV9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGID0gXCJBUFBUSEVPUllfTUlDUk9WTV9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlwiO1xuY29uc3QgRU5WX0VYRUNVVElPTl9ST0xFX0FSTiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fRVhFQ1VUSU9OX1JPTEVfQVJOXCI7XG5jb25zdCBFTlZfTE9HR0lORyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fTE9HR0lOR1wiO1xuXG5jb25zdCBSRVNFUlZFRF9FTlZfS0VZUyA9IFtcbiAgRU5WX0NPTlRSQUNUX05BTUUsXG4gIEVOVl9DT05UUkFDVF9WRVJTSU9OLFxuICBFTlZfQ09OVFJPTExFUl9FTkRQT0lOVCxcbiAgRU5WX0NPTlRST0xMRVJfT1BFUkFUSU9OUyxcbiAgRU5WX0NPTlRST0xMRVJfUk9VVEVTLFxuICBFTlZfQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVELFxuICBFTlZfQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQsXG4gIEVOVl9TRVNTSU9OX1JFR0lTVFJZX1RBQkxFLFxuICBFTlZfSU1BR0VfUkVGLFxuICBFTlZfTkVUV09SS19DT05ORUNUT1JfUkVGUyxcbiAgRU5WX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGUyxcbiAgRU5WX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTLFxuICBFTlZfU0hFTExfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUYsXG4gIEVOVl9FWEVDVVRJT05fUk9MRV9BUk4sXG4gIEVOVl9MT0dHSU5HLFxuXTtcblxuLyoqXG4gKiBTdGFnZSBjb25maWd1cmF0aW9uIGZvciB0aGUgTWljcm9WTSBjb250cm9sbGVyIEhUVFAgQVBJLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0IGZvciB0aGUgc3RhZ2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFBhY2thZ2luZyBhbmQgcnVudGltZSBjb25maWd1cmF0aW9uIGZvciB0aGUgQXBwVGhlb3J5IE1pY3JvVk0gY29udHJvbGxlciBMYW1iZGEuXG4gKlxuICogQXBwVGhlb3J5IGNyZWF0ZXMgdGhlIExhbWJkYSBmdW5jdGlvbiBzbyBpdCBjYW4gd2lyZSB0aGUgY2Fub25pY2FsIHNlc3Npb24gdGFibGUsXG4gKiBNaWNyb1ZNIGltYWdlL25ldHdvcmsgcmVmZXJlbmNlcywgYW5kIGZhaWwtY2xvc2VkIGF1dGggZW52aXJvbm1lbnQgY29uc2lzdGVudGx5LlxuICogVGhlIGNhbGxlciBzdXBwbGllcyBvbmx5IHRoZSBoYW5kbGVyIHBhY2thZ2UgZGV0YWlscyBhbmQgYW55IG9yZGluYXJ5IExhbWJkYVxuICogRnVuY3Rpb25Qcm9wcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlckZ1bmN0aW9uUHJvcHMgZXh0ZW5kcyBsYW1iZGEuRnVuY3Rpb25Qcm9wcyB7fVxuXG4vKipcbiAqIFByb3BzIGZvciBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzIHtcbiAgLyoqXG4gICAqIENvbnRyb2xsZXIgTGFtYmRhIHBhY2thZ2luZyBhbmQgY29uZmlndXJhdGlvbi5cbiAgICpcbiAgICogVGhlIGhhbmRsZXIgY29kZSBtdXN0IHVzZSBBcHBUaGVvcnkncyBNaWNyb1ZNIHJ1bnRpbWUvY29udHJvbGxlciBwcmltaXRpdmVzLlxuICAgKiBUaGlzIGNvbnN0cnVjdCBkb2VzIG5vdCBpbXBsZW1lbnQgYSBwcm9kdWN0IGNvbnRyb2wtcGxhbmUgc2VydmljZS5cbiAgICovXG4gIHJlYWRvbmx5IGNvbnRyb2xsZXI6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyRnVuY3Rpb25Qcm9wcztcblxuICAvKipcbiAgICogTGFtYmRhIHJlcXVlc3QgYXV0aG9yaXplciByZXF1aXJlZCBmb3IgZXZlcnkgY29udHJvbGxlciByb3V0ZS5cbiAgICpcbiAgICogVGhlIGNvbnN0cnVjdCBmYWlscyBjbG9zZWQgd2hlbiB0aGlzIGlzIG9taXR0ZWQ7IHVuYXV0aGVudGljYXRlZCBjb250cm9sbGVyIHJvdXRlc1xuICAgKiBhcmUgbm90IHN5bnRoZXNpemVkLlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplcjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogVGhlIE1pY3JvVk0gaW1hZ2UgdGhlIGNvbnRyb2xsZXIgaXMgcGVybWl0dGVkIHRvIHJ1bi5cbiAgICovXG4gIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZTogSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZTtcblxuICAvKipcbiAgICogSW5ncmVzcyBuZXR3b3JrIGNvbm5lY3RvcnMgdGhlIGNvbnRyb2xsZXIgaXMgcGVybWl0dGVkIHRvIHBhc3MgdG8gTGFtYmRhIE1pY3JvVk1zLlxuICAgKlxuICAgKiBBdCBsZWFzdCBvbmUgY29ubmVjdG9yIHJlZmVyZW5jZSBpcyByZXF1aXJlZCBhbmQgbm8gbW9yZSB0aGFuIDEwIG1heSBiZSBzdXBwbGllZC5cbiAgICogVXNlIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yLmFsbEluZ3Jlc3Mvbm9JbmdyZXNzIG9yIGFuIGV4cGxpY2l0bHkgdHlwZWRcbiAgICogaW1wb3J0ZWQgaW5ncmVzcyBjb25uZWN0b3IgcmVmZXJlbmNlOyBBcHBUaGVvcnkgZG9lcyBub3QgaGlkZSBhbiBpbmdyZXNzIGRlZmF1bHQuXG4gICAqL1xuICByZWFkb25seSBpbmdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBFZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBwYXNzIHRvIExhbWJkYSBNaWNyb1ZNcy5cbiAgICpcbiAgICogQXQgbGVhc3Qgb25lIGNvbm5lY3RvciByZWZlcmVuY2UgaXMgcmVxdWlyZWQgYW5kIG5vIG1vcmUgdGhhbiAxMCBtYXkgYmUgc3VwcGxpZWQuXG4gICAqL1xuICByZWFkb25seSBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yczogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW107XG5cbiAgLyoqXG4gICAqIFNoZWxsIGluZ3Jlc3MgY29ubmVjdG9yIHJlcXVpcmVkIGZvciBzaGVsbC1hdXRoLXRva2VuIHN1cHBvcnQuXG4gICAqXG4gICAqIFVzZSBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvci5zaGVsbEluZ3Jlc3Mgb3IgYW4gZXhwbGljaXRseSB0eXBlZCBzaGVsbC1pbmdyZXNzXG4gICAqIGNvbm5lY3RvciByZWZlcmVuY2UuIFRoZSBzaGVsbC1hdXRoLXRva2VuIHJvdXRlIGlzIHBhcnQgb2YgdGhlIHJlYWwgTTE2IGNvbnRyb2xsZXJcbiAgICogc3VyZmFjZSwgc28gdGhpcyByZWZlcmVuY2UgaXMgcmVxdWlyZWQgaW5zdGVhZCBvZiBiZWluZyBzaWxlbnRseSBkZWZhdWx0ZWQuXG4gICAqL1xuICByZWFkb25seSBzaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3I7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIE1pY3JvVk0gZXhlY3V0aW9uIHJvbGUgcGFzc2VkIHRvIFJ1bk1pY3Jvdm0uXG4gICAqXG4gICAqIFdoZW4gc3VwcGxpZWQsIEFwcFRoZW9yeSBncmFudHMgdGhlIGNvbnRyb2xsZXIgTGFtYmRhIGlhbTpQYXNzUm9sZSBmb3IgdGhpcyByb2xlXG4gICAqIGFuZCBleHBvc2VzIHRoZSBBUk4gYXMgQVBQVEhFT1JZX01JQ1JPVk1fRVhFQ1VUSU9OX1JPTEVfQVJOLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGV4ZWN1dGlvblJvbGU/OiBpYW0uSVJvbGU7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIEFQSSBuYW1lLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgKlxuICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgQVBJIGFjY2VzcyBsb2dnaW5nIGlzIG9uIGJ5IGRlZmF1bHQgdG8gYVxuICAgKiBsb2cgZ3JvdXAgbmFtZWQgYGxvZ3MvYWNjZXNzL2FwaS97bG9naWNhbE5hbWV9YCBjYXJyeWluZyB0aGUgY29udHJhY3Qnc1xuICAgKiBKU09OIGZpZWxkIHNldC4gUGFzcyBgc3RhZ2UuYWNjZXNzTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQuXG4gICAqXG4gICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkIHdoZW4gYVxuICAgKiBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBzdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGRlZmF1bHQgSFRUUCBBUEkgc3RhZ2UpXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIGNvbnRyb2xsZXIgcm91dGVzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICogb25lIHBlcm1pc3Npb24gcGVyIGNvbnRyb2xsZXIgcm91dGUuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3IgdGhlIGNhbm9uaWNhbFxuICAgKiBjb250cm9sbGVyIHJvdXRlIGZhbWlseSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlXG4gICAqIHBvbGljeSBzaXplIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgY29udHJvbGxlciBMYW1iZGEsIG5vdCBvbmx5IHRoZSBjb250cm9sbGVyIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogTmFtZSBmb3IgdGhlIGR1cmFibGUgTWljcm9WTSBzZXNzaW9uIHJlZ2lzdHJ5IER5bmFtb0RCIHRhYmxlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZClcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEJpbGxpbmcgbW9kZSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFBBWV9QRVJfUkVRVUVTVFxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlQmlsbGluZ01vZGU/OiBkeW5hbW9kYi5CaWxsaW5nTW9kZTtcblxuICAvKipcbiAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIHRoZSBzZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgZGVsZXRpb24gcHJvdGVjdGlvbiBzaG91bGQgYmUgZW5hYmxlZCBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gQVdTIGRlZmF1bHQgKG5vIGRlbGV0aW9uIHByb3RlY3Rpb24pXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVEZWxldGlvblByb3RlY3Rpb24/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHBvaW50LWluLXRpbWUgcmVjb3Zlcnkgc2hvdWxkIGJlIGVuYWJsZWQgZm9yIHRoZSBzZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVTZXNzaW9uVGFibGVQb2ludEluVGltZVJlY292ZXJ5PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogU2Vzc2lvbiByZWdpc3RyeSB0YWJsZSBlbmNyeXB0aW9uIHNldHRpbmcuXG4gICAqXG4gICAqIEBkZWZhdWx0IEFXU19NQU5BR0VEXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVFbmNyeXB0aW9uPzogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uO1xuXG4gIC8qKlxuICAgKiBDdXN0b21lci1tYW5hZ2VkIEtNUyBrZXkgZm9yIHRoZSBzZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlLlxuICAgKlxuICAgKiBSZXF1aXJlZCB3aGVuIHNlc3Npb25UYWJsZUVuY3J5cHRpb24gaXMgQ1VTVE9NRVJfTUFOQUdFRC5cbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXk/OiBrbXMuSUtleTtcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgcmVhZCBjYXBhY2l0eSB3aGVuIHNlc3Npb25UYWJsZUJpbGxpbmdNb2RlIGlzIFBST1ZJU0lPTkVELlxuICAgKlxuICAgKiBAZGVmYXVsdCA1XG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVSZWFkQ2FwYWNpdHk/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFByb3Zpc2lvbmVkIHdyaXRlIGNhcGFjaXR5IHdoZW4gc2Vzc2lvblRhYmxlQmlsbGluZ01vZGUgaXMgUFJPVklTSU9ORUQuXG4gICAqXG4gICAqIEBkZWZhdWx0IDVcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZVdyaXRlQ2FwYWNpdHk/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIEhlYWRlciB1c2VkIGFzIHRoZSBpZGVudGl0eSBzb3VyY2UgZm9yIGNvbnRyb2xsZXIgYXV0aG9yaXphdGlvbi5cbiAgICpcbiAgICogQGRlZmF1bHQgXCJBdXRob3JpemF0aW9uXCJcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJIZWFkZXJOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGcmllbmRseSBhdXRob3JpemVyIG5hbWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExhbWJkYSBhdXRob3JpemVyIHJlc3VsdCBjYWNoZSBUVEwuXG4gICAqXG4gICAqIERlZmF1bHRzIHRvIGRpc2FibGVkIHNvIHN0YWxlIGF1dGggY2Fubm90IHNpbGVudGx5IGJyb2FkZW4gY29udHJvbGxlciBhY2Nlc3MuXG4gICAqXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLnNlY29uZHMoMClcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJDYWNoZVR0bD86IER1cmF0aW9uO1xufVxuXG4vKipcbiAqIEFwcFRoZW9yeSBDREsgY29uc3RydWN0IGZvciB0aGUgZmlyc3QtY2xhc3MgTGFtYmRhIE1pY3JvVk0gY29udHJvbGxlciBkZXBsb3ltZW50IHN1cmZhY2UuXG4gKlxuICogVGhlIGNvbnN0cnVjdCBwcm92aXNpb25zIHRoZSBwcm90ZWN0ZWQgSFRUUCBBUEkgcm91dGVzIGZyb20gdGhlIE0xNiByZWFsIGNvbnRyb2xsZXIgY29udHJhY3QsXG4gKiB0aGUgY29udHJvbGxlciBMYW1iZGEsIHRoZSBjYW5vbmljYWwgZHVyYWJsZSBzZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlLCBJQU0gZ3JhbnRzLCBhbmRcbiAqIGZhaWwtY2xvc2VkIGF1dGggZW52aXJvbm1lbnQgd2lyaW5nLiBSdW50aW1lIGNvbW1hbmQgaGFuZGxpbmcgcmVtYWlucyBpbiB0aGUgQXBwVGhlb3J5XG4gKiBydW50aW1lIGNvbnRyYWN0OyB0aGlzIGNvbnN0cnVjdCBvbmx5IHdpcmVzIHRoZSBkZXBsb3ltZW50IHBhdGguXG4gKi9cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBleHRlbmRzIENvbnN0cnVjdCB7XG4gIC8qKlxuICAgKiBUaGUgdW5kZXJseWluZyBIVFRQIEFQSSBHYXRld2F5IHYyIEFQSS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuSHR0cEFwaTtcblxuICAvKipcbiAgICogVGhlIEFQSSBHYXRld2F5IHN0YWdlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlnd3YyLklTdGFnZTtcblxuICAvKipcbiAgICogTGFtYmRhIHJlcXVlc3QgYXV0aG9yaXplciBhdHRhY2hlZCB0byBldmVyeSBjb250cm9sbGVyIHJvdXRlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHJvdXRlQXV0aG9yaXplcjogYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFBdXRob3JpemVyO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJvbGxlciBMYW1iZGEgZnVuY3Rpb24gY3JlYXRlZCBieSB0aGlzIGNvbnN0cnVjdC5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBjb250cm9sbGVyRnVuY3Rpb246IGxhbWJkYS5GdW5jdGlvbjtcblxuICAvKipcbiAgICogVGhlIGR1cmFibGUgVGFibGVUaGVvcnktc2hhcGVkIHNlc3Npb24gcmVnaXN0cnkgRHluYW1vREIgdGFibGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc2Vzc2lvblRhYmxlOiBkeW5hbW9kYi5UYWJsZTtcblxuICAvKipcbiAgICogVGhlIGNvbnRyb2xsZXIgYmFzZSBlbmRwb2ludCAoYC9taWNyb3Ztc2ApLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGVuZHBvaW50OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIFRoZSBhY2Nlc3MgbG9nIGdyb3VwIChpZiBhY2Nlc3MgbG9nZ2luZyBpcyBlbmFibGVkKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIHByaXZhdGUgcmVhZG9ubHkgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogYm9vbGVhbjtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAocHJvcHMgPT09IHVuZGVmaW5lZCB8fCBwcm9wcyA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHNcIik7XG4gICAgfVxuICAgIHZhbGlkYXRlUmVxdWlyZWQocHJvcHMuY29udHJvbGxlciwgXCJjb250cm9sbGVyXCIpO1xuICAgIHZhbGlkYXRlUmVxdWlyZWQocHJvcHMuYXV0aG9yaXplciwgXCJhdXRob3JpemVyXCIpO1xuICAgIHZhbGlkYXRlUmVxdWlyZWQocHJvcHMubWljcm92bUltYWdlLCBcIm1pY3Jvdm1JbWFnZVwiKTtcbiAgICB0aGlzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPSBwcm9wcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID8/IHRydWU7XG5cbiAgICBjb25zdCBpbWFnZUFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhwcm9wcy5taWNyb3ZtSW1hZ2UubWljcm92bUltYWdlQXJuLCBcIm1pY3Jvdm1JbWFnZS5taWNyb3ZtSW1hZ2VBcm5cIiwgMjA0OCk7XG4gICAgY29uc3QgaW5ncmVzc0Nvbm5lY3RvckFybnMgPSBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICAgICAgcHJvcHMuaW5ncmVzc05ldHdvcmtDb25uZWN0b3JzLFxuICAgICAgXCJpbmdyZXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5JTkdSRVNTLFxuICAgICk7XG4gICAgY29uc3QgZWdyZXNzQ29ubmVjdG9yQXJucyA9IG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gICAgICBwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyxcbiAgICAgIFwiZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5FR1JFU1MsXG4gICAgKTtcbiAgICBjb25zdCBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm4gPSBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoXG4gICAgICBwcm9wcy5zaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yLFxuICAgICAgXCJzaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yXCIsXG4gICAgICBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuU0hFTExfSU5HUkVTUyxcbiAgICApO1xuICAgIGNvbnN0IGFsbEluZ3Jlc3NDb25uZWN0b3JBcm5zID0gZGVkdXBlQ29ubmVjdG9yQXJucyhbLi4uaW5ncmVzc0Nvbm5lY3RvckFybnMsIHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybl0pO1xuICAgIGFzc2VydE5vRHVwbGljYXRlcyhbLi4uYWxsSW5ncmVzc0Nvbm5lY3RvckFybnMsIC4uLmVncmVzc0Nvbm5lY3RvckFybnNdLCBcImNvbnRyb2xsZXIgbmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgICBjb25zdCBsb2dnaW5nRW52aXJvbm1lbnQgPSBjb250cm9sbGVyTG9nZ2luZ0Vudmlyb25tZW50KHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLCBwcm9wcy5leGVjdXRpb25Sb2xlKTtcbiAgICBjb25zdCBhdXRob3JpemVySGVhZGVyTmFtZSA9IG5vcm1hbGl6ZUhlYWRlck5hbWUocHJvcHMuYXV0aG9yaXplckhlYWRlck5hbWUgPz8gXCJBdXRob3JpemF0aW9uXCIpO1xuICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAobmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKG5hbWluZ0NvbnRleHQsIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJcIiwgXCJhcGlOYW1lXCIsIFwiYXBpX2h0dHBcIiwgbG9naWNhbCwgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICBpZiAobmFtaW5nQ29udGV4dCAmJiBwcm9wcy5zZXNzaW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIC8vIHYwLjEgbmFtZXMgb25seSB0aGUgY29udHJvbGxlciBBUEkgdGhyb3VnaCB0aGUgY29udHJhY3QuIFJlZnVzaW5nIHRoZVxuICAgICAgLy8gaGFuZC1idWlsdCB0YWJsZSBuYW1lIGtlZXBzIHNlY3Rpb24gNCdzIGV4cGxpY2l0LW5hbWUgcnVsZTsgdGhlIHRhYmxlXG4gICAgICAvLyBzdGF5cyBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgdW50aWwgYSBjb250cmFjdCByZXZpc2lvbiBhZGRzIGl0cyBuYW1lLlxuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIGNhbm5vdCBob25vciBwcm9wcy5zZXNzaW9uVGFibGVOYW1lIHdoZW4gYSBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50OyB0aGUgY29uc3RydWN0IG5hbWVzIG9ubHkgaXRzIEFQSSB1bmRlciB0aGUgbmFtaW5nIGNvbnRyYWN0IGluIHYwLjEsIHNvIHJlbW92ZSB0aGUgbmFtZSBhbmQgbGV0IENsb3VkRm9ybWF0aW9uIGdlbmVyYXRlIHRoZSBzZXNzaW9uIHRhYmxlIG5hbWVcIixcbiAgICAgICk7XG4gICAgfVxuICAgIGNvbnN0IGRlcml2ZWRBcGlOYW1lID0gbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsID8gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJhcGlfaHR0cFwiLCBsb2dpY2FsKSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBzdGFnZU9wdHMgPSBlZmZlY3RpdmVTdGFnZU9wdGlvbnMocHJvcHMuc3RhZ2UgPz8ge30sIG5hbWluZ0NvbnRleHQpO1xuICAgIGNvbnN0IHN0YWdlTmFtZSA9IG5vcm1hbGl6ZVN0YWdlTmFtZShzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIik7XG5cbiAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRoaXMuY3JlYXRlU2Vzc2lvblRhYmxlKHByb3BzKTtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBkZXJpdmVkQXBpTmFtZSAmJiAhZGVyaXZlZEFwaU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZEFwaU5hbWUubmFtZSA6IHByb3BzLmFwaU5hbWUsXG4gICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6ICFuZWVkc0V4cGxpY2l0U3RhZ2Uoc3RhZ2VPcHRzLCBzdGFnZU5hbWUpLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhZ2UgPSB0aGlzLmNyZWF0ZVN0YWdlKHN0YWdlT3B0cywgc3RhZ2VOYW1lLCBuYW1pbmdDb250ZXh0LCBsb2dpY2FsKTtcbiAgICBpZiAoIXN0YWdlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogZmFpbGVkIHRvIGNyZWF0ZSBBUEkgc3RhZ2VcIik7XG4gICAgfVxuICAgIHRoaXMuc3RhZ2UgPSBzdGFnZTtcblxuICAgIHRoaXMuZW5kcG9pbnQgPSBzdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgPyBgJHtzdHJpcFRyYWlsaW5nU2xhc2godGhpcy5hcGkuYXBpRW5kcG9pbnQpfS9taWNyb3Ztc2BcbiAgICAgIDogYCR7c3RyaXBUcmFpbGluZ1NsYXNoKHRoaXMuYXBpLmFwaUVuZHBvaW50KX0vJHtzdGFnZU5hbWV9L21pY3Jvdm1zYDtcblxuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uID0gdGhpcy5jcmVhdGVDb250cm9sbGVyRnVuY3Rpb24oXG4gICAgICBwcm9wcyxcbiAgICAgIGltYWdlQXJuLFxuICAgICAgYWxsSW5ncmVzc0Nvbm5lY3RvckFybnMsXG4gICAgICBlZ3Jlc3NDb25uZWN0b3JBcm5zLFxuICAgICAgc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuLFxuICAgICAgbG9nZ2luZ0Vudmlyb25tZW50LFxuICAgICk7XG4gICAgdGhpcy5zZXNzaW9uVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuY29udHJvbGxlckZ1bmN0aW9uKTtcbiAgICB0aGlzLmdyYW50TWljcm92bUNvbnRyb2xQbGFuZShwcm9wcyk7XG5cbiAgICB0aGlzLnJvdXRlQXV0aG9yaXplciA9IG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXIoXCJBdXRob3JpemVyXCIsIHByb3BzLmF1dGhvcml6ZXIsIHtcbiAgICAgIGF1dGhvcml6ZXJOYW1lOiBwcm9wcy5hdXRob3JpemVyTmFtZSxcbiAgICAgIGlkZW50aXR5U291cmNlOiBbYCRyZXF1ZXN0LmhlYWRlci4ke2F1dGhvcml6ZXJIZWFkZXJOYW1lfWBdLFxuICAgICAgcmVzdWx0c0NhY2hlVHRsOiBwcm9wcy5hdXRob3JpemVyQ2FjaGVUdGwgPz8gRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgIHJlc3BvbnNlVHlwZXM6IFthcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYVJlc3BvbnNlVHlwZS5TSU1QTEVdLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRDb250cm9sbGVyUm91dGVzKCk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlc3Npb25UYWJsZShwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyk6IGR5bmFtb2RiLlRhYmxlIHtcbiAgICBjb25zdCBiaWxsaW5nTW9kZSA9IHByb3BzLnNlc3Npb25UYWJsZUJpbGxpbmdNb2RlID8/IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVDtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuc2Vzc2lvblRhYmxlUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCBlbmNyeXB0aW9uID0gcHJvcHMuc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiA/PyBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQ7XG4gICAgY29uc3QgZW5hYmxlUElUUiA9IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZVBvaW50SW5UaW1lUmVjb3ZlcnkgPz8gdHJ1ZTtcblxuICAgIGlmIChlbmNyeXB0aW9uID09PSBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQ1VTVE9NRVJfTUFOQUdFRCAmJiAhcHJvcHMuc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXkgd2hlbiBzZXNzaW9uVGFibGVFbmNyeXB0aW9uIGlzIENVU1RPTUVSX01BTkFHRURcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgdGFibGVOYW1lID0gcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSA9PT0gdW5kZWZpbmVkXG4gICAgICA/IHVuZGVmaW5lZFxuICAgICAgOiBub3JtYWxpemVSZXF1aXJlZFN0cmluZyhwcm9wcy5zZXNzaW9uVGFibGVOYW1lLCBcInNlc3Npb25UYWJsZU5hbWVcIik7XG5cbiAgICByZXR1cm4gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgIHRhYmxlTmFtZSxcbiAgICAgIGJpbGxpbmdNb2RlLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwicGtcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJza1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJ0dGxcIixcbiAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICBkZWxldGlvblByb3RlY3Rpb246IHByb3BzLnNlc3Npb25UYWJsZURlbGV0aW9uUHJvdGVjdGlvbixcbiAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiBlbmFibGVQSVRSLFxuICAgICAgfSxcbiAgICAgIGVuY3J5cHRpb24sXG4gICAgICBlbmNyeXB0aW9uS2V5OiBwcm9wcy5zZXNzaW9uVGFibGVFbmNyeXB0aW9uS2V5LFxuICAgICAgLi4uKGJpbGxpbmdNb2RlID09PSBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJlYWRDYXBhY2l0eTogcHJvcHMuc2Vzc2lvblRhYmxlUmVhZENhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgICB3cml0ZUNhcGFjaXR5OiBwcm9wcy5zZXNzaW9uVGFibGVXcml0ZUNhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgfVxuICAgICAgICA6IHt9KSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU3RhZ2UoXG4gICAgc3RhZ2VPcHRzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyxcbiAgICBzdGFnZU5hbWU6IHN0cmluZyxcbiAgICBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCxcbiAgICBsb2dpY2FsPzogc3RyaW5nLFxuICApOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKCFuZWVkc0V4cGxpY2l0U3RhZ2Uoc3RhZ2VPcHRzLCBzdGFnZU5hbWUpKSB7XG4gICAgICByZXR1cm4gdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YWdlID0gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZU5hbWUsXG4gICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgdGhyb3R0bGU6IChzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgY29uc3Qgc3RhbmRhcmQgPSBuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgbG9naWNhbCAhPT0gdW5kZWZpbmVkO1xuICAgICAgaWYgKG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiAhbG9naWNhbCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgbG9naWNhbCBuYW1lXCIpO1xuICAgICAgfVxuICAgICAgLy8gVGhlIGNvbnN0cnVjdC1jcmVhdGVkIGFjY2Vzcy1sb2cgZ3JvdXAgaXMgYSBsb2dnaW5nIHJlc291cmNlOiB1bmRlciB0aGVcbiAgICAgIC8vIHN0YW5kYXJkIHByb2ZpbGUgaXQgdGFrZXMgdGhlIGNvbnRyYWN0IGxvZy1zb3VyY2UgbmFtZSwgYW5kIHVuZGVyIHRoZVxuICAgICAgLy8gbGVnYWN5IHByb2ZpbGUgaXQga2VlcHMgdG9kYXkncyBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZSBhbmRcbiAgICAgIC8vIGNvbnN1bWVzIG5vIG5hbWluZyBlbnRyeSAocjMsIEFEVi0xMzEyLTEpLlxuICAgICAgY29uc3QgbG9nR3JvdXAgPSBzdGFuZGFyZCAmJiBsb2dpY2FsXG4gICAgICAgID8gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogbmFtaW5nQ29udGV4dCEubG9nR3JvdXBOYW1lKGBsb2dzL2FjY2Vzcy9hcGkvJHtsb2dpY2FsfWApLFxuICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IobmFtaW5nQ29udGV4dCEucmV0ZW50aW9uRGF5cyksXG4gICAgICAgICAgfSlcbiAgICAgICAgOiBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgZm9ybWF0OiBzdGFuZGFyZCA/IGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQoKSA6IGxlZ2FjeUFjY2Vzc0xvZ0Zvcm1hdCgpLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gc3RhZ2U7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNvbnRyb2xsZXJGdW5jdGlvbihcbiAgICBwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyxcbiAgICBpbWFnZUFybjogc3RyaW5nLFxuICAgIGluZ3Jlc3NDb25uZWN0b3JBcm5zOiBzdHJpbmdbXSxcbiAgICBlZ3Jlc3NDb25uZWN0b3JBcm5zOiBzdHJpbmdbXSxcbiAgICBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm46IHN0cmluZyxcbiAgICBsb2dnaW5nRW52aXJvbm1lbnQ6IHN0cmluZyxcbiAgKTogbGFtYmRhLkZ1bmN0aW9uIHtcbiAgICBjb25zdCBjb250cm9sbGVyUHJvcHMgPSBwcm9wcy5jb250cm9sbGVyO1xuICAgIGNvbnN0IGVudmlyb25tZW50ID0gYnVpbGRDb250cm9sbGVyRW52aXJvbm1lbnQoXG4gICAgICBjb250cm9sbGVyUHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICB7XG4gICAgICAgIFtFTlZfQ09OVFJBQ1RfTkFNRV06IE1JQ1JPVk1fQ09OVFJBQ1RfTkFNRSxcbiAgICAgICAgW0VOVl9DT05UUkFDVF9WRVJTSU9OXTogTUlDUk9WTV9DT05UUkFDVF9WRVJTSU9OLFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfRU5EUE9JTlRdOiB0aGlzLmVuZHBvaW50LFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfT1BFUkFUSU9OU106IENPTlRST0xMRVJfT1BFUkFUSU9OUy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX1JPVVRFU106IENPTlRST0xMRVJfUk9VVEVfREVGSU5JVElPTlMubWFwKChyb3V0ZSkgPT4gYCR7cm91dGUubWV0aG9kfSAke3JvdXRlLnBhdGh9YCkuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEXTogQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVELFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUXTogQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQsXG4gICAgICAgIFtFTlZfU0VTU0lPTl9SRUdJU1RSWV9UQUJMRV06IHRoaXMuc2Vzc2lvblRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgW0VOVl9JTUFHRV9SRUZdOiBpbWFnZUFybixcbiAgICAgICAgW0VOVl9ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXTogZWdyZXNzQ29ubmVjdG9yQXJucy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlNdOiBpbmdyZXNzQ29ubmVjdG9yQXJucy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU106IGVncmVzc0Nvbm5lY3RvckFybnMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfU0hFTExfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZdOiBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm4sXG4gICAgICAgIFtFTlZfTE9HR0lOR106IGxvZ2dpbmdFbnZpcm9ubWVudCxcbiAgICAgICAgLi4uKHByb3BzLmV4ZWN1dGlvblJvbGUgPyB7IFtFTlZfRVhFQ1VUSU9OX1JPTEVfQVJOXTogcHJvcHMuZXhlY3V0aW9uUm9sZS5yb2xlQXJuIH0gOiB7fSksXG4gICAgICB9LFxuICAgICk7XG5cbiAgICByZXR1cm4gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkNvbnRyb2xsZXJGdW5jdGlvblwiLCB7XG4gICAgICBhcmNoaXRlY3R1cmU6IGNvbnRyb2xsZXJQcm9wcy5hcmNoaXRlY3R1cmUgPz8gbGFtYmRhLkFyY2hpdGVjdHVyZS5BUk1fNjQsXG4gICAgICB0cmFjaW5nOiBjb250cm9sbGVyUHJvcHMudHJhY2luZyA/PyBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgICBtZW1vcnlTaXplOiBjb250cm9sbGVyUHJvcHMubWVtb3J5U2l6ZSA/PyA1MTIsXG4gICAgICB0aW1lb3V0OiBjb250cm9sbGVyUHJvcHMudGltZW91dCA/PyBEdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIC4uLmNvbnRyb2xsZXJQcm9wcyxcbiAgICAgIGVudmlyb25tZW50LFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBncmFudE1pY3Jvdm1Db250cm9sUGxhbmUocHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpOiB2b2lkIHtcbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbFBsYW5lXCIsXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImxhbWJkYTpDcmVhdGVNaWNyb3ZtQXV0aFRva2VuXCIsXG4gICAgICAgICAgXCJsYW1iZGE6Q3JlYXRlTWljcm92bVNoZWxsQXV0aFRva2VuXCIsXG4gICAgICAgICAgXCJsYW1iZGE6R2V0TWljcm92bVwiLFxuICAgICAgICAgIFwibGFtYmRhOlJlc3VtZU1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpSdW5NaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6U3VzcGVuZE1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpUZXJtaW5hdGVNaWNyb3ZtXCIsXG4gICAgICAgIF0sXG4gICAgICAgIC8vIExhbWJkYSBNaWNyb1ZNIHJlc291cmNlLWxldmVsIElBTSBzY29waW5nIGZvciB0aGVzZSBhY3Rpb25zIHJlbWFpbnNcbiAgICAgICAgLy8gdW50ZXN0ZWQsIHNvIHRoZSBncmFudCBzdGF5cyBvbiBcIipcIi4gVGhlIG9uZSBsaXZlIG9ic2VydmF0aW9uICh0aGVcbiAgICAgICAgLy8gaW1hZ2UtdmVyc2lvbiBsaXN0L2RlbGV0ZSBvcGVyYXRpb25zKSBzaG93cyB0aGUgY29udHJvbCBwbGFuZVxuICAgICAgICAvLyBhdXRob3JpemVzIHRoZSBjYW5vbmljYWwgY29sb24tZm9ybSBpbWFnZSBBUk4gKGAuLi46bWljcm92bS1pbWFnZTo8bmFtZT5gKVxuICAgICAgICAvLyBhbmQgcmVqZWN0cyB0aGUgc2xhc2ggZm9ybSB3aXRoIEhUVFAgNDAzIEFjY2Vzc0RlbmllZCByZWdhcmRsZXNzIG9mXG4gICAgICAgIC8vIElBTSAobGl2ZS12ZXJpZmllZCkuIEFwcFRoZW9yeSBjb25zdHJhaW5zIHdoaWNoIGltYWdlL2Nvbm5lY3RvcnMvcm9sZVxuICAgICAgICAvLyBtYXkgYmUgdXNlZCB0aHJvdWdoIHR5cGVkIGNvbnN0cnVjdCBwcm9wcywgZmFpbC1jbG9zZWQgY29udHJvbGxlciBlbnYsXG4gICAgICAgIC8vIGFuZCBzY29wZWQgaWFtOlBhc3NSb2xlIHJhdGhlciB0aGFuIHJlLXNjb3BpbmcgdGhlc2UgcmVzb3VyY2UgZ3JhbnRzLlxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6IFwiQXBwVGhlb3J5TWljcm92bUxpc3RcIixcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOkxpc3RNaWNyb3Ztc1wiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgc2lkOiBcIkFwcFRoZW9yeU1pY3Jvdm1QYXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOlBhc3NOZXR3b3JrQ29ubmVjdG9yXCJdLFxuICAgICAgICAvLyBMYW1iZGEgbWFya3MgUGFzc05ldHdvcmtDb25uZWN0b3IgYXMgcGVybWlzc2lvbi1vbmx5IHdpdGhvdXQgcmVzb3VyY2UtbGV2ZWxcbiAgICAgICAgLy8gc3VwcG9ydC4gQXBwVGhlb3J5IGNvbnN0cmFpbnMgdGhlIHBlcm1pdHRlZCBjb25uZWN0b3Igc2V0IHRocm91Z2ggdHlwZWQgcHJvcHNcbiAgICAgICAgLy8gYW5kIGZhaWwtY2xvc2VkIGVudmlyb25tZW50IHdpcmluZyBpbnN0ZWFkIG9mIGFjY2VwdGluZyByYXcgcmVxdWVzdCBzdHJpbmdzLlxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgaWYgKHByb3BzLmV4ZWN1dGlvblJvbGUpIHtcbiAgICAgIHByb3BzLmV4ZWN1dGlvblJvbGUuZ3JhbnRQYXNzUm9sZSh0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5ncmFudFByaW5jaXBhbCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhZGRDb250cm9sbGVyUm91dGVzKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2YgQ09OVFJPTExFUl9ST1VURV9ERUZJTklUSU9OUykge1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgICAgcGF0aDogcm91dGUucGF0aCxcbiAgICAgICAgbWV0aG9kczogW3JvdXRlLm1ldGhvZF0sXG4gICAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24ocm91dGUuaWQsIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLCB7XG4gICAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogdGhpcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlLFxuICAgICAgICB9KSxcbiAgICAgICAgYXV0aG9yaXplcjogdGhpcy5yb3V0ZUF1dGhvcml6ZXIsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbGVnYWN5QWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICB9KTtcbn1cblxuLyoqXG4gKiBBcHBseSB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlJ3MgZGVmYXVsdC1vbiBhY2Nlc3MgbG9nZ2luZy4gQW4gZXhwbGljaXRcbiAqIGBhY2Nlc3NMb2dnaW5nYCB2YWx1ZSwgaW5jbHVkaW5nIGBmYWxzZWAsIGFsd2F5cyB3aW5zLlxuICovXG5mdW5jdGlvbiBlZmZlY3RpdmVTdGFnZU9wdGlvbnMoXG4gIHN0YWdlOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyxcbiAgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQsXG4pOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyB7XG4gIGlmIChuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgc3RhZ2UuYWNjZXNzTG9nZ2luZyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHsgLi4uc3RhZ2UsIGFjY2Vzc0xvZ2dpbmc6IHRydWUgfTtcbiAgfVxuICByZXR1cm4gc3RhZ2U7XG59XG5cbmZ1bmN0aW9uIG5lZWRzRXhwbGljaXRTdGFnZShzdGFnZU9wdHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zLCBzdGFnZU5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICB8fCBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZVxuICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWRcbiAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSZXF1aXJlZCh2YWx1ZTogdW5rbm93biwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyh2YWx1ZSkudHJpbSgpO1xuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nLCBtYXhMZW5ndGg6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgcHJvcE5hbWUpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgL1xccy8udGVzdChub3JtYWxpemVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6ICR7cHJvcE5hbWV9IG11c3Qgbm90IGNvbnRhaW4gd2hpdGVzcGFjZWApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiBub3JtYWxpemVkLmxlbmd0aCA+IG1heExlbmd0aCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYXQgbW9zdCAke21heExlbmd0aH0gY2hhcmFjdGVyc2ApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBjb250cm9sbGVyTG9nZ2luZ0Vudmlyb25tZW50KFxuICBsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nIHwgdW5kZWZpbmVkLFxuICBleGVjdXRpb25Sb2xlOiBpYW0uSVJvbGUgfCB1bmRlZmluZWQsXG4pOiBzdHJpbmcge1xuICBpZiAobG9nZ2luZyA9PT0gdW5kZWZpbmVkIHx8IGxvZ2dpbmcgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZ1wiKTtcbiAgfVxuICBjb25zdCBoYXNDbG91ZFdhdGNoID0gbG9nZ2luZy5jbG91ZFdhdGNoICE9PSB1bmRlZmluZWQgJiYgbG9nZ2luZy5jbG91ZFdhdGNoICE9PSBudWxsO1xuICBjb25zdCBoYXNEaXNhYmxlZCA9IGxvZ2dpbmcuZGlzYWJsZWQgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0Nsb3VkV2F0Y2ggPT09IGhhc0Rpc2FibGVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcgbXVzdCBzcGVjaWZ5IGV4YWN0bHkgb25lIG9mIGNsb3VkV2F0Y2ggb3IgZGlzYWJsZWRcIixcbiAgICApO1xuICB9XG4gIGlmIChoYXNEaXNhYmxlZCkge1xuICAgIGlmIChsb2dnaW5nLmRpc2FibGVkICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmRpc2FibGVkIG11c3QgYmUgdHJ1ZSB3aGVuIHByb3ZpZGVkXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBkaXNhYmxlZDogdHJ1ZSB9KTtcbiAgfVxuICBpZiAoIWV4ZWN1dGlvblJvbGUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLmV4ZWN1dGlvblJvbGUgd2hlbiBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoIGlzIGNvbmZpZ3VyZWRcIixcbiAgICApO1xuICB9XG5cbiAgY29uc3QgY2xvdWRXYXRjaCA9IGxvZ2dpbmcuY2xvdWRXYXRjaDtcbiAgaWYgKCFjbG91ZFdhdGNoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaFwiKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGlmIChjbG91ZFdhdGNoLmxvZ0dyb3VwICE9PSB1bmRlZmluZWQpIHtcbiAgICBub3JtYWxpemVkLmxvZ19ncm91cCA9IG5vcm1hbGl6ZUNvbnRyb2xsZXJMb2dHcm91cChjbG91ZFdhdGNoLmxvZ0dyb3VwKTtcbiAgfVxuICBpZiAoY2xvdWRXYXRjaC5sb2dTdHJlYW0gIT09IHVuZGVmaW5lZCkge1xuICAgIG5vcm1hbGl6ZWQubG9nX3N0cmVhbSA9IG5vcm1hbGl6ZUNvbnRyb2xsZXJMb2dTdHJlYW0oY2xvdWRXYXRjaC5sb2dTdHJlYW0pO1xuICB9XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IGNsb3VkX3dhdGNoOiBub3JtYWxpemVkIH0pO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb250cm9sbGVyTG9nR3JvdXAodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJtaWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgIS9eW2EtekEtWjAtOV9cXC0vLiNdezEsNTEyfSQvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29udHJvbGxlckxvZ1N0cmVhbSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBcIm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgKCEvXlteOipdKiQvLnRlc3Qobm9ybWFsaXplZCkgfHwgbm9ybWFsaXplZC5sZW5ndGggPiA1MTIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW0gaXMgb3V0c2lkZSB0aGUgQ2xvdWRXYXRjaCBMb2dzIHBhdHRlcm5cIixcbiAgICApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICBjb25uZWN0b3JzOiByZWFkb25seSBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXSB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbiAgZXhwZWN0ZWRLaW5kOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQsXG4pOiBzdHJpbmdbXSB7XG4gIGlmICghY29ubmVjdG9ycyB8fCBjb25uZWN0b3JzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgYXQgbGVhc3QgMSAke3Byb3BOYW1lfSBlbnRyeWApO1xuICB9XG4gIGlmIChjb25uZWN0b3JzLmxlbmd0aCA+IDEwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBzdXBwb3J0cyBhdCBtb3N0IDEwICR7cHJvcE5hbWV9IGVudHJpZXNgKTtcbiAgfVxuXG4gIGNvbnN0IGFybnMgPSBjb25uZWN0b3JzLm1hcCgoY29ubmVjdG9yLCBpbmRleCkgPT4ge1xuICAgIHJldHVybiBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoY29ubmVjdG9yLCBgJHtwcm9wTmFtZX1bJHtpbmRleH1dYCwgZXhwZWN0ZWRLaW5kKTtcbiAgfSk7XG5cbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKGFybnMsIGAke3Byb3BOYW1lfSBuZXR3b3JrQ29ubmVjdG9yQXJuYCk7XG4gIHJldHVybiBhcm5zO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoXG4gIGNvbm5lY3RvcjogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuICBleHBlY3RlZEtpbmQ6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCxcbik6IHN0cmluZyB7XG4gIGlmIChjb25uZWN0b3IgPT09IHVuZGVmaW5lZCB8fCBjb25uZWN0b3IgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgY29uc3QgYWN0dWFsS2luZCA9IG5vcm1hbGl6ZUNvbm5lY3RvcktpbmRGb3JDb250cm9sbGVyKGNvbm5lY3Rvci5uZXR3b3JrQ29ubmVjdG9yS2luZCwgcHJvcE5hbWUpO1xuICBpZiAoYWN0dWFsS2luZCAhPT0gZXhwZWN0ZWRLaW5kKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy4ke3Byb3BOYW1lfSBtdXN0IGJlIGEgJHtleHBlY3RlZEtpbmR9IGNvbm5lY3RvciByZWZlcmVuY2VgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhjb25uZWN0b3IubmV0d29ya0Nvbm5lY3RvckFybiwgYCR7cHJvcE5hbWV9Lm5ldHdvcmtDb25uZWN0b3JBcm5gLCAyMDQ4KTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29ubmVjdG9yS2luZEZvckNvbnRyb2xsZXIoXG4gIGtpbmQ6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCB8IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbik6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCB7XG4gIGlmIChraW5kID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy4ke3Byb3BOYW1lfSBtdXN0IGluY2x1ZGUgbmV0d29ya0Nvbm5lY3RvcktpbmRgKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKGtpbmQpLnRyaW0oKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1tfLV0vZywgXCJcIik7XG4gIGlmIChub3JtYWxpemVkID09PSBcImluZ3Jlc3NcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuSU5HUkVTUztcbiAgfVxuICBpZiAobm9ybWFsaXplZCA9PT0gXCJlZ3Jlc3NcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuRUdSRVNTO1xuICB9XG4gIGlmIChub3JtYWxpemVkID09PSBcInNoZWxsaW5ncmVzc1wiKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5TSEVMTF9JTkdSRVNTO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLiR7cHJvcE5hbWV9Lm5ldHdvcmtDb25uZWN0b3JLaW5kIG11c3QgYmUgaW5ncmVzcywgZWdyZXNzLCBvciBzaGVsbC1pbmdyZXNzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gZGVkdXBlQ29ubmVjdG9yQXJucyhhcm5zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKGFybnMsIFwiY29udHJvbGxlciBuZXR3b3JrQ29ubmVjdG9yQXJuXCIpO1xuICByZXR1cm4gYXJucztcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9EdXBsaWNhdGVzKHZhbHVlczogcmVhZG9ubHkgc3RyaW5nW10sIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHNlZW4uaGFzKHZhbHVlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBkb2VzIG5vdCBhbGxvdyBkdXBsaWNhdGUgJHtsYWJlbH0gdmFsdWVzYCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVIZWFkZXJOYW1lKGhlYWRlck5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBTdHJpbmcoaGVhZGVyTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gIGlmICghdHJpbW1lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBhdXRob3JpemVySGVhZGVyTmFtZSBpcyByZXF1aXJlZFwiKTtcbiAgfVxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RhZ2VOYW1lKHN0YWdlTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IFN0cmluZyhzdGFnZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogc3RhZ2VOYW1lIGlzIHJlcXVpcmVkXCIpO1xuICB9XG4gIHJldHVybiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiBidWlsZENvbnRyb2xsZXJFbnZpcm9ubWVudChcbiAgdXNlckVudmlyb25tZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkLFxuICByZXNlcnZlZEVudmlyb25tZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IGVudmlyb25tZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyAuLi4odXNlckVudmlyb25tZW50ID8/IHt9KSB9O1xuICBmb3IgKGNvbnN0IGtleSBvZiBSRVNFUlZFRF9FTlZfS0VZUykge1xuICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoZW52aXJvbm1lbnQsIGtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IGNvbnRyb2xsZXIuZW52aXJvbm1lbnQgY2Fubm90IG92ZXJyaWRlIHJlc2VydmVkICR7a2V5fWApO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyAuLi5lbnZpcm9ubWVudCwgLi4ucmVzZXJ2ZWRFbnZpcm9ubWVudCB9O1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cbiJdfQ==