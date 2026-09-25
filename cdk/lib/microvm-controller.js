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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmController", version: "4.4.1" };
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
    createStage(stageOpts, stageName) {
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
            this.accessLogGroup = logGroup;
            const cfnStage = stage.node.defaultChild;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1jb250cm9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1jb250cm9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSw2Q0FBNkQ7QUFDN0Qsc0VBQXdEO0FBQ3hELDZGQUErRTtBQUMvRSwrRkFBaUY7QUFDakYsbUVBQXFEO0FBQ3JELHlEQUEyQztBQUUzQywrREFBaUQ7QUFDakQsMkRBQTZDO0FBQzdDLDJDQUF1QztBQUd2QywyRUFHcUM7QUFFckMsTUFBTSxxQkFBcUIsR0FBRywwQkFBMEIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLGdCQUFnQixDQUFDO0FBQ2xELE1BQU0sd0JBQXdCLEdBQUcsTUFBTSxDQUFDO0FBQ3hDLE1BQU0sdUJBQXVCLEdBQUcsTUFBTSxDQUFDO0FBQ3ZDLE1BQU0scUJBQXFCLEdBQUc7SUFDNUIsS0FBSztJQUNMLEtBQUs7SUFDTCxNQUFNO0lBQ04sU0FBUztJQUNULFFBQVE7SUFDUixXQUFXO0lBQ1gsUUFBUTtJQUNSLFlBQVk7SUFDWixrQkFBa0I7Q0FDbkIsQ0FBQztBQUNGLE1BQU0sNEJBQTRCLEdBQW9FO0lBQ3BHLEVBQUUsRUFBRSxFQUFFLFlBQVksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLFdBQVcsRUFBRTtJQUN4RSxFQUFFLEVBQUUsRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUU7SUFDekUsRUFBRSxFQUFFLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsd0JBQXdCLEVBQUU7SUFDcEYsRUFBRSxFQUFFLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxV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QztJQUUzQyxNQUFNLFdBQVcsR0FBMkIsRUFBRSxHQUFHLENBQUMsZUFBZSxJQUFJLEVBQUUsQ0FBQyxFQUFFLENBQUM7SUFDM0UsS0FBSyxNQUFNLEdBQUcsSUFBSSxpQkFBaUIsRUFBRSxDQUFDO1FBQ3BDLElBQUksTUFBTSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxHQUFHLENBQUMsRUFBRSxDQUFDO1lBQzNELE1BQU0sSUFBSSxLQUFLLENBQUMsK0VBQStFLEdBQUcsRUFBRSxDQUFDLENBQUM7UUFDeEcsQ0FBQztJQUNILENBQUM7SUFDRCxPQUFPLEVBQUUsR0FBRyxXQUFXLEVBQUUsR0FBRyxtQkFBbUIsRUFBRSxDQUFDO0FBQ3BELENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLEdBQVc7SUFDckMsT0FBTyxHQUFHLENBQUMsT0FBTyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztBQUNoQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgRHVyYXRpb24sIFJlbW92YWxQb2xpY3ksIFRva2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlNaWNyb3ZtSW1hZ2VMb2dnaW5nLCBJQXBwVGhlb3J5TWljcm92bUltYWdlIH0gZnJvbSBcIi4vbWljcm92bS1pbWFnZVwiO1xuaW1wb3J0IHtcbiAgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuICB0eXBlIElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvcixcbn0gZnJvbSBcIi4vbWljcm92bS1uZXR3b3JrLWNvbm5lY3RvclwiO1xuXG5jb25zdCBNSUNST1ZNX0NPTlRSQUNUX05BTUUgPSBcImFwcHRoZW9yeS5sYW1iZGFfbWljcm92bVwiO1xuY29uc3QgTUlDUk9WTV9DT05UUkFDVF9WRVJTSU9OID0gXCJtMTYubWljcm92bS92MVwiO1xuY29uc3QgQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEID0gXCJ0cnVlXCI7XG5jb25zdCBDT05UUk9MTEVSX0FVVEhfREVGQVVMVCA9IFwiZGVueVwiO1xuY29uc3QgQ09OVFJPTExFUl9PUEVSQVRJT05TID0gW1xuICBcInJ1blwiLFxuICBcImdldFwiLFxuICBcImxpc3RcIixcbiAgXCJzdXNwZW5kXCIsXG4gIFwicmVzdW1lXCIsXG4gIFwidGVybWluYXRlXCIsXG4gIFwiaW52b2tlXCIsXG4gIFwiYXV0aC10b2tlblwiLFxuICBcInNoZWxsLWF1dGgtdG9rZW5cIixcbl07XG5jb25zdCBDT05UUk9MTEVSX1JPVVRFX0RFRklOSVRJT05TOiBBcnJheTx7IGlkOiBzdHJpbmc7IG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kOyBwYXRoOiBzdHJpbmcgfT4gPSBbXG4gIHsgaWQ6IFwiUnVuTWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztc1wiIH0sXG4gIHsgaWQ6IFwiTGlzdE1pY3Jvdm1zXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogXCIvbWljcm92bXNcIiB9LFxuICB7IGlkOiBcIkdldE1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH1cIiB9LFxuICB7IGlkOiBcIlN1c3BlbmRNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9zdXNwZW5kXCIgfSxcbiAgeyBpZDogXCJSZXN1bWVNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9yZXN1bWVcIiB9LFxuICB7IGlkOiBcIlRlcm1pbmF0ZU1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFLCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH1cIiB9LFxuICB7IGlkOiBcIkludm9rZU1pY3Jvdm1Sb290XCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L2ludm9rZVwiIH0sXG4gIHsgaWQ6IFwiSW52b2tlTWljcm92bVByb3h5XCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L2ludm9rZS97cHJveHkrfVwiIH0sXG4gIHsgaWQ6IFwiQ3JlYXRlTWljcm92bUF1dGhUb2tlblwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vYXV0aC10b2tlblwiIH0sXG4gIHtcbiAgICBpZDogXCJDcmVhdGVNaWNyb3ZtU2hlbGxBdXRoVG9rZW5cIixcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULFxuICAgIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9zaGVsbC1hdXRoLXRva2VuXCIsXG4gIH0sXG5dO1xuXG5jb25zdCBFTlZfQ09OVFJBQ1RfTkFNRSA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJBQ1RfTkFNRVwiO1xuY29uc3QgRU5WX0NPTlRSQUNUX1ZFUlNJT04gPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRSQUNUX1ZFUlNJT05cIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0VORFBPSU5UID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0VORFBPSU5UXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9PUEVSQVRJT05TID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX09QRVJBVElPTlNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX1JPVVRFUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9ST1VURVNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRFwiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0FVVEhfREVGQVVMVFwiO1xuY29uc3QgRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEUgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX1NFU1NJT05fUkVHSVNUUllfVEFCTEVcIjtcbmNvbnN0IEVOVl9JTUFHRV9SRUYgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX1JFRlwiO1xuY29uc3QgRU5WX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX05FVFdPUktfQ09OTkVDVE9SX1JFRlNcIjtcbmNvbnN0IEVOVl9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTID0gXCJBUFBUSEVPUllfTUlDUk9WTV9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGID0gXCJBUFBUSEVPUllfTUlDUk9WTV9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlwiO1xuY29uc3QgRU5WX0VYRUNVVElPTl9ST0xFX0FSTiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fRVhFQ1VUSU9OX1JPTEVfQVJOXCI7XG5jb25zdCBFTlZfTE9HR0lORyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fTE9HR0lOR1wiO1xuXG5jb25zdCBSRVNFUlZFRF9FTlZfS0VZUyA9IFtcbiAgRU5WX0NPTlRSQUNUX05BTUUsXG4gIEVOVl9DT05UUkFDVF9WRVJTSU9OLFxuICBFTlZfQ09OVFJPTExFUl9FTkRQT0lOVCxcbiAgRU5WX0NPTlRST0xMRVJfT1BFUkFUSU9OUyxcbiAgRU5WX0NPTlRST0xMRVJfUk9VVEVTLFxuICBFTlZfQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVELFxuICBFTlZfQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQsXG4gIEVOVl9TRVNTSU9OX1JFR0lTVFJZX1RBQkxFLFxuICBFTlZfSU1BR0VfUkVGLFxuICBFTlZfTkVUV09SS19DT05ORUNUT1JfUkVGUyxcbiAgRU5WX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGUyxcbiAgRU5WX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTLFxuICBFTlZfU0hFTExfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUYsXG4gIEVOVl9FWEVDVVRJT05fUk9MRV9BUk4sXG4gIEVOVl9MT0dHSU5HLFxuXTtcblxuLyoqXG4gKiBTdGFnZSBjb25maWd1cmF0aW9uIGZvciB0aGUgTWljcm9WTSBjb250cm9sbGVyIEhUVFAgQVBJLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zIHtcbiAgLyoqXG4gICAqIFN0YWdlIG5hbWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFwiJGRlZmF1bHRcIlxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBFbmFibGUgQ2xvdWRXYXRjaCBhY2Nlc3MgbG9nZ2luZyBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBmYWxzZVxuICAgKi9cbiAgcmVhZG9ubHkgYWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFJldGVudGlvbiBwZXJpb2QgZm9yIGF1dG8tY3JlYXRlZCBhY2Nlc3MgbG9nIGdyb3VwLlxuICAgKiBPbmx5IGFwcGxpZXMgd2hlbiBhY2Nlc3NMb2dnaW5nIGlzIHRydWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEhcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcblxuICAvKipcbiAgICogVGhyb3R0bGluZyByYXRlIGxpbWl0IChyZXF1ZXN0cyBwZXIgc2Vjb25kKSBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nUmF0ZUxpbWl0PzogbnVtYmVyO1xuXG4gIC8qKlxuICAgKiBUaHJvdHRsaW5nIGJ1cnN0IGxpbWl0IGZvciB0aGUgc3RhZ2UuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAobm8gdGhyb3R0bGluZylcbiAgICovXG4gIHJlYWRvbmx5IHRocm90dGxpbmdCdXJzdExpbWl0PzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFBhY2thZ2luZyBhbmQgcnVudGltZSBjb25maWd1cmF0aW9uIGZvciB0aGUgQXBwVGhlb3J5IE1pY3JvVk0gY29udHJvbGxlciBMYW1iZGEuXG4gKlxuICogQXBwVGhlb3J5IGNyZWF0ZXMgdGhlIExhbWJkYSBmdW5jdGlvbiBzbyBpdCBjYW4gd2lyZSB0aGUgY2Fub25pY2FsIHNlc3Npb24gdGFibGUsXG4gKiBNaWNyb1ZNIGltYWdlL25ldHdvcmsgcmVmZXJlbmNlcywgYW5kIGZhaWwtY2xvc2VkIGF1dGggZW52aXJvbm1lbnQgY29uc2lzdGVudGx5LlxuICogVGhlIGNhbGxlciBzdXBwbGllcyBvbmx5IHRoZSBoYW5kbGVyIHBhY2thZ2UgZGV0YWlscyBhbmQgYW55IG9yZGluYXJ5IExhbWJkYVxuICogRnVuY3Rpb25Qcm9wcy5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlckZ1bmN0aW9uUHJvcHMgZXh0ZW5kcyBsYW1iZGEuRnVuY3Rpb25Qcm9wcyB7fVxuXG4vKipcbiAqIFByb3BzIGZvciBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlci5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzIHtcbiAgLyoqXG4gICAqIENvbnRyb2xsZXIgTGFtYmRhIHBhY2thZ2luZyBhbmQgY29uZmlndXJhdGlvbi5cbiAgICpcbiAgICogVGhlIGhhbmRsZXIgY29kZSBtdXN0IHVzZSBBcHBUaGVvcnkncyBNaWNyb1ZNIHJ1bnRpbWUvY29udHJvbGxlciBwcmltaXRpdmVzLlxuICAgKiBUaGlzIGNvbnN0cnVjdCBkb2VzIG5vdCBpbXBsZW1lbnQgYSBwcm9kdWN0IGNvbnRyb2wtcGxhbmUgc2VydmljZS5cbiAgICovXG4gIHJlYWRvbmx5IGNvbnRyb2xsZXI6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyRnVuY3Rpb25Qcm9wcztcblxuICAvKipcbiAgICogTGFtYmRhIHJlcXVlc3QgYXV0aG9yaXplciByZXF1aXJlZCBmb3IgZXZlcnkgY29udHJvbGxlciByb3V0ZS5cbiAgICpcbiAgICogVGhlIGNvbnN0cnVjdCBmYWlscyBjbG9zZWQgd2hlbiB0aGlzIGlzIG9taXR0ZWQ7IHVuYXV0aGVudGljYXRlZCBjb250cm9sbGVyIHJvdXRlc1xuICAgKiBhcmUgbm90IHN5bnRoZXNpemVkLlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplcjogbGFtYmRhLklGdW5jdGlvbjtcblxuICAvKipcbiAgICogVGhlIE1pY3JvVk0gaW1hZ2UgdGhlIGNvbnRyb2xsZXIgaXMgcGVybWl0dGVkIHRvIHJ1bi5cbiAgICovXG4gIHJlYWRvbmx5IG1pY3Jvdm1JbWFnZTogSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZTtcblxuICAvKipcbiAgICogSW5ncmVzcyBuZXR3b3JrIGNvbm5lY3RvcnMgdGhlIGNvbnRyb2xsZXIgaXMgcGVybWl0dGVkIHRvIHBhc3MgdG8gTGFtYmRhIE1pY3JvVk1zLlxuICAgKlxuICAgKiBBdCBsZWFzdCBvbmUgY29ubmVjdG9yIHJlZmVyZW5jZSBpcyByZXF1aXJlZCBhbmQgbm8gbW9yZSB0aGFuIDEwIG1heSBiZSBzdXBwbGllZC5cbiAgICogVXNlIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yLmFsbEluZ3Jlc3Mvbm9JbmdyZXNzIG9yIGFuIGV4cGxpY2l0bHkgdHlwZWRcbiAgICogaW1wb3J0ZWQgaW5ncmVzcyBjb25uZWN0b3IgcmVmZXJlbmNlOyBBcHBUaGVvcnkgZG9lcyBub3QgaGlkZSBhbiBpbmdyZXNzIGRlZmF1bHQuXG4gICAqL1xuICByZWFkb25seSBpbmdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBFZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBwYXNzIHRvIExhbWJkYSBNaWNyb1ZNcy5cbiAgICpcbiAgICogQXQgbGVhc3Qgb25lIGNvbm5lY3RvciByZWZlcmVuY2UgaXMgcmVxdWlyZWQgYW5kIG5vIG1vcmUgdGhhbiAxMCBtYXkgYmUgc3VwcGxpZWQuXG4gICAqL1xuICByZWFkb25seSBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yczogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW107XG5cbiAgLyoqXG4gICAqIFNoZWxsIGluZ3Jlc3MgY29ubmVjdG9yIHJlcXVpcmVkIGZvciBzaGVsbC1hdXRoLXRva2VuIHN1cHBvcnQuXG4gICAqXG4gICAqIFVzZSBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvci5zaGVsbEluZ3Jlc3Mgb3IgYW4gZXhwbGljaXRseSB0eXBlZCBzaGVsbC1pbmdyZXNzXG4gICAqIGNvbm5lY3RvciByZWZlcmVuY2UuIFRoZSBzaGVsbC1hdXRoLXRva2VuIHJvdXRlIGlzIHBhcnQgb2YgdGhlIHJlYWwgTTE2IGNvbnRyb2xsZXJcbiAgICogc3VyZmFjZSwgc28gdGhpcyByZWZlcmVuY2UgaXMgcmVxdWlyZWQgaW5zdGVhZCBvZiBiZWluZyBzaWxlbnRseSBkZWZhdWx0ZWQuXG4gICAqL1xuICByZWFkb25seSBzaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3I7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIE1pY3JvVk0gZXhlY3V0aW9uIHJvbGUgcGFzc2VkIHRvIFJ1bk1pY3Jvdm0uXG4gICAqXG4gICAqIFdoZW4gc3VwcGxpZWQsIEFwcFRoZW9yeSBncmFudHMgdGhlIGNvbnRyb2xsZXIgTGFtYmRhIGlhbTpQYXNzUm9sZSBmb3IgdGhpcyByb2xlXG4gICAqIGFuZCBleHBvc2VzIHRoZSBBUk4gYXMgQVBQVEhFT1JZX01JQ1JPVk1fRVhFQ1VUSU9OX1JPTEVfQVJOLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGV4ZWN1dGlvblJvbGU/OiBpYW0uSVJvbGU7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIEFQSSBuYW1lLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIHN0YWdlIGNvbmZpZ3VyYXRpb24uXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoZGVmYXVsdCBIVFRQIEFQSSBzdGFnZSlcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlPzogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnM7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgTGFtYmRhIGludm9rZSBwZXJtaXNzaW9ucyBzaG91bGQgYmUgc2NvcGVkIHRvIGluZGl2aWR1YWwgY29udHJvbGxlciByb3V0ZXMuXG4gICAqXG4gICAqIFdoZW4gZmFsc2UsIHRoZSBjb25zdHJ1Y3QgZ3JhbnRzIG9uZSBBUEktc2NvcGVkIGludm9rZSBwZXJtaXNzaW9uIHBlciBMYW1iZGEgaW5zdGVhZCBvZlxuICAgKiBvbmUgcGVybWlzc2lvbiBwZXIgY29udHJvbGxlciByb3V0ZS4gVGhpcyBpcyB0aGUgc2NhbGFibGUgY2hvaWNlIGZvciB0aGUgY2Fub25pY2FsXG4gICAqIGNvbnRyb2xsZXIgcm91dGUgZmFtaWx5LCB3aGVyZSB0aGUgcGVyLXJvdXRlIHBlcm1pc3Npb25zIGNhbiBleGhhdXN0IHRoZSBMYW1iZGEgcmVzb3VyY2VcbiAgICogcG9saWN5IHNpemUgbGltaXQuXG4gICAqXG4gICAqIFRoZSB0cmFkZS1vZmYgaXMgZXhwbGljaXQ6IHRoZSBBUEktc2NvcGVkIHBlcm1pc3Npb24gYWxsb3dzIGV2ZXJ5IHJvdXRlIG9uIHRoYXQgSFRUUCBBUElcbiAgICogdG8gaW52b2tlIHRoZSBjb250cm9sbGVyIExhbWJkYSwgbm90IG9ubHkgdGhlIGNvbnRyb2xsZXIgcm91dGVzIHRoaXMgY29uc3RydWN0IG93bnMuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IHNjb3BlUGVybWlzc2lvblRvUm91dGU/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBOYW1lIGZvciB0aGUgZHVyYWJsZSBNaWNyb1ZNIHNlc3Npb24gcmVnaXN0cnkgRHluYW1vREIgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQmlsbGluZyBtb2RlIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgUEFZX1BFUl9SRVFVRVNUXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZT86IGR5bmFtb2RiLkJpbGxpbmdNb2RlO1xuXG4gIC8qKlxuICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcblxuICAvKipcbiAgICogV2hldGhlciBkZWxldGlvbiBwcm90ZWN0aW9uIHNob3VsZCBiZSBlbmFibGVkIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBBV1MgZGVmYXVsdCAobm8gZGVsZXRpb24gcHJvdGVjdGlvbilcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZURlbGV0aW9uUHJvdGVjdGlvbj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgcG9pbnQtaW4tdGltZSByZWNvdmVyeSBzaG91bGQgYmUgZW5hYmxlZCBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlIGVuY3J5cHRpb24gc2V0dGluZy5cbiAgICpcbiAgICogQGRlZmF1bHQgQVdTX01BTkFHRURcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZUVuY3J5cHRpb24/OiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb247XG5cbiAgLyoqXG4gICAqIEN1c3RvbWVyLW1hbmFnZWQgS01TIGtleSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIFJlcXVpcmVkIHdoZW4gc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VELlxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleT86IGttcy5JS2V5O1xuXG4gIC8qKlxuICAgKiBQcm92aXNpb25lZCByZWFkIGNhcGFjaXR5IHdoZW4gc2Vzc2lvblRhYmxlQmlsbGluZ01vZGUgaXMgUFJPVklTSU9ORUQuXG4gICAqXG4gICAqIEBkZWZhdWx0IDVcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZVJlYWRDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgd3JpdGUgY2FwYWNpdHkgd2hlbiBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZSBpcyBQUk9WSVNJT05FRC5cbiAgICpcbiAgICogQGRlZmF1bHQgNVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlV3JpdGVDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogSGVhZGVyIHVzZWQgYXMgdGhlIGlkZW50aXR5IHNvdXJjZSBmb3IgY29udHJvbGxlciBhdXRob3JpemF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcIkF1dGhvcml6YXRpb25cIlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckhlYWRlck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZyaWVuZGx5IGF1dGhvcml6ZXIgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGFtYmRhIGF1dGhvcml6ZXIgcmVzdWx0IGNhY2hlIFRUTC5cbiAgICpcbiAgICogRGVmYXVsdHMgdG8gZGlzYWJsZWQgc28gc3RhbGUgYXV0aCBjYW5ub3Qgc2lsZW50bHkgYnJvYWRlbiBjb250cm9sbGVyIGFjY2Vzcy5cbiAgICpcbiAgICogQGRlZmF1bHQgRHVyYXRpb24uc2Vjb25kcygwKVxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckNhY2hlVHRsPzogRHVyYXRpb247XG59XG5cbi8qKlxuICogQXBwVGhlb3J5IENESyBjb25zdHJ1Y3QgZm9yIHRoZSBmaXJzdC1jbGFzcyBMYW1iZGEgTWljcm9WTSBjb250cm9sbGVyIGRlcGxveW1lbnQgc3VyZmFjZS5cbiAqXG4gKiBUaGUgY29uc3RydWN0IHByb3Zpc2lvbnMgdGhlIHByb3RlY3RlZCBIVFRQIEFQSSByb3V0ZXMgZnJvbSB0aGUgTTE2IHJlYWwgY29udHJvbGxlciBjb250cmFjdCxcbiAqIHRoZSBjb250cm9sbGVyIExhbWJkYSwgdGhlIGNhbm9uaWNhbCBkdXJhYmxlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUsIElBTSBncmFudHMsIGFuZFxuICogZmFpbC1jbG9zZWQgYXV0aCBlbnZpcm9ubWVudCB3aXJpbmcuIFJ1bnRpbWUgY29tbWFuZCBoYW5kbGluZyByZW1haW5zIGluIHRoZSBBcHBUaGVvcnlcbiAqIHJ1bnRpbWUgY29udHJhY3Q7IHRoaXMgY29uc3RydWN0IG9ubHkgd2lyZXMgdGhlIGRlcGxveW1lbnQgcGF0aC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSB1bmRlcmx5aW5nIEhUVFAgQVBJIEdhdGV3YXkgdjIgQVBJLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJIEdhdGV3YXkgc3RhZ2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgcmVxdWVzdCBhdXRob3JpemVyIGF0dGFjaGVkIHRvIGV2ZXJ5IGNvbnRyb2xsZXIgcm91dGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVBdXRob3JpemVyOiBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBjb250cm9sbGVyIExhbWJkYSBmdW5jdGlvbiBjcmVhdGVkIGJ5IHRoaXMgY29uc3RydWN0LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNvbnRyb2xsZXJGdW5jdGlvbjogbGFtYmRhLkZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBUaGUgZHVyYWJsZSBUYWJsZVRoZW9yeS1zaGFwZWQgc2Vzc2lvbiByZWdpc3RyeSBEeW5hbW9EQiB0YWJsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJvbGxlciBiYXNlIGVuZHBvaW50IChgL21pY3Jvdm1zYCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgcHJpdmF0ZSByZWFkb25seSBzY29wZVBlcm1pc3Npb25Ub1JvdXRlOiBib29sZWFuO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGlmIChwcm9wcyA9PT0gdW5kZWZpbmVkIHx8IHByb3BzID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wc1wiKTtcbiAgICB9XG4gICAgdmFsaWRhdGVSZXF1aXJlZChwcm9wcy5jb250cm9sbGVyLCBcImNvbnRyb2xsZXJcIik7XG4gICAgdmFsaWRhdGVSZXF1aXJlZChwcm9wcy5hdXRob3JpemVyLCBcImF1dGhvcml6ZXJcIik7XG4gICAgdmFsaWRhdGVSZXF1aXJlZChwcm9wcy5taWNyb3ZtSW1hZ2UsIFwibWljcm92bUltYWdlXCIpO1xuICAgIHRoaXMuc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZSA9IHByb3BzLnNjb3BlUGVybWlzc2lvblRvUm91dGUgPz8gdHJ1ZTtcblxuICAgIGNvbnN0IGltYWdlQXJuID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHByb3BzLm1pY3Jvdm1JbWFnZS5taWNyb3ZtSW1hZ2VBcm4sIFwibWljcm92bUltYWdlLm1pY3Jvdm1JbWFnZUFyblwiLCAyMDQ4KTtcbiAgICBjb25zdCBpbmdyZXNzQ29ubmVjdG9yQXJucyA9IG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gICAgICBwcm9wcy5pbmdyZXNzTmV0d29ya0Nvbm5lY3RvcnMsXG4gICAgICBcImluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1wiLFxuICAgICAgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLklOR1JFU1MsXG4gICAgKTtcbiAgICBjb25zdCBlZ3Jlc3NDb25uZWN0b3JBcm5zID0gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhcbiAgICAgIHByb3BzLmVncmVzc05ldHdvcmtDb25uZWN0b3JzLFxuICAgICAgXCJlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1wiLFxuICAgICAgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLkVHUkVTUyxcbiAgICApO1xuICAgIGNvbnN0IHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybiA9IG5vcm1hbGl6ZVNpbmdsZUNvbm5lY3RvclJlZmVyZW5jZShcbiAgICAgIHByb3BzLnNoZWxsSW5ncmVzc05ldHdvcmtDb25uZWN0b3IsXG4gICAgICBcInNoZWxsSW5ncmVzc05ldHdvcmtDb25uZWN0b3JcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5TSEVMTF9JTkdSRVNTLFxuICAgICk7XG4gICAgY29uc3QgYWxsSW5ncmVzc0Nvbm5lY3RvckFybnMgPSBkZWR1cGVDb25uZWN0b3JBcm5zKFsuLi5pbmdyZXNzQ29ubmVjdG9yQXJucywgc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuXSk7XG4gICAgYXNzZXJ0Tm9EdXBsaWNhdGVzKFsuLi5hbGxJbmdyZXNzQ29ubmVjdG9yQXJucywgLi4uZWdyZXNzQ29ubmVjdG9yQXJuc10sIFwiY29udHJvbGxlciBuZXR3b3JrQ29ubmVjdG9yQXJuXCIpO1xuICAgIGNvbnN0IGxvZ2dpbmdFbnZpcm9ubWVudCA9IGNvbnRyb2xsZXJMb2dnaW5nRW52aXJvbm1lbnQocHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcsIHByb3BzLmV4ZWN1dGlvblJvbGUpO1xuICAgIGNvbnN0IGF1dGhvcml6ZXJIZWFkZXJOYW1lID0gbm9ybWFsaXplSGVhZGVyTmFtZShwcm9wcy5hdXRob3JpemVySGVhZGVyTmFtZSA/PyBcIkF1dGhvcml6YXRpb25cIik7XG4gICAgY29uc3Qgc3RhZ2VPcHRzID0gcHJvcHMuc3RhZ2UgPz8ge307XG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gbm9ybWFsaXplU3RhZ2VOYW1lKHN0YWdlT3B0cy5zdGFnZU5hbWUgPz8gXCIkZGVmYXVsdFwiKTtcblxuICAgIHRoaXMuc2Vzc2lvblRhYmxlID0gdGhpcy5jcmVhdGVTZXNzaW9uVGFibGUocHJvcHMpO1xuXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5IdHRwQXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgICBjcmVhdGVEZWZhdWx0U3RhZ2U6ICFuZWVkc0V4cGxpY2l0U3RhZ2Uoc3RhZ2VPcHRzLCBzdGFnZU5hbWUpLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc3RhZ2UgPSB0aGlzLmNyZWF0ZVN0YWdlKHN0YWdlT3B0cywgc3RhZ2VOYW1lKTtcbiAgICBpZiAoIXN0YWdlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogZmFpbGVkIHRvIGNyZWF0ZSBBUEkgc3RhZ2VcIik7XG4gICAgfVxuICAgIHRoaXMuc3RhZ2UgPSBzdGFnZTtcblxuICAgIHRoaXMuZW5kcG9pbnQgPSBzdGFnZU5hbWUgPT09IFwiJGRlZmF1bHRcIlxuICAgICAgPyBgJHtzdHJpcFRyYWlsaW5nU2xhc2godGhpcy5hcGkuYXBpRW5kcG9pbnQpfS9taWNyb3Ztc2BcbiAgICAgIDogYCR7c3RyaXBUcmFpbGluZ1NsYXNoKHRoaXMuYXBpLmFwaUVuZHBvaW50KX0vJHtzdGFnZU5hbWV9L21pY3Jvdm1zYDtcblxuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uID0gdGhpcy5jcmVhdGVDb250cm9sbGVyRnVuY3Rpb24oXG4gICAgICBwcm9wcyxcbiAgICAgIGltYWdlQXJuLFxuICAgICAgYWxsSW5ncmVzc0Nvbm5lY3RvckFybnMsXG4gICAgICBlZ3Jlc3NDb25uZWN0b3JBcm5zLFxuICAgICAgc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuLFxuICAgICAgbG9nZ2luZ0Vudmlyb25tZW50LFxuICAgICk7XG4gICAgdGhpcy5zZXNzaW9uVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKHRoaXMuY29udHJvbGxlckZ1bmN0aW9uKTtcbiAgICB0aGlzLmdyYW50TWljcm92bUNvbnRyb2xQbGFuZShwcm9wcyk7XG5cbiAgICB0aGlzLnJvdXRlQXV0aG9yaXplciA9IG5ldyBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXIoXCJBdXRob3JpemVyXCIsIHByb3BzLmF1dGhvcml6ZXIsIHtcbiAgICAgIGF1dGhvcml6ZXJOYW1lOiBwcm9wcy5hdXRob3JpemVyTmFtZSxcbiAgICAgIGlkZW50aXR5U291cmNlOiBbYCRyZXF1ZXN0LmhlYWRlci4ke2F1dGhvcml6ZXJIZWFkZXJOYW1lfWBdLFxuICAgICAgcmVzdWx0c0NhY2hlVHRsOiBwcm9wcy5hdXRob3JpemVyQ2FjaGVUdGwgPz8gRHVyYXRpb24uc2Vjb25kcygwKSxcbiAgICAgIHJlc3BvbnNlVHlwZXM6IFthcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYVJlc3BvbnNlVHlwZS5TSU1QTEVdLFxuICAgIH0pO1xuXG4gICAgdGhpcy5hZGRDb250cm9sbGVyUm91dGVzKCk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVNlc3Npb25UYWJsZShwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyk6IGR5bmFtb2RiLlRhYmxlIHtcbiAgICBjb25zdCBiaWxsaW5nTW9kZSA9IHByb3BzLnNlc3Npb25UYWJsZUJpbGxpbmdNb2RlID8/IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVDtcbiAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuc2Vzc2lvblRhYmxlUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICBjb25zdCBlbmNyeXB0aW9uID0gcHJvcHMuc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiA/PyBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQ7XG4gICAgY29uc3QgZW5hYmxlUElUUiA9IHByb3BzLmVuYWJsZVNlc3Npb25UYWJsZVBvaW50SW5UaW1lUmVjb3ZlcnkgPz8gdHJ1ZTtcblxuICAgIGlmIChlbmNyeXB0aW9uID09PSBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQ1VTVE9NRVJfTUFOQUdFRCAmJiAhcHJvcHMuc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXkgd2hlbiBzZXNzaW9uVGFibGVFbmNyeXB0aW9uIGlzIENVU1RPTUVSX01BTkFHRURcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgY29uc3QgdGFibGVOYW1lID0gcHJvcHMuc2Vzc2lvblRhYmxlTmFtZSA9PT0gdW5kZWZpbmVkXG4gICAgICA/IHVuZGVmaW5lZFxuICAgICAgOiBub3JtYWxpemVSZXF1aXJlZFN0cmluZyhwcm9wcy5zZXNzaW9uVGFibGVOYW1lLCBcInNlc3Npb25UYWJsZU5hbWVcIik7XG5cbiAgICByZXR1cm4gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiU2Vzc2lvblRhYmxlXCIsIHtcbiAgICAgIHRhYmxlTmFtZSxcbiAgICAgIGJpbGxpbmdNb2RlLFxuICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IFwicGtcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHNvcnRLZXk6IHsgbmFtZTogXCJza1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogXCJ0dGxcIixcbiAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICBkZWxldGlvblByb3RlY3Rpb246IHByb3BzLnNlc3Npb25UYWJsZURlbGV0aW9uUHJvdGVjdGlvbixcbiAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiBlbmFibGVQSVRSLFxuICAgICAgfSxcbiAgICAgIGVuY3J5cHRpb24sXG4gICAgICBlbmNyeXB0aW9uS2V5OiBwcm9wcy5zZXNzaW9uVGFibGVFbmNyeXB0aW9uS2V5LFxuICAgICAgLi4uKGJpbGxpbmdNb2RlID09PSBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QUk9WSVNJT05FRFxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJlYWRDYXBhY2l0eTogcHJvcHMuc2Vzc2lvblRhYmxlUmVhZENhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgICB3cml0ZUNhcGFjaXR5OiBwcm9wcy5zZXNzaW9uVGFibGVXcml0ZUNhcGFjaXR5ID8/IDUsXG4gICAgICAgICAgfVxuICAgICAgICA6IHt9KSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU3RhZ2UoXG4gICAgc3RhZ2VPcHRzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyxcbiAgICBzdGFnZU5hbWU6IHN0cmluZyxcbiAgKTogYXBpZ3d2Mi5JU3RhZ2UgfCB1bmRlZmluZWQge1xuICAgIGlmICghbmVlZHNFeHBsaWNpdFN0YWdlKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSkge1xuICAgICAgcmV0dXJuIHRoaXMuYXBpLmRlZmF1bHRTdGFnZTtcbiAgICB9XG5cbiAgICBjb25zdCBzdGFnZSA9IG5ldyBhcGlnd3YyLkh0dHBTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgIGh0dHBBcGk6IHRoaXMuYXBpLFxuICAgICAgc3RhZ2VOYW1lLFxuICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgIHRocm90dGxlOiAoc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZCB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZClcbiAgICAgICAgPyB7XG4gICAgICAgICAgICByYXRlTGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0LFxuICAgICAgICAgICAgYnVyc3RMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0LFxuICAgICAgICAgIH1cbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgfSk7XG5cbiAgICBpZiAoc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcpIHtcbiAgICAgIGNvbnN0IGxvZ0dyb3VwID0gbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgcmV0ZW50aW9uOiBzdGFnZU9wdHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsXG4gICAgICB9KTtcbiAgICAgICh0aGlzIGFzIHsgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cCB9KS5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgICBjb25zdCBjZm5TdGFnZSA9IHN0YWdlLm5vZGUuZGVmYXVsdENoaWxkIGFzIGFwaWd3djIuQ2ZuU3RhZ2U7XG4gICAgICBjZm5TdGFnZS5hY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgICAgZGVzdGluYXRpb25Bcm46IGxvZ0dyb3VwLmxvZ0dyb3VwQXJuLFxuICAgICAgICBmb3JtYXQ6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICByZXF1ZXN0SWQ6IFwiJGNvbnRleHQucmVxdWVzdElkXCIsXG4gICAgICAgICAgaXA6IFwiJGNvbnRleHQuaWRlbnRpdHkuc291cmNlSXBcIixcbiAgICAgICAgICByZXF1ZXN0VGltZTogXCIkY29udGV4dC5yZXF1ZXN0VGltZVwiLFxuICAgICAgICAgIGh0dHBNZXRob2Q6IFwiJGNvbnRleHQuaHR0cE1ldGhvZFwiLFxuICAgICAgICAgIHJvdXRlS2V5OiBcIiRjb250ZXh0LnJvdXRlS2V5XCIsXG4gICAgICAgICAgc3RhdHVzOiBcIiRjb250ZXh0LnN0YXR1c1wiLFxuICAgICAgICAgIHByb3RvY29sOiBcIiRjb250ZXh0LnByb3RvY29sXCIsXG4gICAgICAgICAgcmVzcG9uc2VMZW5ndGg6IFwiJGNvbnRleHQucmVzcG9uc2VMZW5ndGhcIixcbiAgICAgICAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IFwiJGNvbnRleHQuaW50ZWdyYXRpb25MYXRlbmN5XCIsXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gc3RhZ2U7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNvbnRyb2xsZXJGdW5jdGlvbihcbiAgICBwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyxcbiAgICBpbWFnZUFybjogc3RyaW5nLFxuICAgIGluZ3Jlc3NDb25uZWN0b3JBcm5zOiBzdHJpbmdbXSxcbiAgICBlZ3Jlc3NDb25uZWN0b3JBcm5zOiBzdHJpbmdbXSxcbiAgICBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm46IHN0cmluZyxcbiAgICBsb2dnaW5nRW52aXJvbm1lbnQ6IHN0cmluZyxcbiAgKTogbGFtYmRhLkZ1bmN0aW9uIHtcbiAgICBjb25zdCBjb250cm9sbGVyUHJvcHMgPSBwcm9wcy5jb250cm9sbGVyO1xuICAgIGNvbnN0IGVudmlyb25tZW50ID0gYnVpbGRDb250cm9sbGVyRW52aXJvbm1lbnQoXG4gICAgICBjb250cm9sbGVyUHJvcHMuZW52aXJvbm1lbnQsXG4gICAgICB7XG4gICAgICAgIFtFTlZfQ09OVFJBQ1RfTkFNRV06IE1JQ1JPVk1fQ09OVFJBQ1RfTkFNRSxcbiAgICAgICAgW0VOVl9DT05UUkFDVF9WRVJTSU9OXTogTUlDUk9WTV9DT05UUkFDVF9WRVJTSU9OLFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfRU5EUE9JTlRdOiB0aGlzLmVuZHBvaW50LFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfT1BFUkFUSU9OU106IENPTlRST0xMRVJfT1BFUkFUSU9OUy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX1JPVVRFU106IENPTlRST0xMRVJfUk9VVEVfREVGSU5JVElPTlMubWFwKChyb3V0ZSkgPT4gYCR7cm91dGUubWV0aG9kfSAke3JvdXRlLnBhdGh9YCkuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEXTogQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVELFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUXTogQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQsXG4gICAgICAgIFtFTlZfU0VTU0lPTl9SRUdJU1RSWV9UQUJMRV06IHRoaXMuc2Vzc2lvblRhYmxlLnRhYmxlTmFtZSxcbiAgICAgICAgW0VOVl9JTUFHRV9SRUZdOiBpbWFnZUFybixcbiAgICAgICAgW0VOVl9ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXTogZWdyZXNzQ29ubmVjdG9yQXJucy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlNdOiBpbmdyZXNzQ29ubmVjdG9yQXJucy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU106IGVncmVzc0Nvbm5lY3RvckFybnMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfU0hFTExfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZdOiBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm4sXG4gICAgICAgIFtFTlZfTE9HR0lOR106IGxvZ2dpbmdFbnZpcm9ubWVudCxcbiAgICAgICAgLi4uKHByb3BzLmV4ZWN1dGlvblJvbGUgPyB7IFtFTlZfRVhFQ1VUSU9OX1JPTEVfQVJOXTogcHJvcHMuZXhlY3V0aW9uUm9sZS5yb2xlQXJuIH0gOiB7fSksXG4gICAgICB9LFxuICAgICk7XG5cbiAgICByZXR1cm4gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkNvbnRyb2xsZXJGdW5jdGlvblwiLCB7XG4gICAgICBhcmNoaXRlY3R1cmU6IGNvbnRyb2xsZXJQcm9wcy5hcmNoaXRlY3R1cmUgPz8gbGFtYmRhLkFyY2hpdGVjdHVyZS5BUk1fNjQsXG4gICAgICB0cmFjaW5nOiBjb250cm9sbGVyUHJvcHMudHJhY2luZyA/PyBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgICBtZW1vcnlTaXplOiBjb250cm9sbGVyUHJvcHMubWVtb3J5U2l6ZSA/PyA1MTIsXG4gICAgICB0aW1lb3V0OiBjb250cm9sbGVyUHJvcHMudGltZW91dCA/PyBEdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIC4uLmNvbnRyb2xsZXJQcm9wcyxcbiAgICAgIGVudmlyb25tZW50LFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBncmFudE1pY3Jvdm1Db250cm9sUGxhbmUocHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpOiB2b2lkIHtcbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbFBsYW5lXCIsXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImxhbWJkYTpDcmVhdGVNaWNyb3ZtQXV0aFRva2VuXCIsXG4gICAgICAgICAgXCJsYW1iZGE6Q3JlYXRlTWljcm92bVNoZWxsQXV0aFRva2VuXCIsXG4gICAgICAgICAgXCJsYW1iZGE6R2V0TWljcm92bVwiLFxuICAgICAgICAgIFwibGFtYmRhOlJlc3VtZU1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpSdW5NaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6U3VzcGVuZE1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpUZXJtaW5hdGVNaWNyb3ZtXCIsXG4gICAgICAgIF0sXG4gICAgICAgIC8vIExhbWJkYSBNaWNyb1ZNIHJlc291cmNlLWxldmVsIElBTSBzY29waW5nIGZvciB0aGVzZSBhY3Rpb25zIHJlbWFpbnNcbiAgICAgICAgLy8gdW50ZXN0ZWQsIHNvIHRoZSBncmFudCBzdGF5cyBvbiBcIipcIi4gVGhlIG9uZSBsaXZlIG9ic2VydmF0aW9uICh0aGVcbiAgICAgICAgLy8gaW1hZ2UtdmVyc2lvbiBsaXN0L2RlbGV0ZSBvcGVyYXRpb25zKSBzaG93cyB0aGUgY29udHJvbCBwbGFuZVxuICAgICAgICAvLyBhdXRob3JpemVzIHRoZSBjYW5vbmljYWwgY29sb24tZm9ybSBpbWFnZSBBUk4gKGAuLi46bWljcm92bS1pbWFnZTo8bmFtZT5gKVxuICAgICAgICAvLyBhbmQgcmVqZWN0cyB0aGUgc2xhc2ggZm9ybSB3aXRoIEhUVFAgNDAzIEFjY2Vzc0RlbmllZCByZWdhcmRsZXNzIG9mXG4gICAgICAgIC8vIElBTSAobGl2ZS12ZXJpZmllZCkuIEFwcFRoZW9yeSBjb25zdHJhaW5zIHdoaWNoIGltYWdlL2Nvbm5lY3RvcnMvcm9sZVxuICAgICAgICAvLyBtYXkgYmUgdXNlZCB0aHJvdWdoIHR5cGVkIGNvbnN0cnVjdCBwcm9wcywgZmFpbC1jbG9zZWQgY29udHJvbGxlciBlbnYsXG4gICAgICAgIC8vIGFuZCBzY29wZWQgaWFtOlBhc3NSb2xlIHJhdGhlciB0aGFuIHJlLXNjb3BpbmcgdGhlc2UgcmVzb3VyY2UgZ3JhbnRzLlxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6IFwiQXBwVGhlb3J5TWljcm92bUxpc3RcIixcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOkxpc3RNaWNyb3Ztc1wiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgc2lkOiBcIkFwcFRoZW9yeU1pY3Jvdm1QYXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOlBhc3NOZXR3b3JrQ29ubmVjdG9yXCJdLFxuICAgICAgICAvLyBMYW1iZGEgbWFya3MgUGFzc05ldHdvcmtDb25uZWN0b3IgYXMgcGVybWlzc2lvbi1vbmx5IHdpdGhvdXQgcmVzb3VyY2UtbGV2ZWxcbiAgICAgICAgLy8gc3VwcG9ydC4gQXBwVGhlb3J5IGNvbnN0cmFpbnMgdGhlIHBlcm1pdHRlZCBjb25uZWN0b3Igc2V0IHRocm91Z2ggdHlwZWQgcHJvcHNcbiAgICAgICAgLy8gYW5kIGZhaWwtY2xvc2VkIGVudmlyb25tZW50IHdpcmluZyBpbnN0ZWFkIG9mIGFjY2VwdGluZyByYXcgcmVxdWVzdCBzdHJpbmdzLlxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgaWYgKHByb3BzLmV4ZWN1dGlvblJvbGUpIHtcbiAgICAgIHByb3BzLmV4ZWN1dGlvblJvbGUuZ3JhbnRQYXNzUm9sZSh0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5ncmFudFByaW5jaXBhbCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhZGRDb250cm9sbGVyUm91dGVzKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2YgQ09OVFJPTExFUl9ST1VURV9ERUZJTklUSU9OUykge1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgICAgcGF0aDogcm91dGUucGF0aCxcbiAgICAgICAgbWV0aG9kczogW3JvdXRlLm1ldGhvZF0sXG4gICAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24ocm91dGUuaWQsIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLCB7XG4gICAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgICAgc2NvcGVQZXJtaXNzaW9uVG9Sb3V0ZTogdGhpcy5zY29wZVBlcm1pc3Npb25Ub1JvdXRlLFxuICAgICAgICB9KSxcbiAgICAgICAgYXV0aG9yaXplcjogdGhpcy5yb3V0ZUF1dGhvcml6ZXIsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbmVlZHNFeHBsaWNpdFN0YWdlKHN0YWdlT3B0czogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnMsIHN0YWdlTmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBzdGFnZU5hbWUgIT09IFwiJGRlZmF1bHRcIlxuICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlXG4gICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZFxuICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJlcXVpcmVkKHZhbHVlOiB1bmtub3duLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHZhbHVlKS50cmltKCk7XG4gIGlmICghbm9ybWFsaXplZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcsIG1heExlbmd0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBwcm9wTmFtZSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAvXFxzLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogJHtwcm9wTmFtZX0gbXVzdCBub3QgY29udGFpbiB3aGl0ZXNwYWNlYCk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIG5vcm1hbGl6ZWQubGVuZ3RoID4gbWF4TGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhdCBtb3N0ICR7bWF4TGVuZ3RofSBjaGFyYWN0ZXJzYCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIGNvbnRyb2xsZXJMb2dnaW5nRW52aXJvbm1lbnQoXG4gIGxvZ2dpbmc6IEFwcFRoZW9yeU1pY3Jvdm1JbWFnZUxvZ2dpbmcgfCB1bmRlZmluZWQsXG4gIGV4ZWN1dGlvblJvbGU6IGlhbS5JUm9sZSB8IHVuZGVmaW5lZCxcbik6IHN0cmluZyB7XG4gIGlmIChsb2dnaW5nID09PSB1bmRlZmluZWQgfHwgbG9nZ2luZyA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nXCIpO1xuICB9XG4gIGNvbnN0IGhhc0Nsb3VkV2F0Y2ggPSBsb2dnaW5nLmNsb3VkV2F0Y2ggIT09IHVuZGVmaW5lZCAmJiBsb2dnaW5nLmNsb3VkV2F0Y2ggIT09IG51bGw7XG4gIGNvbnN0IGhhc0Rpc2FibGVkID0gbG9nZ2luZy5kaXNhYmxlZCAhPT0gdW5kZWZpbmVkO1xuICBpZiAoaGFzQ2xvdWRXYXRjaCA9PT0gaGFzRGlzYWJsZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZyBtdXN0IHNwZWNpZnkgZXhhY3RseSBvbmUgb2YgY2xvdWRXYXRjaCBvciBkaXNhYmxlZFwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGhhc0Rpc2FibGVkKSB7XG4gICAgaWYgKGxvZ2dpbmcuZGlzYWJsZWQgIT09IHRydWUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcuZGlzYWJsZWQgbXVzdCBiZSB0cnVlIHdoZW4gcHJvdmlkZWRcIixcbiAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiBKU09OLnN0cmluZ2lmeSh7IGRpc2FibGVkOiB0cnVlIH0pO1xuICB9XG4gIGlmICghZXhlY3V0aW9uUm9sZSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuZXhlY3V0aW9uUm9sZSB3aGVuIHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmNsb3VkV2F0Y2ggaXMgY29uZmlndXJlZFwiLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBjbG91ZFdhdGNoID0gbG9nZ2luZy5jbG91ZFdhdGNoO1xuICBpZiAoIWNsb3VkV2F0Y2gpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoXCIpO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7fTtcbiAgaWYgKGNsb3VkV2F0Y2gubG9nR3JvdXAgIT09IHVuZGVmaW5lZCkge1xuICAgIG5vcm1hbGl6ZWQubG9nX2dyb3VwID0gbm9ybWFsaXplQ29udHJvbGxlckxvZ0dyb3VwKGNsb3VkV2F0Y2gubG9nR3JvdXApO1xuICB9XG4gIGlmIChjbG91ZFdhdGNoLmxvZ1N0cmVhbSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgbm9ybWFsaXplZC5sb2dfc3RyZWFtID0gbm9ybWFsaXplQ29udHJvbGxlckxvZ1N0cmVhbShjbG91ZFdhdGNoLmxvZ1N0cmVhbSk7XG4gIH1cbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgY2xvdWRfd2F0Y2g6IG5vcm1hbGl6ZWQgfSk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbnRyb2xsZXJMb2dHcm91cCh2YWx1ZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBcIm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXBcIik7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAhL15bYS16QS1aMC05X1xcLS8uI117MSw1MTJ9JC8udGVzdChub3JtYWxpemVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmNsb3VkV2F0Y2gubG9nR3JvdXAgaXMgb3V0c2lkZSB0aGUgQ2xvdWRXYXRjaCBMb2dzIHBhdHRlcm5cIixcbiAgICApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb250cm9sbGVyTG9nU3RyZWFtKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIFwibWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dTdHJlYW1cIik7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAoIS9eW146Kl0qJC8udGVzdChub3JtYWxpemVkKSB8fCBub3JtYWxpemVkLmxlbmd0aCA+IDUxMikpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoLmxvZ1N0cmVhbSBpcyBvdXRzaWRlIHRoZSBDbG91ZFdhdGNoIExvZ3MgcGF0dGVyblwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gIGNvbm5lY3RvcnM6IHJlYWRvbmx5IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuICBleHBlY3RlZEtpbmQ6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCxcbik6IHN0cmluZ1tdIHtcbiAgaWYgKCFjb25uZWN0b3JzIHx8IGNvbm5lY3RvcnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBhdCBsZWFzdCAxICR7cHJvcE5hbWV9IGVudHJ5YCk7XG4gIH1cbiAgaWYgKGNvbm5lY3RvcnMubGVuZ3RoID4gMTApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHN1cHBvcnRzIGF0IG1vc3QgMTAgJHtwcm9wTmFtZX0gZW50cmllc2ApO1xuICB9XG5cbiAgY29uc3QgYXJucyA9IGNvbm5lY3RvcnMubWFwKChjb25uZWN0b3IsIGluZGV4KSA9PiB7XG4gICAgcmV0dXJuIG5vcm1hbGl6ZVNpbmdsZUNvbm5lY3RvclJlZmVyZW5jZShjb25uZWN0b3IsIGAke3Byb3BOYW1lfVske2luZGV4fV1gLCBleHBlY3RlZEtpbmQpO1xuICB9KTtcblxuICBhc3NlcnROb0R1cGxpY2F0ZXMoYXJucywgYCR7cHJvcE5hbWV9IG5ldHdvcmtDb25uZWN0b3JBcm5gKTtcbiAgcmV0dXJuIGFybnM7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNpbmdsZUNvbm5lY3RvclJlZmVyZW5jZShcbiAgY29ubmVjdG9yOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3IgfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4gIGV4cGVjdGVkS2luZDogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuKTogc3RyaW5nIHtcbiAgaWYgKGNvbm5lY3RvciA9PT0gdW5kZWZpbmVkIHx8IGNvbm5lY3RvciA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBjb25zdCBhY3R1YWxLaW5kID0gbm9ybWFsaXplQ29ubmVjdG9yS2luZEZvckNvbnRyb2xsZXIoY29ubmVjdG9yLm5ldHdvcmtDb25uZWN0b3JLaW5kLCBwcm9wTmFtZSk7XG4gIGlmIChhY3R1YWxLaW5kICE9PSBleHBlY3RlZEtpbmQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLiR7cHJvcE5hbWV9IG11c3QgYmUgYSAke2V4cGVjdGVkS2luZH0gY29ubmVjdG9yIHJlZmVyZW5jZWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKGNvbm5lY3Rvci5uZXR3b3JrQ29ubmVjdG9yQXJuLCBgJHtwcm9wTmFtZX0ubmV0d29ya0Nvbm5lY3RvckFybmAsIDIwNDgpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb25uZWN0b3JLaW5kRm9yQ29udHJvbGxlcihcbiAga2luZDogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kIHwgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuKTogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kIHtcbiAgaWYgKGtpbmQgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLiR7cHJvcE5hbWV9IG11c3QgaW5jbHVkZSBuZXR3b3JrQ29ubmVjdG9yS2luZGApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcoa2luZCkudHJpbSgpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW18tXS9nLCBcIlwiKTtcbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiaW5ncmVzc1wiKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5JTkdSRVNTO1xuICB9XG4gIGlmIChub3JtYWxpemVkID09PSBcImVncmVzc1wiKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5FR1JFU1M7XG4gIH1cbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwic2hlbGxpbmdyZXNzXCIpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLlNIRUxMX0lOR1JFU1M7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMuJHtwcm9wTmFtZX0ubmV0d29ya0Nvbm5lY3RvcktpbmQgbXVzdCBiZSBpbmdyZXNzLCBlZ3Jlc3MsIG9yIHNoZWxsLWluZ3Jlc3NgLFxuICApO1xufVxuXG5mdW5jdGlvbiBkZWR1cGVDb25uZWN0b3JBcm5zKGFybnM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBhc3NlcnROb0R1cGxpY2F0ZXMoYXJucywgXCJjb250cm9sbGVyIG5ldHdvcmtDb25uZWN0b3JBcm5cIik7XG4gIHJldHVybiBhcm5zO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0R1cGxpY2F0ZXModmFsdWVzOiByZWFkb25seSBzdHJpbmdbXSwgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG4gICAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoc2Vlbi5oYXModmFsdWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIGRvZXMgbm90IGFsbG93IGR1cGxpY2F0ZSAke2xhYmVsfSB2YWx1ZXNgKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQodmFsdWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUhlYWRlck5hbWUoaGVhZGVyTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IFN0cmluZyhoZWFkZXJOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IGF1dGhvcml6ZXJIZWFkZXJOYW1lIGlzIHJlcXVpcmVkXCIpO1xuICB9XG4gIHJldHVybiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTdGFnZU5hbWUoc3RhZ2VOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gU3RyaW5nKHN0YWdlTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gIGlmICghdHJpbW1lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBzdGFnZU5hbWUgaXMgcmVxdWlyZWRcIik7XG4gIH1cbiAgcmV0dXJuIHRyaW1tZWQ7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ29udHJvbGxlckVudmlyb25tZW50KFxuICB1c2VyRW52aXJvbm1lbnQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQsXG4gIHJlc2VydmVkRW52aXJvbm1lbnQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgY29uc3QgZW52aXJvbm1lbnQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IC4uLih1c2VyRW52aXJvbm1lbnQgPz8ge30pIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIFJFU0VSVkVEX0VOVl9LRVlTKSB7XG4gICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChlbnZpcm9ubWVudCwga2V5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogY29udHJvbGxlci5lbnZpcm9ubWVudCBjYW5ub3Qgb3ZlcnJpZGUgcmVzZXJ2ZWQgJHtrZXl9YCk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IC4uLmVudmlyb25tZW50LCAuLi5yZXNlcnZlZEVudmlyb25tZW50IH07XG59XG5cbmZ1bmN0aW9uIHN0cmlwVHJhaWxpbmdTbGFzaCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB1cmwucmVwbGFjZSgvXFwvJC8sIFwiXCIpO1xufVxuIl19