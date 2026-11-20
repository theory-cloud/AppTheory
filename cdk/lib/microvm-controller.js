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
const secure_defaults_1 = require("./private/secure-defaults");
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
        const deletionProtection = (0, secure_defaults_1.defaultDeletionProtection)(props.namingContext, removalPolicy, props.sessionTableDeletionProtection);
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
            deletionProtection: deletionProtection,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1jb250cm9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1jb250cm9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkQ7QUFDN0Qsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBQ3JELHlEQUEyQztBQUUzQywrREFBaUQ7QUFDakQsMkRBQTZDO0FBQzdDLDJDQUF1QztBQUV2Qyx5REFBNEQ7QUFDNUQseUVBQW9FO0FBQ3BFLCtEQUFzRTtBQUN0RSxpRUFBa0Y7QUFHbEYsMkVBR3FDO0FBRXJDLE1BQU0scUJBQXFCLEdBQUcsMEJBQTBCLENBQUM7QUFDekQsTUFBTSx3QkFBd0IsR0FBRyxnQkFBZ0IsQ0FBQztBQUNsRCxNQUFNLHdCQUF3QixHQUFHLE1BQU0sQ0FBQztBQUN4QyxNQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQztBQUN2QyxNQUFNLHFCQUFxQixHQUFHO0lBQzVCLEtBQUs7SUFDTCxLQUFLO0lBQ0wsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0lBQ1IsV0FBVztJQUNYLFFBQVE7SUFDUixZQUFZO0lBQ1osa0JBQWtCO0NBQ25CLENBQUM7QUFDRixNQUFNLDRCQUE0QixHQUFvRTtJQUNwRyxFQUFFLEVBQUUsRUFBRSxZQUFZLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUU7SUFDeEUsRUFBRSxFQUFFLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFO0lBQ3pFLEVBQUUsRUFBRSxFQUFFLFlBQVksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLHdCQUF3QixFQUFFO0lB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WUFDM0QsTUFBTSxJQUFJLEtBQUssQ0FBQywrRUFBK0UsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUN4RyxDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sRUFBRSxHQUFHLFdBQVcsRUFBRSxHQUFHLG1CQUFtQixFQUFFLENBQUM7QUFDcEQsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsR0FBVztJQUNyQyxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ2hDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMga21zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbiB9IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5pbXBvcnQgeyBodHRwQXBpQWNjZXNzTG9nRm9ybWF0LCByZXRlbnRpb25Gb3IgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmcsIElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgfSBmcm9tIFwiLi9taWNyb3ZtLWltYWdlXCI7XG5pbXBvcnQge1xuICBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQsXG4gIHR5cGUgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yLFxufSBmcm9tIFwiLi9taWNyb3ZtLW5ldHdvcmstY29ubmVjdG9yXCI7XG5cbmNvbnN0IE1JQ1JPVk1fQ09OVFJBQ1RfTkFNRSA9IFwiYXBwdGhlb3J5LmxhbWJkYV9taWNyb3ZtXCI7XG5jb25zdCBNSUNST1ZNX0NPTlRSQUNUX1ZFUlNJT04gPSBcIm0xNi5taWNyb3ZtL3YxXCI7XG5jb25zdCBDT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQgPSBcInRydWVcIjtcbmNvbnN0IENPTlRST0xMRVJfQVVUSF9ERUZBVUxUID0gXCJkZW55XCI7XG5jb25zdCBDT05UUk9MTEVSX09QRVJBVElPTlMgPSBbXG4gIFwicnVuXCIsXG4gIFwiZ2V0XCIsXG4gIFwibGlzdFwiLFxuICBcInN1c3BlbmRcIixcbiAgXCJyZXN1bWVcIixcbiAgXCJ0ZXJtaW5hdGVcIixcbiAgXCJpbnZva2VcIixcbiAgXCJhdXRoLXRva2VuXCIsXG4gIFwic2hlbGwtYXV0aC10b2tlblwiLFxuXTtcbmNvbnN0IENPTlRST0xMRVJfUk9VVEVfREVGSU5JVElPTlM6IEFycmF5PHsgaWQ6IHN0cmluZzsgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2Q7IHBhdGg6IHN0cmluZyB9PiA9IFtcbiAgeyBpZDogXCJSdW5NaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zXCIgfSxcbiAgeyBpZDogXCJMaXN0TWljcm92bXNcIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBwYXRoOiBcIi9taWNyb3Ztc1wiIH0sXG4gIHsgaWQ6IFwiR2V0TWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfVwiIH0sXG4gIHsgaWQ6IFwiU3VzcGVuZE1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L3N1c3BlbmRcIiB9LFxuICB7IGlkOiBcIlJlc3VtZU1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L3Jlc3VtZVwiIH0sXG4gIHsgaWQ6IFwiVGVybWluYXRlTWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5ERUxFVEUsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfVwiIH0sXG4gIHsgaWQ6IFwiSW52b2tlTWljcm92bVJvb3RcIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuQU5ZLCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vaW52b2tlXCIgfSxcbiAgeyBpZDogXCJJbnZva2VNaWNyb3ZtUHJveHlcIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuQU5ZLCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vaW52b2tlL3twcm94eSt9XCIgfSxcbiAgeyBpZDogXCJDcmVhdGVNaWNyb3ZtQXV0aFRva2VuXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9hdXRoLXRva2VuXCIgfSxcbiAge1xuICAgIGlkOiBcIkNyZWF0ZU1pY3Jvdm1TaGVsbEF1dGhUb2tlblwiLFxuICAgIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsXG4gICAgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L3NoZWxsLWF1dGgtdG9rZW5cIixcbiAgfSxcbl07XG5cbmNvbnN0IEVOVl9DT05UUkFDVF9OQU1FID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUkFDVF9OQU1FXCI7XG5jb25zdCBFTlZfQ09OVFJBQ1RfVkVSU0lPTiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJBQ1RfVkVSU0lPTlwiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfRU5EUE9JTlQgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfRU5EUE9JTlRcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX09QRVJBVElPTlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfT1BFUkFUSU9OU1wiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfUk9VVEVTID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX1JPVVRFU1wiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRCA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUXCI7XG5jb25zdCBFTlZfU0VTU0lPTl9SRUdJU1RSWV9UQUJMRSA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fU0VTU0lPTl9SRUdJU1RSWV9UQUJMRVwiO1xuY29uc3QgRU5WX0lNQUdFX1JFRiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fSU1BR0VfUkVGXCI7XG5jb25zdCBFTlZfTkVUV09SS19DT05ORUNUT1JfUkVGUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXCI7XG5jb25zdCBFTlZfRUdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXCI7XG5jb25zdCBFTlZfU0hFTExfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUYgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGXCI7XG5jb25zdCBFTlZfRVhFQ1VUSU9OX1JPTEVfQVJOID0gXCJBUFBUSEVPUllfTUlDUk9WTV9FWEVDVVRJT05fUk9MRV9BUk5cIjtcbmNvbnN0IEVOVl9MT0dHSU5HID0gXCJBUFBUSEVPUllfTUlDUk9WTV9MT0dHSU5HXCI7XG5cbmNvbnN0IFJFU0VSVkVEX0VOVl9LRVlTID0gW1xuICBFTlZfQ09OVFJBQ1RfTkFNRSxcbiAgRU5WX0NPTlRSQUNUX1ZFUlNJT04sXG4gIEVOVl9DT05UUk9MTEVSX0VORFBPSU5ULFxuICBFTlZfQ09OVFJPTExFUl9PUEVSQVRJT05TLFxuICBFTlZfQ09OVFJPTExFUl9ST1VURVMsXG4gIEVOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQsXG4gIEVOVl9DT05UUk9MTEVSX0FVVEhfREVGQVVMVCxcbiAgRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEUsXG4gIEVOVl9JTUFHRV9SRUYsXG4gIEVOVl9ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTLFxuICBFTlZfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTLFxuICBFTlZfRUdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMsXG4gIEVOVl9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRixcbiAgRU5WX0VYRUNVVElPTl9ST0xFX0FSTixcbiAgRU5WX0xPR0dJTkcsXG5dO1xuXG4vKipcbiAqIFN0YWdlIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBNaWNyb1ZNIGNvbnRyb2xsZXIgSFRUUCBBUEkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnMge1xuICAvKipcbiAgICogU3RhZ2UgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgXCIkZGVmYXVsdFwiXG4gICAqL1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEVuYWJsZSBDbG91ZFdhdGNoIGFjY2VzcyBsb2dnaW5nIGZvciB0aGUgc3RhZ2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IGZhbHNlXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dnaW5nPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogUmV0ZW50aW9uIHBlcmlvZCBmb3IgYXV0by1jcmVhdGVkIGFjY2VzcyBsb2cgZ3JvdXAuXG4gICAqIE9ubHkgYXBwbGllcyB3aGVuIGFjY2Vzc0xvZ2dpbmcgaXMgdHJ1ZS5cbiAgICpcbiAgICogQGRlZmF1bHQgbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USFxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIHJhdGUgbGltaXQgKHJlcXVlc3RzIHBlciBzZWNvbmQpIGZvciB0aGUgc3RhZ2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdSYXRlTGltaXQ/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgYnVyc3QgbGltaXQgZm9yIHRoZSBzdGFnZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ0J1cnN0TGltaXQ/OiBudW1iZXI7XG59XG5cbi8qKlxuICogUGFja2FnaW5nIGFuZCBydW50aW1lIGNvbmZpZ3VyYXRpb24gZm9yIHRoZSBBcHBUaGVvcnkgTWljcm9WTSBjb250cm9sbGVyIExhbWJkYS5cbiAqXG4gKiBBcHBUaGVvcnkgY3JlYXRlcyB0aGUgTGFtYmRhIGZ1bmN0aW9uIHNvIGl0IGNhbiB3aXJlIHRoZSBjYW5vbmljYWwgc2Vzc2lvbiB0YWJsZSxcbiAqIE1pY3JvVk0gaW1hZ2UvbmV0d29yayByZWZlcmVuY2VzLCBhbmQgZmFpbC1jbG9zZWQgYXV0aCBlbnZpcm9ubWVudCBjb25zaXN0ZW50bHkuXG4gKiBUaGUgY2FsbGVyIHN1cHBsaWVzIG9ubHkgdGhlIGhhbmRsZXIgcGFja2FnZSBkZXRhaWxzIGFuZCBhbnkgb3JkaW5hcnkgTGFtYmRhXG4gKiBGdW5jdGlvblByb3BzLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyRnVuY3Rpb25Qcm9wcyBleHRlbmRzIGxhbWJkYS5GdW5jdGlvblByb3BzIHt9XG5cbi8qKlxuICogUHJvcHMgZm9yIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMge1xuICAvKipcbiAgICogQ29udHJvbGxlciBMYW1iZGEgcGFja2FnaW5nIGFuZCBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBUaGUgaGFuZGxlciBjb2RlIG11c3QgdXNlIEFwcFRoZW9yeSdzIE1pY3JvVk0gcnVudGltZS9jb250cm9sbGVyIHByaW1pdGl2ZXMuXG4gICAqIFRoaXMgY29uc3RydWN0IGRvZXMgbm90IGltcGxlbWVudCBhIHByb2R1Y3QgY29udHJvbC1wbGFuZSBzZXJ2aWNlLlxuICAgKi9cbiAgcmVhZG9ubHkgY29udHJvbGxlcjogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJGdW5jdGlvblByb3BzO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgcmVxdWVzdCBhdXRob3JpemVyIHJlcXVpcmVkIGZvciBldmVyeSBjb250cm9sbGVyIHJvdXRlLlxuICAgKlxuICAgKiBUaGUgY29uc3RydWN0IGZhaWxzIGNsb3NlZCB3aGVuIHRoaXMgaXMgb21pdHRlZDsgdW5hdXRoZW50aWNhdGVkIGNvbnRyb2xsZXIgcm91dGVzXG4gICAqIGFyZSBub3Qgc3ludGhlc2l6ZWQuXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBUaGUgTWljcm9WTSBpbWFnZSB0aGUgY29udHJvbGxlciBpcyBwZXJtaXR0ZWQgdG8gcnVuLlxuICAgKi9cbiAgcmVhZG9ubHkgbWljcm92bUltYWdlOiBJQXBwVGhlb3J5TWljcm92bUltYWdlO1xuXG4gIC8qKlxuICAgKiBJbmdyZXNzIG5ldHdvcmsgY29ubmVjdG9ycyB0aGUgY29udHJvbGxlciBpcyBwZXJtaXR0ZWQgdG8gcGFzcyB0byBMYW1iZGEgTWljcm9WTXMuXG4gICAqXG4gICAqIEF0IGxlYXN0IG9uZSBjb25uZWN0b3IgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gMTAgbWF5IGJlIHN1cHBsaWVkLlxuICAgKiBVc2UgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3IuYWxsSW5ncmVzcy9ub0luZ3Jlc3Mgb3IgYW4gZXhwbGljaXRseSB0eXBlZFxuICAgKiBpbXBvcnRlZCBpbmdyZXNzIGNvbm5lY3RvciByZWZlcmVuY2U7IEFwcFRoZW9yeSBkb2VzIG5vdCBoaWRlIGFuIGluZ3Jlc3MgZGVmYXVsdC5cbiAgICovXG4gIHJlYWRvbmx5IGluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yczogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW107XG5cbiAgLyoqXG4gICAqIEVncmVzcyBuZXR3b3JrIGNvbm5lY3RvcnMgdGhlIGNvbnRyb2xsZXIgaXMgcGVybWl0dGVkIHRvIHBhc3MgdG8gTGFtYmRhIE1pY3JvVk1zLlxuICAgKlxuICAgKiBBdCBsZWFzdCBvbmUgY29ubmVjdG9yIHJlZmVyZW5jZSBpcyByZXF1aXJlZCBhbmQgbm8gbW9yZSB0aGFuIDEwIG1heSBiZSBzdXBwbGllZC5cbiAgICovXG4gIHJlYWRvbmx5IGVncmVzc05ldHdvcmtDb25uZWN0b3JzOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXTtcblxuICAvKipcbiAgICogU2hlbGwgaW5ncmVzcyBjb25uZWN0b3IgcmVxdWlyZWQgZm9yIHNoZWxsLWF1dGgtdG9rZW4gc3VwcG9ydC5cbiAgICpcbiAgICogVXNlIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yLnNoZWxsSW5ncmVzcyBvciBhbiBleHBsaWNpdGx5IHR5cGVkIHNoZWxsLWluZ3Jlc3NcbiAgICogY29ubmVjdG9yIHJlZmVyZW5jZS4gVGhlIHNoZWxsLWF1dGgtdG9rZW4gcm91dGUgaXMgcGFydCBvZiB0aGUgcmVhbCBNMTYgY29udHJvbGxlclxuICAgKiBzdXJmYWNlLCBzbyB0aGlzIHJlZmVyZW5jZSBpcyByZXF1aXJlZCBpbnN0ZWFkIG9mIGJlaW5nIHNpbGVudGx5IGRlZmF1bHRlZC5cbiAgICovXG4gIHJlYWRvbmx5IHNoZWxsSW5ncmVzc05ldHdvcmtDb25uZWN0b3I6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcjtcblxuICAvKipcbiAgICogT3B0aW9uYWwgTWljcm9WTSBleGVjdXRpb24gcm9sZSBwYXNzZWQgdG8gUnVuTWljcm92bS5cbiAgICpcbiAgICogV2hlbiBzdXBwbGllZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgY29udHJvbGxlciBMYW1iZGEgaWFtOlBhc3NSb2xlIGZvciB0aGlzIHJvbGVcbiAgICogYW5kIGV4cG9zZXMgdGhlIEFSTiBhcyBBUFBUSEVPUllfTUlDUk9WTV9FWEVDVVRJT05fUk9MRV9BUk4uXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZXhlY3V0aW9uUm9sZT86IGlhbS5JUm9sZTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQVBJIG5hbWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAqXG4gICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSBBUEkgYWNjZXNzIGxvZ2dpbmcgaXMgb24gYnkgZGVmYXVsdCB0byBhXG4gICAqIGxvZyBncm91cCBuYW1lZCBgbG9ncy9hY2Nlc3MvYXBpL3tsb2dpY2FsTmFtZX1gIGNhcnJ5aW5nIHRoZSBjb250cmFjdCdzXG4gICAqIEpTT04gZmllbGQgc2V0LiBQYXNzIGBzdGFnZS5hY2Nlc3NMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dC5cbiAgICpcbiAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBBUEkncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlbiBhXG4gICAqIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIHN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoZGVmYXVsdCBIVFRQIEFQSSBzdGFnZSlcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgY29udHJvbGxlciByb3V0ZXMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgY29udHJvbGxlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciB0aGUgY2Fub25pY2FsXG4gICAqIGNvbnRyb2xsZXIgcm91dGUgZmFtaWx5LCB3aGVyZSB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2VcbiAgICogcG9saWN5IHNpemUgbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBjb250cm9sbGVyIExhbWJkYSwgbm90IG9ubHkgdGhlIGNvbnRyb2xsZXIgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBOYW1lIGZvciB0aGUgZHVyYWJsZSBNaWNyb1ZNIHNlc3Npb24gcmVnaXN0cnkgRHluYW1vREIgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQmlsbGluZyBtb2RlIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgUEFZX1BFUl9SRVFVRVNUXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZT86IGR5bmFtb2RiLkJpbGxpbmdNb2RlO1xuXG4gIC8qKlxuICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcblxuICAvKipcbiAgICogV2hldGhlciBkZWxldGlvbiBwcm90ZWN0aW9uIHNob3VsZCBiZSBlbmFibGVkIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkICh3aXRoIG5vIG5hbWluZyBjb250ZXh0OiB0aGUgQVdTIGRlZmF1bHQsIG5vIGRlbGV0aW9uXG4gICAqIHByb3RlY3Rpb247IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dDogb24gZm9yIGEgUkVUQUlOIHRhYmxlLCBvZmYgb3RoZXJ3aXNlKVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlRGVsZXRpb25Qcm90ZWN0aW9uPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogV2hldGhlciBwb2ludC1pbi10aW1lIHJlY292ZXJ5IHNob3VsZCBiZSBlbmFibGVkIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdHJ1ZVxuICAgKi9cbiAgcmVhZG9ubHkgZW5hYmxlU2Vzc2lvblRhYmxlUG9pbnRJblRpbWVSZWNvdmVyeT86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFNlc3Npb24gcmVnaXN0cnkgdGFibGUgZW5jcnlwdGlvbiBzZXR0aW5nLlxuICAgKlxuICAgKiBAZGVmYXVsdCBBV1NfTUFOQUdFRFxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlRW5jcnlwdGlvbj86IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbjtcblxuICAvKipcbiAgICogQ3VzdG9tZXItbWFuYWdlZCBLTVMga2V5IGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogUmVxdWlyZWQgd2hlbiBzZXNzaW9uVGFibGVFbmNyeXB0aW9uIGlzIENVU1RPTUVSX01BTkFHRUQuXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVFbmNyeXB0aW9uS2V5Pzoga21zLklLZXk7XG5cbiAgLyoqXG4gICAqIFByb3Zpc2lvbmVkIHJlYWQgY2FwYWNpdHkgd2hlbiBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZSBpcyBQUk9WSVNJT05FRC5cbiAgICpcbiAgICogQGRlZmF1bHQgNVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlUmVhZENhcGFjaXR5PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBQcm92aXNpb25lZCB3cml0ZSBjYXBhY2l0eSB3aGVuIHNlc3Npb25UYWJsZUJpbGxpbmdNb2RlIGlzIFBST1ZJU0lPTkVELlxuICAgKlxuICAgKiBAZGVmYXVsdCA1XG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVXcml0ZUNhcGFjaXR5PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBIZWFkZXIgdXNlZCBhcyB0aGUgaWRlbnRpdHkgc291cmNlIGZvciBjb250cm9sbGVyIGF1dGhvcml6YXRpb24uXG4gICAqXG4gICAqIEBkZWZhdWx0IFwiQXV0aG9yaXphdGlvblwiXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVySGVhZGVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRnJpZW5kbHkgYXV0aG9yaXplciBuYW1lLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgYXV0aG9yaXplciByZXN1bHQgY2FjaGUgVFRMLlxuICAgKlxuICAgKiBEZWZhdWx0cyB0byBkaXNhYmxlZCBzbyBzdGFsZSBhdXRoIGNhbm5vdCBzaWxlbnRseSBicm9hZGVuIGNvbnRyb2xsZXIgYWNjZXNzLlxuICAgKlxuICAgKiBAZGVmYXVsdCBEdXJhdGlvbi5zZWNvbmRzKDApXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyQ2FjaGVUdGw/OiBEdXJhdGlvbjtcbn1cblxuLyoqXG4gKiBBcHBUaGVvcnkgQ0RLIGNvbnN0cnVjdCBmb3IgdGhlIGZpcnN0LWNsYXNzIExhbWJkYSBNaWNyb1ZNIGNvbnRyb2xsZXIgZGVwbG95bWVudCBzdXJmYWNlLlxuICpcbiAqIFRoZSBjb25zdHJ1Y3QgcHJvdmlzaW9ucyB0aGUgcHJvdGVjdGVkIEhUVFAgQVBJIHJvdXRlcyBmcm9tIHRoZSBNMTYgcmVhbCBjb250cm9sbGVyIGNvbnRyYWN0LFxuICogdGhlIGNvbnRyb2xsZXIgTGFtYmRhLCB0aGUgY2Fub25pY2FsIGR1cmFibGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZSwgSUFNIGdyYW50cywgYW5kXG4gKiBmYWlsLWNsb3NlZCBhdXRoIGVudmlyb25tZW50IHdpcmluZy4gUnVudGltZSBjb21tYW5kIGhhbmRsaW5nIHJlbWFpbnMgaW4gdGhlIEFwcFRoZW9yeVxuICogcnVudGltZSBjb250cmFjdDsgdGhpcyBjb25zdHJ1Y3Qgb25seSB3aXJlcyB0aGUgZGVwbG95bWVudCBwYXRoLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKipcbiAgICogVGhlIHVuZGVybHlpbmcgSFRUUCBBUEkgR2F0ZXdheSB2MiBBUEkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLkh0dHBBcGk7XG5cbiAgLyoqXG4gICAqIFRoZSBBUEkgR2F0ZXdheSBzdGFnZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2U7XG5cbiAgLyoqXG4gICAqIExhbWJkYSByZXF1ZXN0IGF1dGhvcml6ZXIgYXR0YWNoZWQgdG8gZXZlcnkgY29udHJvbGxlciByb3V0ZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSByb3V0ZUF1dGhvcml6ZXI6IGFwaWd3djJBdXRob3JpemVycy5IdHRwTGFtYmRhQXV0aG9yaXplcjtcblxuICAvKipcbiAgICogVGhlIGNvbnRyb2xsZXIgTGFtYmRhIGZ1bmN0aW9uIGNyZWF0ZWQgYnkgdGhpcyBjb25zdHJ1Y3QuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgY29udHJvbGxlckZ1bmN0aW9uOiBsYW1iZGEuRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFRoZSBkdXJhYmxlIFRhYmxlVGhlb3J5LXNoYXBlZCBzZXNzaW9uIHJlZ2lzdHJ5IER5bmFtb0RCIHRhYmxlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHNlc3Npb25UYWJsZTogZHluYW1vZGIuVGFibGU7XG5cbiAgLyoqXG4gICAqIFRoZSBjb250cm9sbGVyIGJhc2UgZW5kcG9pbnQgKGAvbWljcm92bXNgKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYWNjZXNzIGxvZyBncm91cCAoaWYgYWNjZXNzIGxvZ2dpbmcgaXMgZW5hYmxlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICBwcml2YXRlIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU6IGJvb2xlYW47XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzID09PSB1bmRlZmluZWQgfHwgcHJvcHMgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzXCIpO1xuICAgIH1cbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLmNvbnRyb2xsZXIsIFwiY29udHJvbGxlclwiKTtcbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLmF1dGhvcml6ZXIsIFwiYXV0aG9yaXplclwiKTtcbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLm1pY3Jvdm1JbWFnZSwgXCJtaWNyb3ZtSW1hZ2VcIik7XG4gICAgdGhpcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlID0gcHJvcHMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA/PyB0cnVlO1xuXG4gICAgY29uc3QgaW1hZ2VBcm4gPSBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcocHJvcHMubWljcm92bUltYWdlLm1pY3Jvdm1JbWFnZUFybiwgXCJtaWNyb3ZtSW1hZ2UubWljcm92bUltYWdlQXJuXCIsIDIwNDgpO1xuICAgIGNvbnN0IGluZ3Jlc3NDb25uZWN0b3JBcm5zID0gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhcbiAgICAgIHByb3BzLmluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyxcbiAgICAgIFwiaW5ncmVzc05ldHdvcmtDb25uZWN0b3JzXCIsXG4gICAgICBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuSU5HUkVTUyxcbiAgICApO1xuICAgIGNvbnN0IGVncmVzc0Nvbm5lY3RvckFybnMgPSBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICAgICAgcHJvcHMuZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMsXG4gICAgICBcImVncmVzc05ldHdvcmtDb25uZWN0b3JzXCIsXG4gICAgICBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuRUdSRVNTLFxuICAgICk7XG4gICAgY29uc3Qgc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuID0gbm9ybWFsaXplU2luZ2xlQ29ubmVjdG9yUmVmZXJlbmNlKFxuICAgICAgcHJvcHMuc2hlbGxJbmdyZXNzTmV0d29ya0Nvbm5lY3RvcixcbiAgICAgIFwic2hlbGxJbmdyZXNzTmV0d29ya0Nvbm5lY3RvclwiLFxuICAgICAgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLlNIRUxMX0lOR1JFU1MsXG4gICAgKTtcbiAgICBjb25zdCBhbGxJbmdyZXNzQ29ubmVjdG9yQXJucyA9IGRlZHVwZUNvbm5lY3RvckFybnMoWy4uLmluZ3Jlc3NDb25uZWN0b3JBcm5zLCBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm5dKTtcbiAgICBhc3NlcnROb0R1cGxpY2F0ZXMoWy4uLmFsbEluZ3Jlc3NDb25uZWN0b3JBcm5zLCAuLi5lZ3Jlc3NDb25uZWN0b3JBcm5zXSwgXCJjb250cm9sbGVyIG5ldHdvcmtDb25uZWN0b3JBcm5cIik7XG4gICAgY29uc3QgbG9nZ2luZ0Vudmlyb25tZW50ID0gY29udHJvbGxlckxvZ2dpbmdFbnZpcm9ubWVudChwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZywgcHJvcHMuZXhlY3V0aW9uUm9sZSk7XG4gICAgY29uc3QgYXV0aG9yaXplckhlYWRlck5hbWUgPSBub3JtYWxpemVIZWFkZXJOYW1lKHByb3BzLmF1dGhvcml6ZXJIZWFkZXJOYW1lID8/IFwiQXV0aG9yaXphdGlvblwiKTtcbiAgICBjb25zdCBuYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyXCIsIFwiYXBpTmFtZVwiLCBcImFwaV9odHRwXCIsIGxvZ2ljYWwsIHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgaWYgKG5hbWluZ0NvbnRleHQgJiYgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyB2MC4xIG5hbWVzIG9ubHkgdGhlIGNvbnRyb2xsZXIgQVBJIHRocm91Z2ggdGhlIGNvbnRyYWN0LiBSZWZ1c2luZyB0aGVcbiAgICAgIC8vIGhhbmQtYnVpbHQgdGFibGUgbmFtZSBrZWVwcyBzZWN0aW9uIDQncyBleHBsaWNpdC1uYW1lIHJ1bGU7IHRoZSB0YWJsZVxuICAgICAgLy8gc3RheXMgQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkIHVudGlsIGEgY29udHJhY3QgcmV2aXNpb24gYWRkcyBpdHMgbmFtZS5cbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBjYW5ub3QgaG9ub3IgcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSB3aGVuIGEgbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudDsgdGhlIGNvbnN0cnVjdCBuYW1lcyBvbmx5IGl0cyBBUEkgdW5kZXIgdGhlIG5hbWluZyBjb250cmFjdCBpbiB2MC4xLCBzbyByZW1vdmUgdGhlIG5hbWUgYW5kIGxldCBDbG91ZEZvcm1hdGlvbiBnZW5lcmF0ZSB0aGUgc2Vzc2lvbiB0YWJsZSBuYW1lXCIsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBkZXJpdmVkQXBpTmFtZSA9IG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCA/IG5hbWluZ0NvbnRleHQucGh5c2ljYWxOYW1lKFwiYXBpX2h0dHBcIiwgbG9naWNhbCkgOiB1bmRlZmluZWQ7XG4gICAgY29uc3Qgc3RhZ2VPcHRzID0gZWZmZWN0aXZlU3RhZ2VPcHRpb25zKHByb3BzLnN0YWdlID8/IHt9LCBuYW1pbmdDb250ZXh0KTtcbiAgICBjb25zdCBzdGFnZU5hbWUgPSBub3JtYWxpemVTdGFnZU5hbWUoc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCIpO1xuXG4gICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0aGlzLmNyZWF0ZVNlc3Npb25UYWJsZShwcm9wcyk7XG5cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgYXBpTmFtZTogZGVyaXZlZEFwaU5hbWUgJiYgIWRlcml2ZWRBcGlOYW1lLmdlbmVyYXRlZCA/IGRlcml2ZWRBcGlOYW1lLm5hbWUgOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0YWdlID0gdGhpcy5jcmVhdGVTdGFnZShzdGFnZU9wdHMsIHN0YWdlTmFtZSwgbmFtaW5nQ29udGV4dCwgbG9naWNhbCk7XG4gICAgaWYgKCFzdGFnZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IGZhaWxlZCB0byBjcmVhdGUgQVBJIHN0YWdlXCIpO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlID0gc3RhZ2U7XG5cbiAgICB0aGlzLmVuZHBvaW50ID0gc3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgID8gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKHRoaXMuYXBpLmFwaUVuZHBvaW50KX0vbWljcm92bXNgXG4gICAgICA6IGAke3N0cmlwVHJhaWxpbmdTbGFzaCh0aGlzLmFwaS5hcGlFbmRwb2ludCl9LyR7c3RhZ2VOYW1lfS9taWNyb3Ztc2A7XG5cbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbiA9IHRoaXMuY3JlYXRlQ29udHJvbGxlckZ1bmN0aW9uKFxuICAgICAgcHJvcHMsXG4gICAgICBpbWFnZUFybixcbiAgICAgIGFsbEluZ3Jlc3NDb25uZWN0b3JBcm5zLFxuICAgICAgZWdyZXNzQ29ubmVjdG9yQXJucyxcbiAgICAgIHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybixcbiAgICAgIGxvZ2dpbmdFbnZpcm9ubWVudCxcbiAgICApO1xuICAgIHRoaXMuc2Vzc2lvblRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbik7XG4gICAgdGhpcy5ncmFudE1pY3Jvdm1Db250cm9sUGxhbmUocHJvcHMpO1xuXG4gICAgdGhpcy5yb3V0ZUF1dGhvcml6ZXIgPSBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFBdXRob3JpemVyKFwiQXV0aG9yaXplclwiLCBwcm9wcy5hdXRob3JpemVyLCB7XG4gICAgICBhdXRob3JpemVyTmFtZTogcHJvcHMuYXV0aG9yaXplck5hbWUsXG4gICAgICBpZGVudGl0eVNvdXJjZTogW2AkcmVxdWVzdC5oZWFkZXIuJHthdXRob3JpemVySGVhZGVyTmFtZX1gXSxcbiAgICAgIHJlc3VsdHNDYWNoZVR0bDogcHJvcHMuYXV0aG9yaXplckNhY2hlVHRsID8/IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICByZXNwb25zZVR5cGVzOiBbYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFSZXNwb25zZVR5cGUuU0lNUExFXSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29udHJvbGxlclJvdXRlcygpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZXNzaW9uVGFibGUocHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpOiBkeW5hbW9kYi5UYWJsZSB7XG4gICAgY29uc3QgYmlsbGluZ01vZGUgPSBwcm9wcy5zZXNzaW9uVGFibGVCaWxsaW5nTW9kZSA/PyBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1Q7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnNlc3Npb25UYWJsZVJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgZW5jcnlwdGlvbiA9IHByb3BzLnNlc3Npb25UYWJsZUVuY3J5cHRpb24gPz8gZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VEO1xuICAgIGNvbnN0IGVuYWJsZVBJVFIgPSBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGVQb2ludEluVGltZVJlY292ZXJ5ID8/IHRydWU7XG4gICAgY29uc3QgZGVsZXRpb25Qcm90ZWN0aW9uID0gZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbihcbiAgICAgIHByb3BzLm5hbWluZ0NvbnRleHQsXG4gICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgcHJvcHMuc2Vzc2lvblRhYmxlRGVsZXRpb25Qcm90ZWN0aW9uLFxuICAgICk7XG5cbiAgICBpZiAoZW5jcnlwdGlvbiA9PT0gZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkNVU1RPTUVSX01BTkFHRUQgJiYgIXByb3BzLnNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBzZXNzaW9uVGFibGVFbmNyeXB0aW9uS2V5IHdoZW4gc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VEXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgPT09IHVuZGVmaW5lZFxuICAgICAgPyB1bmRlZmluZWRcbiAgICAgIDogbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcocHJvcHMuc2Vzc2lvblRhYmxlTmFtZSwgXCJzZXNzaW9uVGFibGVOYW1lXCIpO1xuXG4gICAgcmV0dXJuIG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlNlc3Npb25UYWJsZVwiLCB7XG4gICAgICB0YWJsZU5hbWUsXG4gICAgICBiaWxsaW5nTW9kZSxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInBrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6IFwic2tcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwidHRsXCIsXG4gICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBkZWxldGlvblByb3RlY3Rpb24sXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogZW5hYmxlUElUUixcbiAgICAgIH0sXG4gICAgICBlbmNyeXB0aW9uLFxuICAgICAgZW5jcnlwdGlvbktleTogcHJvcHMuc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleSxcbiAgICAgIC4uLihiaWxsaW5nTW9kZSA9PT0gZHluYW1vZGIuQmlsbGluZ01vZGUuUFJPVklTSU9ORURcbiAgICAgICAgPyB7XG4gICAgICAgICAgICByZWFkQ2FwYWNpdHk6IHByb3BzLnNlc3Npb25UYWJsZVJlYWRDYXBhY2l0eSA/PyA1LFxuICAgICAgICAgICAgd3JpdGVDYXBhY2l0eTogcHJvcHMuc2Vzc2lvblRhYmxlV3JpdGVDYXBhY2l0eSA/PyA1LFxuICAgICAgICAgIH1cbiAgICAgICAgOiB7fSksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVN0YWdlKFxuICAgIHN0YWdlT3B0czogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnMsXG4gICAgc3RhZ2VOYW1lOiBzdHJpbmcsXG4gICAgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQsXG4gICAgbG9naWNhbD86IHN0cmluZyxcbiAgKTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQge1xuICAgIGlmICghbmVlZHNFeHBsaWNpdFN0YWdlKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSkge1xuICAgICAgcmV0dXJuIHRoaXMuYXBpLmRlZmF1bHRTdGFnZTtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgc3RhZ2VOYW1lLFxuICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgIHRocm90dGxlOiAoc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgPyB7XG4gICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgIH1cbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgfSk7XG5cbiAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgIGNvbnN0IHN0YW5kYXJkID0gbmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIGxvZ2ljYWwgIT09IHVuZGVmaW5lZDtcbiAgICAgIGlmIChuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgIWxvZ2ljYWwpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIGxvZ2ljYWwgbmFtZVwiKTtcbiAgICAgIH1cbiAgICAgIC8vIFRoZSBjb25zdHJ1Y3QtY3JlYXRlZCBhY2Nlc3MtbG9nIGdyb3VwIGlzIGEgbG9nZ2luZyByZXNvdXJjZTogdW5kZXIgdGhlXG4gICAgICAvLyBzdGFuZGFyZCBwcm9maWxlIGl0IHRha2VzIHRoZSBjb250cmFjdCBsb2ctc291cmNlIG5hbWUsIGFuZCB1bmRlciB0aGVcbiAgICAgIC8vIGxlZ2FjeSBwcm9maWxlIGl0IGtlZXBzIHRvZGF5J3MgQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkIG5hbWUgYW5kXG4gICAgICAvLyBjb25zdW1lcyBubyBuYW1pbmcgZW50cnkgKHIzLCBBRFYtMTMxMi0xKS5cbiAgICAgIGNvbnN0IGxvZ0dyb3VwID0gc3RhbmRhcmQgJiYgbG9naWNhbFxuICAgICAgICA/IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgICBsb2dHcm91cE5hbWU6IG5hbWluZ0NvbnRleHQhLmxvZ0dyb3VwTmFtZShgbG9ncy9hY2Nlc3MvYXBpLyR7bG9naWNhbH1gKSxcbiAgICAgICAgICAgIHJldGVudGlvbjogcmV0ZW50aW9uRm9yKG5hbWluZ0NvbnRleHQhLnJldGVudGlvbkRheXMpLFxuICAgICAgICAgIH0pXG4gICAgICAgIDogbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICAgIGZvcm1hdDogc3RhbmRhcmQgPyBodHRwQXBpQWNjZXNzTG9nRm9ybWF0KCkgOiBsZWdhY3lBY2Nlc3NMb2dGb3JtYXQoKSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHN0YWdlO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVDb250cm9sbGVyRnVuY3Rpb24oXG4gICAgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMsXG4gICAgaW1hZ2VBcm46IHN0cmluZyxcbiAgICBpbmdyZXNzQ29ubmVjdG9yQXJuczogc3RyaW5nW10sXG4gICAgZWdyZXNzQ29ubmVjdG9yQXJuczogc3RyaW5nW10sXG4gICAgc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuOiBzdHJpbmcsXG4gICAgbG9nZ2luZ0Vudmlyb25tZW50OiBzdHJpbmcsXG4gICk6IGxhbWJkYS5GdW5jdGlvbiB7XG4gICAgY29uc3QgY29udHJvbGxlclByb3BzID0gcHJvcHMuY29udHJvbGxlcjtcbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IGJ1aWxkQ29udHJvbGxlckVudmlyb25tZW50KFxuICAgICAgY29udHJvbGxlclByb3BzLmVudmlyb25tZW50LFxuICAgICAge1xuICAgICAgICBbRU5WX0NPTlRSQUNUX05BTUVdOiBNSUNST1ZNX0NPTlRSQUNUX05BTUUsXG4gICAgICAgIFtFTlZfQ09OVFJBQ1RfVkVSU0lPTl06IE1JQ1JPVk1fQ09OVFJBQ1RfVkVSU0lPTixcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX0VORFBPSU5UXTogdGhpcy5lbmRwb2ludCxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX09QRVJBVElPTlNdOiBDT05UUk9MTEVSX09QRVJBVElPTlMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9ST1VURVNdOiBDT05UUk9MTEVSX1JPVVRFX0RFRklOSVRJT05TLm1hcCgocm91dGUpID0+IGAke3JvdXRlLm1ldGhvZH0gJHtyb3V0ZS5wYXRofWApLmpvaW4oXCIsXCIpLFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRF06IENPTlRST0xMRVJfQVVUSF9SRVFVSVJFRCxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX0FVVEhfREVGQVVMVF06IENPTlRST0xMRVJfQVVUSF9ERUZBVUxULFxuICAgICAgICBbRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEVdOiB0aGlzLnNlc3Npb25UYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFtFTlZfSU1BR0VfUkVGXTogaW1hZ2VBcm4sXG4gICAgICAgIFtFTlZfTkVUV09SS19DT05ORUNUT1JfUkVGU106IGVncmVzc0Nvbm5lY3RvckFybnMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXTogaW5ncmVzc0Nvbm5lY3RvckFybnMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfRUdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlNdOiBlZ3Jlc3NDb25uZWN0b3JBcm5zLmpvaW4oXCIsXCIpLFxuICAgICAgICBbRU5WX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGXTogc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuLFxuICAgICAgICBbRU5WX0xPR0dJTkddOiBsb2dnaW5nRW52aXJvbm1lbnQsXG4gICAgICAgIC4uLihwcm9wcy5leGVjdXRpb25Sb2xlID8geyBbRU5WX0VYRUNVVElPTl9ST0xFX0FSTl06IHByb3BzLmV4ZWN1dGlvblJvbGUucm9sZUFybiB9IDoge30pLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgcmV0dXJuIG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJDb250cm9sbGVyRnVuY3Rpb25cIiwge1xuICAgICAgYXJjaGl0ZWN0dXJlOiBjb250cm9sbGVyUHJvcHMuYXJjaGl0ZWN0dXJlID8/IGxhbWJkYS5BcmNoaXRlY3R1cmUuQVJNXzY0LFxuICAgICAgdHJhY2luZzogY29udHJvbGxlclByb3BzLnRyYWNpbmcgPz8gbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgICAgbWVtb3J5U2l6ZTogY29udHJvbGxlclByb3BzLm1lbW9yeVNpemUgPz8gNTEyLFxuICAgICAgdGltZW91dDogY29udHJvbGxlclByb3BzLnRpbWVvdXQgPz8gRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAuLi5jb250cm9sbGVyUHJvcHMsXG4gICAgICBlbnZpcm9ubWVudCxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgZ3JhbnRNaWNyb3ZtQ29udHJvbFBsYW5lKHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzKTogdm9pZCB7XG4gICAgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6IFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xQbGFuZVwiLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJsYW1iZGE6Q3JlYXRlTWljcm92bUF1dGhUb2tlblwiLFxuICAgICAgICAgIFwibGFtYmRhOkNyZWF0ZU1pY3Jvdm1TaGVsbEF1dGhUb2tlblwiLFxuICAgICAgICAgIFwibGFtYmRhOkdldE1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpSZXN1bWVNaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6UnVuTWljcm92bVwiLFxuICAgICAgICAgIFwibGFtYmRhOlN1c3BlbmRNaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6VGVybWluYXRlTWljcm92bVwiLFxuICAgICAgICBdLFxuICAgICAgICAvLyBMYW1iZGEgTWljcm9WTSByZXNvdXJjZS1sZXZlbCBJQU0gc2NvcGluZyBmb3IgdGhlc2UgYWN0aW9ucyByZW1haW5zXG4gICAgICAgIC8vIHVudGVzdGVkLCBzbyB0aGUgZ3JhbnQgc3RheXMgb24gXCIqXCIuIFRoZSBvbmUgbGl2ZSBvYnNlcnZhdGlvbiAodGhlXG4gICAgICAgIC8vIGltYWdlLXZlcnNpb24gbGlzdC9kZWxldGUgb3BlcmF0aW9ucykgc2hvd3MgdGhlIGNvbnRyb2wgcGxhbmVcbiAgICAgICAgLy8gYXV0aG9yaXplcyB0aGUgY2Fub25pY2FsIGNvbG9uLWZvcm0gaW1hZ2UgQVJOIChgLi4uOm1pY3Jvdm0taW1hZ2U6PG5hbWU+YClcbiAgICAgICAgLy8gYW5kIHJlamVjdHMgdGhlIHNsYXNoIGZvcm0gd2l0aCBIVFRQIDQwMyBBY2Nlc3NEZW5pZWQgcmVnYXJkbGVzcyBvZlxuICAgICAgICAvLyBJQU0gKGxpdmUtdmVyaWZpZWQpLiBBcHBUaGVvcnkgY29uc3RyYWlucyB3aGljaCBpbWFnZS9jb25uZWN0b3JzL3JvbGVcbiAgICAgICAgLy8gbWF5IGJlIHVzZWQgdGhyb3VnaCB0eXBlZCBjb25zdHJ1Y3QgcHJvcHMsIGZhaWwtY2xvc2VkIGNvbnRyb2xsZXIgZW52LFxuICAgICAgICAvLyBhbmQgc2NvcGVkIGlhbTpQYXNzUm9sZSByYXRoZXIgdGhhbiByZS1zY29waW5nIHRoZXNlIHJlc291cmNlIGdyYW50cy5cbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgc2lkOiBcIkFwcFRoZW9yeU1pY3Jvdm1MaXN0XCIsXG4gICAgICAgIGFjdGlvbnM6IFtcImxhbWJkYTpMaXN0TWljcm92bXNcIl0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogXCJBcHBUaGVvcnlNaWNyb3ZtUGFzc05ldHdvcmtDb25uZWN0b3JzXCIsXG4gICAgICAgIGFjdGlvbnM6IFtcImxhbWJkYTpQYXNzTmV0d29ya0Nvbm5lY3RvclwiXSxcbiAgICAgICAgLy8gTGFtYmRhIG1hcmtzIFBhc3NOZXR3b3JrQ29ubmVjdG9yIGFzIHBlcm1pc3Npb24tb25seSB3aXRob3V0IHJlc291cmNlLWxldmVsXG4gICAgICAgIC8vIHN1cHBvcnQuIEFwcFRoZW9yeSBjb25zdHJhaW5zIHRoZSBwZXJtaXR0ZWQgY29ubmVjdG9yIHNldCB0aHJvdWdoIHR5cGVkIHByb3BzXG4gICAgICAgIC8vIGFuZCBmYWlsLWNsb3NlZCBlbnZpcm9ubWVudCB3aXJpbmcgaW5zdGVhZCBvZiBhY2NlcHRpbmcgcmF3IHJlcXVlc3Qgc3RyaW5ncy5cbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIGlmIChwcm9wcy5leGVjdXRpb25Sb2xlKSB7XG4gICAgICBwcm9wcy5leGVjdXRpb25Sb2xlLmdyYW50UGFzc1JvbGUodGhpcy5jb250cm9sbGVyRnVuY3Rpb24uZ3JhbnRQcmluY2lwYWwpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWRkQ29udHJvbGxlclJvdXRlcygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IHJvdXRlIG9mIENPTlRST0xMRVJfUk9VVEVfREVGSU5JVElPTlMpIHtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6IHJvdXRlLnBhdGgsXG4gICAgICAgIG1ldGhvZHM6IFtyb3V0ZS5tZXRob2RdLFxuICAgICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKHJvdXRlLmlkLCB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbiwge1xuICAgICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICAgIHNjb3BlUGVybWlzc2lvblRvUm91dGU6IHRoaXMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSxcbiAgICAgICAgfSksXG4gICAgICAgIGF1dGhvcml6ZXI6IHRoaXMucm91dGVBdXRob3JpemVyLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIGxlZ2FjeUFjY2Vzc0xvZ0Zvcm1hdCgpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoe1xuICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgfSk7XG59XG5cbi8qKlxuICogQXBwbHkgdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSdzIGRlZmF1bHQtb24gYWNjZXNzIGxvZ2dpbmcuIEFuIGV4cGxpY2l0XG4gKiBgYWNjZXNzTG9nZ2luZ2AgdmFsdWUsIGluY2x1ZGluZyBgZmFsc2VgLCBhbHdheXMgd2lucy5cbiAqL1xuZnVuY3Rpb24gZWZmZWN0aXZlU3RhZ2VPcHRpb25zKFxuICBzdGFnZTogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnMsXG4gIG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0LFxuKTogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnMge1xuICBpZiAobmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlICYmIHN0YWdlLmFjY2Vzc0xvZ2dpbmcgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7IC4uLnN0YWdlLCBhY2Nlc3NMb2dnaW5nOiB0cnVlIH07XG4gIH1cbiAgcmV0dXJuIHN0YWdlO1xufVxuXG5mdW5jdGlvbiBuZWVkc0V4cGxpY2l0U3RhZ2Uoc3RhZ2VPcHRzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucywgc3RhZ2VOYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIHN0YWdlTmFtZSAhPT0gXCIkZGVmYXVsdFwiXG4gICAgfHwgc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IHRydWVcbiAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUmVxdWlyZWQodmFsdWU6IHVua25vd24sIHByb3BOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcodmFsdWUpLnRyaW0oKTtcbiAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZywgbWF4TGVuZ3RoOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIHByb3BOYW1lKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIC9cXHMvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiAke3Byb3BOYW1lfSBtdXN0IG5vdCBjb250YWluIHdoaXRlc3BhY2VgKTtcbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgbm9ybWFsaXplZC5sZW5ndGggPiBtYXhMZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGF0IG1vc3QgJHttYXhMZW5ndGh9IGNoYXJhY3RlcnNgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gY29udHJvbGxlckxvZ2dpbmdFbnZpcm9ubWVudChcbiAgbG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyB8IHVuZGVmaW5lZCxcbiAgZXhlY3V0aW9uUm9sZTogaWFtLklSb2xlIHwgdW5kZWZpbmVkLFxuKTogc3RyaW5nIHtcbiAgaWYgKGxvZ2dpbmcgPT09IHVuZGVmaW5lZCB8fCBsb2dnaW5nID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmdcIik7XG4gIH1cbiAgY29uc3QgaGFzQ2xvdWRXYXRjaCA9IGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gdW5kZWZpbmVkICYmIGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gbnVsbDtcbiAgY29uc3QgaGFzRGlzYWJsZWQgPSBsb2dnaW5nLmRpc2FibGVkICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNDbG91ZFdhdGNoID09PSBoYXNEaXNhYmxlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nIG11c3Qgc3BlY2lmeSBleGFjdGx5IG9uZSBvZiBjbG91ZFdhdGNoIG9yIGRpc2FibGVkXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoaGFzRGlzYWJsZWQpIHtcbiAgICBpZiAobG9nZ2luZy5kaXNhYmxlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZy5kaXNhYmxlZCBtdXN0IGJlIHRydWUgd2hlbiBwcm92aWRlZFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgZGlzYWJsZWQ6IHRydWUgfSk7XG4gIH1cbiAgaWYgKCFleGVjdXRpb25Sb2xlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy5leGVjdXRpb25Sb2xlIHdoZW4gcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaCBpcyBjb25maWd1cmVkXCIsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGNsb3VkV2F0Y2ggPSBsb2dnaW5nLmNsb3VkV2F0Y2g7XG4gIGlmICghY2xvdWRXYXRjaCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmNsb3VkV2F0Y2hcIik7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBpZiAoY2xvdWRXYXRjaC5sb2dHcm91cCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgbm9ybWFsaXplZC5sb2dfZ3JvdXAgPSBub3JtYWxpemVDb250cm9sbGVyTG9nR3JvdXAoY2xvdWRXYXRjaC5sb2dHcm91cCk7XG4gIH1cbiAgaWYgKGNsb3VkV2F0Y2gubG9nU3RyZWFtICE9PSB1bmRlZmluZWQpIHtcbiAgICBub3JtYWxpemVkLmxvZ19zdHJlYW0gPSBub3JtYWxpemVDb250cm9sbGVyTG9nU3RyZWFtKGNsb3VkV2F0Y2gubG9nU3RyZWFtKTtcbiAgfVxuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBjbG91ZF93YXRjaDogbm9ybWFsaXplZCB9KTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29udHJvbGxlckxvZ0dyb3VwKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIFwibWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cFwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICEvXlthLXpBLVowLTlfXFwtLy4jXXsxLDUxMn0kLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cCBpcyBvdXRzaWRlIHRoZSBDbG91ZFdhdGNoIExvZ3MgcGF0dGVyblwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbnRyb2xsZXJMb2dTdHJlYW0odmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJtaWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoLmxvZ1N0cmVhbVwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICghL15bXjoqXSokLy50ZXN0KG5vcm1hbGl6ZWQpIHx8IG5vcm1hbGl6ZWQubGVuZ3RoID4gNTEyKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhcbiAgY29ubmVjdG9yczogcmVhZG9ubHkgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW10gfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4gIGV4cGVjdGVkS2luZDogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuKTogc3RyaW5nW10ge1xuICBpZiAoIWNvbm5lY3RvcnMgfHwgY29ubmVjdG9ycy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIGF0IGxlYXN0IDEgJHtwcm9wTmFtZX0gZW50cnlgKTtcbiAgfVxuICBpZiAoY29ubmVjdG9ycy5sZW5ndGggPiAxMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgc3VwcG9ydHMgYXQgbW9zdCAxMCAke3Byb3BOYW1lfSBlbnRyaWVzYCk7XG4gIH1cblxuICBjb25zdCBhcm5zID0gY29ubmVjdG9ycy5tYXAoKGNvbm5lY3RvciwgaW5kZXgpID0+IHtcbiAgICByZXR1cm4gbm9ybWFsaXplU2luZ2xlQ29ubmVjdG9yUmVmZXJlbmNlKGNvbm5lY3RvciwgYCR7cHJvcE5hbWV9WyR7aW5kZXh9XWAsIGV4cGVjdGVkS2luZCk7XG4gIH0pO1xuXG4gIGFzc2VydE5vRHVwbGljYXRlcyhhcm5zLCBgJHtwcm9wTmFtZX0gbmV0d29ya0Nvbm5lY3RvckFybmApO1xuICByZXR1cm4gYXJucztcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU2luZ2xlQ29ubmVjdG9yUmVmZXJlbmNlKFxuICBjb25uZWN0b3I6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbiAgZXhwZWN0ZWRLaW5kOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQsXG4pOiBzdHJpbmcge1xuICBpZiAoY29ubmVjdG9yID09PSB1bmRlZmluZWQgfHwgY29ubmVjdG9yID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIGNvbnN0IGFjdHVhbEtpbmQgPSBub3JtYWxpemVDb25uZWN0b3JLaW5kRm9yQ29udHJvbGxlcihjb25uZWN0b3IubmV0d29ya0Nvbm5lY3RvcktpbmQsIHByb3BOYW1lKTtcbiAgaWYgKGFjdHVhbEtpbmQgIT09IGV4cGVjdGVkS2luZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMuJHtwcm9wTmFtZX0gbXVzdCBiZSBhICR7ZXhwZWN0ZWRLaW5kfSBjb25uZWN0b3IgcmVmZXJlbmNlYCxcbiAgICApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcoY29ubmVjdG9yLm5ldHdvcmtDb25uZWN0b3JBcm4sIGAke3Byb3BOYW1lfS5uZXR3b3JrQ29ubmVjdG9yQXJuYCwgMjA0OCk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbm5lY3RvcktpbmRGb3JDb250cm9sbGVyKFxuICBraW5kOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQgfCBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4pOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQge1xuICBpZiAoa2luZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMuJHtwcm9wTmFtZX0gbXVzdCBpbmNsdWRlIG5ldHdvcmtDb25uZWN0b3JLaW5kYCk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyhraW5kKS50cmltKCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bXy1dL2csIFwiXCIpO1xuICBpZiAobm9ybWFsaXplZCA9PT0gXCJpbmdyZXNzXCIpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLklOR1JFU1M7XG4gIH1cbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiZWdyZXNzXCIpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLkVHUkVTUztcbiAgfVxuICBpZiAobm9ybWFsaXplZCA9PT0gXCJzaGVsbGluZ3Jlc3NcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuU0hFTExfSU5HUkVTUztcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy4ke3Byb3BOYW1lfS5uZXR3b3JrQ29ubmVjdG9yS2luZCBtdXN0IGJlIGluZ3Jlc3MsIGVncmVzcywgb3Igc2hlbGwtaW5ncmVzc2AsXG4gICk7XG59XG5cbmZ1bmN0aW9uIGRlZHVwZUNvbm5lY3RvckFybnMoYXJuczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGFzc2VydE5vRHVwbGljYXRlcyhhcm5zLCBcImNvbnRyb2xsZXIgbmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgcmV0dXJuIGFybnM7XG59XG5cbmZ1bmN0aW9uIGFzc2VydE5vRHVwbGljYXRlcyh2YWx1ZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBsYWJlbDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcbiAgICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChzZWVuLmhhcyh2YWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgZG9lcyBub3QgYWxsb3cgZHVwbGljYXRlICR7bGFiZWx9IHZhbHVlc2ApO1xuICAgIH1cbiAgICBzZWVuLmFkZCh2YWx1ZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplSGVhZGVyTmFtZShoZWFkZXJOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gU3RyaW5nKGhlYWRlck5hbWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogYXV0aG9yaXplckhlYWRlck5hbWUgaXMgcmVxdWlyZWRcIik7XG4gIH1cbiAgcmV0dXJuIHRyaW1tZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0YWdlTmFtZShzdGFnZU5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBTdHJpbmcoc3RhZ2VOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHN0YWdlTmFtZSBpcyByZXF1aXJlZFwiKTtcbiAgfVxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuZnVuY3Rpb24gYnVpbGRDb250cm9sbGVyRW52aXJvbm1lbnQoXG4gIHVzZXJFbnZpcm9ubWVudDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZCxcbiAgcmVzZXJ2ZWRFbnZpcm9ubWVudDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICBjb25zdCBlbnZpcm9ubWVudDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uKHVzZXJFbnZpcm9ubWVudCA/PyB7fSkgfTtcbiAgZm9yIChjb25zdCBrZXkgb2YgUkVTRVJWRURfRU5WX0tFWVMpIHtcbiAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGVudmlyb25tZW50LCBrZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBjb250cm9sbGVyLmVudmlyb25tZW50IGNhbm5vdCBvdmVycmlkZSByZXNlcnZlZCAke2tleX1gKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgLi4uZW52aXJvbm1lbnQsIC4uLnJlc2VydmVkRW52aXJvbm1lbnQgfTtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG4iXX0=