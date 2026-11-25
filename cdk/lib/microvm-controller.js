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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmController", version: "7.5.0" };
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
        if (namingContext && logical) {
            // Contract section 11.4: declare the resource carrying the composed name.
            namingContext.declareName("api_http", logical, this.api);
        }
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
            if (standard && namingContext && logical) {
                // Contract section 11.4: declare the resource carrying the log-source name.
                namingContext.declareName("log_group", `logs/access/api/${logical}`, logGroup);
            }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1jb250cm9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1jb250cm9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkQ7QUFDN0Qsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBQ3JELHlEQUEyQztBQUUzQywrREFBaUQ7QUFDakQsMkRBQTZDO0FBQzdDLDJDQUF1QztBQUV2Qyx5REFBNEQ7QUFDNUQseUVBQW9FO0FBQ3BFLCtEQUFzRTtBQUN0RSxpRUFBa0Y7QUFHbEYsMkVBR3FDO0FBRXJDLE1BQU0scUJBQXFCLEdBQUcsMEJBQTBCLENBQUM7QUFDekQsTUFBTSx3QkFBd0IsR0FBRyxnQkFBZ0IsQ0FBQztBQUNsRCxNQUFNLHdCQUF3QixHQUFHLE1BQU0sQ0FBQztBQUN4QyxNQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQztBQUN2QyxNQUFNLHFCQUFxQixHQUFHO0lBQzVCLEtBQUs7SUFDTCxLQUFLO0lBQ0wsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0lBQ1IsV0FBVztJQUNYLFFBQVE7SUFDUixZQUFZO0lBQ1osa0JBQWtCO0NBQ25CLENBQUM7QUFDRixNQUFNLDRCQUE0QixHQUFvRTtJQUNwRyxFQUFFLEVBQUUsRUFBRSxZQUFZLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUU7SUFDeEUsRUFBRSxFQUFFLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFO0lBQ3pFLEVBQUUsRUFBRSxFQUFFLFlBQVksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLHdCQUF3QixFQUFFO0lB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QUN2RSxDQUFDO0lBQ0QsT0FBTyxPQUFPLENBQUM7QUFDakIsQ0FBQztBQUVELFNBQVMsMEJBQTBCLENBQ2pDLGVBQW1ELEVBQ25ELG1CQUEyQztJQUUzQyxNQUFNLFdBQVcsR0FBMkIsRUFBRSxHQUFHLENBQUMsZUFBZSxJQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUM7SUFDM0UsS0FBSyxNQUFNLEdBQUcsSUFBSSxpQkFBaUIsRUFBRSxDQUFDO1FBQ3BDLElBQUksTUFBTSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzNELE1BQU0sSUFBSSxLQUFLLENBQUMsK0VBQStFLEdBQUcsRUFBRSxDQUFDLENBQUM7UUFDeEcsQ0FBQztJQUNILENBQUM7SUFDRCxPQUFPLEVBQUUsR0FBRyxXQUFXLEVBQUUsR0FBRyxtQkFBbUIsRUFBRSxDQUFDO0FBQ3BELENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEdBQVc7SUFDckMsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztBQUNoQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgZGVmYXVsdExvZ2ljYWxOYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2dpY2FsLW5hbWVcIjtcbmltcG9ydCB7IHJlZnVzZUV4cGxpY2l0TmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvcmVmdXNlLWV4cGxpY2l0LW5hbWVcIjtcbmltcG9ydCB7IGRlZmF1bHREZWxldGlvblByb3RlY3Rpb24gfSBmcm9tIFwiLi9wcml2YXRlL3NlY3VyZS1kZWZhdWx0c1wiO1xuaW1wb3J0IHsgaHR0cEFwaUFjY2Vzc0xvZ0Zvcm1hdCwgcmV0ZW50aW9uRm9yIH0gZnJvbSBcIi4vcHJpdmF0ZS9zdGFuZGFyZC1sb2dnaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nLCBJQXBwVGhlb3J5TWljcm92bUltYWdlIH0gZnJvbSBcIi4vbWljcm92bS1pbWFnZVwiO1xuaW1wb3J0IHtcbiAgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuICB0eXBlIElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvcixcbn0gZnJvbSBcIi4vbWljcm92bS1uZXR3b3JrLWNvbm5lY3RvclwiO1xuXG5jb25zdCBNSUNST1ZNX0NPTlRSQUNUX05BTUUgPSBcImFwcHRoZW9yeS5sYW1iZGFfbWljcm92bVwiO1xuY29uc3QgTUlDUk9WTV9DT05UUkFDVF9WRVJTSU9OID0gXCJtMTYubWljcm92bS92MVwiO1xuY29uc3QgQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEID0gXCJ0cnVlXCI7XG5jb25zdCBDT05UUk9MTEVSX0FVVEhfREVGQVVMVCA9IFwiZGVueVwiO1xuY29uc3QgQ09OVFJPTExFUl9PUEVSQVRJT05TID0gW1xuICBcInJ1blwiLFxuICBcImdldFwiLFxuICBcImxpc3RcIixcbiAgXCJzdXNwZW5kXCIsXG4gIFwicmVzdW1lXCIsXG4gIFwidGVybWluYXRlXCIsXG4gIFwiaW52b2tlXCIsXG4gIFwiYXV0aC10b2tlblwiLFxuICBcInNoZWxsLWF1dGgtdG9rZW5cIixcbl07XG5jb25zdCBDT05UUk9MTEVSX1JPVVRFX0RFRklOSVRJT05TOiBBcnJheTx7IGlkOiBzdHJpbmc7IG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kOyBwYXRoOiBzdHJpbmcgfT4gPSBbXG4gIHsgaWQ6IFwiUnVuTWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztc1wiIH0sXG4gIHsgaWQ6IFwiTGlzdE1pY3Jvdm1zXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogXCIvbWljcm92bXNcIiB9LFxuICB7IGlkOiBcIkdldE1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH1cIiB9LFxuICB7IGlkOiBcIlN1c3BlbmRNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9zdXNwZW5kXCIgfSxcbiAgeyBpZDogXCJSZXN1bWVNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9yZXN1bWVcIiB9LFxuICB7IGlkOiBcIlRlcm1pbmF0ZU1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFLCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH1cIiB9LFxuICB7IGlkOiBcIkludm9rZU1pY3Jvdm1Sb290XCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L2ludm9rZVwiIH0sXG4gIHsgaWQ6IFwiSW52b2tlTWljcm92bVByb3h5XCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L2ludm9rZS97cHJveHkrfVwiIH0sXG4gIHsgaWQ6IFwiQ3JlYXRlTWljcm92bUF1dGhUb2tlblwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vYXV0aC10b2tlblwiIH0sXG4gIHtcbiAgICBpZDogXCJDcmVhdGVNaWNyb3ZtU2hlbGxBdXRoVG9rZW5cIixcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULFxuICAgIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9zaGVsbC1hdXRoLXRva2VuXCIsXG4gIH0sXG5dO1xuXG5jb25zdCBFTlZfQ09OVFJBQ1RfTkFNRSA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJBQ1RfTkFNRVwiO1xuY29uc3QgRU5WX0NPTlRSQUNUX1ZFUlNJT04gPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRSQUNUX1ZFUlNJT05cIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0VORFBPSU5UID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0VORFBPSU5UXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9PUEVSQVRJT05TID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX09QRVJBVElPTlNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX1JPVVRFUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9ST1VURVNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRFwiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0FVVEhfREVGQVVMVFwiO1xuY29uc3QgRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEUgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX1NFU1NJT05fUkVHSVNUUllfVEFCTEVcIjtcbmNvbnN0IEVOVl9JTUFHRV9SRUYgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX1JFRlwiO1xuY29uc3QgRU5WX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX05FVFdPUktfQ09OTkVDVE9SX1JFRlNcIjtcbmNvbnN0IEVOVl9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTID0gXCJBUFBUSEVPUllfTUlDUk9WTV9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGID0gXCJBUFBUSEVPUllfTUlDUk9WTV9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlwiO1xuY29uc3QgRU5WX0VYRUNVVElPTl9ST0xFX0FSTiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fRVhFQ1VUSU9OX1JPTEVfQVJOXCI7XG5jb25zdCBFTlZfTE9HR0lORyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fTE9HR0lOR1wiO1xuXG5jb25zdCBSRVNFUlZFRF9FTlZfS0VZUyA9IFtcbiAgRU5WX0NPTlRSQUNUX05BTUUsXG4gIEVOVl9DT05UUkFDVF9WRVJTSU9OLFxuICBFTlZfQ09OVFJPTExFUl9FTkRQT0lOVCxcbiAgRU5WX0NPTlRST0xMRVJfT1BFUkFUSU9OUyxcbiAgRU5WX0NPTlRST0xMRVJfUk9VVEVTLFxuICBFTlZfQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVELFxuICBFTlZfQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQsXG4gIEVOVl9TRVNTSU9OX1JFR0lTVFJZX1RBQkxFLFxuICBFTlZfSU1BR0VfUkVGLFxuICBFTlZfTkVUV09SS19DT05ORUNUT1JfUkVGUyxcbiAgRU5WX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGUyxcbiAgRU5WX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTLFxuICBFTlZfU0hFTExfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUYsXG4gIEVOVl9FWEVDVVRJT05fUk9MRV9BUk4sXG4gIEVOVl9MT0dHSU5HLFxuXTtcblxuLyoqXG4gKiBTdGFnZSBjb25maWd1cmF0aW9uIGZvciB0aGUgTWljcm9WTSBjb250cm9sbGVyIEhUVFAgQVBJLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0IGZvciB0aGUgc3RhZ2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFBhY2thZ2luZyBhbmQgcnVudGltZSBjb25maWd1cmF0aW9uIGZvciB0aGUgQXBwVGhlb3J5IE1pY3JvVk0gY29udHJvbGxlciBMYW1iZGEuXG4gKlxuICogQXBwVGhlb3J5IGNyZWF0ZXMgdGhlIExhbWJkYSBmdW5jdGlvbiBzbyBpdCBjYW4gd2lyZSB0aGUgY2Fub25pY2FsIHNlc3Npb24gdGFibGUsXG4gKiBNaWNyb1ZNIGltYWdlL25ldHdvcmsgcmVmZXJlbmNlcywgYW5kIGZhaWwtY2xvc2VkIGF1dGggZW52aXJvbm1lbnQgY29uc2lzdGVudGx5LlxuICogVGhlIGNhbGxlciBzdXBwbGllcyBvbmx5IHRoZSBoYW5kbGVyIHBhY2thZ2UgZGV0YWlscyBhbmQgYW55IG9yZGluYXJ5IExhbWJkYVxuICogRnVuY3Rpb25Qcm9wcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlckZ1bmN0aW9uUHJvcHMgZXh0ZW5kcyBsYW1iZGEuRnVuY3Rpb25Qcm9wcyB7fVxuXG4vKipcbiAqIFByb3BzIGZvciBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzIHtcbiAgLyoqXG4gICAqIENvbnRyb2xsZXIgTGFtYmRhIHBhY2thZ2luZyBhbmQgY29uZmlndXJhdGlvbi5cbiAgICpcbiAgICogVGhlIGhhbmRsZXIgY29kZSBtdXN0IHVzZSBBcHBUaGVvcnkncyBNaWNyb1ZNIHJ1bnRpbWUvY29udHJvbGxlciBwcmltaXRpdmVzLlxuICAgKiBUaGlzIGNvbnN0cnVjdCBkb2VzIG5vdCBpbXBsZW1lbnQgYSBwcm9kdWN0IGNvbnRyb2wtcGxhbmUgc2VydmljZS5cbiAgICovXG4gIHJlYWRvbmx5IGNvbnRyb2xsZXI6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyRnVuY3Rpb25Qcm9wcztcblxuICAvKipcbiAgICogTGFtYmRhIHJlcXVlc3QgYXV0aG9yaXplciByZXF1aXJlZCBmb3IgZXZlcnkgY29udHJvbGxlciByb3V0ZS5cbiAgICpcbiAgICogVGhlIGNvbnN0cnVjdCBmYWlscyBjbG9zZWQgd2hlbiB0aGlzIGlzIG9taXR0ZWQ7IHVuYXV0aGVudGljYXRlZCBjb250cm9sbGVyIHJvdXRlc1xuICAgKiBhcmUgbm90IHN5bnRoZXNpemVkLlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplcjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogVGhlIE1pY3JvVk0gaW1hZ2UgdGhlIGNvbnRyb2xsZXIgaXMgcGVybWl0dGVkIHRvIHJ1bi5cbiAgICovXG4gIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZTogSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZTtcblxuICAvKipcbiAgICogSW5ncmVzcyBuZXR3b3JrIGNvbm5lY3RvcnMgdGhlIGNvbnRyb2xsZXIgaXMgcGVybWl0dGVkIHRvIHBhc3MgdG8gTGFtYmRhIE1pY3JvVk1zLlxuICAgKlxuICAgKiBBdCBsZWFzdCBvbmUgY29ubmVjdG9yIHJlZmVyZW5jZSBpcyByZXF1aXJlZCBhbmQgbm8gbW9yZSB0aGFuIDEwIG1heSBiZSBzdXBwbGllZC5cbiAgICogVXNlIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yLmFsbEluZ3Jlc3Mvbm9JbmdyZXNzIG9yIGFuIGV4cGxpY2l0bHkgdHlwZWRcbiAgICogaW1wb3J0ZWQgaW5ncmVzcyBjb25uZWN0b3IgcmVmZXJlbmNlOyBBcHBUaGVvcnkgZG9lcyBub3QgaGlkZSBhbiBpbmdyZXNzIGRlZmF1bHQuXG4gICAqL1xuICByZWFkb25seSBpbmdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBFZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBwYXNzIHRvIExhbWJkYSBNaWNyb1ZNcy5cbiAgICpcbiAgICogQXQgbGVhc3Qgb25lIGNvbm5lY3RvciByZWZlcmVuY2UgaXMgcmVxdWlyZWQgYW5kIG5vIG1vcmUgdGhhbiAxMCBtYXkgYmUgc3VwcGxpZWQuXG4gICAqL1xuICByZWFkb25seSBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yczogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW107XG5cbiAgLyoqXG4gICAqIFNoZWxsIGluZ3Jlc3MgY29ubmVjdG9yIHJlcXVpcmVkIGZvciBzaGVsbC1hdXRoLXRva2VuIHN1cHBvcnQuXG4gICAqXG4gICAqIFVzZSBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvci5zaGVsbEluZ3Jlc3Mgb3IgYW4gZXhwbGljaXRseSB0eXBlZCBzaGVsbC1pbmdyZXNzXG4gICAqIGNvbm5lY3RvciByZWZlcmVuY2UuIFRoZSBzaGVsbC1hdXRoLXRva2VuIHJvdXRlIGlzIHBhcnQgb2YgdGhlIHJlYWwgTTE2IGNvbnRyb2xsZXJcbiAgICogc3VyZmFjZSwgc28gdGhpcyByZWZlcmVuY2UgaXMgcmVxdWlyZWQgaW5zdGVhZCBvZiBiZWluZyBzaWxlbnRseSBkZWZhdWx0ZWQuXG4gICAqL1xuICByZWFkb25seSBzaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3I7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIE1pY3JvVk0gZXhlY3V0aW9uIHJvbGUgcGFzc2VkIHRvIFJ1bk1pY3Jvdm0uXG4gICAqXG4gICAqIFdoZW4gc3VwcGxpZWQsIEFwcFRoZW9yeSBncmFudHMgdGhlIGNvbnRyb2xsZXIgTGFtYmRhIGlhbTpQYXNzUm9sZSBmb3IgdGhpcyByb2xlXG4gICAqIGFuZCBleHBvc2VzIHRoZSBBUk4gYXMgQVBQVEhFT1JZX01JQ1JPVk1fRVhFQ1VUSU9OX1JPTEVfQVJOLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGV4ZWN1dGlvblJvbGU/OiBpYW0uSVJvbGU7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIEFQSSBuYW1lLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgKlxuICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgQVBJIGFjY2VzcyBsb2dnaW5nIGlzIG9uIGJ5IGRlZmF1bHQgdG8gYVxuICAgKiBsb2cgZ3JvdXAgbmFtZWQgYGxvZ3MvYWNjZXNzL2FwaS97bG9naWNhbE5hbWV9YCBjYXJyeWluZyB0aGUgY29udHJhY3Qnc1xuICAgKiBKU09OIGZpZWxkIHNldC4gUGFzcyBgc3RhZ2UuYWNjZXNzTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQuXG4gICAqXG4gICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkIHdoZW4gYVxuICAgKiBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBzdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGRlZmF1bHQgSFRUUCBBUEkgc3RhZ2UpXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgc2hvdWxkIGJlIHNjb3BlZCB0byBpbmRpdmlkdWFsIGNvbnRyb2xsZXIgcm91dGVzLlxuICAgKlxuICAgKiBXaGVuIGZhbHNlLCB0aGUgY29uc3RydWN0IGdyYW50cyBvbmUgQVBJLXNjb3BlZCBpbnZva2UgcGVybWlzc2lvbiBwZXIgTGFtYmRhIGluc3RlYWQgb2ZcbiAgICogb25lIHBlcm1pc3Npb24gcGVyIGNvbnRyb2xsZXIgcm91dGUuIFRoaXMgaXMgdGhlIHNjYWxhYmxlIGNob2ljZSBmb3IgdGhlIGNhbm9uaWNhbFxuICAgKiBjb250cm9sbGVyIHJvdXRlIGZhbWlseSwgd2hlcmUgdGhlIHBlci1yb3V0ZSBwZXJtaXNzaW9ucyBjYW4gZXhoYXVzdCB0aGUgTGFtYmRhIHJlc291cmNlXG4gICAqIHBvbGljeSBzaXplIGxpbWl0LlxuICAgKlxuICAgKiBUaGUgdHJhZGUtb2ZmIGlzIGV4cGxpY2l0OiB0aGUgQVBJLXNjb3BlZCBwZXJtaXNzaW9uIGFsbG93cyBldmVyeSByb3V0ZSBvbiB0aGF0IEhUVFAgQVBJXG4gICAqIHRvIGludm9rZSB0aGUgY29udHJvbGxlciBMYW1iZGEsIG5vdCBvbmx5IHRoZSBjb250cm9sbGVyIHJvdXRlcyB0aGlzIGNvbnN0cnVjdCBvd25zLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlPzogYm9vbGVhbjtcblxuICAvKipcbiAgICogTmFtZSBmb3IgdGhlIGR1cmFibGUgTWljcm9WTSBzZXNzaW9uIHJlZ2lzdHJ5IER5bmFtb0RCIHRhYmxlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZClcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEJpbGxpbmcgbW9kZSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFBBWV9QRVJfUkVRVUVTVFxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlQmlsbGluZ01vZGU/OiBkeW5hbW9kYi5CaWxsaW5nTW9kZTtcblxuICAvKipcbiAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIHRoZSBzZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgZGVsZXRpb24gcHJvdGVjdGlvbiBzaG91bGQgYmUgZW5hYmxlZCBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAod2l0aCBubyBuYW1pbmcgY29udGV4dDogdGhlIEFXUyBkZWZhdWx0LCBubyBkZWxldGlvblxuICAgKiBwcm90ZWN0aW9uOyB1bmRlciBhIGRlcml2ZWQgbmFtaW5nIGNvbnRleHQ6IG9uIGZvciBhIFJFVEFJTiB0YWJsZSwgb2ZmIG90aGVyd2lzZSlcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZURlbGV0aW9uUHJvdGVjdGlvbj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgcG9pbnQtaW4tdGltZSByZWNvdmVyeSBzaG91bGQgYmUgZW5hYmxlZCBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlIGVuY3J5cHRpb24gc2V0dGluZy5cbiAgICpcbiAgICogQGRlZmF1bHQgQVdTX01BTkFHRURcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZUVuY3J5cHRpb24/OiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb247XG5cbiAgLyoqXG4gICAqIEN1c3RvbWVyLW1hbmFnZWQgS01TIGtleSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIFJlcXVpcmVkIHdoZW4gc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VELlxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleT86IGttcy5JS2V5O1xuXG4gIC8qKlxuICAgKiBQcm92aXNpb25lZCByZWFkIGNhcGFjaXR5IHdoZW4gc2Vzc2lvblRhYmxlQmlsbGluZ01vZGUgaXMgUFJPVklTSU9ORUQuXG4gICAqXG4gICAqIEBkZWZhdWx0IDVcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZVJlYWRDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgd3JpdGUgY2FwYWNpdHkgd2hlbiBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZSBpcyBQUk9WSVNJT05FRC5cbiAgICpcbiAgICogQGRlZmF1bHQgNVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlV3JpdGVDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogSGVhZGVyIHVzZWQgYXMgdGhlIGlkZW50aXR5IHNvdXJjZSBmb3IgY29udHJvbGxlciBhdXRob3JpemF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcIkF1dGhvcml6YXRpb25cIlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckhlYWRlck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZyaWVuZGx5IGF1dGhvcml6ZXIgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGFtYmRhIGF1dGhvcml6ZXIgcmVzdWx0IGNhY2hlIFRUTC5cbiAgICpcbiAgICogRGVmYXVsdHMgdG8gZGlzYWJsZWQgc28gc3RhbGUgYXV0aCBjYW5ub3Qgc2lsZW50bHkgYnJvYWRlbiBjb250cm9sbGVyIGFjY2Vzcy5cbiAgICpcbiAgICogQGRlZmF1bHQgRHVyYXRpb24uc2Vjb25kcygwKVxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckNhY2hlVHRsPzogRHVyYXRpb247XG59XG5cbi8qKlxuICogQXBwVGhlb3J5IENESyBjb25zdHJ1Y3QgZm9yIHRoZSBmaXJzdC1jbGFzcyBMYW1iZGEgTWljcm9WTSBjb250cm9sbGVyIGRlcGxveW1lbnQgc3VyZmFjZS5cbiAqXG4gKiBUaGUgY29uc3RydWN0IHByb3Zpc2lvbnMgdGhlIHByb3RlY3RlZCBIVFRQIEFQSSByb3V0ZXMgZnJvbSB0aGUgTTE2IHJlYWwgY29udHJvbGxlciBjb250cmFjdCxcbiAqIHRoZSBjb250cm9sbGVyIExhbWJkYSwgdGhlIGNhbm9uaWNhbCBkdXJhYmxlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUsIElBTSBncmFudHMsIGFuZFxuICogZmFpbC1jbG9zZWQgYXV0aCBlbnZpcm9ubWVudCB3aXJpbmcuIFJ1bnRpbWUgY29tbWFuZCBoYW5kbGluZyByZW1haW5zIGluIHRoZSBBcHBUaGVvcnlcbiAqIHJ1bnRpbWUgY29udHJhY3Q7IHRoaXMgY29uc3RydWN0IG9ubHkgd2lyZXMgdGhlIGRlcGxveW1lbnQgcGF0aC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSB1bmRlcmx5aW5nIEhUVFAgQVBJIEdhdGV3YXkgdjIgQVBJLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJIEdhdGV3YXkgc3RhZ2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgcmVxdWVzdCBhdXRob3JpemVyIGF0dGFjaGVkIHRvIGV2ZXJ5IGNvbnRyb2xsZXIgcm91dGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVBdXRob3JpemVyOiBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBjb250cm9sbGVyIExhbWJkYSBmdW5jdGlvbiBjcmVhdGVkIGJ5IHRoaXMgY29uc3RydWN0LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNvbnRyb2xsZXJGdW5jdGlvbjogbGFtYmRhLkZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBUaGUgZHVyYWJsZSBUYWJsZVRoZW9yeS1zaGFwZWQgc2Vzc2lvbiByZWdpc3RyeSBEeW5hbW9EQiB0YWJsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJvbGxlciBiYXNlIGVuZHBvaW50IChgL21pY3Jvdm1zYCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgcHJpdmF0ZSByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBib29sZWFuO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcyA9PT0gdW5kZWZpbmVkIHx8IHByb3BzID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wc1wiKTtcbiAgICB9XG4gICAgdmFsaWRhdGVSZXF1aXJlZChwcm9wcy5jb250cm9sbGVyLCBcImNvbnRyb2xsZXJcIik7XG4gICAgdmFsaWRhdGVSZXF1aXJlZChwcm9wcy5hdXRob3JpemVyLCBcImF1dGhvcml6ZXJcIik7XG4gICAgdmFsaWRhdGVSZXF1aXJlZChwcm9wcy5taWNyb3ZtSW1hZ2UsIFwibWljcm92bUltYWdlXCIpO1xuICAgIHRoaXMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA9IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZTtcblxuICAgIGNvbnN0IGltYWdlQXJuID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHByb3BzLm1pY3Jvdm1JbWFnZS5taWNyb3ZtSW1hZ2VBcm4sIFwibWljcm92bUltYWdlLm1pY3Jvdm1JbWFnZUFyblwiLCAyMDQ4KTtcbiAgICBjb25zdCBpbmdyZXNzQ29ubmVjdG9yQXJucyA9IG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gICAgICBwcm9wcy5pbmdyZXNzTmV0d29ya0Nvbm5lY3RvcnMsXG4gICAgICBcImluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1wiLFxuICAgICAgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLklOR1JFU1MsXG4gICAgKTtcbiAgICBjb25zdCBlZ3Jlc3NDb25uZWN0b3JBcm5zID0gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhcbiAgICAgIHByb3BzLmVncmVzc05ldHdvcmtDb25uZWN0b3JzLFxuICAgICAgXCJlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1wiLFxuICAgICAgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLkVHUkVTUyxcbiAgICApO1xuICAgIGNvbnN0IHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybiA9IG5vcm1hbGl6ZVNpbmdsZUNvbm5lY3RvclJlZmVyZW5jZShcbiAgICAgIHByb3BzLnNoZWxsSW5ncmVzc05ldHdvcmtDb25uZWN0b3IsXG4gICAgICBcInNoZWxsSW5ncmVzc05ldHdvcmtDb25uZWN0b3JcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5TSEVMTF9JTkdSRVNTLFxuICAgICk7XG4gICAgY29uc3QgYWxsSW5ncmVzc0Nvbm5lY3RvckFybnMgPSBkZWR1cGVDb25uZWN0b3JBcm5zKFsuLi5pbmdyZXNzQ29ubmVjdG9yQXJucywgc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuXSk7XG4gICAgYXNzZXJ0Tm9EdXBsaWNhdGVzKFsuLi5hbGxJbmdyZXNzQ29ubmVjdG9yQXJucywgLi4uZWdyZXNzQ29ubmVjdG9yQXJuc10sIFwiY29udHJvbGxlciBuZXR3b3JrQ29ubmVjdG9yQXJuXCIpO1xuICAgIGNvbnN0IGxvZ2dpbmdFbnZpcm9ubWVudCA9IGNvbnRyb2xsZXJMb2dnaW5nRW52aXJvbm1lbnQocHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcsIHByb3BzLmV4ZWN1dGlvblJvbGUpO1xuICAgIGNvbnN0IGF1dGhvcml6ZXJIZWFkZXJOYW1lID0gbm9ybWFsaXplSGVhZGVyTmFtZShwcm9wcy5hdXRob3JpemVySGVhZGVyTmFtZSA/PyBcIkF1dGhvcml6YXRpb25cIik7XG4gICAgY29uc3QgbmFtaW5nQ29udGV4dCA9IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgY29uc3QgbG9naWNhbCA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChuYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUobmFtaW5nQ29udGV4dCwgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclwiLCBcImFwaU5hbWVcIiwgXCJhcGlfaHR0cFwiLCBsb2dpY2FsLCBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpO1xuICAgIGlmIChuYW1pbmdDb250ZXh0ICYmIHByb3BzLnNlc3Npb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgLy8gdjAuMSBuYW1lcyBvbmx5IHRoZSBjb250cm9sbGVyIEFQSSB0aHJvdWdoIHRoZSBjb250cmFjdC4gUmVmdXNpbmcgdGhlXG4gICAgICAvLyBoYW5kLWJ1aWx0IHRhYmxlIG5hbWUga2VlcHMgc2VjdGlvbiA0J3MgZXhwbGljaXQtbmFtZSBydWxlOyB0aGUgdGFibGVcbiAgICAgIC8vIHN0YXlzIENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZCB1bnRpbCBhIGNvbnRyYWN0IHJldmlzaW9uIGFkZHMgaXRzIG5hbWUuXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgY2Fubm90IGhvbm9yIHByb3BzLnNlc3Npb25UYWJsZU5hbWUgd2hlbiBhIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQ7IHRoZSBjb25zdHJ1Y3QgbmFtZXMgb25seSBpdHMgQVBJIHVuZGVyIHRoZSBuYW1pbmcgY29udHJhY3QgaW4gdjAuMSwgc28gcmVtb3ZlIHRoZSBuYW1lIGFuZCBsZXQgQ2xvdWRGb3JtYXRpb24gZ2VuZXJhdGUgdGhlIHNlc3Npb24gdGFibGUgbmFtZVwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgY29uc3QgZGVyaXZlZEFwaU5hbWUgPSBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwgPyBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImFwaV9odHRwXCIsIGxvZ2ljYWwpIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IHN0YWdlT3B0cyA9IGVmZmVjdGl2ZVN0YWdlT3B0aW9ucyhwcm9wcy5zdGFnZSA/PyB7fSwgbmFtaW5nQ29udGV4dCk7XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gbm9ybWFsaXplU3RhZ2VOYW1lKHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiKTtcblxuICAgIHRoaXMuc2Vzc2lvblRhYmxlID0gdGhpcy5jcmVhdGVTZXNzaW9uVGFibGUocHJvcHMpO1xuXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IGRlcml2ZWRBcGlOYW1lICYmICFkZXJpdmVkQXBpTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkQXBpTmFtZS5uYW1lIDogcHJvcHMuYXBpTmFtZSxcbiAgICAgIGNyZWF0ZURlZmF1bHRTdGFnZTogIW5lZWRzRXhwbGljaXRTdGFnZShzdGFnZU9wdHMsIHN0YWdlTmFtZSksXG4gICAgfSk7XG4gICAgaWYgKG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCkge1xuICAgICAgLy8gQ29udHJhY3Qgc2VjdGlvbiAxMS40OiBkZWNsYXJlIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgY29tcG9zZWQgbmFtZS5cbiAgICAgIG5hbWluZ0NvbnRleHQuZGVjbGFyZU5hbWUoXCJhcGlfaHR0cFwiLCBsb2dpY2FsLCB0aGlzLmFwaSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhZ2UgPSB0aGlzLmNyZWF0ZVN0YWdlKHN0YWdlT3B0cywgc3RhZ2VOYW1lLCBuYW1pbmdDb250ZXh0LCBsb2dpY2FsKTtcbiAgICBpZiAoIXN0YWdlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogZmFpbGVkIHRvIGNyZWF0ZSBBUEkgc3RhZ2VcIik7XG4gICAgfVxuICAgIHRoaXMuc3RhZ2UgPSBzdGFnZTtcblxuICAgIHRoaXMuZW5kcG9pbnQgPSBzdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgPyBgJHtzdHJpcFRyYWlsaW5nU2xhc2godGhpcy5hcGkuYXBpRW5kcG9pbnQpfS9taWNyb3Ztc2BcbiAgICAgIDogYCR7c3RyaXBUcmFpbGluZ1NsYXNoKHRoaXMuYXBpLmFwaUVuZHBvaW50KX0vJHtzdGFnZU5hbWV9L21pY3Jvdm1zYDtcblxuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uID0gdGhpcy5jcmVhdGVDb250cm9sbGVyRnVuY3Rpb24oXG4gICAgICBwcm9wcyxcbiAgICAgIGltYWdlQXJuLFxuICAgICAgYWxsSW5ncmVzc0Nvbm5lY3RvckFybnMsXG4gICAgICBlZ3Jlc3NDb25uZWN0b3JBcm5zLFxuICAgICAgc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuLFxuICAgICAgbG9nZ2luZ0Vudmlyb25tZW50LFxuICAgICk7XG4gICAgdGhpcy5zZXNzaW9uVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuY29udHJvbGxlckZ1bmN0aW9uKTtcbiAgICB0aGlzLmdyYW50TWljcm92bUNvbnRyb2xQbGFuZShwcm9wcyk7XG5cbiAgICB0aGlzLnJvdXRlQXV0aG9yaXplciA9IG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXIoXCJBdXRob3JpemVyXCIsIHByb3BzLmF1dGhvcml6ZXIsIHtcbiAgICAgIGF1dGhvcml6ZXJOYW1lOiBwcm9wcy5hdXRob3JpemVyTmFtZSxcbiAgICAgIGlkZW50aXR5U291cmNlOiBbYCRyZXF1ZXN0LmhlYWRlci4ke2F1dGhvcml6ZXJIZWFkZXJOYW1lfWBdLFxuICAgICAgcmVzdWx0c0NhY2hlVHRsOiBwcm9wcy5hdXRob3JpemVyQ2FjaGVUdGwgPz8gRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgIHJlc3BvbnNlVHlwZXM6IFthcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYVJlc3BvbnNlVHlwZS5TSU1QTEVdLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRDb250cm9sbGVyUm91dGVzKCk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlc3Npb25UYWJsZShwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyk6IGR5bmFtb2RiLlRhYmxlIHtcbiAgICBjb25zdCBiaWxsaW5nTW9kZSA9IHByb3BzLnNlc3Npb25UYWJsZUJpbGxpbmdNb2RlID8/IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVDtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuc2Vzc2lvblRhYmxlUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCBlbmNyeXB0aW9uID0gcHJvcHMuc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiA/PyBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQ7XG4gICAgY29uc3QgZW5hYmxlUElUUiA9IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZVBvaW50SW5UaW1lUmVjb3ZlcnkgPz8gdHJ1ZTtcbiAgICBjb25zdCBkZWxldGlvblByb3RlY3Rpb24gPSBkZWZhdWx0RGVsZXRpb25Qcm90ZWN0aW9uKFxuICAgICAgcHJvcHMubmFtaW5nQ29udGV4dCxcbiAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICBwcm9wcy5zZXNzaW9uVGFibGVEZWxldGlvblByb3RlY3Rpb24sXG4gICAgKTtcblxuICAgIGlmIChlbmNyeXB0aW9uID09PSBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQ1VTVE9NRVJfTUFOQUdFRCAmJiAhcHJvcHMuc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXkgd2hlbiBzZXNzaW9uVGFibGVFbmNyeXB0aW9uIGlzIENVU1RPTUVSX01BTkFHRURcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgdGFibGVOYW1lID0gcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSA9PT0gdW5kZWZpbmVkXG4gICAgICA/IHVuZGVmaW5lZFxuICAgICAgOiBub3JtYWxpemVSZXF1aXJlZFN0cmluZyhwcm9wcy5zZXNzaW9uVGFibGVOYW1lLCBcInNlc3Npb25UYWJsZU5hbWVcIik7XG5cbiAgICByZXR1cm4gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgIHRhYmxlTmFtZSxcbiAgICAgIGJpbGxpbmdNb2RlLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwicGtcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJza1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJ0dGxcIixcbiAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICBkZWxldGlvblByb3RlY3Rpb246IGRlbGV0aW9uUHJvdGVjdGlvbixcbiAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiBlbmFibGVQSVRSLFxuICAgICAgfSxcbiAgICAgIGVuY3J5cHRpb24sXG4gICAgICBlbmNyeXB0aW9uS2V5OiBwcm9wcy5zZXNzaW9uVGFibGVFbmNyeXB0aW9uS2V5LFxuICAgICAgLi4uKGJpbGxpbmdNb2RlID09PSBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJlYWRDYXBhY2l0eTogcHJvcHMuc2Vzc2lvblRhYmxlUmVhZENhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgICB3cml0ZUNhcGFjaXR5OiBwcm9wcy5zZXNzaW9uVGFibGVXcml0ZUNhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgfVxuICAgICAgICA6IHt9KSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU3RhZ2UoXG4gICAgc3RhZ2VPcHRzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyxcbiAgICBzdGFnZU5hbWU6IHN0cmluZyxcbiAgICBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dCxcbiAgICBsb2dpY2FsPzogc3RyaW5nLFxuICApOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKCFuZWVkc0V4cGxpY2l0U3RhZ2Uoc3RhZ2VPcHRzLCBzdGFnZU5hbWUpKSB7XG4gICAgICByZXR1cm4gdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YWdlID0gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZU5hbWUsXG4gICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgdGhyb3R0bGU6IChzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgY29uc3Qgc3RhbmRhcmQgPSBuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgbG9naWNhbCAhPT0gdW5kZWZpbmVkO1xuICAgICAgaWYgKG5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZSAmJiAhbG9naWNhbCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgbG9naWNhbCBuYW1lXCIpO1xuICAgICAgfVxuICAgICAgLy8gVGhlIGNvbnN0cnVjdC1jcmVhdGVkIGFjY2Vzcy1sb2cgZ3JvdXAgaXMgYSBsb2dnaW5nIHJlc291cmNlOiB1bmRlciB0aGVcbiAgICAgIC8vIHN0YW5kYXJkIHByb2ZpbGUgaXQgdGFrZXMgdGhlIGNvbnRyYWN0IGxvZy1zb3VyY2UgbmFtZSwgYW5kIHVuZGVyIHRoZVxuICAgICAgLy8gbGVnYWN5IHByb2ZpbGUgaXQga2VlcHMgdG9kYXkncyBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZSBhbmRcbiAgICAgIC8vIGNvbnN1bWVzIG5vIG5hbWluZyBlbnRyeSAocjMsIEFEVi0xMzEyLTEpLlxuICAgICAgY29uc3QgbG9nR3JvdXAgPSBzdGFuZGFyZCAmJiBsb2dpY2FsXG4gICAgICAgID8gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogbmFtaW5nQ29udGV4dCEubG9nR3JvdXBOYW1lKGBsb2dzL2FjY2Vzcy9hcGkvJHtsb2dpY2FsfWApLFxuICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IobmFtaW5nQ29udGV4dCEucmV0ZW50aW9uRGF5cyksXG4gICAgICAgICAgfSlcbiAgICAgICAgOiBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcbiAgICAgIGlmIChzdGFuZGFyZCAmJiBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwpIHtcbiAgICAgICAgLy8gQ29udHJhY3Qgc2VjdGlvbiAxMS40OiBkZWNsYXJlIHRoZSByZXNvdXJjZSBjYXJyeWluZyB0aGUgbG9nLXNvdXJjZSBuYW1lLlxuICAgICAgICBuYW1pbmdDb250ZXh0LmRlY2xhcmVOYW1lKFwibG9nX2dyb3VwXCIsIGBsb2dzL2FjY2Vzcy9hcGkvJHtsb2dpY2FsfWAsIGxvZ0dyb3VwKTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgZm9ybWF0OiBzdGFuZGFyZCA/IGh0dHBBcGlBY2Nlc3NMb2dGb3JtYXQoKSA6IGxlZ2FjeUFjY2Vzc0xvZ0Zvcm1hdCgpLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gc3RhZ2U7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNvbnRyb2xsZXJGdW5jdGlvbihcbiAgICBwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyxcbiAgICBpbWFnZUFybjogc3RyaW5nLFxuICAgIGluZ3Jlc3NDb25uZWN0b3JBcm5zOiBzdHJpbmdbXSxcbiAgICBlZ3Jlc3NDb25uZWN0b3JBcm5zOiBzdHJpbmdbXSxcbiAgICBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm46IHN0cmluZyxcbiAgICBsb2dnaW5nRW52aXJvbm1lbnQ6IHN0cmluZyxcbiAgKTogbGFtYmRhLkZ1bmN0aW9uIHtcbiAgICBjb25zdCBjb250cm9sbGVyUHJvcHMgPSBwcm9wcy5jb250cm9sbGVyO1xuICAgIGNvbnN0IGVudmlyb25tZW50ID0gYnVpbGRDb250cm9sbGVyRW52aXJvbm1lbnQoXG4gICAgICBjb250cm9sbGVyUHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICB7XG4gICAgICAgIFtFTlZfQ09OVFJBQ1RfTkFNRV06IE1JQ1JPVk1fQ09OVFJBQ1RfTkFNRSxcbiAgICAgICAgW0VOVl9DT05UUkFDVF9WRVJTSU9OXTogTUlDUk9WTV9DT05UUkFDVF9WRVJTSU9OLFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfRU5EUE9JTlRdOiB0aGlzLmVuZHBvaW50LFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfT1BFUkFUSU9OU106IENPTlRST0xMRVJfT1BFUkFUSU9OUy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX1JPVVRFU106IENPTlRST0xMRVJfUk9VVEVfREVGSU5JVElPTlMubWFwKChyb3V0ZSkgPT4gYCR7cm91dGUubWV0aG9kfSAke3JvdXRlLnBhdGh9YCkuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEXTogQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVELFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUXTogQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQsXG4gICAgICAgIFtFTlZfU0VTU0lPTl9SRUdJU1RSWV9UQUJMRV06IHRoaXMuc2Vzc2lvblRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgW0VOVl9JTUFHRV9SRUZdOiBpbWFnZUFybixcbiAgICAgICAgW0VOVl9ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXTogZWdyZXNzQ29ubmVjdG9yQXJucy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlNdOiBpbmdyZXNzQ29ubmVjdG9yQXJucy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU106IGVncmVzc0Nvbm5lY3RvckFybnMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfU0hFTExfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZdOiBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm4sXG4gICAgICAgIFtFTlZfTE9HR0lOR106IGxvZ2dpbmdFbnZpcm9ubWVudCxcbiAgICAgICAgLi4uKHByb3BzLmV4ZWN1dGlvblJvbGUgPyB7IFtFTlZfRVhFQ1VUSU9OX1JPTEVfQVJOXTogcHJvcHMuZXhlY3V0aW9uUm9sZS5yb2xlQXJuIH0gOiB7fSksXG4gICAgICB9LFxuICAgICk7XG5cbiAgICByZXR1cm4gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkNvbnRyb2xsZXJGdW5jdGlvblwiLCB7XG4gICAgICBhcmNoaXRlY3R1cmU6IGNvbnRyb2xsZXJQcm9wcy5hcmNoaXRlY3R1cmUgPz8gbGFtYmRhLkFyY2hpdGVjdHVyZS5BUk1fNjQsXG4gICAgICB0cmFjaW5nOiBjb250cm9sbGVyUHJvcHMudHJhY2luZyA/PyBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgICBtZW1vcnlTaXplOiBjb250cm9sbGVyUHJvcHMubWVtb3J5U2l6ZSA/PyA1MTIsXG4gICAgICB0aW1lb3V0OiBjb250cm9sbGVyUHJvcHMudGltZW91dCA/PyBEdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIC4uLmNvbnRyb2xsZXJQcm9wcyxcbiAgICAgIGVudmlyb25tZW50LFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBncmFudE1pY3Jvdm1Db250cm9sUGxhbmUocHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpOiB2b2lkIHtcbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbFBsYW5lXCIsXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImxhbWJkYTpDcmVhdGVNaWNyb3ZtQXV0aFRva2VuXCIsXG4gICAgICAgICAgXCJsYW1iZGE6Q3JlYXRlTWljcm92bVNoZWxsQXV0aFRva2VuXCIsXG4gICAgICAgICAgXCJsYW1iZGE6R2V0TWljcm92bVwiLFxuICAgICAgICAgIFwibGFtYmRhOlJlc3VtZU1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpSdW5NaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6U3VzcGVuZE1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpUZXJtaW5hdGVNaWNyb3ZtXCIsXG4gICAgICAgIF0sXG4gICAgICAgIC8vIExhbWJkYSBNaWNyb1ZNIHJlc291cmNlLWxldmVsIElBTSBzY29waW5nIGZvciB0aGVzZSBhY3Rpb25zIHJlbWFpbnNcbiAgICAgICAgLy8gdW50ZXN0ZWQsIHNvIHRoZSBncmFudCBzdGF5cyBvbiBcIipcIi4gVGhlIG9uZSBsaXZlIG9ic2VydmF0aW9uICh0aGVcbiAgICAgICAgLy8gaW1hZ2UtdmVyc2lvbiBsaXN0L2RlbGV0ZSBvcGVyYXRpb25zKSBzaG93cyB0aGUgY29udHJvbCBwbGFuZVxuICAgICAgICAvLyBhdXRob3JpemVzIHRoZSBjYW5vbmljYWwgY29sb24tZm9ybSBpbWFnZSBBUk4gKGAuLi46bWljcm92bS1pbWFnZTo8bmFtZT5gKVxuICAgICAgICAvLyBhbmQgcmVqZWN0cyB0aGUgc2xhc2ggZm9ybSB3aXRoIEhUVFAgNDAzIEFjY2Vzc0RlbmllZCByZWdhcmRsZXNzIG9mXG4gICAgICAgIC8vIElBTSAobGl2ZS12ZXJpZmllZCkuIEFwcFRoZW9yeSBjb25zdHJhaW5zIHdoaWNoIGltYWdlL2Nvbm5lY3RvcnMvcm9sZVxuICAgICAgICAvLyBtYXkgYmUgdXNlZCB0aHJvdWdoIHR5cGVkIGNvbnN0cnVjdCBwcm9wcywgZmFpbC1jbG9zZWQgY29udHJvbGxlciBlbnYsXG4gICAgICAgIC8vIGFuZCBzY29wZWQgaWFtOlBhc3NSb2xlIHJhdGhlciB0aGFuIHJlLXNjb3BpbmcgdGhlc2UgcmVzb3VyY2UgZ3JhbnRzLlxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6IFwiQXBwVGhlb3J5TWljcm92bUxpc3RcIixcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOkxpc3RNaWNyb3Ztc1wiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgc2lkOiBcIkFwcFRoZW9yeU1pY3Jvdm1QYXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOlBhc3NOZXR3b3JrQ29ubmVjdG9yXCJdLFxuICAgICAgICAvLyBMYW1iZGEgbWFya3MgUGFzc05ldHdvcmtDb25uZWN0b3IgYXMgcGVybWlzc2lvbi1vbmx5IHdpdGhvdXQgcmVzb3VyY2UtbGV2ZWxcbiAgICAgICAgLy8gc3VwcG9ydC4gQXBwVGhlb3J5IGNvbnN0cmFpbnMgdGhlIHBlcm1pdHRlZCBjb25uZWN0b3Igc2V0IHRocm91Z2ggdHlwZWQgcHJvcHNcbiAgICAgICAgLy8gYW5kIGZhaWwtY2xvc2VkIGVudmlyb25tZW50IHdpcmluZyBpbnN0ZWFkIG9mIGFjY2VwdGluZyByYXcgcmVxdWVzdCBzdHJpbmdzLlxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgaWYgKHByb3BzLmV4ZWN1dGlvblJvbGUpIHtcbiAgICAgIHByb3BzLmV4ZWN1dGlvblJvbGUuZ3JhbnRQYXNzUm9sZSh0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5ncmFudFByaW5jaXBhbCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhZGRDb250cm9sbGVyUm91dGVzKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2YgQ09OVFJPTExFUl9ST1VURV9ERUZJTklUSU9OUykge1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgICAgcGF0aDogcm91dGUucGF0aCxcbiAgICAgICAgbWV0aG9kczogW3JvdXRlLm1ldGhvZF0sXG4gICAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24ocm91dGUuaWQsIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLCB7XG4gICAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogdGhpcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlLFxuICAgICAgICB9KSxcbiAgICAgICAgYXV0aG9yaXplcjogdGhpcy5yb3V0ZUF1dGhvcml6ZXIsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbGVnYWN5QWNjZXNzTG9nRm9ybWF0KCk6IHN0cmluZyB7XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7XG4gICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICB9KTtcbn1cblxuLyoqXG4gKiBBcHBseSB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlJ3MgZGVmYXVsdC1vbiBhY2Nlc3MgbG9nZ2luZy4gQW4gZXhwbGljaXRcbiAqIGBhY2Nlc3NMb2dnaW5nYCB2YWx1ZSwgaW5jbHVkaW5nIGBmYWxzZWAsIGFsd2F5cyB3aW5zLlxuICovXG5mdW5jdGlvbiBlZmZlY3RpdmVTdGFnZU9wdGlvbnMoXG4gIHN0YWdlOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyxcbiAgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQsXG4pOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyB7XG4gIGlmIChuYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWUgJiYgc3RhZ2UuYWNjZXNzTG9nZ2luZyA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHsgLi4uc3RhZ2UsIGFjY2Vzc0xvZ2dpbmc6IHRydWUgfTtcbiAgfVxuICByZXR1cm4gc3RhZ2U7XG59XG5cbmZ1bmN0aW9uIG5lZWRzRXhwbGljaXRTdGFnZShzdGFnZU9wdHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zLCBzdGFnZU5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICB8fCBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZVxuICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWRcbiAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSZXF1aXJlZCh2YWx1ZTogdW5rbm93biwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyh2YWx1ZSkudHJpbSgpO1xuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nLCBtYXhMZW5ndGg6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgcHJvcE5hbWUpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgL1xccy8udGVzdChub3JtYWxpemVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6ICR7cHJvcE5hbWV9IG11c3Qgbm90IGNvbnRhaW4gd2hpdGVzcGFjZWApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiBub3JtYWxpemVkLmxlbmd0aCA+IG1heExlbmd0aCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYXQgbW9zdCAke21heExlbmd0aH0gY2hhcmFjdGVyc2ApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBjb250cm9sbGVyTG9nZ2luZ0Vudmlyb25tZW50KFxuICBsb2dnaW5nOiBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nIHwgdW5kZWZpbmVkLFxuICBleGVjdXRpb25Sb2xlOiBpYW0uSVJvbGUgfCB1bmRlZmluZWQsXG4pOiBzdHJpbmcge1xuICBpZiAobG9nZ2luZyA9PT0gdW5kZWZpbmVkIHx8IGxvZ2dpbmcgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZ1wiKTtcbiAgfVxuICBjb25zdCBoYXNDbG91ZFdhdGNoID0gbG9nZ2luZy5jbG91ZFdhdGNoICE9PSB1bmRlZmluZWQgJiYgbG9nZ2luZy5jbG91ZFdhdGNoICE9PSBudWxsO1xuICBjb25zdCBoYXNEaXNhYmxlZCA9IGxvZ2dpbmcuZGlzYWJsZWQgIT09IHVuZGVmaW5lZDtcbiAgaWYgKGhhc0Nsb3VkV2F0Y2ggPT09IGhhc0Rpc2FibGVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcgbXVzdCBzcGVjaWZ5IGV4YWN0bHkgb25lIG9mIGNsb3VkV2F0Y2ggb3IgZGlzYWJsZWRcIixcbiAgICApO1xuICB9XG4gIGlmIChoYXNEaXNhYmxlZCkge1xuICAgIGlmIChsb2dnaW5nLmRpc2FibGVkICE9PSB0cnVlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmRpc2FibGVkIG11c3QgYmUgdHJ1ZSB3aGVuIHByb3ZpZGVkXCIsXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBkaXNhYmxlZDogdHJ1ZSB9KTtcbiAgfVxuICBpZiAoIWV4ZWN1dGlvblJvbGUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLmV4ZWN1dGlvblJvbGUgd2hlbiBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoIGlzIGNvbmZpZ3VyZWRcIixcbiAgICApO1xuICB9XG5cbiAgY29uc3QgY2xvdWRXYXRjaCA9IGxvZ2dpbmcuY2xvdWRXYXRjaDtcbiAgaWYgKCFjbG91ZFdhdGNoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaFwiKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIGlmIChjbG91ZFdhdGNoLmxvZ0dyb3VwICE9PSB1bmRlZmluZWQpIHtcbiAgICBub3JtYWxpemVkLmxvZ19ncm91cCA9IG5vcm1hbGl6ZUNvbnRyb2xsZXJMb2dHcm91cChjbG91ZFdhdGNoLmxvZ0dyb3VwKTtcbiAgfVxuICBpZiAoY2xvdWRXYXRjaC5sb2dTdHJlYW0gIT09IHVuZGVmaW5lZCkge1xuICAgIG5vcm1hbGl6ZWQubG9nX3N0cmVhbSA9IG5vcm1hbGl6ZUNvbnRyb2xsZXJMb2dTdHJlYW0oY2xvdWRXYXRjaC5sb2dTdHJlYW0pO1xuICB9XG4gIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IGNsb3VkX3dhdGNoOiBub3JtYWxpemVkIH0pO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb250cm9sbGVyTG9nR3JvdXAodmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJtaWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgIS9eW2EtekEtWjAtOV9cXC0vLiNdezEsNTEyfSQvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoLmxvZ0dyb3VwIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29udHJvbGxlckxvZ1N0cmVhbSh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBcIm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtXCIpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgKCEvXlteOipdKiQvLnRlc3Qobm9ybWFsaXplZCkgfHwgbm9ybWFsaXplZC5sZW5ndGggPiA1MTIpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW0gaXMgb3V0c2lkZSB0aGUgQ2xvdWRXYXRjaCBMb2dzIHBhdHRlcm5cIixcbiAgICApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICBjb25uZWN0b3JzOiByZWFkb25seSBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXSB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbiAgZXhwZWN0ZWRLaW5kOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQsXG4pOiBzdHJpbmdbXSB7XG4gIGlmICghY29ubmVjdG9ycyB8fCBjb25uZWN0b3JzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgYXQgbGVhc3QgMSAke3Byb3BOYW1lfSBlbnRyeWApO1xuICB9XG4gIGlmIChjb25uZWN0b3JzLmxlbmd0aCA+IDEwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBzdXBwb3J0cyBhdCBtb3N0IDEwICR7cHJvcE5hbWV9IGVudHJpZXNgKTtcbiAgfVxuXG4gIGNvbnN0IGFybnMgPSBjb25uZWN0b3JzLm1hcCgoY29ubmVjdG9yLCBpbmRleCkgPT4ge1xuICAgIHJldHVybiBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoY29ubmVjdG9yLCBgJHtwcm9wTmFtZX1bJHtpbmRleH1dYCwgZXhwZWN0ZWRLaW5kKTtcbiAgfSk7XG5cbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKGFybnMsIGAke3Byb3BOYW1lfSBuZXR3b3JrQ29ubmVjdG9yQXJuYCk7XG4gIHJldHVybiBhcm5zO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoXG4gIGNvbm5lY3RvcjogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuICBleHBlY3RlZEtpbmQ6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCxcbik6IHN0cmluZyB7XG4gIGlmIChjb25uZWN0b3IgPT09IHVuZGVmaW5lZCB8fCBjb25uZWN0b3IgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgY29uc3QgYWN0dWFsS2luZCA9IG5vcm1hbGl6ZUNvbm5lY3RvcktpbmRGb3JDb250cm9sbGVyKGNvbm5lY3Rvci5uZXR3b3JrQ29ubmVjdG9yS2luZCwgcHJvcE5hbWUpO1xuICBpZiAoYWN0dWFsS2luZCAhPT0gZXhwZWN0ZWRLaW5kKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy4ke3Byb3BOYW1lfSBtdXN0IGJlIGEgJHtleHBlY3RlZEtpbmR9IGNvbm5lY3RvciByZWZlcmVuY2VgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhjb25uZWN0b3IubmV0d29ya0Nvbm5lY3RvckFybiwgYCR7cHJvcE5hbWV9Lm5ldHdvcmtDb25uZWN0b3JBcm5gLCAyMDQ4KTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29ubmVjdG9yS2luZEZvckNvbnRyb2xsZXIoXG4gIGtpbmQ6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCB8IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbik6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCB7XG4gIGlmIChraW5kID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy4ke3Byb3BOYW1lfSBtdXN0IGluY2x1ZGUgbmV0d29ya0Nvbm5lY3RvcktpbmRgKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKGtpbmQpLnRyaW0oKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1tfLV0vZywgXCJcIik7XG4gIGlmIChub3JtYWxpemVkID09PSBcImluZ3Jlc3NcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuSU5HUkVTUztcbiAgfVxuICBpZiAobm9ybWFsaXplZCA9PT0gXCJlZ3Jlc3NcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuRUdSRVNTO1xuICB9XG4gIGlmIChub3JtYWxpemVkID09PSBcInNoZWxsaW5ncmVzc1wiKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5TSEVMTF9JTkdSRVNTO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLiR7cHJvcE5hbWV9Lm5ldHdvcmtDb25uZWN0b3JLaW5kIG11c3QgYmUgaW5ncmVzcywgZWdyZXNzLCBvciBzaGVsbC1pbmdyZXNzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gZGVkdXBlQ29ubmVjdG9yQXJucyhhcm5zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKGFybnMsIFwiY29udHJvbGxlciBuZXR3b3JrQ29ubmVjdG9yQXJuXCIpO1xuICByZXR1cm4gYXJucztcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9EdXBsaWNhdGVzKHZhbHVlczogcmVhZG9ubHkgc3RyaW5nW10sIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHNlZW4uaGFzKHZhbHVlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBkb2VzIG5vdCBhbGxvdyBkdXBsaWNhdGUgJHtsYWJlbH0gdmFsdWVzYCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVIZWFkZXJOYW1lKGhlYWRlck5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBTdHJpbmcoaGVhZGVyTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gIGlmICghdHJpbW1lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBhdXRob3JpemVySGVhZGVyTmFtZSBpcyByZXF1aXJlZFwiKTtcbiAgfVxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RhZ2VOYW1lKHN0YWdlTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IFN0cmluZyhzdGFnZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogc3RhZ2VOYW1lIGlzIHJlcXVpcmVkXCIpO1xuICB9XG4gIHJldHVybiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiBidWlsZENvbnRyb2xsZXJFbnZpcm9ubWVudChcbiAgdXNlckVudmlyb25tZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkLFxuICByZXNlcnZlZEVudmlyb25tZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IGVudmlyb25tZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyAuLi4odXNlckVudmlyb25tZW50ID8/IHt9KSB9O1xuICBmb3IgKGNvbnN0IGtleSBvZiBSRVNFUlZFRF9FTlZfS0VZUykge1xuICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoZW52aXJvbm1lbnQsIGtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IGNvbnRyb2xsZXIuZW52aXJvbm1lbnQgY2Fubm90IG92ZXJyaWRlIHJlc2VydmVkICR7a2V5fWApO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyAuLi5lbnZpcm9ubWVudCwgLi4ucmVzZXJ2ZWRFbnZpcm9ubWVudCB9O1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cbiJdfQ==