"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryMicrovmController = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const apigwv2Authorizers = require("aws-cdk-lib/aws-apigatewayv2-authorizers");
const apigwv2Integrations = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const iam = require("aws-cdk-lib/aws-iam");
const lambda = require("aws-cdk-lib/aws-lambda");
const logs = require("aws-cdk-lib/aws-logs");
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
    constructor(scope, id, props) {
        super(scope, id);
        if (props === undefined || props === null) {
            throw new Error("AppTheoryMicrovmController requires props");
        }
        validateRequired(props.controller, "controller");
        validateRequired(props.authorizer, "authorizer");
        validateRequired(props.microvmImage, "microvmImage");
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
            // Lambda MicroVM control-plane operations are currently permission-only
            // actions. AppTheory constrains which image/connectors/role may be used
            // through typed construct props, fail-closed controller env, and scoped
            // iam:PassRole rather than pretending the service supports per-MicroVM
            // resource ARNs for these actions.
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
                }),
                authorizer: this.routeAuthorizer,
            });
        }
    }
}
exports.AppTheoryMicrovmController = AppTheoryMicrovmController;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryMicrovmController[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmController", version: "1.17.1" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1jb250cm9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1jb250cm9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQTZEO0FBQzdELHdEQUF3RDtBQUN4RCwrRUFBK0U7QUFDL0UsaUZBQWlGO0FBQ2pGLHFEQUFxRDtBQUNyRCwyQ0FBMkM7QUFFM0MsaURBQWlEO0FBQ2pELDZDQUE2QztBQUM3QywyQ0FBdUM7QUFHdkMsMkVBR3FDO0FBRXJDLE1BQU0scUJBQXFCLEdBQUcsMEJBQTBCLENBQUM7QUFDekQsTUFBTSx3QkFBd0IsR0FBRyxnQkFBZ0IsQ0FBQztBQUNsRCxNQUFNLHdCQUF3QixHQUFHLE1BQU0sQ0FBQztBQUN4QyxNQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQztBQUN2QyxNQUFNLHFCQUFxQixHQUFHO0lBQzVCLEtBQUs7SUFDTCxLQUFLO0lBQ0wsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0lBQ1IsV0FBVztJQUNYLFFBQVE7SUFDUixZQUFZO0lBQ1osa0JBQWtCO0NBQ25CLENBQUM7QUFDRixNQUFNLDRCQUE0QixHQUFvRTtJQUNwRyxFQUFFLEVBQUUsRUFBRSxZQUFZLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUU7SUFDeEUsRUFBRSxFQUFFLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFO0lBQ3pFLEVBQUUsRUFBRSxFQUFFLFlBQVksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLHdCQUF3QixFQUFFO0lBQ3BGLEVBQUUsRUFBRSxFQUFFLGdCQUFnQixFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsZ0NB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QU8sQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDaEMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IER1cmF0aW9uLCBSZW1vdmFsUG9saWN5LCBUb2tlbiB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkF1dGhvcml6ZXJzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWF1dGhvcml6ZXJzXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgKiBhcyBrbXMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1rbXNcIjtcbmltcG9ydCAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZywgSUFwcFRoZW9yeU1pY3Jvdm1JbWFnZSB9IGZyb20gXCIuL21pY3Jvdm0taW1hZ2VcIjtcbmltcG9ydCB7XG4gIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCxcbiAgdHlwZSBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3IsXG59IGZyb20gXCIuL21pY3Jvdm0tbmV0d29yay1jb25uZWN0b3JcIjtcblxuY29uc3QgTUlDUk9WTV9DT05UUkFDVF9OQU1FID0gXCJhcHB0aGVvcnkubGFtYmRhX21pY3Jvdm1cIjtcbmNvbnN0IE1JQ1JPVk1fQ09OVFJBQ1RfVkVSU0lPTiA9IFwibTE2Lm1pY3Jvdm0vdjFcIjtcbmNvbnN0IENPTlRST0xMRVJfQVVUSF9SRVFVSVJFRCA9IFwidHJ1ZVwiO1xuY29uc3QgQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQgPSBcImRlbnlcIjtcbmNvbnN0IENPTlRST0xMRVJfT1BFUkFUSU9OUyA9IFtcbiAgXCJydW5cIixcbiAgXCJnZXRcIixcbiAgXCJsaXN0XCIsXG4gIFwic3VzcGVuZFwiLFxuICBcInJlc3VtZVwiLFxuICBcInRlcm1pbmF0ZVwiLFxuICBcImludm9rZVwiLFxuICBcImF1dGgtdG9rZW5cIixcbiAgXCJzaGVsbC1hdXRoLXRva2VuXCIsXG5dO1xuY29uc3QgQ09OVFJPTExFUl9ST1VURV9ERUZJTklUSU9OUzogQXJyYXk8eyBpZDogc3RyaW5nOyBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZDsgcGF0aDogc3RyaW5nIH0+ID0gW1xuICB7IGlkOiBcIlJ1bk1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogXCIvbWljcm92bXNcIiB9LFxuICB7IGlkOiBcIkxpc3RNaWNyb3Ztc1wiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6IFwiL21pY3Jvdm1zXCIgfSxcbiAgeyBpZDogXCJHZXRNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9XCIgfSxcbiAgeyBpZDogXCJTdXNwZW5kTWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vc3VzcGVuZFwiIH0sXG4gIHsgaWQ6IFwiUmVzdW1lTWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vcmVzdW1lXCIgfSxcbiAgeyBpZDogXCJUZXJtaW5hdGVNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkRFTEVURSwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9XCIgfSxcbiAgeyBpZDogXCJJbnZva2VNaWNyb3ZtUm9vdFwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5BTlksIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9pbnZva2VcIiB9LFxuICB7IGlkOiBcIkludm9rZU1pY3Jvdm1Qcm94eVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5BTlksIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9pbnZva2Uve3Byb3h5K31cIiB9LFxuICB7IGlkOiBcIkNyZWF0ZU1pY3Jvdm1BdXRoVG9rZW5cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L2F1dGgtdG9rZW5cIiB9LFxuICB7XG4gICAgaWQ6IFwiQ3JlYXRlTWljcm92bVNoZWxsQXV0aFRva2VuXCIsXG4gICAgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCxcbiAgICBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vc2hlbGwtYXV0aC10b2tlblwiLFxuICB9LFxuXTtcblxuY29uc3QgRU5WX0NPTlRSQUNUX05BTUUgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRSQUNUX05BTUVcIjtcbmNvbnN0IEVOVl9DT05UUkFDVF9WRVJTSU9OID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUkFDVF9WRVJTSU9OXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9FTkRQT0lOVCA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9FTkRQT0lOVFwiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfT1BFUkFUSU9OUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9PUEVSQVRJT05TXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9ST1VURVMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfUk9VVEVTXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRURcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0FVVEhfREVGQVVMVCA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9BVVRIX0RFRkFVTFRcIjtcbmNvbnN0IEVOVl9TRVNTSU9OX1JFR0lTVFJZX1RBQkxFID0gXCJBUFBUSEVPUllfTUlDUk9WTV9TRVNTSU9OX1JFR0lTVFJZX1RBQkxFXCI7XG5jb25zdCBFTlZfSU1BR0VfUkVGID0gXCJBUFBUSEVPUllfTUlDUk9WTV9JTUFHRV9SRUZcIjtcbmNvbnN0IEVOVl9ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTID0gXCJBUFBUSEVPUllfTUlDUk9WTV9ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXCI7XG5jb25zdCBFTlZfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTID0gXCJBUFBUSEVPUllfTUlDUk9WTV9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlNcIjtcbmNvbnN0IEVOVl9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fRUdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlNcIjtcbmNvbnN0IEVOVl9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fU0hFTExfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZcIjtcbmNvbnN0IEVOVl9FWEVDVVRJT05fUk9MRV9BUk4gPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0VYRUNVVElPTl9ST0xFX0FSTlwiO1xuY29uc3QgRU5WX0xPR0dJTkcgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0xPR0dJTkdcIjtcblxuY29uc3QgUkVTRVJWRURfRU5WX0tFWVMgPSBbXG4gIEVOVl9DT05UUkFDVF9OQU1FLFxuICBFTlZfQ09OVFJBQ1RfVkVSU0lPTixcbiAgRU5WX0NPTlRST0xMRVJfRU5EUE9JTlQsXG4gIEVOVl9DT05UUk9MTEVSX09QRVJBVElPTlMsXG4gIEVOVl9DT05UUk9MTEVSX1JPVVRFUyxcbiAgRU5WX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRCxcbiAgRU5WX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxULFxuICBFTlZfU0VTU0lPTl9SRUdJU1RSWV9UQUJMRSxcbiAgRU5WX0lNQUdFX1JFRixcbiAgRU5WX05FVFdPUktfQ09OTkVDVE9SX1JFRlMsXG4gIEVOVl9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMsXG4gIEVOVl9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGUyxcbiAgRU5WX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGLFxuICBFTlZfRVhFQ1VUSU9OX1JPTEVfQVJOLFxuICBFTlZfTE9HR0lORyxcbl07XG5cbi8qKlxuICogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1pY3JvVk0gY29udHJvbGxlciBIVFRQIEFQSS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgZm9yIHRoZSBzdGFnZS5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogT25seSBhcHBsaWVzIHdoZW4gYWNjZXNzTG9nZ2luZyBpcyB0cnVlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBQYWNrYWdpbmcgYW5kIHJ1bnRpbWUgY29uZmlndXJhdGlvbiBmb3IgdGhlIEFwcFRoZW9yeSBNaWNyb1ZNIGNvbnRyb2xsZXIgTGFtYmRhLlxuICpcbiAqIEFwcFRoZW9yeSBjcmVhdGVzIHRoZSBMYW1iZGEgZnVuY3Rpb24gc28gaXQgY2FuIHdpcmUgdGhlIGNhbm9uaWNhbCBzZXNzaW9uIHRhYmxlLFxuICogTWljcm9WTSBpbWFnZS9uZXR3b3JrIHJlZmVyZW5jZXMsIGFuZCBmYWlsLWNsb3NlZCBhdXRoIGVudmlyb25tZW50IGNvbnNpc3RlbnRseS5cbiAqIFRoZSBjYWxsZXIgc3VwcGxpZXMgb25seSB0aGUgaGFuZGxlciBwYWNrYWdlIGRldGFpbHMgYW5kIGFueSBvcmRpbmFyeSBMYW1iZGFcbiAqIEZ1bmN0aW9uUHJvcHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJGdW5jdGlvblByb3BzIGV4dGVuZHMgbGFtYmRhLkZ1bmN0aW9uUHJvcHMge31cblxuLyoqXG4gKiBQcm9wcyBmb3IgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyB7XG4gIC8qKlxuICAgKiBDb250cm9sbGVyIExhbWJkYSBwYWNrYWdpbmcgYW5kIGNvbmZpZ3VyYXRpb24uXG4gICAqXG4gICAqIFRoZSBoYW5kbGVyIGNvZGUgbXVzdCB1c2UgQXBwVGhlb3J5J3MgTWljcm9WTSBydW50aW1lL2NvbnRyb2xsZXIgcHJpbWl0aXZlcy5cbiAgICogVGhpcyBjb25zdHJ1Y3QgZG9lcyBub3QgaW1wbGVtZW50IGEgcHJvZHVjdCBjb250cm9sLXBsYW5lIHNlcnZpY2UuXG4gICAqL1xuICByZWFkb25seSBjb250cm9sbGVyOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlckZ1bmN0aW9uUHJvcHM7XG5cbiAgLyoqXG4gICAqIExhbWJkYSByZXF1ZXN0IGF1dGhvcml6ZXIgcmVxdWlyZWQgZm9yIGV2ZXJ5IGNvbnRyb2xsZXIgcm91dGUuXG4gICAqXG4gICAqIFRoZSBjb25zdHJ1Y3QgZmFpbHMgY2xvc2VkIHdoZW4gdGhpcyBpcyBvbWl0dGVkOyB1bmF1dGhlbnRpY2F0ZWQgY29udHJvbGxlciByb3V0ZXNcbiAgICogYXJlIG5vdCBzeW50aGVzaXplZC5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFRoZSBNaWNyb1ZNIGltYWdlIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBydW4uXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSW1hZ2U6IElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U7XG5cbiAgLyoqXG4gICAqIEluZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBwYXNzIHRvIExhbWJkYSBNaWNyb1ZNcy5cbiAgICpcbiAgICogQXQgbGVhc3Qgb25lIGNvbm5lY3RvciByZWZlcmVuY2UgaXMgcmVxdWlyZWQgYW5kIG5vIG1vcmUgdGhhbiAxMCBtYXkgYmUgc3VwcGxpZWQuXG4gICAqIFVzZSBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvci5hbGxJbmdyZXNzL25vSW5ncmVzcyBvciBhbiBleHBsaWNpdGx5IHR5cGVkXG4gICAqIGltcG9ydGVkIGluZ3Jlc3MgY29ubmVjdG9yIHJlZmVyZW5jZTsgQXBwVGhlb3J5IGRvZXMgbm90IGhpZGUgYW4gaW5ncmVzcyBkZWZhdWx0LlxuICAgKi9cbiAgcmVhZG9ubHkgaW5ncmVzc05ldHdvcmtDb25uZWN0b3JzOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXTtcblxuICAvKipcbiAgICogRWdyZXNzIG5ldHdvcmsgY29ubmVjdG9ycyB0aGUgY29udHJvbGxlciBpcyBwZXJtaXR0ZWQgdG8gcGFzcyB0byBMYW1iZGEgTWljcm9WTXMuXG4gICAqXG4gICAqIEF0IGxlYXN0IG9uZSBjb25uZWN0b3IgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gMTAgbWF5IGJlIHN1cHBsaWVkLlxuICAgKi9cbiAgcmVhZG9ubHkgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBTaGVsbCBpbmdyZXNzIGNvbm5lY3RvciByZXF1aXJlZCBmb3Igc2hlbGwtYXV0aC10b2tlbiBzdXBwb3J0LlxuICAgKlxuICAgKiBVc2UgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3Iuc2hlbGxJbmdyZXNzIG9yIGFuIGV4cGxpY2l0bHkgdHlwZWQgc2hlbGwtaW5ncmVzc1xuICAgKiBjb25uZWN0b3IgcmVmZXJlbmNlLiBUaGUgc2hlbGwtYXV0aC10b2tlbiByb3V0ZSBpcyBwYXJ0IG9mIHRoZSByZWFsIE0xNiBjb250cm9sbGVyXG4gICAqIHN1cmZhY2UsIHNvIHRoaXMgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGluc3RlYWQgb2YgYmVpbmcgc2lsZW50bHkgZGVmYXVsdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgc2hlbGxJbmdyZXNzTmV0d29ya0Nvbm5lY3RvcjogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBNaWNyb1ZNIGV4ZWN1dGlvbiByb2xlIHBhc3NlZCB0byBSdW5NaWNyb3ZtLlxuICAgKlxuICAgKiBXaGVuIHN1cHBsaWVkLCBBcHBUaGVvcnkgZ3JhbnRzIHRoZSBjb250cm9sbGVyIExhbWJkYSBpYW06UGFzc1JvbGUgZm9yIHRoaXMgcm9sZVxuICAgKiBhbmQgZXhwb3NlcyB0aGUgQVJOIGFzIEFQUFRIRU9SWV9NSUNST1ZNX0VYRUNVVElPTl9ST0xFX0FSTi5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBleGVjdXRpb25Sb2xlPzogaWFtLklSb2xlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBUEkgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBzdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGRlZmF1bHQgSFRUUCBBUEkgc3RhZ2UpXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBOYW1lIGZvciB0aGUgZHVyYWJsZSBNaWNyb1ZNIHNlc3Npb24gcmVnaXN0cnkgRHluYW1vREIgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQmlsbGluZyBtb2RlIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgUEFZX1BFUl9SRVFVRVNUXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZT86IGR5bmFtb2RiLkJpbGxpbmdNb2RlO1xuXG4gIC8qKlxuICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcblxuICAvKipcbiAgICogV2hldGhlciBkZWxldGlvbiBwcm90ZWN0aW9uIHNob3VsZCBiZSBlbmFibGVkIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBBV1MgZGVmYXVsdCAobm8gZGVsZXRpb24gcHJvdGVjdGlvbilcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZURlbGV0aW9uUHJvdGVjdGlvbj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgcG9pbnQtaW4tdGltZSByZWNvdmVyeSBzaG91bGQgYmUgZW5hYmxlZCBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlIGVuY3J5cHRpb24gc2V0dGluZy5cbiAgICpcbiAgICogQGRlZmF1bHQgQVdTX01BTkFHRURcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZUVuY3J5cHRpb24/OiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb247XG5cbiAgLyoqXG4gICAqIEN1c3RvbWVyLW1hbmFnZWQgS01TIGtleSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIFJlcXVpcmVkIHdoZW4gc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VELlxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleT86IGttcy5JS2V5O1xuXG4gIC8qKlxuICAgKiBQcm92aXNpb25lZCByZWFkIGNhcGFjaXR5IHdoZW4gc2Vzc2lvblRhYmxlQmlsbGluZ01vZGUgaXMgUFJPVklTSU9ORUQuXG4gICAqXG4gICAqIEBkZWZhdWx0IDVcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZVJlYWRDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgd3JpdGUgY2FwYWNpdHkgd2hlbiBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZSBpcyBQUk9WSVNJT05FRC5cbiAgICpcbiAgICogQGRlZmF1bHQgNVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlV3JpdGVDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogSGVhZGVyIHVzZWQgYXMgdGhlIGlkZW50aXR5IHNvdXJjZSBmb3IgY29udHJvbGxlciBhdXRob3JpemF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcIkF1dGhvcml6YXRpb25cIlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckhlYWRlck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZyaWVuZGx5IGF1dGhvcml6ZXIgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGFtYmRhIGF1dGhvcml6ZXIgcmVzdWx0IGNhY2hlIFRUTC5cbiAgICpcbiAgICogRGVmYXVsdHMgdG8gZGlzYWJsZWQgc28gc3RhbGUgYXV0aCBjYW5ub3Qgc2lsZW50bHkgYnJvYWRlbiBjb250cm9sbGVyIGFjY2Vzcy5cbiAgICpcbiAgICogQGRlZmF1bHQgRHVyYXRpb24uc2Vjb25kcygwKVxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckNhY2hlVHRsPzogRHVyYXRpb247XG59XG5cbi8qKlxuICogQXBwVGhlb3J5IENESyBjb25zdHJ1Y3QgZm9yIHRoZSBmaXJzdC1jbGFzcyBMYW1iZGEgTWljcm9WTSBjb250cm9sbGVyIGRlcGxveW1lbnQgc3VyZmFjZS5cbiAqXG4gKiBUaGUgY29uc3RydWN0IHByb3Zpc2lvbnMgdGhlIHByb3RlY3RlZCBIVFRQIEFQSSByb3V0ZXMgZnJvbSB0aGUgTTE2IHJlYWwgY29udHJvbGxlciBjb250cmFjdCxcbiAqIHRoZSBjb250cm9sbGVyIExhbWJkYSwgdGhlIGNhbm9uaWNhbCBkdXJhYmxlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUsIElBTSBncmFudHMsIGFuZFxuICogZmFpbC1jbG9zZWQgYXV0aCBlbnZpcm9ubWVudCB3aXJpbmcuIFJ1bnRpbWUgY29tbWFuZCBoYW5kbGluZyByZW1haW5zIGluIHRoZSBBcHBUaGVvcnlcbiAqIHJ1bnRpbWUgY29udHJhY3Q7IHRoaXMgY29uc3RydWN0IG9ubHkgd2lyZXMgdGhlIGRlcGxveW1lbnQgcGF0aC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSB1bmRlcmx5aW5nIEhUVFAgQVBJIEdhdGV3YXkgdjIgQVBJLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJIEdhdGV3YXkgc3RhZ2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgcmVxdWVzdCBhdXRob3JpemVyIGF0dGFjaGVkIHRvIGV2ZXJ5IGNvbnRyb2xsZXIgcm91dGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVBdXRob3JpemVyOiBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBjb250cm9sbGVyIExhbWJkYSBmdW5jdGlvbiBjcmVhdGVkIGJ5IHRoaXMgY29uc3RydWN0LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNvbnRyb2xsZXJGdW5jdGlvbjogbGFtYmRhLkZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBUaGUgZHVyYWJsZSBUYWJsZVRoZW9yeS1zaGFwZWQgc2Vzc2lvbiByZWdpc3RyeSBEeW5hbW9EQiB0YWJsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJvbGxlciBiYXNlIGVuZHBvaW50IChgL21pY3Jvdm1zYCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzID09PSB1bmRlZmluZWQgfHwgcHJvcHMgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzXCIpO1xuICAgIH1cbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLmNvbnRyb2xsZXIsIFwiY29udHJvbGxlclwiKTtcbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLmF1dGhvcml6ZXIsIFwiYXV0aG9yaXplclwiKTtcbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLm1pY3Jvdm1JbWFnZSwgXCJtaWNyb3ZtSW1hZ2VcIik7XG5cbiAgICBjb25zdCBpbWFnZUFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhwcm9wcy5taWNyb3ZtSW1hZ2UubWljcm92bUltYWdlQXJuLCBcIm1pY3Jvdm1JbWFnZS5taWNyb3ZtSW1hZ2VBcm5cIiwgMjA0OCk7XG4gICAgY29uc3QgaW5ncmVzc0Nvbm5lY3RvckFybnMgPSBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICAgICAgcHJvcHMuaW5ncmVzc05ldHdvcmtDb25uZWN0b3JzLFxuICAgICAgXCJpbmdyZXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5JTkdSRVNTLFxuICAgICk7XG4gICAgY29uc3QgZWdyZXNzQ29ubmVjdG9yQXJucyA9IG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gICAgICBwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyxcbiAgICAgIFwiZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5FR1JFU1MsXG4gICAgKTtcbiAgICBjb25zdCBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm4gPSBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoXG4gICAgICBwcm9wcy5zaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yLFxuICAgICAgXCJzaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yXCIsXG4gICAgICBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuU0hFTExfSU5HUkVTUyxcbiAgICApO1xuICAgIGNvbnN0IGFsbEluZ3Jlc3NDb25uZWN0b3JBcm5zID0gZGVkdXBlQ29ubmVjdG9yQXJucyhbLi4uaW5ncmVzc0Nvbm5lY3RvckFybnMsIHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybl0pO1xuICAgIGFzc2VydE5vRHVwbGljYXRlcyhbLi4uYWxsSW5ncmVzc0Nvbm5lY3RvckFybnMsIC4uLmVncmVzc0Nvbm5lY3RvckFybnNdLCBcImNvbnRyb2xsZXIgbmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgICBjb25zdCBsb2dnaW5nRW52aXJvbm1lbnQgPSBjb250cm9sbGVyTG9nZ2luZ0Vudmlyb25tZW50KHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLCBwcm9wcy5leGVjdXRpb25Sb2xlKTtcbiAgICBjb25zdCBhdXRob3JpemVySGVhZGVyTmFtZSA9IG5vcm1hbGl6ZUhlYWRlck5hbWUocHJvcHMuYXV0aG9yaXplckhlYWRlck5hbWUgPz8gXCJBdXRob3JpemF0aW9uXCIpO1xuICAgIGNvbnN0IHN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgIGNvbnN0IHN0YWdlTmFtZSA9IG5vcm1hbGl6ZVN0YWdlTmFtZShzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIik7XG5cbiAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRoaXMuY3JlYXRlU2Vzc2lvblRhYmxlKHByb3BzKTtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0YWdlID0gdGhpcy5jcmVhdGVTdGFnZShzdGFnZU9wdHMsIHN0YWdlTmFtZSk7XG4gICAgaWYgKCFzdGFnZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IGZhaWxlZCB0byBjcmVhdGUgQVBJIHN0YWdlXCIpO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlID0gc3RhZ2U7XG5cbiAgICB0aGlzLmVuZHBvaW50ID0gc3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgID8gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKHRoaXMuYXBpLmFwaUVuZHBvaW50KX0vbWljcm92bXNgXG4gICAgICA6IGAke3N0cmlwVHJhaWxpbmdTbGFzaCh0aGlzLmFwaS5hcGlFbmRwb2ludCl9LyR7c3RhZ2VOYW1lfS9taWNyb3Ztc2A7XG5cbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbiA9IHRoaXMuY3JlYXRlQ29udHJvbGxlckZ1bmN0aW9uKFxuICAgICAgcHJvcHMsXG4gICAgICBpbWFnZUFybixcbiAgICAgIGFsbEluZ3Jlc3NDb25uZWN0b3JBcm5zLFxuICAgICAgZWdyZXNzQ29ubmVjdG9yQXJucyxcbiAgICAgIHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybixcbiAgICAgIGxvZ2dpbmdFbnZpcm9ubWVudCxcbiAgICApO1xuICAgIHRoaXMuc2Vzc2lvblRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbik7XG4gICAgdGhpcy5ncmFudE1pY3Jvdm1Db250cm9sUGxhbmUocHJvcHMpO1xuXG4gICAgdGhpcy5yb3V0ZUF1dGhvcml6ZXIgPSBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFBdXRob3JpemVyKFwiQXV0aG9yaXplclwiLCBwcm9wcy5hdXRob3JpemVyLCB7XG4gICAgICBhdXRob3JpemVyTmFtZTogcHJvcHMuYXV0aG9yaXplck5hbWUsXG4gICAgICBpZGVudGl0eVNvdXJjZTogW2AkcmVxdWVzdC5oZWFkZXIuJHthdXRob3JpemVySGVhZGVyTmFtZX1gXSxcbiAgICAgIHJlc3VsdHNDYWNoZVR0bDogcHJvcHMuYXV0aG9yaXplckNhY2hlVHRsID8/IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICByZXNwb25zZVR5cGVzOiBbYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFSZXNwb25zZVR5cGUuU0lNUExFXSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29udHJvbGxlclJvdXRlcygpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZXNzaW9uVGFibGUocHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpOiBkeW5hbW9kYi5UYWJsZSB7XG4gICAgY29uc3QgYmlsbGluZ01vZGUgPSBwcm9wcy5zZXNzaW9uVGFibGVCaWxsaW5nTW9kZSA/PyBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1Q7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnNlc3Npb25UYWJsZVJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgZW5jcnlwdGlvbiA9IHByb3BzLnNlc3Npb25UYWJsZUVuY3J5cHRpb24gPz8gZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VEO1xuICAgIGNvbnN0IGVuYWJsZVBJVFIgPSBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGVQb2ludEluVGltZVJlY292ZXJ5ID8/IHRydWU7XG5cbiAgICBpZiAoZW5jcnlwdGlvbiA9PT0gZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkNVU1RPTUVSX01BTkFHRUQgJiYgIXByb3BzLnNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBzZXNzaW9uVGFibGVFbmNyeXB0aW9uS2V5IHdoZW4gc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VEXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgPT09IHVuZGVmaW5lZFxuICAgICAgPyB1bmRlZmluZWRcbiAgICAgIDogbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcocHJvcHMuc2Vzc2lvblRhYmxlTmFtZSwgXCJzZXNzaW9uVGFibGVOYW1lXCIpO1xuXG4gICAgcmV0dXJuIG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlNlc3Npb25UYWJsZVwiLCB7XG4gICAgICB0YWJsZU5hbWUsXG4gICAgICBiaWxsaW5nTW9kZSxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInBrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6IFwic2tcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwidHRsXCIsXG4gICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBwcm9wcy5zZXNzaW9uVGFibGVEZWxldGlvblByb3RlY3Rpb24sXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogZW5hYmxlUElUUixcbiAgICAgIH0sXG4gICAgICBlbmNyeXB0aW9uLFxuICAgICAgZW5jcnlwdGlvbktleTogcHJvcHMuc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleSxcbiAgICAgIC4uLihiaWxsaW5nTW9kZSA9PT0gZHluYW1vZGIuQmlsbGluZ01vZGUuUFJPVklTSU9ORURcbiAgICAgICAgPyB7XG4gICAgICAgICAgICByZWFkQ2FwYWNpdHk6IHByb3BzLnNlc3Npb25UYWJsZVJlYWRDYXBhY2l0eSA/PyA1LFxuICAgICAgICAgICAgd3JpdGVDYXBhY2l0eTogcHJvcHMuc2Vzc2lvblRhYmxlV3JpdGVDYXBhY2l0eSA/PyA1LFxuICAgICAgICAgIH1cbiAgICAgICAgOiB7fSksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVN0YWdlKFxuICAgIHN0YWdlT3B0czogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnMsXG4gICAgc3RhZ2VOYW1lOiBzdHJpbmcsXG4gICk6IGFwaWd3djIuSVN0YWdlIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoIW5lZWRzRXhwbGljaXRTdGFnZShzdGFnZU9wdHMsIHN0YWdlTmFtZSkpIHtcbiAgICAgIHJldHVybiB0aGlzLmFwaS5kZWZhdWx0U3RhZ2U7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHN0YWdlTmFtZSxcbiAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICB0aHJvdHRsZTogKHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmF0ZUxpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICB9XG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgIH0pO1xuXG4gICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgZm9ybWF0OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgICAgICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgICAgICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICAgICAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICAgICAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgICAgICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICAgICAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgICAgICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHN0YWdlO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVDb250cm9sbGVyRnVuY3Rpb24oXG4gICAgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMsXG4gICAgaW1hZ2VBcm46IHN0cmluZyxcbiAgICBpbmdyZXNzQ29ubmVjdG9yQXJuczogc3RyaW5nW10sXG4gICAgZWdyZXNzQ29ubmVjdG9yQXJuczogc3RyaW5nW10sXG4gICAgc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuOiBzdHJpbmcsXG4gICAgbG9nZ2luZ0Vudmlyb25tZW50OiBzdHJpbmcsXG4gICk6IGxhbWJkYS5GdW5jdGlvbiB7XG4gICAgY29uc3QgY29udHJvbGxlclByb3BzID0gcHJvcHMuY29udHJvbGxlcjtcbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IGJ1aWxkQ29udHJvbGxlckVudmlyb25tZW50KFxuICAgICAgY29udHJvbGxlclByb3BzLmVudmlyb25tZW50LFxuICAgICAge1xuICAgICAgICBbRU5WX0NPTlRSQUNUX05BTUVdOiBNSUNST1ZNX0NPTlRSQUNUX05BTUUsXG4gICAgICAgIFtFTlZfQ09OVFJBQ1RfVkVSU0lPTl06IE1JQ1JPVk1fQ09OVFJBQ1RfVkVSU0lPTixcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX0VORFBPSU5UXTogdGhpcy5lbmRwb2ludCxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX09QRVJBVElPTlNdOiBDT05UUk9MTEVSX09QRVJBVElPTlMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9ST1VURVNdOiBDT05UUk9MTEVSX1JPVVRFX0RFRklOSVRJT05TLm1hcCgocm91dGUpID0+IGAke3JvdXRlLm1ldGhvZH0gJHtyb3V0ZS5wYXRofWApLmpvaW4oXCIsXCIpLFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRF06IENPTlRST0xMRVJfQVVUSF9SRVFVSVJFRCxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX0FVVEhfREVGQVVMVF06IENPTlRST0xMRVJfQVVUSF9ERUZBVUxULFxuICAgICAgICBbRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEVdOiB0aGlzLnNlc3Npb25UYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFtFTlZfSU1BR0VfUkVGXTogaW1hZ2VBcm4sXG4gICAgICAgIFtFTlZfTkVUV09SS19DT05ORUNUT1JfUkVGU106IGVncmVzc0Nvbm5lY3RvckFybnMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXTogaW5ncmVzc0Nvbm5lY3RvckFybnMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfRUdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlNdOiBlZ3Jlc3NDb25uZWN0b3JBcm5zLmpvaW4oXCIsXCIpLFxuICAgICAgICBbRU5WX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGXTogc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuLFxuICAgICAgICBbRU5WX0xPR0dJTkddOiBsb2dnaW5nRW52aXJvbm1lbnQsXG4gICAgICAgIC4uLihwcm9wcy5leGVjdXRpb25Sb2xlID8geyBbRU5WX0VYRUNVVElPTl9ST0xFX0FSTl06IHByb3BzLmV4ZWN1dGlvblJvbGUucm9sZUFybiB9IDoge30pLFxuICAgICAgfSxcbiAgICApO1xuXG4gICAgcmV0dXJuIG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgXCJDb250cm9sbGVyRnVuY3Rpb25cIiwge1xuICAgICAgYXJjaGl0ZWN0dXJlOiBjb250cm9sbGVyUHJvcHMuYXJjaGl0ZWN0dXJlID8/IGxhbWJkYS5BcmNoaXRlY3R1cmUuQVJNXzY0LFxuICAgICAgdHJhY2luZzogY29udHJvbGxlclByb3BzLnRyYWNpbmcgPz8gbGFtYmRhLlRyYWNpbmcuQUNUSVZFLFxuICAgICAgbWVtb3J5U2l6ZTogY29udHJvbGxlclByb3BzLm1lbW9yeVNpemUgPz8gNTEyLFxuICAgICAgdGltZW91dDogY29udHJvbGxlclByb3BzLnRpbWVvdXQgPz8gRHVyYXRpb24uc2Vjb25kcygzMCksXG4gICAgICAuLi5jb250cm9sbGVyUHJvcHMsXG4gICAgICBlbnZpcm9ubWVudCxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgZ3JhbnRNaWNyb3ZtQ29udHJvbFBsYW5lKHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzKTogdm9pZCB7XG4gICAgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6IFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xQbGFuZVwiLFxuICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgXCJsYW1iZGE6Q3JlYXRlTWljcm92bUF1dGhUb2tlblwiLFxuICAgICAgICAgIFwibGFtYmRhOkNyZWF0ZU1pY3Jvdm1TaGVsbEF1dGhUb2tlblwiLFxuICAgICAgICAgIFwibGFtYmRhOkdldE1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpSZXN1bWVNaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6UnVuTWljcm92bVwiLFxuICAgICAgICAgIFwibGFtYmRhOlN1c3BlbmRNaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6VGVybWluYXRlTWljcm92bVwiLFxuICAgICAgICBdLFxuICAgICAgICAvLyBMYW1iZGEgTWljcm9WTSBjb250cm9sLXBsYW5lIG9wZXJhdGlvbnMgYXJlIGN1cnJlbnRseSBwZXJtaXNzaW9uLW9ubHlcbiAgICAgICAgLy8gYWN0aW9ucy4gQXBwVGhlb3J5IGNvbnN0cmFpbnMgd2hpY2ggaW1hZ2UvY29ubmVjdG9ycy9yb2xlIG1heSBiZSB1c2VkXG4gICAgICAgIC8vIHRocm91Z2ggdHlwZWQgY29uc3RydWN0IHByb3BzLCBmYWlsLWNsb3NlZCBjb250cm9sbGVyIGVudiwgYW5kIHNjb3BlZFxuICAgICAgICAvLyBpYW06UGFzc1JvbGUgcmF0aGVyIHRoYW4gcHJldGVuZGluZyB0aGUgc2VydmljZSBzdXBwb3J0cyBwZXItTWljcm9WTVxuICAgICAgICAvLyByZXNvdXJjZSBBUk5zIGZvciB0aGVzZSBhY3Rpb25zLlxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6IFwiQXBwVGhlb3J5TWljcm92bUxpc3RcIixcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOkxpc3RNaWNyb3Ztc1wiXSxcbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgc2lkOiBcIkFwcFRoZW9yeU1pY3Jvdm1QYXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgICAgYWN0aW9uczogW1wibGFtYmRhOlBhc3NOZXR3b3JrQ29ubmVjdG9yXCJdLFxuICAgICAgICAvLyBMYW1iZGEgbWFya3MgUGFzc05ldHdvcmtDb25uZWN0b3IgYXMgcGVybWlzc2lvbi1vbmx5IHdpdGhvdXQgcmVzb3VyY2UtbGV2ZWxcbiAgICAgICAgLy8gc3VwcG9ydC4gQXBwVGhlb3J5IGNvbnN0cmFpbnMgdGhlIHBlcm1pdHRlZCBjb25uZWN0b3Igc2V0IHRocm91Z2ggdHlwZWQgcHJvcHNcbiAgICAgICAgLy8gYW5kIGZhaWwtY2xvc2VkIGVudmlyb25tZW50IHdpcmluZyBpbnN0ZWFkIG9mIGFjY2VwdGluZyByYXcgcmVxdWVzdCBzdHJpbmdzLlxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgaWYgKHByb3BzLmV4ZWN1dGlvblJvbGUpIHtcbiAgICAgIHByb3BzLmV4ZWN1dGlvblJvbGUuZ3JhbnRQYXNzUm9sZSh0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5ncmFudFByaW5jaXBhbCk7XG4gICAgfVxuICB9XG5cbiAgcHJpdmF0ZSBhZGRDb250cm9sbGVyUm91dGVzKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3Qgcm91dGUgb2YgQ09OVFJPTExFUl9ST1VURV9ERUZJTklUSU9OUykge1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGVzKHtcbiAgICAgICAgcGF0aDogcm91dGUucGF0aCxcbiAgICAgICAgbWV0aG9kczogW3JvdXRlLm1ldGhvZF0sXG4gICAgICAgIGludGVncmF0aW9uOiBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5IdHRwTGFtYmRhSW50ZWdyYXRpb24ocm91dGUuaWQsIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLCB7XG4gICAgICAgICAgcGF5bG9hZEZvcm1hdFZlcnNpb246IGFwaWd3djIuUGF5bG9hZEZvcm1hdFZlcnNpb24uVkVSU0lPTl8yXzAsXG4gICAgICAgIH0pLFxuICAgICAgICBhdXRob3JpemVyOiB0aGlzLnJvdXRlQXV0aG9yaXplcixcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBuZWVkc0V4cGxpY2l0U3RhZ2Uoc3RhZ2VPcHRzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucywgc3RhZ2VOYW1lOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIHN0YWdlTmFtZSAhPT0gXCIkZGVmYXVsdFwiXG4gICAgfHwgc3RhZ2VPcHRzLmFjY2Vzc0xvZ2dpbmcgPT09IHRydWVcbiAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkXG4gICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIHZhbGlkYXRlUmVxdWlyZWQodmFsdWU6IHVua25vd24sIHByb3BOYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcodmFsdWUpLnRyaW0oKTtcbiAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcodmFsdWU6IHN0cmluZyB8IHVuZGVmaW5lZCwgcHJvcE5hbWU6IHN0cmluZywgbWF4TGVuZ3RoOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIHByb3BOYW1lKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIC9cXHMvLnRlc3Qobm9ybWFsaXplZCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiAke3Byb3BOYW1lfSBtdXN0IG5vdCBjb250YWluIHdoaXRlc3BhY2VgKTtcbiAgfVxuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgbm9ybWFsaXplZC5sZW5ndGggPiBtYXhMZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiAke3Byb3BOYW1lfSBtdXN0IGJlIGF0IG1vc3QgJHttYXhMZW5ndGh9IGNoYXJhY3RlcnNgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gY29udHJvbGxlckxvZ2dpbmdFbnZpcm9ubWVudChcbiAgbG9nZ2luZzogQXBwVGhlb3J5TWljcm92bUltYWdlTG9nZ2luZyB8IHVuZGVmaW5lZCxcbiAgZXhlY3V0aW9uUm9sZTogaWFtLklSb2xlIHwgdW5kZWZpbmVkLFxuKTogc3RyaW5nIHtcbiAgaWYgKGxvZ2dpbmcgPT09IHVuZGVmaW5lZCB8fCBsb2dnaW5nID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmdcIik7XG4gIH1cbiAgY29uc3QgaGFzQ2xvdWRXYXRjaCA9IGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gdW5kZWZpbmVkICYmIGxvZ2dpbmcuY2xvdWRXYXRjaCAhPT0gbnVsbDtcbiAgY29uc3QgaGFzRGlzYWJsZWQgPSBsb2dnaW5nLmRpc2FibGVkICE9PSB1bmRlZmluZWQ7XG4gIGlmIChoYXNDbG91ZFdhdGNoID09PSBoYXNEaXNhYmxlZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nIG11c3Qgc3BlY2lmeSBleGFjdGx5IG9uZSBvZiBjbG91ZFdhdGNoIG9yIGRpc2FibGVkXCIsXG4gICAgKTtcbiAgfVxuICBpZiAoaGFzRGlzYWJsZWQpIHtcbiAgICBpZiAobG9nZ2luZy5kaXNhYmxlZCAhPT0gdHJ1ZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy5taWNyb3ZtSW1hZ2UubG9nZ2luZy5kaXNhYmxlZCBtdXN0IGJlIHRydWUgd2hlbiBwcm92aWRlZFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHsgZGlzYWJsZWQ6IHRydWUgfSk7XG4gIH1cbiAgaWYgKCFleGVjdXRpb25Sb2xlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy5leGVjdXRpb25Sb2xlIHdoZW4gcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaCBpcyBjb25maWd1cmVkXCIsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGNsb3VkV2F0Y2ggPSBsb2dnaW5nLmNsb3VkV2F0Y2g7XG4gIGlmICghY2xvdWRXYXRjaCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmNsb3VkV2F0Y2hcIik7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICBpZiAoY2xvdWRXYXRjaC5sb2dHcm91cCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgbm9ybWFsaXplZC5sb2dfZ3JvdXAgPSBub3JtYWxpemVDb250cm9sbGVyTG9nR3JvdXAoY2xvdWRXYXRjaC5sb2dHcm91cCk7XG4gIH1cbiAgaWYgKGNsb3VkV2F0Y2gubG9nU3RyZWFtICE9PSB1bmRlZmluZWQpIHtcbiAgICBub3JtYWxpemVkLmxvZ19zdHJlYW0gPSBub3JtYWxpemVDb250cm9sbGVyTG9nU3RyZWFtKGNsb3VkV2F0Y2gubG9nU3RyZWFtKTtcbiAgfVxuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBjbG91ZF93YXRjaDogbm9ybWFsaXplZCB9KTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29udHJvbGxlckxvZ0dyb3VwKHZhbHVlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBub3JtYWxpemVkID0gbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcodmFsdWUsIFwibWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cFwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICEvXlthLXpBLVowLTlfXFwtLy4jXXsxLDUxMn0kLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMubWljcm92bUltYWdlLmxvZ2dpbmcuY2xvdWRXYXRjaC5sb2dHcm91cCBpcyBvdXRzaWRlIHRoZSBDbG91ZFdhdGNoIExvZ3MgcGF0dGVyblwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbnRyb2xsZXJMb2dTdHJlYW0odmFsdWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgXCJtaWNyb3ZtSW1hZ2UubG9nZ2luZy5jbG91ZFdhdGNoLmxvZ1N0cmVhbVwiKTtcbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmICghL15bXjoqXSokLy50ZXN0KG5vcm1hbGl6ZWQpIHx8IG5vcm1hbGl6ZWQubGVuZ3RoID4gNTEyKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLm1pY3Jvdm1JbWFnZS5sb2dnaW5nLmNsb3VkV2F0Y2gubG9nU3RyZWFtIGlzIG91dHNpZGUgdGhlIENsb3VkV2F0Y2ggTG9ncyBwYXR0ZXJuXCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhcbiAgY29ubmVjdG9yczogcmVhZG9ubHkgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yW10gfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4gIGV4cGVjdGVkS2luZDogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuKTogc3RyaW5nW10ge1xuICBpZiAoIWNvbm5lY3RvcnMgfHwgY29ubmVjdG9ycy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIGF0IGxlYXN0IDEgJHtwcm9wTmFtZX0gZW50cnlgKTtcbiAgfVxuICBpZiAoY29ubmVjdG9ycy5sZW5ndGggPiAxMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgc3VwcG9ydHMgYXQgbW9zdCAxMCAke3Byb3BOYW1lfSBlbnRyaWVzYCk7XG4gIH1cblxuICBjb25zdCBhcm5zID0gY29ubmVjdG9ycy5tYXAoKGNvbm5lY3RvciwgaW5kZXgpID0+IHtcbiAgICByZXR1cm4gbm9ybWFsaXplU2luZ2xlQ29ubmVjdG9yUmVmZXJlbmNlKGNvbm5lY3RvciwgYCR7cHJvcE5hbWV9WyR7aW5kZXh9XWAsIGV4cGVjdGVkS2luZCk7XG4gIH0pO1xuXG4gIGFzc2VydE5vRHVwbGljYXRlcyhhcm5zLCBgJHtwcm9wTmFtZX0gbmV0d29ya0Nvbm5lY3RvckFybmApO1xuICByZXR1cm4gYXJucztcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU2luZ2xlQ29ubmVjdG9yUmVmZXJlbmNlKFxuICBjb25uZWN0b3I6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbiAgZXhwZWN0ZWRLaW5kOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQsXG4pOiBzdHJpbmcge1xuICBpZiAoY29ubmVjdG9yID09PSB1bmRlZmluZWQgfHwgY29ubmVjdG9yID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG4gIGNvbnN0IGFjdHVhbEtpbmQgPSBub3JtYWxpemVDb25uZWN0b3JLaW5kRm9yQ29udHJvbGxlcihjb25uZWN0b3IubmV0d29ya0Nvbm5lY3RvcktpbmQsIHByb3BOYW1lKTtcbiAgaWYgKGFjdHVhbEtpbmQgIT09IGV4cGVjdGVkS2luZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMuJHtwcm9wTmFtZX0gbXVzdCBiZSBhICR7ZXhwZWN0ZWRLaW5kfSBjb25uZWN0b3IgcmVmZXJlbmNlYCxcbiAgICApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVOb1doaXRlc3BhY2VTdHJpbmcoY29ubmVjdG9yLm5ldHdvcmtDb25uZWN0b3JBcm4sIGAke3Byb3BOYW1lfS5uZXR3b3JrQ29ubmVjdG9yQXJuYCwgMjA0OCk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbm5lY3RvcktpbmRGb3JDb250cm9sbGVyKFxuICBraW5kOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQgfCBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4pOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQge1xuICBpZiAoa2luZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMuJHtwcm9wTmFtZX0gbXVzdCBpbmNsdWRlIG5ldHdvcmtDb25uZWN0b3JLaW5kYCk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyhraW5kKS50cmltKCkudG9Mb3dlckNhc2UoKS5yZXBsYWNlKC9bXy1dL2csIFwiXCIpO1xuICBpZiAobm9ybWFsaXplZCA9PT0gXCJpbmdyZXNzXCIpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLklOR1JFU1M7XG4gIH1cbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiZWdyZXNzXCIpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLkVHUkVTUztcbiAgfVxuICBpZiAobm9ybWFsaXplZCA9PT0gXCJzaGVsbGluZ3Jlc3NcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuU0hFTExfSU5HUkVTUztcbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy4ke3Byb3BOYW1lfS5uZXR3b3JrQ29ubmVjdG9yS2luZCBtdXN0IGJlIGluZ3Jlc3MsIGVncmVzcywgb3Igc2hlbGwtaW5ncmVzc2AsXG4gICk7XG59XG5cbmZ1bmN0aW9uIGRlZHVwZUNvbm5lY3RvckFybnMoYXJuczogc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGFzc2VydE5vRHVwbGljYXRlcyhhcm5zLCBcImNvbnRyb2xsZXIgbmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgcmV0dXJuIGFybnM7XG59XG5cbmZ1bmN0aW9uIGFzc2VydE5vRHVwbGljYXRlcyh2YWx1ZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBsYWJlbDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcbiAgICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChzZWVuLmhhcyh2YWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgZG9lcyBub3QgYWxsb3cgZHVwbGljYXRlICR7bGFiZWx9IHZhbHVlc2ApO1xuICAgIH1cbiAgICBzZWVuLmFkZCh2YWx1ZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplSGVhZGVyTmFtZShoZWFkZXJOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gU3RyaW5nKGhlYWRlck5hbWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogYXV0aG9yaXplckhlYWRlck5hbWUgaXMgcmVxdWlyZWRcIik7XG4gIH1cbiAgcmV0dXJuIHRyaW1tZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0YWdlTmFtZShzdGFnZU5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBTdHJpbmcoc3RhZ2VOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHN0YWdlTmFtZSBpcyByZXF1aXJlZFwiKTtcbiAgfVxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuZnVuY3Rpb24gYnVpbGRDb250cm9sbGVyRW52aXJvbm1lbnQoXG4gIHVzZXJFbnZpcm9ubWVudDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZCxcbiAgcmVzZXJ2ZWRFbnZpcm9ubWVudDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICBjb25zdCBlbnZpcm9ubWVudDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uKHVzZXJFbnZpcm9ubWVudCA/PyB7fSkgfTtcbiAgZm9yIChjb25zdCBrZXkgb2YgUkVTRVJWRURfRU5WX0tFWVMpIHtcbiAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGVudmlyb25tZW50LCBrZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBjb250cm9sbGVyLmVudmlyb25tZW50IGNhbm5vdCBvdmVycmlkZSByZXNlcnZlZCAke2tleX1gKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgLi4uZW52aXJvbm1lbnQsIC4uLnJlc2VydmVkRW52aXJvbm1lbnQgfTtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG4iXX0=