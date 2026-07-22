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
        this.controllerFunction = this.createControllerFunction(props, imageArn, allIngressConnectorArns, egressConnectorArns, shellIngressConnectorArn);
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
    createControllerFunction(props, imageArn, ingressConnectorArns, egressConnectorArns, shellIngressConnectorArn) {
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
AppTheoryMicrovmController[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmController", version: "1.17.1-rc" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1jb250cm9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1jb250cm9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQTZEO0FBQzdELHdEQUF3RDtBQUN4RCwrRUFBK0U7QUFDL0UsaUZBQWlGO0FBQ2pGLHFEQUFxRDtBQUNyRCwyQ0FBMkM7QUFFM0MsaURBQWlEO0FBQ2pELDZDQUE2QztBQUM3QywyQ0FBdUM7QUFHdkMsMkVBR3FDO0FBRXJDLE1BQU0scUJBQXFCLEdBQUcsMEJBQTBCLENBQUM7QUFDekQsTUFBTSx3QkFBd0IsR0FBRyxnQkFBZ0IsQ0FBQztBQUNsRCxNQUFNLHdCQUF3QixHQUFHLE1BQU0sQ0FBQztBQUN4QyxNQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQztBQUN2QyxNQUFNLHFCQUFxQixHQUFHO0lBQzVCLEtBQUs7SUFDTCxLQUFLO0lBQ0wsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0lBQ1IsV0FBVztJQUNYLFFBQVE7SUFDUixZQUFZO0lBQ1osa0JBQWtCO0NBQ25CLENBQUM7QUFDRixNQUFNLDRCQUE0QixHQUFvRTtJQUNwRyxFQUFFLEVBQUUsRUFBRSxZQUFZLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUU7SUFDeEUsRUFBRSxFQUFFLEVBQUUsY0FBYyxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsV0FBVyxFQUFFO0lBQ3pFLEVBQUUsRUFBRSxFQUFFLFlBQVksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxHQUFHLEVBQUUsSUFBSSxFQUFFLHdCQUF3QixFQUFFO0lBQ3BGLEVBQUUsRUFBRSxFQUFFLGdCQUFnQixFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxJQUFJLEVBQUUsZ0NB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a2VuIH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyQXV0aG9yaXplcnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItYXV0aG9yaXplcnNcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCAqIGFzIGttcyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWttc1wiO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHR5cGUgeyBJQXBwVGhlb3J5TWljcm92bUltYWdlIH0gZnJvbSBcIi4vbWljcm92bS1pbWFnZVwiO1xuaW1wb3J0IHtcbiAgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuICB0eXBlIElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvcixcbn0gZnJvbSBcIi4vbWljcm92bS1uZXR3b3JrLWNvbm5lY3RvclwiO1xuXG5jb25zdCBNSUNST1ZNX0NPTlRSQUNUX05BTUUgPSBcImFwcHRoZW9yeS5sYW1iZGFfbWljcm92bVwiO1xuY29uc3QgTUlDUk9WTV9DT05UUkFDVF9WRVJTSU9OID0gXCJtMTYubWljcm92bS92MVwiO1xuY29uc3QgQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEID0gXCJ0cnVlXCI7XG5jb25zdCBDT05UUk9MTEVSX0FVVEhfREVGQVVMVCA9IFwiZGVueVwiO1xuY29uc3QgQ09OVFJPTExFUl9PUEVSQVRJT05TID0gW1xuICBcInJ1blwiLFxuICBcImdldFwiLFxuICBcImxpc3RcIixcbiAgXCJzdXNwZW5kXCIsXG4gIFwicmVzdW1lXCIsXG4gIFwidGVybWluYXRlXCIsXG4gIFwiaW52b2tlXCIsXG4gIFwiYXV0aC10b2tlblwiLFxuICBcInNoZWxsLWF1dGgtdG9rZW5cIixcbl07XG5jb25zdCBDT05UUk9MTEVSX1JPVVRFX0RFRklOSVRJT05TOiBBcnJheTx7IGlkOiBzdHJpbmc7IG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kOyBwYXRoOiBzdHJpbmcgfT4gPSBbXG4gIHsgaWQ6IFwiUnVuTWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztc1wiIH0sXG4gIHsgaWQ6IFwiTGlzdE1pY3Jvdm1zXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogXCIvbWljcm92bXNcIiB9LFxuICB7IGlkOiBcIkdldE1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH1cIiB9LFxuICB7IGlkOiBcIlN1c3BlbmRNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9zdXNwZW5kXCIgfSxcbiAgeyBpZDogXCJSZXN1bWVNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9yZXN1bWVcIiB9LFxuICB7IGlkOiBcIlRlcm1pbmF0ZU1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuREVMRVRFLCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH1cIiB9LFxuICB7IGlkOiBcIkludm9rZU1pY3Jvdm1Sb290XCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L2ludm9rZVwiIH0sXG4gIHsgaWQ6IFwiSW52b2tlTWljcm92bVByb3h5XCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkFOWSwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L2ludm9rZS97cHJveHkrfVwiIH0sXG4gIHsgaWQ6IFwiQ3JlYXRlTWljcm92bUF1dGhUb2tlblwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vYXV0aC10b2tlblwiIH0sXG4gIHtcbiAgICBpZDogXCJDcmVhdGVNaWNyb3ZtU2hlbGxBdXRoVG9rZW5cIixcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULFxuICAgIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9zaGVsbC1hdXRoLXRva2VuXCIsXG4gIH0sXG5dO1xuXG5jb25zdCBFTlZfQ09OVFJBQ1RfTkFNRSA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJBQ1RfTkFNRVwiO1xuY29uc3QgRU5WX0NPTlRSQUNUX1ZFUlNJT04gPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRSQUNUX1ZFUlNJT05cIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0VORFBPSU5UID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0VORFBPSU5UXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9PUEVSQVRJT05TID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX09QRVJBVElPTlNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX1JPVVRFUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9ST1VURVNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRFwiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0FVVEhfREVGQVVMVFwiO1xuY29uc3QgRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEUgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX1NFU1NJT05fUkVHSVNUUllfVEFCTEVcIjtcbmNvbnN0IEVOVl9JTUFHRV9SRUYgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX1JFRlwiO1xuY29uc3QgRU5WX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX05FVFdPUktfQ09OTkVDVE9SX1JFRlNcIjtcbmNvbnN0IEVOVl9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTID0gXCJBUFBUSEVPUllfTUlDUk9WTV9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGID0gXCJBUFBUSEVPUllfTUlDUk9WTV9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlwiO1xuY29uc3QgRU5WX0VYRUNVVElPTl9ST0xFX0FSTiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fRVhFQ1VUSU9OX1JPTEVfQVJOXCI7XG5cbmNvbnN0IFJFU0VSVkVEX0VOVl9LRVlTID0gW1xuICBFTlZfQ09OVFJBQ1RfTkFNRSxcbiAgRU5WX0NPTlRSQUNUX1ZFUlNJT04sXG4gIEVOVl9DT05UUk9MTEVSX0VORFBPSU5ULFxuICBFTlZfQ09OVFJPTExFUl9PUEVSQVRJT05TLFxuICBFTlZfQ09OVFJPTExFUl9ST1VURVMsXG4gIEVOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQsXG4gIEVOVl9DT05UUk9MTEVSX0FVVEhfREVGQVVMVCxcbiAgRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEUsXG4gIEVOVl9JTUFHRV9SRUYsXG4gIEVOVl9ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTLFxuICBFTlZfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTLFxuICBFTlZfRUdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMsXG4gIEVOVl9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRixcbiAgRU5WX0VYRUNVVElPTl9ST0xFX0FSTixcbl07XG5cbi8qKlxuICogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1pY3JvVk0gY29udHJvbGxlciBIVFRQIEFQSS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgZm9yIHRoZSBzdGFnZS5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogT25seSBhcHBsaWVzIHdoZW4gYWNjZXNzTG9nZ2luZyBpcyB0cnVlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBQYWNrYWdpbmcgYW5kIHJ1bnRpbWUgY29uZmlndXJhdGlvbiBmb3IgdGhlIEFwcFRoZW9yeSBNaWNyb1ZNIGNvbnRyb2xsZXIgTGFtYmRhLlxuICpcbiAqIEFwcFRoZW9yeSBjcmVhdGVzIHRoZSBMYW1iZGEgZnVuY3Rpb24gc28gaXQgY2FuIHdpcmUgdGhlIGNhbm9uaWNhbCBzZXNzaW9uIHRhYmxlLFxuICogTWljcm9WTSBpbWFnZS9uZXR3b3JrIHJlZmVyZW5jZXMsIGFuZCBmYWlsLWNsb3NlZCBhdXRoIGVudmlyb25tZW50IGNvbnNpc3RlbnRseS5cbiAqIFRoZSBjYWxsZXIgc3VwcGxpZXMgb25seSB0aGUgaGFuZGxlciBwYWNrYWdlIGRldGFpbHMgYW5kIGFueSBvcmRpbmFyeSBMYW1iZGFcbiAqIEZ1bmN0aW9uUHJvcHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJGdW5jdGlvblByb3BzIGV4dGVuZHMgbGFtYmRhLkZ1bmN0aW9uUHJvcHMge31cblxuLyoqXG4gKiBQcm9wcyBmb3IgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyB7XG4gIC8qKlxuICAgKiBDb250cm9sbGVyIExhbWJkYSBwYWNrYWdpbmcgYW5kIGNvbmZpZ3VyYXRpb24uXG4gICAqXG4gICAqIFRoZSBoYW5kbGVyIGNvZGUgbXVzdCB1c2UgQXBwVGhlb3J5J3MgTWljcm9WTSBydW50aW1lL2NvbnRyb2xsZXIgcHJpbWl0aXZlcy5cbiAgICogVGhpcyBjb25zdHJ1Y3QgZG9lcyBub3QgaW1wbGVtZW50IGEgcHJvZHVjdCBjb250cm9sLXBsYW5lIHNlcnZpY2UuXG4gICAqL1xuICByZWFkb25seSBjb250cm9sbGVyOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlckZ1bmN0aW9uUHJvcHM7XG5cbiAgLyoqXG4gICAqIExhbWJkYSByZXF1ZXN0IGF1dGhvcml6ZXIgcmVxdWlyZWQgZm9yIGV2ZXJ5IGNvbnRyb2xsZXIgcm91dGUuXG4gICAqXG4gICAqIFRoZSBjb25zdHJ1Y3QgZmFpbHMgY2xvc2VkIHdoZW4gdGhpcyBpcyBvbWl0dGVkOyB1bmF1dGhlbnRpY2F0ZWQgY29udHJvbGxlciByb3V0ZXNcbiAgICogYXJlIG5vdCBzeW50aGVzaXplZC5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFRoZSBNaWNyb1ZNIGltYWdlIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBydW4uXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSW1hZ2U6IElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U7XG5cbiAgLyoqXG4gICAqIEluZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBwYXNzIHRvIExhbWJkYSBNaWNyb1ZNcy5cbiAgICpcbiAgICogQXQgbGVhc3Qgb25lIGNvbm5lY3RvciByZWZlcmVuY2UgaXMgcmVxdWlyZWQgYW5kIG5vIG1vcmUgdGhhbiAxMCBtYXkgYmUgc3VwcGxpZWQuXG4gICAqIFVzZSBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvci5hbGxJbmdyZXNzL25vSW5ncmVzcyBvciBhbiBleHBsaWNpdGx5IHR5cGVkXG4gICAqIGltcG9ydGVkIGluZ3Jlc3MgY29ubmVjdG9yIHJlZmVyZW5jZTsgQXBwVGhlb3J5IGRvZXMgbm90IGhpZGUgYW4gaW5ncmVzcyBkZWZhdWx0LlxuICAgKi9cbiAgcmVhZG9ubHkgaW5ncmVzc05ldHdvcmtDb25uZWN0b3JzOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXTtcblxuICAvKipcbiAgICogRWdyZXNzIG5ldHdvcmsgY29ubmVjdG9ycyB0aGUgY29udHJvbGxlciBpcyBwZXJtaXR0ZWQgdG8gcGFzcyB0byBMYW1iZGEgTWljcm9WTXMuXG4gICAqXG4gICAqIEF0IGxlYXN0IG9uZSBjb25uZWN0b3IgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gMTAgbWF5IGJlIHN1cHBsaWVkLlxuICAgKi9cbiAgcmVhZG9ubHkgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBTaGVsbCBpbmdyZXNzIGNvbm5lY3RvciByZXF1aXJlZCBmb3Igc2hlbGwtYXV0aC10b2tlbiBzdXBwb3J0LlxuICAgKlxuICAgKiBVc2UgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3Iuc2hlbGxJbmdyZXNzIG9yIGFuIGV4cGxpY2l0bHkgdHlwZWQgc2hlbGwtaW5ncmVzc1xuICAgKiBjb25uZWN0b3IgcmVmZXJlbmNlLiBUaGUgc2hlbGwtYXV0aC10b2tlbiByb3V0ZSBpcyBwYXJ0IG9mIHRoZSByZWFsIE0xNiBjb250cm9sbGVyXG4gICAqIHN1cmZhY2UsIHNvIHRoaXMgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGluc3RlYWQgb2YgYmVpbmcgc2lsZW50bHkgZGVmYXVsdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgc2hlbGxJbmdyZXNzTmV0d29ya0Nvbm5lY3RvcjogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBNaWNyb1ZNIGV4ZWN1dGlvbiByb2xlIHBhc3NlZCB0byBSdW5NaWNyb3ZtLlxuICAgKlxuICAgKiBXaGVuIHN1cHBsaWVkLCBBcHBUaGVvcnkgZ3JhbnRzIHRoZSBjb250cm9sbGVyIExhbWJkYSBpYW06UGFzc1JvbGUgZm9yIHRoaXMgcm9sZVxuICAgKiBhbmQgZXhwb3NlcyB0aGUgQVJOIGFzIEFQUFRIRU9SWV9NSUNST1ZNX0VYRUNVVElPTl9ST0xFX0FSTi5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBleGVjdXRpb25Sb2xlPzogaWFtLklSb2xlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBUEkgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBzdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGRlZmF1bHQgSFRUUCBBUEkgc3RhZ2UpXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBOYW1lIGZvciB0aGUgZHVyYWJsZSBNaWNyb1ZNIHNlc3Npb24gcmVnaXN0cnkgRHluYW1vREIgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQmlsbGluZyBtb2RlIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgUEFZX1BFUl9SRVFVRVNUXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZT86IGR5bmFtb2RiLkJpbGxpbmdNb2RlO1xuXG4gIC8qKlxuICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcblxuICAvKipcbiAgICogV2hldGhlciBkZWxldGlvbiBwcm90ZWN0aW9uIHNob3VsZCBiZSBlbmFibGVkIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBBV1MgZGVmYXVsdCAobm8gZGVsZXRpb24gcHJvdGVjdGlvbilcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZURlbGV0aW9uUHJvdGVjdGlvbj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgcG9pbnQtaW4tdGltZSByZWNvdmVyeSBzaG91bGQgYmUgZW5hYmxlZCBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlIGVuY3J5cHRpb24gc2V0dGluZy5cbiAgICpcbiAgICogQGRlZmF1bHQgQVdTX01BTkFHRURcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZUVuY3J5cHRpb24/OiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb247XG5cbiAgLyoqXG4gICAqIEN1c3RvbWVyLW1hbmFnZWQgS01TIGtleSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIFJlcXVpcmVkIHdoZW4gc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VELlxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleT86IGttcy5JS2V5O1xuXG4gIC8qKlxuICAgKiBQcm92aXNpb25lZCByZWFkIGNhcGFjaXR5IHdoZW4gc2Vzc2lvblRhYmxlQmlsbGluZ01vZGUgaXMgUFJPVklTSU9ORUQuXG4gICAqXG4gICAqIEBkZWZhdWx0IDVcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZVJlYWRDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgd3JpdGUgY2FwYWNpdHkgd2hlbiBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZSBpcyBQUk9WSVNJT05FRC5cbiAgICpcbiAgICogQGRlZmF1bHQgNVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlV3JpdGVDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogSGVhZGVyIHVzZWQgYXMgdGhlIGlkZW50aXR5IHNvdXJjZSBmb3IgY29udHJvbGxlciBhdXRob3JpemF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcIkF1dGhvcml6YXRpb25cIlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckhlYWRlck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZyaWVuZGx5IGF1dGhvcml6ZXIgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGFtYmRhIGF1dGhvcml6ZXIgcmVzdWx0IGNhY2hlIFRUTC5cbiAgICpcbiAgICogRGVmYXVsdHMgdG8gZGlzYWJsZWQgc28gc3RhbGUgYXV0aCBjYW5ub3Qgc2lsZW50bHkgYnJvYWRlbiBjb250cm9sbGVyIGFjY2Vzcy5cbiAgICpcbiAgICogQGRlZmF1bHQgRHVyYXRpb24uc2Vjb25kcygwKVxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckNhY2hlVHRsPzogRHVyYXRpb247XG59XG5cbi8qKlxuICogQXBwVGhlb3J5IENESyBjb25zdHJ1Y3QgZm9yIHRoZSBmaXJzdC1jbGFzcyBMYW1iZGEgTWljcm9WTSBjb250cm9sbGVyIGRlcGxveW1lbnQgc3VyZmFjZS5cbiAqXG4gKiBUaGUgY29uc3RydWN0IHByb3Zpc2lvbnMgdGhlIHByb3RlY3RlZCBIVFRQIEFQSSByb3V0ZXMgZnJvbSB0aGUgTTE2IHJlYWwgY29udHJvbGxlciBjb250cmFjdCxcbiAqIHRoZSBjb250cm9sbGVyIExhbWJkYSwgdGhlIGNhbm9uaWNhbCBkdXJhYmxlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUsIElBTSBncmFudHMsIGFuZFxuICogZmFpbC1jbG9zZWQgYXV0aCBlbnZpcm9ubWVudCB3aXJpbmcuIFJ1bnRpbWUgY29tbWFuZCBoYW5kbGluZyByZW1haW5zIGluIHRoZSBBcHBUaGVvcnlcbiAqIHJ1bnRpbWUgY29udHJhY3Q7IHRoaXMgY29uc3RydWN0IG9ubHkgd2lyZXMgdGhlIGRlcGxveW1lbnQgcGF0aC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSB1bmRlcmx5aW5nIEhUVFAgQVBJIEdhdGV3YXkgdjIgQVBJLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJIEdhdGV3YXkgc3RhZ2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgcmVxdWVzdCBhdXRob3JpemVyIGF0dGFjaGVkIHRvIGV2ZXJ5IGNvbnRyb2xsZXIgcm91dGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVBdXRob3JpemVyOiBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBjb250cm9sbGVyIExhbWJkYSBmdW5jdGlvbiBjcmVhdGVkIGJ5IHRoaXMgY29uc3RydWN0LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNvbnRyb2xsZXJGdW5jdGlvbjogbGFtYmRhLkZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBUaGUgZHVyYWJsZSBUYWJsZVRoZW9yeS1zaGFwZWQgc2Vzc2lvbiByZWdpc3RyeSBEeW5hbW9EQiB0YWJsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJvbGxlciBiYXNlIGVuZHBvaW50IChgL21pY3Jvdm1zYCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzID09PSB1bmRlZmluZWQgfHwgcHJvcHMgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzXCIpO1xuICAgIH1cbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLmNvbnRyb2xsZXIsIFwiY29udHJvbGxlclwiKTtcbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLmF1dGhvcml6ZXIsIFwiYXV0aG9yaXplclwiKTtcbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLm1pY3Jvdm1JbWFnZSwgXCJtaWNyb3ZtSW1hZ2VcIik7XG5cbiAgICBjb25zdCBpbWFnZUFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhwcm9wcy5taWNyb3ZtSW1hZ2UubWljcm92bUltYWdlQXJuLCBcIm1pY3Jvdm1JbWFnZS5taWNyb3ZtSW1hZ2VBcm5cIiwgMjA0OCk7XG4gICAgY29uc3QgaW5ncmVzc0Nvbm5lY3RvckFybnMgPSBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICAgICAgcHJvcHMuaW5ncmVzc05ldHdvcmtDb25uZWN0b3JzLFxuICAgICAgXCJpbmdyZXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5JTkdSRVNTLFxuICAgICk7XG4gICAgY29uc3QgZWdyZXNzQ29ubmVjdG9yQXJucyA9IG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gICAgICBwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyxcbiAgICAgIFwiZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5FR1JFU1MsXG4gICAgKTtcbiAgICBjb25zdCBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm4gPSBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoXG4gICAgICBwcm9wcy5zaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yLFxuICAgICAgXCJzaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yXCIsXG4gICAgICBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuU0hFTExfSU5HUkVTUyxcbiAgICApO1xuICAgIGNvbnN0IGFsbEluZ3Jlc3NDb25uZWN0b3JBcm5zID0gZGVkdXBlQ29ubmVjdG9yQXJucyhbLi4uaW5ncmVzc0Nvbm5lY3RvckFybnMsIHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybl0pO1xuICAgIGFzc2VydE5vRHVwbGljYXRlcyhbLi4uYWxsSW5ncmVzc0Nvbm5lY3RvckFybnMsIC4uLmVncmVzc0Nvbm5lY3RvckFybnNdLCBcImNvbnRyb2xsZXIgbmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgICBjb25zdCBhdXRob3JpemVySGVhZGVyTmFtZSA9IG5vcm1hbGl6ZUhlYWRlck5hbWUocHJvcHMuYXV0aG9yaXplckhlYWRlck5hbWUgPz8gXCJBdXRob3JpemF0aW9uXCIpO1xuICAgIGNvbnN0IHN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgIGNvbnN0IHN0YWdlTmFtZSA9IG5vcm1hbGl6ZVN0YWdlTmFtZShzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIik7XG5cbiAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRoaXMuY3JlYXRlU2Vzc2lvblRhYmxlKHByb3BzKTtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0YWdlID0gdGhpcy5jcmVhdGVTdGFnZShzdGFnZU9wdHMsIHN0YWdlTmFtZSk7XG4gICAgaWYgKCFzdGFnZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IGZhaWxlZCB0byBjcmVhdGUgQVBJIHN0YWdlXCIpO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlID0gc3RhZ2U7XG5cbiAgICB0aGlzLmVuZHBvaW50ID0gc3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgID8gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKHRoaXMuYXBpLmFwaUVuZHBvaW50KX0vbWljcm92bXNgXG4gICAgICA6IGAke3N0cmlwVHJhaWxpbmdTbGFzaCh0aGlzLmFwaS5hcGlFbmRwb2ludCl9LyR7c3RhZ2VOYW1lfS9taWNyb3Ztc2A7XG5cbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbiA9IHRoaXMuY3JlYXRlQ29udHJvbGxlckZ1bmN0aW9uKFxuICAgICAgcHJvcHMsXG4gICAgICBpbWFnZUFybixcbiAgICAgIGFsbEluZ3Jlc3NDb25uZWN0b3JBcm5zLFxuICAgICAgZWdyZXNzQ29ubmVjdG9yQXJucyxcbiAgICAgIHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybixcbiAgICApO1xuICAgIHRoaXMuc2Vzc2lvblRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbik7XG4gICAgdGhpcy5ncmFudE1pY3Jvdm1Db250cm9sUGxhbmUocHJvcHMpO1xuXG4gICAgdGhpcy5yb3V0ZUF1dGhvcml6ZXIgPSBuZXcgYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFBdXRob3JpemVyKFwiQXV0aG9yaXplclwiLCBwcm9wcy5hdXRob3JpemVyLCB7XG4gICAgICBhdXRob3JpemVyTmFtZTogcHJvcHMuYXV0aG9yaXplck5hbWUsXG4gICAgICBpZGVudGl0eVNvdXJjZTogW2AkcmVxdWVzdC5oZWFkZXIuJHthdXRob3JpemVySGVhZGVyTmFtZX1gXSxcbiAgICAgIHJlc3VsdHNDYWNoZVR0bDogcHJvcHMuYXV0aG9yaXplckNhY2hlVHRsID8/IER1cmF0aW9uLnNlY29uZHMoMCksXG4gICAgICByZXNwb25zZVR5cGVzOiBbYXBpZ3d2MkF1dGhvcml6ZXJzLkh0dHBMYW1iZGFSZXNwb25zZVR5cGUuU0lNUExFXSxcbiAgICB9KTtcblxuICAgIHRoaXMuYWRkQ29udHJvbGxlclJvdXRlcygpO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTZXNzaW9uVGFibGUocHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpOiBkeW5hbW9kYi5UYWJsZSB7XG4gICAgY29uc3QgYmlsbGluZ01vZGUgPSBwcm9wcy5zZXNzaW9uVGFibGVCaWxsaW5nTW9kZSA/PyBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1Q7XG4gICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLnNlc3Npb25UYWJsZVJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgY29uc3QgZW5jcnlwdGlvbiA9IHByb3BzLnNlc3Npb25UYWJsZUVuY3J5cHRpb24gPz8gZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VEO1xuICAgIGNvbnN0IGVuYWJsZVBJVFIgPSBwcm9wcy5lbmFibGVTZXNzaW9uVGFibGVQb2ludEluVGltZVJlY292ZXJ5ID8/IHRydWU7XG5cbiAgICBpZiAoZW5jcnlwdGlvbiA9PT0gZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkNVU1RPTUVSX01BTkFHRUQgJiYgIXByb3BzLnNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBzZXNzaW9uVGFibGVFbmNyeXB0aW9uS2V5IHdoZW4gc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VEXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHRhYmxlTmFtZSA9IHByb3BzLnNlc3Npb25UYWJsZU5hbWUgPT09IHVuZGVmaW5lZFxuICAgICAgPyB1bmRlZmluZWRcbiAgICAgIDogbm9ybWFsaXplUmVxdWlyZWRTdHJpbmcocHJvcHMuc2Vzc2lvblRhYmxlTmFtZSwgXCJzZXNzaW9uVGFibGVOYW1lXCIpO1xuXG4gICAgcmV0dXJuIG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIlNlc3Npb25UYWJsZVwiLCB7XG4gICAgICB0YWJsZU5hbWUsXG4gICAgICBiaWxsaW5nTW9kZSxcbiAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBcInBrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICBzb3J0S2V5OiB7IG5hbWU6IFwic2tcIiwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IFwidHRsXCIsXG4gICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBwcm9wcy5zZXNzaW9uVGFibGVEZWxldGlvblByb3RlY3Rpb24sXG4gICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogZW5hYmxlUElUUixcbiAgICAgIH0sXG4gICAgICBlbmNyeXB0aW9uLFxuICAgICAgZW5jcnlwdGlvbktleTogcHJvcHMuc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleSxcbiAgICAgIC4uLihiaWxsaW5nTW9kZSA9PT0gZHluYW1vZGIuQmlsbGluZ01vZGUuUFJPVklTSU9ORURcbiAgICAgICAgPyB7XG4gICAgICAgICAgICByZWFkQ2FwYWNpdHk6IHByb3BzLnNlc3Npb25UYWJsZVJlYWRDYXBhY2l0eSA/PyA1LFxuICAgICAgICAgICAgd3JpdGVDYXBhY2l0eTogcHJvcHMuc2Vzc2lvblRhYmxlV3JpdGVDYXBhY2l0eSA/PyA1LFxuICAgICAgICAgIH1cbiAgICAgICAgOiB7fSksXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVN0YWdlKFxuICAgIHN0YWdlT3B0czogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnMsXG4gICAgc3RhZ2VOYW1lOiBzdHJpbmcsXG4gICk6IGFwaWd3djIuSVN0YWdlIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoIW5lZWRzRXhwbGljaXRTdGFnZShzdGFnZU9wdHMsIHN0YWdlTmFtZSkpIHtcbiAgICAgIHJldHVybiB0aGlzLmFwaS5kZWZhdWx0U3RhZ2U7XG4gICAgfVxuXG4gICAgY29uc3Qgc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5IdHRwU3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICBodHRwQXBpOiB0aGlzLmFwaSxcbiAgICAgIHN0YWdlTmFtZSxcbiAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICB0aHJvdHRsZTogKHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWQgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdCdXJzdExpbWl0ICE9PSB1bmRlZmluZWQpXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmF0ZUxpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCxcbiAgICAgICAgICAgIGJ1cnN0TGltaXQ6IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCxcbiAgICAgICAgICB9XG4gICAgICAgIDogdW5kZWZpbmVkLFxuICAgIH0pO1xuXG4gICAgaWYgKHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nKSB7XG4gICAgICBjb25zdCBsb2dHcm91cCA9IG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgIHJldGVudGlvbjogc3RhZ2VPcHRzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILFxuICAgICAgfSk7XG4gICAgICAodGhpcyBhcyB7IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXAgfSkuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgICAgY29uc3QgY2ZuU3RhZ2UgPSBzdGFnZS5ub2RlLmRlZmF1bHRDaGlsZCBhcyBhcGlnd3YyLkNmblN0YWdlO1xuICAgICAgY2ZuU3RhZ2UuYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgIGRlc3RpbmF0aW9uQXJuOiBsb2dHcm91cC5sb2dHcm91cEFybixcbiAgICAgICAgZm9ybWF0OiBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgcmVxdWVzdElkOiBcIiRjb250ZXh0LnJlcXVlc3RJZFwiLFxuICAgICAgICAgIGlwOiBcIiRjb250ZXh0LmlkZW50aXR5LnNvdXJjZUlwXCIsXG4gICAgICAgICAgcmVxdWVzdFRpbWU6IFwiJGNvbnRleHQucmVxdWVzdFRpbWVcIixcbiAgICAgICAgICBodHRwTWV0aG9kOiBcIiRjb250ZXh0Lmh0dHBNZXRob2RcIixcbiAgICAgICAgICByb3V0ZUtleTogXCIkY29udGV4dC5yb3V0ZUtleVwiLFxuICAgICAgICAgIHN0YXR1czogXCIkY29udGV4dC5zdGF0dXNcIixcbiAgICAgICAgICBwcm90b2NvbDogXCIkY29udGV4dC5wcm90b2NvbFwiLFxuICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBcIiRjb250ZXh0LnJlc3BvbnNlTGVuZ3RoXCIsXG4gICAgICAgICAgaW50ZWdyYXRpb25MYXRlbmN5OiBcIiRjb250ZXh0LmludGVncmF0aW9uTGF0ZW5jeVwiLFxuICAgICAgICB9KSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHN0YWdlO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVDb250cm9sbGVyRnVuY3Rpb24oXG4gICAgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMsXG4gICAgaW1hZ2VBcm46IHN0cmluZyxcbiAgICBpbmdyZXNzQ29ubmVjdG9yQXJuczogc3RyaW5nW10sXG4gICAgZWdyZXNzQ29ubmVjdG9yQXJuczogc3RyaW5nW10sXG4gICAgc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuOiBzdHJpbmcsXG4gICk6IGxhbWJkYS5GdW5jdGlvbiB7XG4gICAgY29uc3QgY29udHJvbGxlclByb3BzID0gcHJvcHMuY29udHJvbGxlcjtcbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IGJ1aWxkQ29udHJvbGxlckVudmlyb25tZW50KFxuICAgICAgY29udHJvbGxlclByb3BzLmVudmlyb25tZW50LFxuICAgICAge1xuICAgICAgICBbRU5WX0NPTlRSQUNUX05BTUVdOiBNSUNST1ZNX0NPTlRSQUNUX05BTUUsXG4gICAgICAgIFtFTlZfQ09OVFJBQ1RfVkVSU0lPTl06IE1JQ1JPVk1fQ09OVFJBQ1RfVkVSU0lPTixcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX0VORFBPSU5UXTogdGhpcy5lbmRwb2ludCxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX09QRVJBVElPTlNdOiBDT05UUk9MTEVSX09QRVJBVElPTlMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9ST1VURVNdOiBDT05UUk9MTEVSX1JPVVRFX0RFRklOSVRJT05TLm1hcCgocm91dGUpID0+IGAke3JvdXRlLm1ldGhvZH0gJHtyb3V0ZS5wYXRofWApLmpvaW4oXCIsXCIpLFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRF06IENPTlRST0xMRVJfQVVUSF9SRVFVSVJFRCxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX0FVVEhfREVGQVVMVF06IENPTlRST0xMRVJfQVVUSF9ERUZBVUxULFxuICAgICAgICBbRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEVdOiB0aGlzLnNlc3Npb25UYWJsZS50YWJsZU5hbWUsXG4gICAgICAgIFtFTlZfSU1BR0VfUkVGXTogaW1hZ2VBcm4sXG4gICAgICAgIFtFTlZfTkVUV09SS19DT05ORUNUT1JfUkVGU106IGVncmVzc0Nvbm5lY3RvckFybnMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXTogaW5ncmVzc0Nvbm5lY3RvckFybnMuam9pbihcIixcIiksXG4gICAgICAgIFtFTlZfRUdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlNdOiBlZ3Jlc3NDb25uZWN0b3JBcm5zLmpvaW4oXCIsXCIpLFxuICAgICAgICBbRU5WX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGXTogc2hlbGxJbmdyZXNzQ29ubmVjdG9yQXJuLFxuICAgICAgICAuLi4ocHJvcHMuZXhlY3V0aW9uUm9sZSA/IHsgW0VOVl9FWEVDVVRJT05fUk9MRV9BUk5dOiBwcm9wcy5leGVjdXRpb25Sb2xlLnJvbGVBcm4gfSA6IHt9KSxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIHJldHVybiBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiQ29udHJvbGxlckZ1bmN0aW9uXCIsIHtcbiAgICAgIGFyY2hpdGVjdHVyZTogY29udHJvbGxlclByb3BzLmFyY2hpdGVjdHVyZSA/PyBsYW1iZGEuQXJjaGl0ZWN0dXJlLkFSTV82NCxcbiAgICAgIHRyYWNpbmc6IGNvbnRyb2xsZXJQcm9wcy50cmFjaW5nID8/IGxhbWJkYS5UcmFjaW5nLkFDVElWRSxcbiAgICAgIG1lbW9yeVNpemU6IGNvbnRyb2xsZXJQcm9wcy5tZW1vcnlTaXplID8/IDUxMixcbiAgICAgIHRpbWVvdXQ6IGNvbnRyb2xsZXJQcm9wcy50aW1lb3V0ID8/IER1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgLi4uY29udHJvbGxlclByb3BzLFxuICAgICAgZW52aXJvbm1lbnQsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGdyYW50TWljcm92bUNvbnRyb2xQbGFuZShwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyk6IHZvaWQge1xuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgc2lkOiBcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sUGxhbmVcIixcbiAgICAgICAgYWN0aW9uczogW1xuICAgICAgICAgIFwibGFtYmRhOkNyZWF0ZU1pY3Jvdm1BdXRoVG9rZW5cIixcbiAgICAgICAgICBcImxhbWJkYTpDcmVhdGVNaWNyb3ZtU2hlbGxBdXRoVG9rZW5cIixcbiAgICAgICAgICBcImxhbWJkYTpHZXRNaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6UmVzdW1lTWljcm92bVwiLFxuICAgICAgICAgIFwibGFtYmRhOlJ1bk1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpTdXNwZW5kTWljcm92bVwiLFxuICAgICAgICAgIFwibGFtYmRhOlRlcm1pbmF0ZU1pY3Jvdm1cIixcbiAgICAgICAgXSxcbiAgICAgICAgLy8gTGFtYmRhIE1pY3JvVk0gY29udHJvbC1wbGFuZSBvcGVyYXRpb25zIGFyZSBjdXJyZW50bHkgcGVybWlzc2lvbi1vbmx5XG4gICAgICAgIC8vIGFjdGlvbnMuIEFwcFRoZW9yeSBjb25zdHJhaW5zIHdoaWNoIGltYWdlL2Nvbm5lY3RvcnMvcm9sZSBtYXkgYmUgdXNlZFxuICAgICAgICAvLyB0aHJvdWdoIHR5cGVkIGNvbnN0cnVjdCBwcm9wcywgZmFpbC1jbG9zZWQgY29udHJvbGxlciBlbnYsIGFuZCBzY29wZWRcbiAgICAgICAgLy8gaWFtOlBhc3NSb2xlIHJhdGhlciB0aGFuIHByZXRlbmRpbmcgdGhlIHNlcnZpY2Ugc3VwcG9ydHMgcGVyLU1pY3JvVk1cbiAgICAgICAgLy8gcmVzb3VyY2UgQVJOcyBmb3IgdGhlc2UgYWN0aW9ucy5cbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLmFkZFRvUm9sZVBvbGljeShcbiAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgc2lkOiBcIkFwcFRoZW9yeU1pY3Jvdm1MaXN0XCIsXG4gICAgICAgIGFjdGlvbnM6IFtcImxhbWJkYTpMaXN0TWljcm92bXNcIl0sXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogXCJBcHBUaGVvcnlNaWNyb3ZtUGFzc05ldHdvcmtDb25uZWN0b3JzXCIsXG4gICAgICAgIGFjdGlvbnM6IFtcImxhbWJkYTpQYXNzTmV0d29ya0Nvbm5lY3RvclwiXSxcbiAgICAgICAgLy8gTGFtYmRhIG1hcmtzIFBhc3NOZXR3b3JrQ29ubmVjdG9yIGFzIHBlcm1pc3Npb24tb25seSB3aXRob3V0IHJlc291cmNlLWxldmVsXG4gICAgICAgIC8vIHN1cHBvcnQuIEFwcFRoZW9yeSBjb25zdHJhaW5zIHRoZSBwZXJtaXR0ZWQgY29ubmVjdG9yIHNldCB0aHJvdWdoIHR5cGVkIHByb3BzXG4gICAgICAgIC8vIGFuZCBmYWlsLWNsb3NlZCBlbnZpcm9ubWVudCB3aXJpbmcgaW5zdGVhZCBvZiBhY2NlcHRpbmcgcmF3IHJlcXVlc3Qgc3RyaW5ncy5cbiAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgfSksXG4gICAgKTtcblxuICAgIGlmIChwcm9wcy5leGVjdXRpb25Sb2xlKSB7XG4gICAgICBwcm9wcy5leGVjdXRpb25Sb2xlLmdyYW50UGFzc1JvbGUodGhpcy5jb250cm9sbGVyRnVuY3Rpb24uZ3JhbnRQcmluY2lwYWwpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgYWRkQ29udHJvbGxlclJvdXRlcygpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IHJvdXRlIG9mIENPTlRST0xMRVJfUk9VVEVfREVGSU5JVElPTlMpIHtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6IHJvdXRlLnBhdGgsXG4gICAgICAgIG1ldGhvZHM6IFtyb3V0ZS5tZXRob2RdLFxuICAgICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKHJvdXRlLmlkLCB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbiwge1xuICAgICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICB9KSxcbiAgICAgICAgYXV0aG9yaXplcjogdGhpcy5yb3V0ZUF1dGhvcml6ZXIsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbmVlZHNFeHBsaWNpdFN0YWdlKHN0YWdlT3B0czogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnMsIHN0YWdlTmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBzdGFnZU5hbWUgIT09IFwiJGRlZmF1bHRcIlxuICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlXG4gICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZFxuICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJlcXVpcmVkKHZhbHVlOiB1bmtub3duLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHZhbHVlKS50cmltKCk7XG4gIGlmICghbm9ybWFsaXplZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcsIG1heExlbmd0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBwcm9wTmFtZSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAvXFxzLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogJHtwcm9wTmFtZX0gbXVzdCBub3QgY29udGFpbiB3aGl0ZXNwYWNlYCk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIG5vcm1hbGl6ZWQubGVuZ3RoID4gbWF4TGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhdCBtb3N0ICR7bWF4TGVuZ3RofSBjaGFyYWN0ZXJzYCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gIGNvbm5lY3RvcnM6IHJlYWRvbmx5IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuICBleHBlY3RlZEtpbmQ6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCxcbik6IHN0cmluZ1tdIHtcbiAgaWYgKCFjb25uZWN0b3JzIHx8IGNvbm5lY3RvcnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBhdCBsZWFzdCAxICR7cHJvcE5hbWV9IGVudHJ5YCk7XG4gIH1cbiAgaWYgKGNvbm5lY3RvcnMubGVuZ3RoID4gMTApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHN1cHBvcnRzIGF0IG1vc3QgMTAgJHtwcm9wTmFtZX0gZW50cmllc2ApO1xuICB9XG5cbiAgY29uc3QgYXJucyA9IGNvbm5lY3RvcnMubWFwKChjb25uZWN0b3IsIGluZGV4KSA9PiB7XG4gICAgcmV0dXJuIG5vcm1hbGl6ZVNpbmdsZUNvbm5lY3RvclJlZmVyZW5jZShjb25uZWN0b3IsIGAke3Byb3BOYW1lfVske2luZGV4fV1gLCBleHBlY3RlZEtpbmQpO1xuICB9KTtcblxuICBhc3NlcnROb0R1cGxpY2F0ZXMoYXJucywgYCR7cHJvcE5hbWV9IG5ldHdvcmtDb25uZWN0b3JBcm5gKTtcbiAgcmV0dXJuIGFybnM7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVNpbmdsZUNvbm5lY3RvclJlZmVyZW5jZShcbiAgY29ubmVjdG9yOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3IgfCB1bmRlZmluZWQsXG4gIHByb3BOYW1lOiBzdHJpbmcsXG4gIGV4cGVjdGVkS2luZDogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLFxuKTogc3RyaW5nIHtcbiAgaWYgKGNvbm5lY3RvciA9PT0gdW5kZWZpbmVkIHx8IGNvbm5lY3RvciA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBjb25zdCBhY3R1YWxLaW5kID0gbm9ybWFsaXplQ29ubmVjdG9yS2luZEZvckNvbnRyb2xsZXIoY29ubmVjdG9yLm5ldHdvcmtDb25uZWN0b3JLaW5kLCBwcm9wTmFtZSk7XG4gIGlmIChhY3R1YWxLaW5kICE9PSBleHBlY3RlZEtpbmQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLiR7cHJvcE5hbWV9IG11c3QgYmUgYSAke2V4cGVjdGVkS2luZH0gY29ubmVjdG9yIHJlZmVyZW5jZWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKGNvbm5lY3Rvci5uZXR3b3JrQ29ubmVjdG9yQXJuLCBgJHtwcm9wTmFtZX0ubmV0d29ya0Nvbm5lY3RvckFybmAsIDIwNDgpO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb25uZWN0b3JLaW5kRm9yQ29udHJvbGxlcihcbiAga2luZDogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kIHwgc3RyaW5nIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuKTogQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kIHtcbiAgaWYgKGtpbmQgPT09IHVuZGVmaW5lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLiR7cHJvcE5hbWV9IG11c3QgaW5jbHVkZSBuZXR3b3JrQ29ubmVjdG9yS2luZGApO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBTdHJpbmcoa2luZCkudHJpbSgpLnRvTG93ZXJDYXNlKCkucmVwbGFjZSgvW18tXS9nLCBcIlwiKTtcbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwiaW5ncmVzc1wiKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5JTkdSRVNTO1xuICB9XG4gIGlmIChub3JtYWxpemVkID09PSBcImVncmVzc1wiKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5FR1JFU1M7XG4gIH1cbiAgaWYgKG5vcm1hbGl6ZWQgPT09IFwic2hlbGxpbmdyZXNzXCIpIHtcbiAgICByZXR1cm4gQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JLaW5kLlNIRUxMX0lOR1JFU1M7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgIGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogcHJvcHMuJHtwcm9wTmFtZX0ubmV0d29ya0Nvbm5lY3RvcktpbmQgbXVzdCBiZSBpbmdyZXNzLCBlZ3Jlc3MsIG9yIHNoZWxsLWluZ3Jlc3NgLFxuICApO1xufVxuXG5mdW5jdGlvbiBkZWR1cGVDb25uZWN0b3JBcm5zKGFybnM6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBhc3NlcnROb0R1cGxpY2F0ZXMoYXJucywgXCJjb250cm9sbGVyIG5ldHdvcmtDb25uZWN0b3JBcm5cIik7XG4gIHJldHVybiBhcm5zO1xufVxuXG5mdW5jdGlvbiBhc3NlcnROb0R1cGxpY2F0ZXModmFsdWVzOiByZWFkb25seSBzdHJpbmdbXSwgbGFiZWw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XG4gICAgaWYgKFRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoc2Vlbi5oYXModmFsdWUpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIGRvZXMgbm90IGFsbG93IGR1cGxpY2F0ZSAke2xhYmVsfSB2YWx1ZXNgKTtcbiAgICB9XG4gICAgc2Vlbi5hZGQodmFsdWUpO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUhlYWRlck5hbWUoaGVhZGVyTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IFN0cmluZyhoZWFkZXJOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IGF1dGhvcml6ZXJIZWFkZXJOYW1lIGlzIHJlcXVpcmVkXCIpO1xuICB9XG4gIHJldHVybiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTdGFnZU5hbWUoc3RhZ2VOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gU3RyaW5nKHN0YWdlTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gIGlmICghdHJpbW1lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBzdGFnZU5hbWUgaXMgcmVxdWlyZWRcIik7XG4gIH1cbiAgcmV0dXJuIHRyaW1tZWQ7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkQ29udHJvbGxlckVudmlyb25tZW50KFxuICB1c2VyRW52aXJvbm1lbnQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gfCB1bmRlZmluZWQsXG4gIHJlc2VydmVkRW52aXJvbm1lbnQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4pOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHtcbiAgY29uc3QgZW52aXJvbm1lbnQ6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7IC4uLih1c2VyRW52aXJvbm1lbnQgPz8ge30pIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIFJFU0VSVkVEX0VOVl9LRVlTKSB7XG4gICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChlbnZpcm9ubWVudCwga2V5KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogY29udHJvbGxlci5lbnZpcm9ubWVudCBjYW5ub3Qgb3ZlcnJpZGUgcmVzZXJ2ZWQgJHtrZXl9YCk7XG4gICAgfVxuICB9XG4gIHJldHVybiB7IC4uLmVudmlyb25tZW50LCAuLi5yZXNlcnZlZEVudmlyb25tZW50IH07XG59XG5cbmZ1bmN0aW9uIHN0cmlwVHJhaWxpbmdTbGFzaCh1cmw6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB1cmwucmVwbGFjZSgvXFwvJC8sIFwiXCIpO1xufVxuIl19