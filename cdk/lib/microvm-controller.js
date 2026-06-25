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
        this.grantMicrovmControlPlane(props, imageArn);
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
    grantMicrovmControlPlane(props, imageArn) {
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
            resources: [imageArn],
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
AppTheoryMicrovmController[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmController", version: "1.14.0" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1jb250cm9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1jb250cm9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQTZEO0FBQzdELHdEQUF3RDtBQUN4RCwrRUFBK0U7QUFDL0UsaUZBQWlGO0FBQ2pGLHFEQUFxRDtBQUNyRCwyQ0FBMkM7QUFFM0MsaURBQWlEO0FBQ2pELDZDQUE2QztBQUM3QywyQ0FBdUM7QUFHdkMsMkVBR3FDO0FBRXJDLE1BQU0scUJBQXFCLEdBQUcsMEJBQTBCLENBQUM7QUFDekQsTUFBTSx3QkFBd0IsR0FBRyxnQkFBZ0IsQ0FBQztBQUNsRCxNQUFNLHdCQUF3QixHQUFHLE1BQU0sQ0FBQztBQUN4QyxNQUFNLHVCQUF1QixHQUFHLE1BQU0sQ0FBQztBQUN2QyxNQUFNLHFCQUFxQixHQUFHO0lBQzVCLEtBQUs7SUFDTCxLQUFLO0lBQ0wsTUFBTTtJQUNOLFNBQVM7SUFDVCxRQUFRO0lBQ1IsV0FBVztJQUNYLFlBQVk7SUFDWixrQkFBa0I7Q0FDbkIsQ0FBQztBQUNGLE1BQU0sNEJBQTRCLEdBQW9FO0lBQ3BHLEVBQUUsRUFBRSxFQUFFLFlBQVksRUFBRSxNQUFNLEVBQUUsT0FBTyxDQUFDLFVBQVUsQ0FBQyxJQUFJLEVBQUUsSUFBSSxFQUFFLFdBQVcsRUFBRTtJQUN4RSxFQUFFLEVBQUUsRUFBRSxjQUFjLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsR0FBRyxFQUFFLElBQUksRUFBRSxXQUFXLEVBQUU7SUFDekUsRUFBRSxFQUFFLEVBQUUsWUFBWSxFQUFFLE1BQU0sRUFBRSxPQUFPLENBQUMsVUFBVSxDQUFDLEdBQUcsRUFBRSxJQUFJLEVBQUUsd0JBQXdCLEVBQUU7SUFDcEYsRUFBRSxFQUFFLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxFQUFFLE9BQU8sQ0FBQyxVQUFVLENBQUMsSUFBSSxFQUFFLElBQUksRUFBRSxnQ0FBZ0MsRUFBRTtJ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LENBQUMsSUFBSSxFQUFFLENBQUM7SUFDL0MsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ2IsTUFBTSxJQUFJLEtBQUssQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO0lBQ3ZFLENBQUM7SUFDRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQsU0FBUywwQkFBMEIsQ0FDakMsZUFBbUQsRUFDbkQsbUJBQTJDO0lBRTNDLE1BQU0sV0FBVyxHQUEyQixFQUFFLEdBQUcsQ0FBQyxlQUFlLElBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUMzRSxLQUFLLE1BQU0sR0FBRyxJQUFJLGlCQUFpQixFQUFFLENBQUM7UUFDcEMsSUFBSSxNQUFNLENBQUMsU0FBUyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDM0QsTUFBTSxJQUFJLEtBQUssQ0FBQywrRUFBK0UsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUN4RyxDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sRUFBRSxHQUFHLFdBQVcsRUFBRSxHQUFHLG1CQUFtQixFQUFFLENBQUM7QUFDcEQsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsR0FBVztJQUNyQyxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ2hDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMga21zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgfSBmcm9tIFwiLi9taWNyb3ZtLWltYWdlXCI7XG5pbXBvcnQge1xuICBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQsXG4gIHR5cGUgSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yLFxufSBmcm9tIFwiLi9taWNyb3ZtLW5ldHdvcmstY29ubmVjdG9yXCI7XG5cbmNvbnN0IE1JQ1JPVk1fQ09OVFJBQ1RfTkFNRSA9IFwiYXBwdGhlb3J5LmxhbWJkYV9taWNyb3ZtXCI7XG5jb25zdCBNSUNST1ZNX0NPTlRSQUNUX1ZFUlNJT04gPSBcIm0xNi5taWNyb3ZtL3YxXCI7XG5jb25zdCBDT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQgPSBcInRydWVcIjtcbmNvbnN0IENPTlRST0xMRVJfQVVUSF9ERUZBVUxUID0gXCJkZW55XCI7XG5jb25zdCBDT05UUk9MTEVSX09QRVJBVElPTlMgPSBbXG4gIFwicnVuXCIsXG4gIFwiZ2V0XCIsXG4gIFwibGlzdFwiLFxuICBcInN1c3BlbmRcIixcbiAgXCJyZXN1bWVcIixcbiAgXCJ0ZXJtaW5hdGVcIixcbiAgXCJhdXRoLXRva2VuXCIsXG4gIFwic2hlbGwtYXV0aC10b2tlblwiLFxuXTtcbmNvbnN0IENPTlRST0xMRVJfUk9VVEVfREVGSU5JVElPTlM6IEFycmF5PHsgaWQ6IHN0cmluZzsgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2Q7IHBhdGg6IHN0cmluZyB9PiA9IFtcbiAgeyBpZDogXCJSdW5NaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLlBPU1QsIHBhdGg6IFwiL21pY3Jvdm1zXCIgfSxcbiAgeyBpZDogXCJMaXN0TWljcm92bXNcIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuR0VULCBwYXRoOiBcIi9taWNyb3Ztc1wiIH0sXG4gIHsgaWQ6IFwiR2V0TWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5HRVQsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfVwiIH0sXG4gIHsgaWQ6IFwiU3VzcGVuZE1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L3N1c3BlbmRcIiB9LFxuICB7IGlkOiBcIlJlc3VtZU1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L3Jlc3VtZVwiIH0sXG4gIHsgaWQ6IFwiVGVybWluYXRlTWljcm92bVwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5ERUxFVEUsIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfVwiIH0sXG4gIHsgaWQ6IFwiQ3JlYXRlTWljcm92bUF1dGhUb2tlblwiLCBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULCBwYXRoOiBcIi9taWNyb3Ztcy97c2Vzc2lvbl9pZH0vYXV0aC10b2tlblwiIH0sXG4gIHtcbiAgICBpZDogXCJDcmVhdGVNaWNyb3ZtU2hlbGxBdXRoVG9rZW5cIixcbiAgICBtZXRob2Q6IGFwaWd3djIuSHR0cE1ldGhvZC5QT1NULFxuICAgIHBhdGg6IFwiL21pY3Jvdm1zL3tzZXNzaW9uX2lkfS9zaGVsbC1hdXRoLXRva2VuXCIsXG4gIH0sXG5dO1xuXG5jb25zdCBFTlZfQ09OVFJBQ1RfTkFNRSA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJBQ1RfTkFNRVwiO1xuY29uc3QgRU5WX0NPTlRSQUNUX1ZFUlNJT04gPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRSQUNUX1ZFUlNJT05cIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0VORFBPSU5UID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0VORFBPSU5UXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9PUEVSQVRJT05TID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX09QRVJBVElPTlNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX1JPVVRFUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9ST1VURVNcIjtcbmNvbnN0IEVOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRFwiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUk9MTEVSX0FVVEhfREVGQVVMVFwiO1xuY29uc3QgRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEUgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX1NFU1NJT05fUkVHSVNUUllfVEFCTEVcIjtcbmNvbnN0IEVOVl9JTUFHRV9SRUYgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lNQUdFX1JFRlwiO1xuY29uc3QgRU5WX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX05FVFdPUktfQ09OTkVDVE9SX1JFRlNcIjtcbmNvbnN0IEVOVl9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTID0gXCJBUFBUSEVPUllfTUlDUk9WTV9FR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX1NIRUxMX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGID0gXCJBUFBUSEVPUllfTUlDUk9WTV9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlwiO1xuY29uc3QgRU5WX0VYRUNVVElPTl9ST0xFX0FSTiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fRVhFQ1VUSU9OX1JPTEVfQVJOXCI7XG5cbmNvbnN0IFJFU0VSVkVEX0VOVl9LRVlTID0gW1xuICBFTlZfQ09OVFJBQ1RfTkFNRSxcbiAgRU5WX0NPTlRSQUNUX1ZFUlNJT04sXG4gIEVOVl9DT05UUk9MTEVSX0VORFBPSU5ULFxuICBFTlZfQ09OVFJPTExFUl9PUEVSQVRJT05TLFxuICBFTlZfQ09OVFJPTExFUl9ST1VURVMsXG4gIEVOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQsXG4gIEVOVl9DT05UUk9MTEVSX0FVVEhfREVGQVVMVCxcbiAgRU5WX1NFU1NJT05fUkVHSVNUUllfVEFCTEUsXG4gIEVOVl9JTUFHRV9SRUYsXG4gIEVOVl9ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTLFxuICBFTlZfSU5HUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTLFxuICBFTlZfRUdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRlMsXG4gIEVOVl9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRixcbiAgRU5WX0VYRUNVVElPTl9ST0xFX0FSTixcbl07XG5cbi8qKlxuICogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1pY3JvVk0gY29udHJvbGxlciBIVFRQIEFQSS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgZm9yIHRoZSBzdGFnZS5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogT25seSBhcHBsaWVzIHdoZW4gYWNjZXNzTG9nZ2luZyBpcyB0cnVlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBQYWNrYWdpbmcgYW5kIHJ1bnRpbWUgY29uZmlndXJhdGlvbiBmb3IgdGhlIEFwcFRoZW9yeSBNaWNyb1ZNIGNvbnRyb2xsZXIgTGFtYmRhLlxuICpcbiAqIEFwcFRoZW9yeSBjcmVhdGVzIHRoZSBMYW1iZGEgZnVuY3Rpb24gc28gaXQgY2FuIHdpcmUgdGhlIGNhbm9uaWNhbCBzZXNzaW9uIHRhYmxlLFxuICogTWljcm9WTSBpbWFnZS9uZXR3b3JrIHJlZmVyZW5jZXMsIGFuZCBmYWlsLWNsb3NlZCBhdXRoIGVudmlyb25tZW50IGNvbnNpc3RlbnRseS5cbiAqIFRoZSBjYWxsZXIgc3VwcGxpZXMgb25seSB0aGUgaGFuZGxlciBwYWNrYWdlIGRldGFpbHMgYW5kIGFueSBvcmRpbmFyeSBMYW1iZGFcbiAqIEZ1bmN0aW9uUHJvcHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJGdW5jdGlvblByb3BzIGV4dGVuZHMgbGFtYmRhLkZ1bmN0aW9uUHJvcHMge31cblxuLyoqXG4gKiBQcm9wcyBmb3IgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyB7XG4gIC8qKlxuICAgKiBDb250cm9sbGVyIExhbWJkYSBwYWNrYWdpbmcgYW5kIGNvbmZpZ3VyYXRpb24uXG4gICAqXG4gICAqIFRoZSBoYW5kbGVyIGNvZGUgbXVzdCB1c2UgQXBwVGhlb3J5J3MgTWljcm9WTSBydW50aW1lL2NvbnRyb2xsZXIgcHJpbWl0aXZlcy5cbiAgICogVGhpcyBjb25zdHJ1Y3QgZG9lcyBub3QgaW1wbGVtZW50IGEgcHJvZHVjdCBjb250cm9sLXBsYW5lIHNlcnZpY2UuXG4gICAqL1xuICByZWFkb25seSBjb250cm9sbGVyOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlckZ1bmN0aW9uUHJvcHM7XG5cbiAgLyoqXG4gICAqIExhbWJkYSByZXF1ZXN0IGF1dGhvcml6ZXIgcmVxdWlyZWQgZm9yIGV2ZXJ5IGNvbnRyb2xsZXIgcm91dGUuXG4gICAqXG4gICAqIFRoZSBjb25zdHJ1Y3QgZmFpbHMgY2xvc2VkIHdoZW4gdGhpcyBpcyBvbWl0dGVkOyB1bmF1dGhlbnRpY2F0ZWQgY29udHJvbGxlciByb3V0ZXNcbiAgICogYXJlIG5vdCBzeW50aGVzaXplZC5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFRoZSBNaWNyb1ZNIGltYWdlIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBydW4uXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSW1hZ2U6IElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U7XG5cbiAgLyoqXG4gICAqIEluZ3Jlc3MgbmV0d29yayBjb25uZWN0b3JzIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBwYXNzIHRvIExhbWJkYSBNaWNyb1ZNcy5cbiAgICpcbiAgICogQXQgbGVhc3Qgb25lIGNvbm5lY3RvciByZWZlcmVuY2UgaXMgcmVxdWlyZWQgYW5kIG5vIG1vcmUgdGhhbiAxMCBtYXkgYmUgc3VwcGxpZWQuXG4gICAqIFVzZSBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3Rvci5hbGxJbmdyZXNzL25vSW5ncmVzcyBvciBhbiBleHBsaWNpdGx5IHR5cGVkXG4gICAqIGltcG9ydGVkIGluZ3Jlc3MgY29ubmVjdG9yIHJlZmVyZW5jZTsgQXBwVGhlb3J5IGRvZXMgbm90IGhpZGUgYW4gaW5ncmVzcyBkZWZhdWx0LlxuICAgKi9cbiAgcmVhZG9ubHkgaW5ncmVzc05ldHdvcmtDb25uZWN0b3JzOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXTtcblxuICAvKipcbiAgICogRWdyZXNzIG5ldHdvcmsgY29ubmVjdG9ycyB0aGUgY29udHJvbGxlciBpcyBwZXJtaXR0ZWQgdG8gcGFzcyB0byBMYW1iZGEgTWljcm9WTXMuXG4gICAqXG4gICAqIEF0IGxlYXN0IG9uZSBjb25uZWN0b3IgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGFuZCBubyBtb3JlIHRoYW4gMTAgbWF5IGJlIHN1cHBsaWVkLlxuICAgKi9cbiAgcmVhZG9ubHkgZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnM6IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdO1xuXG4gIC8qKlxuICAgKiBTaGVsbCBpbmdyZXNzIGNvbm5lY3RvciByZXF1aXJlZCBmb3Igc2hlbGwtYXV0aC10b2tlbiBzdXBwb3J0LlxuICAgKlxuICAgKiBVc2UgQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3Iuc2hlbGxJbmdyZXNzIG9yIGFuIGV4cGxpY2l0bHkgdHlwZWQgc2hlbGwtaW5ncmVzc1xuICAgKiBjb25uZWN0b3IgcmVmZXJlbmNlLiBUaGUgc2hlbGwtYXV0aC10b2tlbiByb3V0ZSBpcyBwYXJ0IG9mIHRoZSByZWFsIE0xNiBjb250cm9sbGVyXG4gICAqIHN1cmZhY2UsIHNvIHRoaXMgcmVmZXJlbmNlIGlzIHJlcXVpcmVkIGluc3RlYWQgb2YgYmVpbmcgc2lsZW50bHkgZGVmYXVsdGVkLlxuICAgKi9cbiAgcmVhZG9ubHkgc2hlbGxJbmdyZXNzTmV0d29ya0Nvbm5lY3RvcjogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBNaWNyb1ZNIGV4ZWN1dGlvbiByb2xlIHBhc3NlZCB0byBSdW5NaWNyb3ZtLlxuICAgKlxuICAgKiBXaGVuIHN1cHBsaWVkLCBBcHBUaGVvcnkgZ3JhbnRzIHRoZSBjb250cm9sbGVyIExhbWJkYSBpYW06UGFzc1JvbGUgZm9yIHRoaXMgcm9sZVxuICAgKiBhbmQgZXhwb3NlcyB0aGUgQVJOIGFzIEFQUFRIRU9SWV9NSUNST1ZNX0VYRUNVVElPTl9ST0xFX0FSTi5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBleGVjdXRpb25Sb2xlPzogaWFtLklSb2xlO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBBUEkgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBzdGFnZSBjb25maWd1cmF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKGRlZmF1bHQgSFRUUCBBUEkgc3RhZ2UpXG4gICAqL1xuICByZWFkb25seSBzdGFnZT86IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zO1xuXG4gIC8qKlxuICAgKiBOYW1lIGZvciB0aGUgZHVyYWJsZSBNaWNyb1ZNIHNlc3Npb24gcmVnaXN0cnkgRHluYW1vREIgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZCAoQ2xvdWRGb3JtYXRpb24tZ2VuZXJhdGVkKVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogQmlsbGluZyBtb2RlIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgUEFZX1BFUl9SRVFVRVNUXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZT86IGR5bmFtb2RiLkJpbGxpbmdNb2RlO1xuXG4gIC8qKlxuICAgKiBSZW1vdmFsIHBvbGljeSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFJlbW92YWxQb2xpY3kuUkVUQUlOXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcblxuICAvKipcbiAgICogV2hldGhlciBkZWxldGlvbiBwcm90ZWN0aW9uIHNob3VsZCBiZSBlbmFibGVkIGZvciB0aGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZS5cbiAgICpcbiAgICogQGRlZmF1bHQgLSBBV1MgZGVmYXVsdCAobm8gZGVsZXRpb24gcHJvdGVjdGlvbilcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZURlbGV0aW9uUHJvdGVjdGlvbj86IGJvb2xlYW47XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgcG9pbnQtaW4tdGltZSByZWNvdmVyeSBzaG91bGQgYmUgZW5hYmxlZCBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHRydWVcbiAgICovXG4gIHJlYWRvbmx5IGVuYWJsZVNlc3Npb25UYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBTZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlIGVuY3J5cHRpb24gc2V0dGluZy5cbiAgICpcbiAgICogQGRlZmF1bHQgQVdTX01BTkFHRURcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZUVuY3J5cHRpb24/OiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb247XG5cbiAgLyoqXG4gICAqIEN1c3RvbWVyLW1hbmFnZWQgS01TIGtleSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIFJlcXVpcmVkIHdoZW4gc2Vzc2lvblRhYmxlRW5jcnlwdGlvbiBpcyBDVVNUT01FUl9NQU5BR0VELlxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleT86IGttcy5JS2V5O1xuXG4gIC8qKlxuICAgKiBQcm92aXNpb25lZCByZWFkIGNhcGFjaXR5IHdoZW4gc2Vzc2lvblRhYmxlQmlsbGluZ01vZGUgaXMgUFJPVklTSU9ORUQuXG4gICAqXG4gICAqIEBkZWZhdWx0IDVcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZVJlYWRDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgd3JpdGUgY2FwYWNpdHkgd2hlbiBzZXNzaW9uVGFibGVCaWxsaW5nTW9kZSBpcyBQUk9WSVNJT05FRC5cbiAgICpcbiAgICogQGRlZmF1bHQgNVxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlV3JpdGVDYXBhY2l0eT86IG51bWJlcjtcblxuICAvKipcbiAgICogSGVhZGVyIHVzZWQgYXMgdGhlIGlkZW50aXR5IHNvdXJjZSBmb3IgY29udHJvbGxlciBhdXRob3JpemF0aW9uLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcIkF1dGhvcml6YXRpb25cIlxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckhlYWRlck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEZyaWVuZGx5IGF1dGhvcml6ZXIgbmFtZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBhdXRob3JpemVyTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogTGFtYmRhIGF1dGhvcml6ZXIgcmVzdWx0IGNhY2hlIFRUTC5cbiAgICpcbiAgICogRGVmYXVsdHMgdG8gZGlzYWJsZWQgc28gc3RhbGUgYXV0aCBjYW5ub3Qgc2lsZW50bHkgYnJvYWRlbiBjb250cm9sbGVyIGFjY2Vzcy5cbiAgICpcbiAgICogQGRlZmF1bHQgRHVyYXRpb24uc2Vjb25kcygwKVxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplckNhY2hlVHRsPzogRHVyYXRpb247XG59XG5cbi8qKlxuICogQXBwVGhlb3J5IENESyBjb25zdHJ1Y3QgZm9yIHRoZSBmaXJzdC1jbGFzcyBMYW1iZGEgTWljcm9WTSBjb250cm9sbGVyIGRlcGxveW1lbnQgc3VyZmFjZS5cbiAqXG4gKiBUaGUgY29uc3RydWN0IHByb3Zpc2lvbnMgdGhlIHByb3RlY3RlZCBIVFRQIEFQSSByb3V0ZXMgZnJvbSB0aGUgTTE2IHJlYWwgY29udHJvbGxlciBjb250cmFjdCxcbiAqIHRoZSBjb250cm9sbGVyIExhbWJkYSwgdGhlIGNhbm9uaWNhbCBkdXJhYmxlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUsIElBTSBncmFudHMsIGFuZFxuICogZmFpbC1jbG9zZWQgYXV0aCBlbnZpcm9ubWVudCB3aXJpbmcuIFJ1bnRpbWUgY29tbWFuZCBoYW5kbGluZyByZW1haW5zIGluIHRoZSBBcHBUaGVvcnlcbiAqIHJ1bnRpbWUgY29udHJhY3Q7IHRoaXMgY29uc3RydWN0IG9ubHkgd2lyZXMgdGhlIGRlcGxveW1lbnQgcGF0aC5cbiAqL1xuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgLyoqXG4gICAqIFRoZSB1bmRlcmx5aW5nIEhUVFAgQVBJIEdhdGV3YXkgdjIgQVBJLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5IdHRwQXBpO1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJIEdhdGV3YXkgc3RhZ2UuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuSVN0YWdlO1xuXG4gIC8qKlxuICAgKiBMYW1iZGEgcmVxdWVzdCBhdXRob3JpemVyIGF0dGFjaGVkIHRvIGV2ZXJ5IGNvbnRyb2xsZXIgcm91dGUuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgcm91dGVBdXRob3JpemVyOiBhcGlnd3YyQXV0aG9yaXplcnMuSHR0cExhbWJkYUF1dGhvcml6ZXI7XG5cbiAgLyoqXG4gICAqIFRoZSBjb250cm9sbGVyIExhbWJkYSBmdW5jdGlvbiBjcmVhdGVkIGJ5IHRoaXMgY29uc3RydWN0LlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGNvbnRyb2xsZXJGdW5jdGlvbjogbGFtYmRhLkZ1bmN0aW9uO1xuXG4gIC8qKlxuICAgKiBUaGUgZHVyYWJsZSBUYWJsZVRoZW9yeS1zaGFwZWQgc2Vzc2lvbiByZWdpc3RyeSBEeW5hbW9EQiB0YWJsZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzZXNzaW9uVGFibGU6IGR5bmFtb2RiLlRhYmxlO1xuXG4gIC8qKlxuICAgKiBUaGUgY29udHJvbGxlciBiYXNlIGVuZHBvaW50IChgL21pY3Jvdm1zYCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgZW5kcG9pbnQ6IHN0cmluZztcblxuICAvKipcbiAgICogVGhlIGFjY2VzcyBsb2cgZ3JvdXAgKGlmIGFjY2VzcyBsb2dnaW5nIGlzIGVuYWJsZWQpLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgaWYgKHByb3BzID09PSB1bmRlZmluZWQgfHwgcHJvcHMgPT09IG51bGwpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzXCIpO1xuICAgIH1cbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLmNvbnRyb2xsZXIsIFwiY29udHJvbGxlclwiKTtcbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLmF1dGhvcml6ZXIsIFwiYXV0aG9yaXplclwiKTtcbiAgICB2YWxpZGF0ZVJlcXVpcmVkKHByb3BzLm1pY3Jvdm1JbWFnZSwgXCJtaWNyb3ZtSW1hZ2VcIik7XG5cbiAgICBjb25zdCBpbWFnZUFybiA9IG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhwcm9wcy5taWNyb3ZtSW1hZ2UubWljcm92bUltYWdlQXJuLCBcIm1pY3Jvdm1JbWFnZS5taWNyb3ZtSW1hZ2VBcm5cIiwgMjA0OCk7XG4gICAgY29uc3QgaW5ncmVzc0Nvbm5lY3RvckFybnMgPSBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICAgICAgcHJvcHMuaW5ncmVzc05ldHdvcmtDb25uZWN0b3JzLFxuICAgICAgXCJpbmdyZXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5JTkdSRVNTLFxuICAgICk7XG4gICAgY29uc3QgZWdyZXNzQ29ubmVjdG9yQXJucyA9IG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gICAgICBwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyxcbiAgICAgIFwiZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnNcIixcbiAgICAgIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5FR1JFU1MsXG4gICAgKTtcbiAgICBjb25zdCBzaGVsbEluZ3Jlc3NDb25uZWN0b3JBcm4gPSBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoXG4gICAgICBwcm9wcy5zaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yLFxuICAgICAgXCJzaGVsbEluZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yXCIsXG4gICAgICBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuU0hFTExfSU5HUkVTUyxcbiAgICApO1xuICAgIGNvbnN0IGFsbEluZ3Jlc3NDb25uZWN0b3JBcm5zID0gZGVkdXBlQ29ubmVjdG9yQXJucyhbLi4uaW5ncmVzc0Nvbm5lY3RvckFybnMsIHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybl0pO1xuICAgIGFzc2VydE5vRHVwbGljYXRlcyhbLi4uYWxsSW5ncmVzc0Nvbm5lY3RvckFybnMsIC4uLmVncmVzc0Nvbm5lY3RvckFybnNdLCBcImNvbnRyb2xsZXIgbmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgICBjb25zdCBhdXRob3JpemVySGVhZGVyTmFtZSA9IG5vcm1hbGl6ZUhlYWRlck5hbWUocHJvcHMuYXV0aG9yaXplckhlYWRlck5hbWUgPz8gXCJBdXRob3JpemF0aW9uXCIpO1xuICAgIGNvbnN0IHN0YWdlT3B0cyA9IHByb3BzLnN0YWdlID8/IHt9O1xuICAgIGNvbnN0IHN0YWdlTmFtZSA9IG5vcm1hbGl6ZVN0YWdlTmFtZShzdGFnZU9wdHMuc3RhZ2VOYW1lID8/IFwiJGRlZmF1bHRcIik7XG5cbiAgICB0aGlzLnNlc3Npb25UYWJsZSA9IHRoaXMuY3JlYXRlU2Vzc2lvblRhYmxlKHByb3BzKTtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuSHR0cEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgICAgY3JlYXRlRGVmYXVsdFN0YWdlOiAhbmVlZHNFeHBsaWNpdFN0YWdlKHN0YWdlT3B0cywgc3RhZ2VOYW1lKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHN0YWdlID0gdGhpcy5jcmVhdGVTdGFnZShzdGFnZU9wdHMsIHN0YWdlTmFtZSk7XG4gICAgaWYgKCFzdGFnZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IGZhaWxlZCB0byBjcmVhdGUgQVBJIHN0YWdlXCIpO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlID0gc3RhZ2U7XG5cbiAgICB0aGlzLmVuZHBvaW50ID0gc3RhZ2VOYW1lID09PSBcIiRkZWZhdWx0XCJcbiAgICAgID8gYCR7c3RyaXBUcmFpbGluZ1NsYXNoKHRoaXMuYXBpLmFwaUVuZHBvaW50KX0vbWljcm92bXNgXG4gICAgICA6IGAke3N0cmlwVHJhaWxpbmdTbGFzaCh0aGlzLmFwaS5hcGlFbmRwb2ludCl9LyR7c3RhZ2VOYW1lfS9taWNyb3Ztc2A7XG5cbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbiA9IHRoaXMuY3JlYXRlQ29udHJvbGxlckZ1bmN0aW9uKFxuICAgICAgcHJvcHMsXG4gICAgICBpbWFnZUFybixcbiAgICAgIGFsbEluZ3Jlc3NDb25uZWN0b3JBcm5zLFxuICAgICAgZWdyZXNzQ29ubmVjdG9yQXJucyxcbiAgICAgIHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybixcbiAgICApO1xuICAgIHRoaXMuc2Vzc2lvblRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbik7XG4gICAgdGhpcy5ncmFudE1pY3Jvdm1Db250cm9sUGxhbmUocHJvcHMsIGltYWdlQXJuKTtcblxuICAgIHRoaXMucm91dGVBdXRob3JpemVyID0gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwTGFtYmRhQXV0aG9yaXplcihcIkF1dGhvcml6ZXJcIiwgcHJvcHMuYXV0aG9yaXplciwge1xuICAgICAgYXV0aG9yaXplck5hbWU6IHByb3BzLmF1dGhvcml6ZXJOYW1lLFxuICAgICAgaWRlbnRpdHlTb3VyY2U6IFtgJHJlcXVlc3QuaGVhZGVyLiR7YXV0aG9yaXplckhlYWRlck5hbWV9YF0sXG4gICAgICByZXN1bHRzQ2FjaGVUdGw6IHByb3BzLmF1dGhvcml6ZXJDYWNoZVR0bCA/PyBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgcmVzcG9uc2VUeXBlczogW2FwaWd3djJBdXRob3JpemVycy5IdHRwTGFtYmRhUmVzcG9uc2VUeXBlLlNJTVBMRV0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbnRyb2xsZXJSb3V0ZXMoKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU2Vzc2lvblRhYmxlKHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzKTogZHluYW1vZGIuVGFibGUge1xuICAgIGNvbnN0IGJpbGxpbmdNb2RlID0gcHJvcHMuc2Vzc2lvblRhYmxlQmlsbGluZ01vZGUgPz8gZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNUO1xuICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5zZXNzaW9uVGFibGVSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgIGNvbnN0IGVuY3J5cHRpb24gPSBwcm9wcy5zZXNzaW9uVGFibGVFbmNyeXB0aW9uID8/IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRDtcbiAgICBjb25zdCBlbmFibGVQSVRSID0gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlUG9pbnRJblRpbWVSZWNvdmVyeSA/PyB0cnVlO1xuXG4gICAgaWYgKGVuY3J5cHRpb24gPT09IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5DVVNUT01FUl9NQU5BR0VEICYmICFwcm9wcy5zZXNzaW9uVGFibGVFbmNyeXB0aW9uS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleSB3aGVuIHNlc3Npb25UYWJsZUVuY3J5cHRpb24gaXMgQ1VTVE9NRVJfTUFOQUdFRFwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wcy5zZXNzaW9uVGFibGVOYW1lID09PSB1bmRlZmluZWRcbiAgICAgID8gdW5kZWZpbmVkXG4gICAgICA6IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHByb3BzLnNlc3Npb25UYWJsZU5hbWUsIFwic2Vzc2lvblRhYmxlTmFtZVwiKTtcblxuICAgIHJldHVybiBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTZXNzaW9uVGFibGVcIiwge1xuICAgICAgdGFibGVOYW1lLFxuICAgICAgYmlsbGluZ01vZGUsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJwa1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiBcInNrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcInR0bFwiLFxuICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogcHJvcHMuc2Vzc2lvblRhYmxlRGVsZXRpb25Qcm90ZWN0aW9uLFxuICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IGVuYWJsZVBJVFIsXG4gICAgICB9LFxuICAgICAgZW5jcnlwdGlvbixcbiAgICAgIGVuY3J5cHRpb25LZXk6IHByb3BzLnNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXksXG4gICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhZENhcGFjaXR5OiBwcm9wcy5zZXNzaW9uVGFibGVSZWFkQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IHByb3BzLnNlc3Npb25UYWJsZVdyaXRlQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTdGFnZShcbiAgICBzdGFnZU9wdHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zLFxuICAgIHN0YWdlTmFtZTogc3RyaW5nLFxuICApOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKCFuZWVkc0V4cGxpY2l0U3RhZ2Uoc3RhZ2VPcHRzLCBzdGFnZU5hbWUpKSB7XG4gICAgICByZXR1cm4gdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YWdlID0gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZU5hbWUsXG4gICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgdGhyb3R0bGU6IChzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICAgIGZvcm1hdDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICAgICAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgICAgICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgICAgICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgICAgICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICAgICAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgICAgICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICAgICAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgICAgICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiBzdGFnZTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ29udHJvbGxlckZ1bmN0aW9uKFxuICAgIHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzLFxuICAgIGltYWdlQXJuOiBzdHJpbmcsXG4gICAgaW5ncmVzc0Nvbm5lY3RvckFybnM6IHN0cmluZ1tdLFxuICAgIGVncmVzc0Nvbm5lY3RvckFybnM6IHN0cmluZ1tdLFxuICAgIHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybjogc3RyaW5nLFxuICApOiBsYW1iZGEuRnVuY3Rpb24ge1xuICAgIGNvbnN0IGNvbnRyb2xsZXJQcm9wcyA9IHByb3BzLmNvbnRyb2xsZXI7XG4gICAgY29uc3QgZW52aXJvbm1lbnQgPSBidWlsZENvbnRyb2xsZXJFbnZpcm9ubWVudChcbiAgICAgIGNvbnRyb2xsZXJQcm9wcy5lbnZpcm9ubWVudCxcbiAgICAgIHtcbiAgICAgICAgW0VOVl9DT05UUkFDVF9OQU1FXTogTUlDUk9WTV9DT05UUkFDVF9OQU1FLFxuICAgICAgICBbRU5WX0NPTlRSQUNUX1ZFUlNJT05dOiBNSUNST1ZNX0NPTlRSQUNUX1ZFUlNJT04sXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9FTkRQT0lOVF06IHRoaXMuZW5kcG9pbnQsXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9PUEVSQVRJT05TXTogQ09OVFJPTExFUl9PUEVSQVRJT05TLmpvaW4oXCIsXCIpLFxuICAgICAgICBbRU5WX0NPTlRST0xMRVJfUk9VVEVTXTogQ09OVFJPTExFUl9ST1VURV9ERUZJTklUSU9OUy5tYXAoKHJvdXRlKSA9PiBgJHtyb3V0ZS5tZXRob2R9ICR7cm91dGUucGF0aH1gKS5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRURdOiBDT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQsXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9BVVRIX0RFRkFVTFRdOiBDT05UUk9MTEVSX0FVVEhfREVGQVVMVCxcbiAgICAgICAgW0VOVl9TRVNTSU9OX1JFR0lTVFJZX1RBQkxFXTogdGhpcy5zZXNzaW9uVGFibGUudGFibGVOYW1lLFxuICAgICAgICBbRU5WX0lNQUdFX1JFRl06IGltYWdlQXJuLFxuICAgICAgICBbRU5WX05FVFdPUktfQ09OTkVDVE9SX1JFRlNdOiBlZ3Jlc3NDb25uZWN0b3JBcm5zLmpvaW4oXCIsXCIpLFxuICAgICAgICBbRU5WX0lOR1JFU1NfTkVUV09SS19DT05ORUNUT1JfUkVGU106IGluZ3Jlc3NDb25uZWN0b3JBcm5zLmpvaW4oXCIsXCIpLFxuICAgICAgICBbRU5WX0VHUkVTU19ORVRXT1JLX0NPTk5FQ1RPUl9SRUZTXTogZWdyZXNzQ29ubmVjdG9yQXJucy5qb2luKFwiLFwiKSxcbiAgICAgICAgW0VOVl9TSEVMTF9JTkdSRVNTX05FVFdPUktfQ09OTkVDVE9SX1JFRl06IHNoZWxsSW5ncmVzc0Nvbm5lY3RvckFybixcbiAgICAgICAgLi4uKHByb3BzLmV4ZWN1dGlvblJvbGUgPyB7IFtFTlZfRVhFQ1VUSU9OX1JPTEVfQVJOXTogcHJvcHMuZXhlY3V0aW9uUm9sZS5yb2xlQXJuIH0gOiB7fSksXG4gICAgICB9LFxuICAgICk7XG5cbiAgICByZXR1cm4gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCBcIkNvbnRyb2xsZXJGdW5jdGlvblwiLCB7XG4gICAgICBhcmNoaXRlY3R1cmU6IGNvbnRyb2xsZXJQcm9wcy5hcmNoaXRlY3R1cmUgPz8gbGFtYmRhLkFyY2hpdGVjdHVyZS5BUk1fNjQsXG4gICAgICB0cmFjaW5nOiBjb250cm9sbGVyUHJvcHMudHJhY2luZyA/PyBsYW1iZGEuVHJhY2luZy5BQ1RJVkUsXG4gICAgICBtZW1vcnlTaXplOiBjb250cm9sbGVyUHJvcHMubWVtb3J5U2l6ZSA/PyA1MTIsXG4gICAgICB0aW1lb3V0OiBjb250cm9sbGVyUHJvcHMudGltZW91dCA/PyBEdXJhdGlvbi5zZWNvbmRzKDMwKSxcbiAgICAgIC4uLmNvbnRyb2xsZXJQcm9wcyxcbiAgICAgIGVudmlyb25tZW50LFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBncmFudE1pY3Jvdm1Db250cm9sUGxhbmUocHJvcHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyUHJvcHMsIGltYWdlQXJuOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbFBsYW5lXCIsXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImxhbWJkYTpDcmVhdGVNaWNyb3ZtQXV0aFRva2VuXCIsXG4gICAgICAgICAgXCJsYW1iZGE6Q3JlYXRlTWljcm92bVNoZWxsQXV0aFRva2VuXCIsXG4gICAgICAgICAgXCJsYW1iZGE6R2V0TWljcm92bVwiLFxuICAgICAgICAgIFwibGFtYmRhOlJlc3VtZU1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpSdW5NaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6U3VzcGVuZE1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpUZXJtaW5hdGVNaWNyb3ZtXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW2ltYWdlQXJuXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogXCJBcHBUaGVvcnlNaWNyb3ZtTGlzdFwiLFxuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6TGlzdE1pY3Jvdm1zXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6IFwiQXBwVGhlb3J5TWljcm92bVBhc3NOZXR3b3JrQ29ubmVjdG9yc1wiLFxuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6UGFzc05ldHdvcmtDb25uZWN0b3JcIl0sXG4gICAgICAgIC8vIExhbWJkYSBtYXJrcyBQYXNzTmV0d29ya0Nvbm5lY3RvciBhcyBwZXJtaXNzaW9uLW9ubHkgd2l0aG91dCByZXNvdXJjZS1sZXZlbFxuICAgICAgICAvLyBzdXBwb3J0LiBBcHBUaGVvcnkgY29uc3RyYWlucyB0aGUgcGVybWl0dGVkIGNvbm5lY3RvciBzZXQgdGhyb3VnaCB0eXBlZCBwcm9wc1xuICAgICAgICAvLyBhbmQgZmFpbC1jbG9zZWQgZW52aXJvbm1lbnQgd2lyaW5nIGluc3RlYWQgb2YgYWNjZXB0aW5nIHJhdyByZXF1ZXN0IHN0cmluZ3MuXG4gICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICBpZiAocHJvcHMuZXhlY3V0aW9uUm9sZSkge1xuICAgICAgcHJvcHMuZXhlY3V0aW9uUm9sZS5ncmFudFBhc3NSb2xlKHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLmdyYW50UHJpbmNpcGFsKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFkZENvbnRyb2xsZXJSb3V0ZXMoKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCByb3V0ZSBvZiBDT05UUk9MTEVSX1JPVVRFX0RFRklOSVRJT05TKSB7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZXMoe1xuICAgICAgICBwYXRoOiByb3V0ZS5wYXRoLFxuICAgICAgICBtZXRob2RzOiBbcm91dGUubWV0aG9kXSxcbiAgICAgICAgaW50ZWdyYXRpb246IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLkh0dHBMYW1iZGFJbnRlZ3JhdGlvbihyb3V0ZS5pZCwgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24sIHtcbiAgICAgICAgICBwYXlsb2FkRm9ybWF0VmVyc2lvbjogYXBpZ3d2Mi5QYXlsb2FkRm9ybWF0VmVyc2lvbi5WRVJTSU9OXzJfMCxcbiAgICAgICAgfSksXG4gICAgICAgIGF1dGhvcml6ZXI6IHRoaXMucm91dGVBdXRob3JpemVyLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIG5lZWRzRXhwbGljaXRTdGFnZShzdGFnZU9wdHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zLCBzdGFnZU5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gc3RhZ2VOYW1lICE9PSBcIiRkZWZhdWx0XCJcbiAgICB8fCBzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZyA9PT0gdHJ1ZVxuICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nUmF0ZUxpbWl0ICE9PSB1bmRlZmluZWRcbiAgICB8fCBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQgIT09IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVSZXF1aXJlZCh2YWx1ZTogdW5rbm93biwgcHJvcE5hbWU6IHN0cmluZyk6IHZvaWQge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQgfHwgdmFsdWUgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IFN0cmluZyh2YWx1ZSkudHJpbSgpO1xuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyh2YWx1ZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBwcm9wTmFtZTogc3RyaW5nLCBtYXhMZW5ndGg6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBub3JtYWxpemVSZXF1aXJlZFN0cmluZyh2YWx1ZSwgcHJvcE5hbWUpO1xuICBpZiAoIVRva2VuLmlzVW5yZXNvbHZlZCh2YWx1ZSkgJiYgL1xccy8udGVzdChub3JtYWxpemVkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6ICR7cHJvcE5hbWV9IG11c3Qgbm90IGNvbnRhaW4gd2hpdGVzcGFjZWApO1xuICB9XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiBub3JtYWxpemVkLmxlbmd0aCA+IG1heExlbmd0aCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6ICR7cHJvcE5hbWV9IG11c3QgYmUgYXQgbW9zdCAke21heExlbmd0aH0gY2hhcmFjdGVyc2ApO1xuICB9XG4gIHJldHVybiBub3JtYWxpemVkO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVDb25uZWN0b3JSZWZlcmVuY2VzKFxuICBjb25uZWN0b3JzOiByZWFkb25seSBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXSB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbiAgZXhwZWN0ZWRLaW5kOiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQsXG4pOiBzdHJpbmdbXSB7XG4gIGlmICghY29ubmVjdG9ycyB8fCBjb25uZWN0b3JzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgYXQgbGVhc3QgMSAke3Byb3BOYW1lfSBlbnRyeWApO1xuICB9XG4gIGlmIChjb25uZWN0b3JzLmxlbmd0aCA+IDEwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBzdXBwb3J0cyBhdCBtb3N0IDEwICR7cHJvcE5hbWV9IGVudHJpZXNgKTtcbiAgfVxuXG4gIGNvbnN0IGFybnMgPSBjb25uZWN0b3JzLm1hcCgoY29ubmVjdG9yLCBpbmRleCkgPT4ge1xuICAgIHJldHVybiBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoY29ubmVjdG9yLCBgJHtwcm9wTmFtZX1bJHtpbmRleH1dYCwgZXhwZWN0ZWRLaW5kKTtcbiAgfSk7XG5cbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKGFybnMsIGAke3Byb3BOYW1lfSBuZXR3b3JrQ29ubmVjdG9yQXJuYCk7XG4gIHJldHVybiBhcm5zO1xufVxuXG5mdW5jdGlvbiBub3JtYWxpemVTaW5nbGVDb25uZWN0b3JSZWZlcmVuY2UoXG4gIGNvbm5lY3RvcjogSUFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yIHwgdW5kZWZpbmVkLFxuICBwcm9wTmFtZTogc3RyaW5nLFxuICBleHBlY3RlZEtpbmQ6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCxcbik6IHN0cmluZyB7XG4gIGlmIChjb25uZWN0b3IgPT09IHVuZGVmaW5lZCB8fCBjb25uZWN0b3IgPT09IG51bGwpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyIHJlcXVpcmVzIHByb3BzLiR7cHJvcE5hbWV9YCk7XG4gIH1cbiAgY29uc3QgYWN0dWFsS2luZCA9IG5vcm1hbGl6ZUNvbm5lY3RvcktpbmRGb3JDb250cm9sbGVyKGNvbm5lY3Rvci5uZXR3b3JrQ29ubmVjdG9yS2luZCwgcHJvcE5hbWUpO1xuICBpZiAoYWN0dWFsS2luZCAhPT0gZXhwZWN0ZWRLaW5kKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy4ke3Byb3BOYW1lfSBtdXN0IGJlIGEgJHtleHBlY3RlZEtpbmR9IGNvbm5lY3RvciByZWZlcmVuY2VgLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhjb25uZWN0b3IubmV0d29ya0Nvbm5lY3RvckFybiwgYCR7cHJvcE5hbWV9Lm5ldHdvcmtDb25uZWN0b3JBcm5gLCAyMDQ4KTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplQ29ubmVjdG9yS2luZEZvckNvbnRyb2xsZXIoXG4gIGtpbmQ6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCB8IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgcHJvcE5hbWU6IHN0cmluZyxcbik6IEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZCB7XG4gIGlmIChraW5kID09PSB1bmRlZmluZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBwcm9wcy4ke3Byb3BOYW1lfSBtdXN0IGluY2x1ZGUgbmV0d29ya0Nvbm5lY3RvcktpbmRgKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKGtpbmQpLnRyaW0oKS50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1tfLV0vZywgXCJcIik7XG4gIGlmIChub3JtYWxpemVkID09PSBcImluZ3Jlc3NcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuSU5HUkVTUztcbiAgfVxuICBpZiAobm9ybWFsaXplZCA9PT0gXCJlZ3Jlc3NcIikge1xuICAgIHJldHVybiBBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcktpbmQuRUdSRVNTO1xuICB9XG4gIGlmIChub3JtYWxpemVkID09PSBcInNoZWxsaW5ncmVzc1wiKSB7XG4gICAgcmV0dXJuIEFwcFRoZW9yeU1pY3Jvdm1OZXR3b3JrQ29ubmVjdG9yS2luZC5TSEVMTF9JTkdSRVNTO1xuICB9XG4gIHRocm93IG5ldyBFcnJvcihcbiAgICBgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHByb3BzLiR7cHJvcE5hbWV9Lm5ldHdvcmtDb25uZWN0b3JLaW5kIG11c3QgYmUgaW5ncmVzcywgZWdyZXNzLCBvciBzaGVsbC1pbmdyZXNzYCxcbiAgKTtcbn1cblxuZnVuY3Rpb24gZGVkdXBlQ29ubmVjdG9yQXJucyhhcm5zOiBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKGFybnMsIFwiY29udHJvbGxlciBuZXR3b3JrQ29ubmVjdG9yQXJuXCIpO1xuICByZXR1cm4gYXJucztcbn1cblxuZnVuY3Rpb24gYXNzZXJ0Tm9EdXBsaWNhdGVzKHZhbHVlczogcmVhZG9ubHkgc3RyaW5nW10sIGxhYmVsOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IHZhbHVlIG9mIHZhbHVlcykge1xuICAgIGlmIChUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHNlZW4uaGFzKHZhbHVlKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciBkb2VzIG5vdCBhbGxvdyBkdXBsaWNhdGUgJHtsYWJlbH0gdmFsdWVzYCk7XG4gICAgfVxuICAgIHNlZW4uYWRkKHZhbHVlKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBub3JtYWxpemVIZWFkZXJOYW1lKGhlYWRlck5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBTdHJpbmcoaGVhZGVyTmFtZSA/PyBcIlwiKS50cmltKCk7XG4gIGlmICghdHJpbW1lZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBhdXRob3JpemVySGVhZGVyTmFtZSBpcyByZXF1aXJlZFwiKTtcbiAgfVxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplU3RhZ2VOYW1lKHN0YWdlTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgdHJpbW1lZCA9IFN0cmluZyhzdGFnZU5hbWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogc3RhZ2VOYW1lIGlzIHJlcXVpcmVkXCIpO1xuICB9XG4gIHJldHVybiB0cmltbWVkO1xufVxuXG5mdW5jdGlvbiBidWlsZENvbnRyb2xsZXJFbnZpcm9ubWVudChcbiAgdXNlckVudmlyb25tZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkLFxuICByZXNlcnZlZEVudmlyb25tZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+LFxuKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB7XG4gIGNvbnN0IGVudmlyb25tZW50OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0geyAuLi4odXNlckVudmlyb25tZW50ID8/IHt9KSB9O1xuICBmb3IgKGNvbnN0IGtleSBvZiBSRVNFUlZFRF9FTlZfS0VZUykge1xuICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoZW52aXJvbm1lbnQsIGtleSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IGNvbnRyb2xsZXIuZW52aXJvbm1lbnQgY2Fubm90IG92ZXJyaWRlIHJlc2VydmVkICR7a2V5fWApO1xuICAgIH1cbiAgfVxuICByZXR1cm4geyAuLi5lbnZpcm9ubWVudCwgLi4ucmVzZXJ2ZWRFbnZpcm9ubWVudCB9O1xufVxuXG5mdW5jdGlvbiBzdHJpcFRyYWlsaW5nU2xhc2godXJsOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdXJsLnJlcGxhY2UoL1xcLyQvLCBcIlwiKTtcbn1cbiJdfQ==