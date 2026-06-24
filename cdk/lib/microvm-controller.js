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
const MICROVM_CONTRACT_NAME = "apptheory.lambda_microvm";
const MICROVM_CONTRACT_VERSION = "m15.microvm/v1";
const CONTROLLER_AUTH_REQUIRED = "true";
const CONTROLLER_AUTH_DEFAULT = "deny";
const ENV_CONTRACT_NAME = "APPTHEORY_MICROVM_CONTRACT_NAME";
const ENV_CONTRACT_VERSION = "APPTHEORY_MICROVM_CONTRACT_VERSION";
const ENV_CONTROLLER_ENDPOINT = "APPTHEORY_MICROVM_CONTROLLER_ENDPOINT";
const ENV_CONTROLLER_AUTH_REQUIRED = "APPTHEORY_MICROVM_CONTROLLER_AUTH_REQUIRED";
const ENV_CONTROLLER_AUTH_DEFAULT = "APPTHEORY_MICROVM_CONTROLLER_AUTH_DEFAULT";
const ENV_SESSION_REGISTRY_TABLE = "APPTHEORY_MICROVM_SESSION_REGISTRY_TABLE";
const ENV_IMAGE_REF = "APPTHEORY_MICROVM_IMAGE_REF";
const ENV_NETWORK_CONNECTOR_REFS = "APPTHEORY_MICROVM_NETWORK_CONNECTOR_REFS";
const ENV_EXECUTION_ROLE_ARN = "APPTHEORY_MICROVM_EXECUTION_ROLE_ARN";
const RESERVED_ENV_KEYS = [
    ENV_CONTRACT_NAME,
    ENV_CONTRACT_VERSION,
    ENV_CONTROLLER_ENDPOINT,
    ENV_CONTROLLER_AUTH_REQUIRED,
    ENV_CONTROLLER_AUTH_DEFAULT,
    ENV_SESSION_REGISTRY_TABLE,
    ENV_IMAGE_REF,
    ENV_NETWORK_CONNECTOR_REFS,
    ENV_EXECUTION_ROLE_ARN,
];
/**
 * AppTheory CDK construct for the first-class Lambda MicroVM controller deployment surface.
 *
 * The construct provisions the protected HTTP API routes from the M15 controller contract,
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
        const connectorArns = normalizeConnectorReferences(props.egressNetworkConnectors);
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
        this.controllerFunction = this.createControllerFunction(props, imageArn, connectorArns);
        this.sessionTable.grantReadWriteData(this.controllerFunction);
        this.grantMicrovmControlPlane(props, imageArn, connectorArns);
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
    createControllerFunction(props, imageArn, connectorArns) {
        const controllerProps = props.controller;
        const environment = buildControllerEnvironment(controllerProps.environment, {
            [ENV_CONTRACT_NAME]: MICROVM_CONTRACT_NAME,
            [ENV_CONTRACT_VERSION]: MICROVM_CONTRACT_VERSION,
            [ENV_CONTROLLER_ENDPOINT]: this.endpoint,
            [ENV_CONTROLLER_AUTH_REQUIRED]: CONTROLLER_AUTH_REQUIRED,
            [ENV_CONTROLLER_AUTH_DEFAULT]: CONTROLLER_AUTH_DEFAULT,
            [ENV_SESSION_REGISTRY_TABLE]: this.sessionTable.tableName,
            [ENV_IMAGE_REF]: imageArn,
            [ENV_NETWORK_CONNECTOR_REFS]: connectorArns.join(","),
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
    grantMicrovmControlPlane(props, imageArn, connectorArns) {
        this.controllerFunction.addToRolePolicy(new iam.PolicyStatement({
            sid: "AppTheoryMicrovmControlPlane",
            actions: [
                "lambda:CreateMicrovmAuthToken",
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
            resources: connectorArns,
        }));
        if (props.executionRole) {
            props.executionRole.grantPassRole(this.controllerFunction.grantPrincipal);
        }
    }
    addControllerRoutes() {
        const routes = [
            { id: "CreateMicrovm", method: apigwv2.HttpMethod.POST, path: "/microvms" },
            { id: "StartMicrovm", method: apigwv2.HttpMethod.POST, path: "/microvms/{session_id}/start" },
            { id: "StopMicrovm", method: apigwv2.HttpMethod.POST, path: "/microvms/{session_id}/stop" },
            { id: "StatusMicrovm", method: apigwv2.HttpMethod.GET, path: "/microvms/{session_id}/status" },
            { id: "GetMicrovmSession", method: apigwv2.HttpMethod.GET, path: "/microvms/{session_id}" },
        ];
        for (const route of routes) {
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
AppTheoryMicrovmController[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryMicrovmController", version: "1.15.0" };
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
function normalizeConnectorReferences(connectors) {
    if (!connectors || connectors.length === 0) {
        throw new Error("AppTheoryMicrovmController requires at least 1 egressNetworkConnectors entry");
    }
    if (connectors.length > 10) {
        throw new Error("AppTheoryMicrovmController supports at most 10 egressNetworkConnectors entries");
    }
    const arns = connectors.map((connector, index) => {
        if (connector === undefined || connector === null) {
            throw new Error(`AppTheoryMicrovmController requires props.egressNetworkConnectors[${index}]`);
        }
        return normalizeNoWhitespaceString(connector.networkConnectorArn, `egressNetworkConnectors[${index}].networkConnectorArn`, 2048);
    });
    assertNoDuplicates(arns, "egressNetworkConnectors networkConnectorArn");
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWljcm92bS1jb250cm9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibWljcm92bS1jb250cm9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7Ozs7O0FBQUEsNkNBQTZEO0FBQzdELHdEQUF3RDtBQUN4RCwrRUFBK0U7QUFDL0UsaUZBQWlGO0FBQ2pGLHFEQUFxRDtBQUNyRCwyQ0FBMkM7QUFFM0MsaURBQWlEO0FBQ2pELDZDQUE2QztBQUM3QywyQ0FBdUM7QUFLdkMsTUFBTSxxQkFBcUIsR0FBRywwQkFBMEIsQ0FBQztBQUN6RCxNQUFNLHdCQUF3QixHQUFHLGdCQUFnQixDQUFDO0FBQ2xELE1BQU0sd0JBQXdCLEdBQUcsTUFBTSxDQUFDO0FBQ3hDLE1BQU0sdUJBQXVCLEdBQUcsTUFBTSxDQUFDO0FBRXZDLE1BQU0saUJBQWlCLEdBQUcsaUNBQWlDLENBQUM7QUFDNUQsTUFBTSxvQkFBb0IsR0FBRyxvQ0FBb0MsQ0FBQztBQUNsRSxNQUFNLHVCQUF1QixHQUFHLHVDQUF1QyxDQUFDO0FBQ3hFLE1BQU0sNEJBQTRCLEdBQUcsNENBQTRDLENBQUM7QUFDbEYsTUFBTSwyQkFBMkIsR0FBRywyQ0FBMkMsQ0FBQztBQUNoRixNQUFNLDBCQUEwQixHQUFHLDBDQUEwQyxDQUFDO0FBQzlFLE1BQU0sYUFBYSxHQUFHLDZCQUE2QixDQUFDO0FBQ3BELE1BQU0sMEJBQTBCLEdBQUcsMENBQTBDLENBQUM7QUFDOUUsTUFBTSxzQkFBc0IsR0FBRyxzQ0FBc0MsQ0FBQztBQUV0RSxNQUFNLGlCQUFpQixHQUFHO0lBQ3hCLGlCQUFpQjtJQUNqQixvQkFBb0I7SUFDcEIsdUJBQXVCO0lBQ3ZCLDRCQUE0QjtJQUM1QiwyQkFBMkI7SUFDM0IsMEJBQTBCO0lBQzFCLGFBQWE7SUFDYiwwQkFBMEI7SUFDMUIsc0JBQXNCO0NBQ3ZCLENBQUM7QUFvTUY7Ozs7Ozs7R0FPRztBQUNILE1BQWEsMEJBQTJCLFNBQVEsc0JBQVM7SUFvQ3ZELFlBQVksS0FBZ0Is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LElBQUksS0FBSyxDQUFDLDhEQUE4RCxDQUFDLENBQUM7SUFDbEYsQ0FBQztJQUNELE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFFRCxTQUFTLGtCQUFrQixDQUFDLFNBQWlCO0lBQzNDLE1BQU0sT0FBTyxHQUFHLE1BQU0sQ0FBQyxTQUFTLElBQUksRUFBRSxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDL0MsSUFBSSxDQUFDLE9BQU8sRUFBRSxDQUFDO1FBQ2IsTUFBTSxJQUFJLEtBQUssQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO0lBQ3ZFLENBQUM7SUFDRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQsU0FBUywwQkFBMEIsQ0FDakMsZUFBbUQsRUFDbkQsbUJBQTJDO0lBRTNDLE1BQU0sV0FBVyxHQUEyQixFQUFFLEdBQUcsQ0FBQyxlQUFlLElBQUksRUFBRSxDQUFDLEVBQUUsQ0FBQztJQUMzRSxLQUFLLE1BQU0sR0FBRyxJQUFJLGlCQUFpQixFQUFFLENBQUM7UUFDcEMsSUFBSSxNQUFNLENBQUMsU0FBUyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDM0QsTUFBTSxJQUFJLEtBQUssQ0FBQywrRUFBK0UsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUN4RyxDQUFDO0lBQ0gsQ0FBQztJQUNELE9BQU8sRUFBRSxHQUFHLFdBQVcsRUFBRSxHQUFHLG1CQUFtQixFQUFFLENBQUM7QUFDcEQsQ0FBQztBQUVELFNBQVMsa0JBQWtCLENBQUMsR0FBVztJQUNyQyxPQUFPLEdBQUcsQ0FBQyxPQUFPLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQ2hDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBEdXJhdGlvbiwgUmVtb3ZhbFBvbGljeSwgVG9rZW4gfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJBdXRob3JpemVycyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1hdXRob3JpemVyc1wiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0ICogYXMga21zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3Mta21zXCI7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgdHlwZSB7IElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2UgfSBmcm9tIFwiLi9taWNyb3ZtLWltYWdlXCI7XG5pbXBvcnQgdHlwZSB7IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvciB9IGZyb20gXCIuL21pY3Jvdm0tbmV0d29yay1jb25uZWN0b3JcIjtcblxuY29uc3QgTUlDUk9WTV9DT05UUkFDVF9OQU1FID0gXCJhcHB0aGVvcnkubGFtYmRhX21pY3Jvdm1cIjtcbmNvbnN0IE1JQ1JPVk1fQ09OVFJBQ1RfVkVSU0lPTiA9IFwibTE1Lm1pY3Jvdm0vdjFcIjtcbmNvbnN0IENPTlRST0xMRVJfQVVUSF9SRVFVSVJFRCA9IFwidHJ1ZVwiO1xuY29uc3QgQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQgPSBcImRlbnlcIjtcblxuY29uc3QgRU5WX0NPTlRSQUNUX05BTUUgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRSQUNUX05BTUVcIjtcbmNvbnN0IEVOVl9DT05UUkFDVF9WRVJTSU9OID0gXCJBUFBUSEVPUllfTUlDUk9WTV9DT05UUkFDVF9WRVJTSU9OXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9FTkRQT0lOVCA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9FTkRQT0lOVFwiO1xuY29uc3QgRU5WX0NPTlRST0xMRVJfQVVUSF9SRVFVSVJFRCA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVEXCI7XG5jb25zdCBFTlZfQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQgPSBcIkFQUFRIRU9SWV9NSUNST1ZNX0NPTlRST0xMRVJfQVVUSF9ERUZBVUxUXCI7XG5jb25zdCBFTlZfU0VTU0lPTl9SRUdJU1RSWV9UQUJMRSA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fU0VTU0lPTl9SRUdJU1RSWV9UQUJMRVwiO1xuY29uc3QgRU5WX0lNQUdFX1JFRiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fSU1BR0VfUkVGXCI7XG5jb25zdCBFTlZfTkVUV09SS19DT05ORUNUT1JfUkVGUyA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fTkVUV09SS19DT05ORUNUT1JfUkVGU1wiO1xuY29uc3QgRU5WX0VYRUNVVElPTl9ST0xFX0FSTiA9IFwiQVBQVEhFT1JZX01JQ1JPVk1fRVhFQ1VUSU9OX1JPTEVfQVJOXCI7XG5cbmNvbnN0IFJFU0VSVkVEX0VOVl9LRVlTID0gW1xuICBFTlZfQ09OVFJBQ1RfTkFNRSxcbiAgRU5WX0NPTlRSQUNUX1ZFUlNJT04sXG4gIEVOVl9DT05UUk9MTEVSX0VORFBPSU5ULFxuICBFTlZfQ09OVFJPTExFUl9BVVRIX1JFUVVJUkVELFxuICBFTlZfQ09OVFJPTExFUl9BVVRIX0RFRkFVTFQsXG4gIEVOVl9TRVNTSU9OX1JFR0lTVFJZX1RBQkxFLFxuICBFTlZfSU1BR0VfUkVGLFxuICBFTlZfTkVUV09SS19DT05ORUNUT1JfUkVGUyxcbiAgRU5WX0VYRUNVVElPTl9ST0xFX0FSTixcbl07XG5cbi8qKlxuICogU3RhZ2UgY29uZmlndXJhdGlvbiBmb3IgdGhlIE1pY3JvVk0gY29udHJvbGxlciBIVFRQIEFQSS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucyB7XG4gIC8qKlxuICAgKiBTdGFnZSBuYW1lLlxuICAgKlxuICAgKiBAZGVmYXVsdCBcIiRkZWZhdWx0XCJcbiAgICovXG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogRW5hYmxlIENsb3VkV2F0Y2ggYWNjZXNzIGxvZ2dpbmcgZm9yIHRoZSBzdGFnZS5cbiAgICpcbiAgICogQGRlZmF1bHQgZmFsc2VcbiAgICovXG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBSZXRlbnRpb24gcGVyaW9kIGZvciBhdXRvLWNyZWF0ZWQgYWNjZXNzIGxvZyBncm91cC5cbiAgICogT25seSBhcHBsaWVzIHdoZW4gYWNjZXNzTG9nZ2luZyBpcyB0cnVlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRIXG4gICAqL1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG5cbiAgLyoqXG4gICAqIFRocm90dGxpbmcgcmF0ZSBsaW1pdCAocmVxdWVzdHMgcGVyIHNlY29uZCkgZm9yIHRoZSBzdGFnZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChubyB0aHJvdHRsaW5nKVxuICAgKi9cbiAgcmVhZG9ubHkgdGhyb3R0bGluZ1JhdGVMaW1pdD86IG51bWJlcjtcblxuICAvKipcbiAgICogVGhyb3R0bGluZyBidXJzdCBsaW1pdCBmb3IgdGhlIHN0YWdlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKG5vIHRocm90dGxpbmcpXG4gICAqL1xuICByZWFkb25seSB0aHJvdHRsaW5nQnVyc3RMaW1pdD86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBQYWNrYWdpbmcgYW5kIHJ1bnRpbWUgY29uZmlndXJhdGlvbiBmb3IgdGhlIEFwcFRoZW9yeSBNaWNyb1ZNIGNvbnRyb2xsZXIgTGFtYmRhLlxuICpcbiAqIEFwcFRoZW9yeSBjcmVhdGVzIHRoZSBMYW1iZGEgZnVuY3Rpb24gc28gaXQgY2FuIHdpcmUgdGhlIGNhbm9uaWNhbCBzZXNzaW9uIHRhYmxlLFxuICogTWljcm9WTSBpbWFnZS9uZXR3b3JrIHJlZmVyZW5jZXMsIGFuZCBmYWlsLWNsb3NlZCBhdXRoIGVudmlyb25tZW50IGNvbnNpc3RlbnRseS5cbiAqIFRoZSBjYWxsZXIgc3VwcGxpZXMgb25seSB0aGUgaGFuZGxlciBwYWNrYWdlIGRldGFpbHMgYW5kIGFueSBvcmRpbmFyeSBMYW1iZGFcbiAqIEZ1bmN0aW9uUHJvcHMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJGdW5jdGlvblByb3BzIGV4dGVuZHMgbGFtYmRhLkZ1bmN0aW9uUHJvcHMge31cblxuLyoqXG4gKiBQcm9wcyBmb3IgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyB7XG4gIC8qKlxuICAgKiBDb250cm9sbGVyIExhbWJkYSBwYWNrYWdpbmcgYW5kIGNvbmZpZ3VyYXRpb24uXG4gICAqXG4gICAqIFRoZSBoYW5kbGVyIGNvZGUgbXVzdCB1c2UgQXBwVGhlb3J5J3MgTWljcm9WTSBydW50aW1lL2NvbnRyb2xsZXIgcHJpbWl0aXZlcy5cbiAgICogVGhpcyBjb25zdHJ1Y3QgZG9lcyBub3QgaW1wbGVtZW50IGEgcHJvZHVjdCBjb250cm9sLXBsYW5lIHNlcnZpY2UuXG4gICAqL1xuICByZWFkb25seSBjb250cm9sbGVyOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlckZ1bmN0aW9uUHJvcHM7XG5cbiAgLyoqXG4gICAqIExhbWJkYSByZXF1ZXN0IGF1dGhvcml6ZXIgcmVxdWlyZWQgZm9yIGV2ZXJ5IGNvbnRyb2xsZXIgcm91dGUuXG4gICAqXG4gICAqIFRoZSBjb25zdHJ1Y3QgZmFpbHMgY2xvc2VkIHdoZW4gdGhpcyBpcyBvbWl0dGVkOyB1bmF1dGhlbnRpY2F0ZWQgY29udHJvbGxlciByb3V0ZXNcbiAgICogYXJlIG5vdCBzeW50aGVzaXplZC5cbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXI6IGxhbWJkYS5JRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFRoZSBNaWNyb1ZNIGltYWdlIHRoZSBjb250cm9sbGVyIGlzIHBlcm1pdHRlZCB0byBydW4uXG4gICAqL1xuICByZWFkb25seSBtaWNyb3ZtSW1hZ2U6IElBcHBUaGVvcnlNaWNyb3ZtSW1hZ2U7XG5cbiAgLyoqXG4gICAqIEVncmVzcyBuZXR3b3JrIGNvbm5lY3RvcnMgdGhlIGNvbnRyb2xsZXIgaXMgcGVybWl0dGVkIHRvIHBhc3MgdG8gTGFtYmRhIE1pY3JvVk1zLlxuICAgKlxuICAgKiBBdCBsZWFzdCBvbmUgY29ubmVjdG9yIHJlZmVyZW5jZSBpcyByZXF1aXJlZCBhbmQgbm8gbW9yZSB0aGFuIDEwIG1heSBiZSBzdXBwbGllZC5cbiAgICovXG4gIHJlYWRvbmx5IGVncmVzc05ldHdvcmtDb25uZWN0b3JzOiBJQXBwVGhlb3J5TWljcm92bU5ldHdvcmtDb25uZWN0b3JbXTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgTWljcm9WTSBleGVjdXRpb24gcm9sZSBwYXNzZWQgdG8gUnVuTWljcm92bS5cbiAgICpcbiAgICogV2hlbiBzdXBwbGllZCwgQXBwVGhlb3J5IGdyYW50cyB0aGUgY29udHJvbGxlciBMYW1iZGEgaWFtOlBhc3NSb2xlIGZvciB0aGlzIHJvbGVcbiAgICogYW5kIGV4cG9zZXMgdGhlIEFSTiBhcyBBUFBUSEVPUllfTUlDUk9WTV9FWEVDVVRJT05fUk9MRV9BUk4uXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgZXhlY3V0aW9uUm9sZT86IGlhbS5JUm9sZTtcblxuICAvKipcbiAgICogT3B0aW9uYWwgQVBJIG5hbWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcblxuICAvKipcbiAgICogT3B0aW9uYWwgc3RhZ2UgY29uZmlndXJhdGlvbi5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkIChkZWZhdWx0IEhUVFAgQVBJIHN0YWdlKVxuICAgKi9cbiAgcmVhZG9ubHkgc3RhZ2U/OiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclN0YWdlT3B0aW9ucztcblxuICAvKipcbiAgICogTmFtZSBmb3IgdGhlIGR1cmFibGUgTWljcm9WTSBzZXNzaW9uIHJlZ2lzdHJ5IER5bmFtb0RCIHRhYmxlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKENsb3VkRm9ybWF0aW9uLWdlbmVyYXRlZClcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZU5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIEJpbGxpbmcgbW9kZSBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IFBBWV9QRVJfUkVRVUVTVFxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlQmlsbGluZ01vZGU/OiBkeW5hbW9kYi5CaWxsaW5nTW9kZTtcblxuICAvKipcbiAgICogUmVtb3ZhbCBwb2xpY3kgZm9yIHRoZSBzZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlLlxuICAgKlxuICAgKiBAZGVmYXVsdCBSZW1vdmFsUG9saWN5LlJFVEFJTlxuICAgKi9cbiAgcmVhZG9ubHkgc2Vzc2lvblRhYmxlUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG5cbiAgLyoqXG4gICAqIFdoZXRoZXIgZGVsZXRpb24gcHJvdGVjdGlvbiBzaG91bGQgYmUgZW5hYmxlZCBmb3IgdGhlIHNlc3Npb24gcmVnaXN0cnkgdGFibGUuXG4gICAqXG4gICAqIEBkZWZhdWx0IC0gQVdTIGRlZmF1bHQgKG5vIGRlbGV0aW9uIHByb3RlY3Rpb24pXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVEZWxldGlvblByb3RlY3Rpb24/OiBib29sZWFuO1xuXG4gIC8qKlxuICAgKiBXaGV0aGVyIHBvaW50LWluLXRpbWUgcmVjb3Zlcnkgc2hvdWxkIGJlIGVuYWJsZWQgZm9yIHRoZSBzZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB0cnVlXG4gICAqL1xuICByZWFkb25seSBlbmFibGVTZXNzaW9uVGFibGVQb2ludEluVGltZVJlY292ZXJ5PzogYm9vbGVhbjtcblxuICAvKipcbiAgICogU2Vzc2lvbiByZWdpc3RyeSB0YWJsZSBlbmNyeXB0aW9uIHNldHRpbmcuXG4gICAqXG4gICAqIEBkZWZhdWx0IEFXU19NQU5BR0VEXG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVFbmNyeXB0aW9uPzogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uO1xuXG4gIC8qKlxuICAgKiBDdXN0b21lci1tYW5hZ2VkIEtNUyBrZXkgZm9yIHRoZSBzZXNzaW9uIHJlZ2lzdHJ5IHRhYmxlLlxuICAgKlxuICAgKiBSZXF1aXJlZCB3aGVuIHNlc3Npb25UYWJsZUVuY3J5cHRpb24gaXMgQ1VTVE9NRVJfTUFOQUdFRC5cbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXk/OiBrbXMuSUtleTtcblxuICAvKipcbiAgICogUHJvdmlzaW9uZWQgcmVhZCBjYXBhY2l0eSB3aGVuIHNlc3Npb25UYWJsZUJpbGxpbmdNb2RlIGlzIFBST1ZJU0lPTkVELlxuICAgKlxuICAgKiBAZGVmYXVsdCA1XG4gICAqL1xuICByZWFkb25seSBzZXNzaW9uVGFibGVSZWFkQ2FwYWNpdHk/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIFByb3Zpc2lvbmVkIHdyaXRlIGNhcGFjaXR5IHdoZW4gc2Vzc2lvblRhYmxlQmlsbGluZ01vZGUgaXMgUFJPVklTSU9ORUQuXG4gICAqXG4gICAqIEBkZWZhdWx0IDVcbiAgICovXG4gIHJlYWRvbmx5IHNlc3Npb25UYWJsZVdyaXRlQ2FwYWNpdHk/OiBudW1iZXI7XG5cbiAgLyoqXG4gICAqIEhlYWRlciB1c2VkIGFzIHRoZSBpZGVudGl0eSBzb3VyY2UgZm9yIGNvbnRyb2xsZXIgYXV0aG9yaXphdGlvbi5cbiAgICpcbiAgICogQGRlZmF1bHQgXCJBdXRob3JpemF0aW9uXCJcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJIZWFkZXJOYW1lPzogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBGcmllbmRseSBhdXRob3JpemVyIG5hbWUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgYXV0aG9yaXplck5hbWU/OiBzdHJpbmc7XG5cbiAgLyoqXG4gICAqIExhbWJkYSBhdXRob3JpemVyIHJlc3VsdCBjYWNoZSBUVEwuXG4gICAqXG4gICAqIERlZmF1bHRzIHRvIGRpc2FibGVkIHNvIHN0YWxlIGF1dGggY2Fubm90IHNpbGVudGx5IGJyb2FkZW4gY29udHJvbGxlciBhY2Nlc3MuXG4gICAqXG4gICAqIEBkZWZhdWx0IER1cmF0aW9uLnNlY29uZHMoMClcbiAgICovXG4gIHJlYWRvbmx5IGF1dGhvcml6ZXJDYWNoZVR0bD86IER1cmF0aW9uO1xufVxuXG4vKipcbiAqIEFwcFRoZW9yeSBDREsgY29uc3RydWN0IGZvciB0aGUgZmlyc3QtY2xhc3MgTGFtYmRhIE1pY3JvVk0gY29udHJvbGxlciBkZXBsb3ltZW50IHN1cmZhY2UuXG4gKlxuICogVGhlIGNvbnN0cnVjdCBwcm92aXNpb25zIHRoZSBwcm90ZWN0ZWQgSFRUUCBBUEkgcm91dGVzIGZyb20gdGhlIE0xNSBjb250cm9sbGVyIGNvbnRyYWN0LFxuICogdGhlIGNvbnRyb2xsZXIgTGFtYmRhLCB0aGUgY2Fub25pY2FsIGR1cmFibGUgc2Vzc2lvbiByZWdpc3RyeSB0YWJsZSwgSUFNIGdyYW50cywgYW5kXG4gKiBmYWlsLWNsb3NlZCBhdXRoIGVudmlyb25tZW50IHdpcmluZy4gUnVudGltZSBjb21tYW5kIGhhbmRsaW5nIHJlbWFpbnMgaW4gdGhlIEFwcFRoZW9yeVxuICogcnVudGltZSBjb250cmFjdDsgdGhpcyBjb25zdHJ1Y3Qgb25seSB3aXJlcyB0aGUgZGVwbG95bWVudCBwYXRoLlxuICovXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICAvKipcbiAgICogVGhlIHVuZGVybHlpbmcgSFRUUCBBUEkgR2F0ZXdheSB2MiBBUEkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLkh0dHBBcGk7XG5cbiAgLyoqXG4gICAqIFRoZSBBUEkgR2F0ZXdheSBzdGFnZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3d2Mi5JU3RhZ2U7XG5cbiAgLyoqXG4gICAqIExhbWJkYSByZXF1ZXN0IGF1dGhvcml6ZXIgYXR0YWNoZWQgdG8gZXZlcnkgY29udHJvbGxlciByb3V0ZS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSByb3V0ZUF1dGhvcml6ZXI6IGFwaWd3djJBdXRob3JpemVycy5IdHRwTGFtYmRhQXV0aG9yaXplcjtcblxuICAvKipcbiAgICogVGhlIGNvbnRyb2xsZXIgTGFtYmRhIGZ1bmN0aW9uIGNyZWF0ZWQgYnkgdGhpcyBjb25zdHJ1Y3QuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgY29udHJvbGxlckZ1bmN0aW9uOiBsYW1iZGEuRnVuY3Rpb247XG5cbiAgLyoqXG4gICAqIFRoZSBkdXJhYmxlIFRhYmxlVGhlb3J5LXNoYXBlZCBzZXNzaW9uIHJlZ2lzdHJ5IER5bmFtb0RCIHRhYmxlLlxuICAgKi9cbiAgcHVibGljIHJlYWRvbmx5IHNlc3Npb25UYWJsZTogZHluYW1vZGIuVGFibGU7XG5cbiAgLyoqXG4gICAqIFRoZSBjb250cm9sbGVyIGJhc2UgZW5kcG9pbnQgKGAvbWljcm92bXNgKS5cbiAgICovXG4gIHB1YmxpYyByZWFkb25seSBlbmRwb2ludDogc3RyaW5nO1xuXG4gIC8qKlxuICAgKiBUaGUgYWNjZXNzIGxvZyBncm91cCAoaWYgYWNjZXNzIGxvZ2dpbmcgaXMgZW5hYmxlZCkuXG4gICAqL1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBpZiAocHJvcHMgPT09IHVuZGVmaW5lZCB8fCBwcm9wcyA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHNcIik7XG4gICAgfVxuICAgIHZhbGlkYXRlUmVxdWlyZWQocHJvcHMuY29udHJvbGxlciwgXCJjb250cm9sbGVyXCIpO1xuICAgIHZhbGlkYXRlUmVxdWlyZWQocHJvcHMuYXV0aG9yaXplciwgXCJhdXRob3JpemVyXCIpO1xuICAgIHZhbGlkYXRlUmVxdWlyZWQocHJvcHMubWljcm92bUltYWdlLCBcIm1pY3Jvdm1JbWFnZVwiKTtcblxuICAgIGNvbnN0IGltYWdlQXJuID0gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHByb3BzLm1pY3Jvdm1JbWFnZS5taWNyb3ZtSW1hZ2VBcm4sIFwibWljcm92bUltYWdlLm1pY3Jvdm1JbWFnZUFyblwiLCAyMDQ4KTtcbiAgICBjb25zdCBjb25uZWN0b3JBcm5zID0gbm9ybWFsaXplQ29ubmVjdG9yUmVmZXJlbmNlcyhwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyk7XG4gICAgY29uc3QgYXV0aG9yaXplckhlYWRlck5hbWUgPSBub3JtYWxpemVIZWFkZXJOYW1lKHByb3BzLmF1dGhvcml6ZXJIZWFkZXJOYW1lID8/IFwiQXV0aG9yaXphdGlvblwiKTtcbiAgICBjb25zdCBzdGFnZU9wdHMgPSBwcm9wcy5zdGFnZSA/PyB7fTtcbiAgICBjb25zdCBzdGFnZU5hbWUgPSBub3JtYWxpemVTdGFnZU5hbWUoc3RhZ2VPcHRzLnN0YWdlTmFtZSA/PyBcIiRkZWZhdWx0XCIpO1xuXG4gICAgdGhpcy5zZXNzaW9uVGFibGUgPSB0aGlzLmNyZWF0ZVNlc3Npb25UYWJsZShwcm9wcyk7XG5cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnd3YyLkh0dHBBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgYXBpTmFtZTogcHJvcHMuYXBpTmFtZSxcbiAgICAgIGNyZWF0ZURlZmF1bHRTdGFnZTogIW5lZWRzRXhwbGljaXRTdGFnZShzdGFnZU9wdHMsIHN0YWdlTmFtZSksXG4gICAgfSk7XG5cbiAgICBjb25zdCBzdGFnZSA9IHRoaXMuY3JlYXRlU3RhZ2Uoc3RhZ2VPcHRzLCBzdGFnZU5hbWUpO1xuICAgIGlmICghc3RhZ2UpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBmYWlsZWQgdG8gY3JlYXRlIEFQSSBzdGFnZVwiKTtcbiAgICB9XG4gICAgdGhpcy5zdGFnZSA9IHN0YWdlO1xuXG4gICAgdGhpcy5lbmRwb2ludCA9IHN0YWdlTmFtZSA9PT0gXCIkZGVmYXVsdFwiXG4gICAgICA/IGAke3N0cmlwVHJhaWxpbmdTbGFzaCh0aGlzLmFwaS5hcGlFbmRwb2ludCl9L21pY3Jvdm1zYFxuICAgICAgOiBgJHtzdHJpcFRyYWlsaW5nU2xhc2godGhpcy5hcGkuYXBpRW5kcG9pbnQpfS8ke3N0YWdlTmFtZX0vbWljcm92bXNgO1xuXG4gICAgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24gPSB0aGlzLmNyZWF0ZUNvbnRyb2xsZXJGdW5jdGlvbihwcm9wcywgaW1hZ2VBcm4sIGNvbm5lY3RvckFybnMpO1xuICAgIHRoaXMuc2Vzc2lvblRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YSh0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbik7XG4gICAgdGhpcy5ncmFudE1pY3Jvdm1Db250cm9sUGxhbmUocHJvcHMsIGltYWdlQXJuLCBjb25uZWN0b3JBcm5zKTtcblxuICAgIHRoaXMucm91dGVBdXRob3JpemVyID0gbmV3IGFwaWd3djJBdXRob3JpemVycy5IdHRwTGFtYmRhQXV0aG9yaXplcihcIkF1dGhvcml6ZXJcIiwgcHJvcHMuYXV0aG9yaXplciwge1xuICAgICAgYXV0aG9yaXplck5hbWU6IHByb3BzLmF1dGhvcml6ZXJOYW1lLFxuICAgICAgaWRlbnRpdHlTb3VyY2U6IFtgJHJlcXVlc3QuaGVhZGVyLiR7YXV0aG9yaXplckhlYWRlck5hbWV9YF0sXG4gICAgICByZXN1bHRzQ2FjaGVUdGw6IHByb3BzLmF1dGhvcml6ZXJDYWNoZVR0bCA/PyBEdXJhdGlvbi5zZWNvbmRzKDApLFxuICAgICAgcmVzcG9uc2VUeXBlczogW2FwaWd3djJBdXRob3JpemVycy5IdHRwTGFtYmRhUmVzcG9uc2VUeXBlLlNJTVBMRV0sXG4gICAgfSk7XG5cbiAgICB0aGlzLmFkZENvbnRyb2xsZXJSb3V0ZXMoKTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlU2Vzc2lvblRhYmxlKHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzKTogZHluYW1vZGIuVGFibGUge1xuICAgIGNvbnN0IGJpbGxpbmdNb2RlID0gcHJvcHMuc2Vzc2lvblRhYmxlQmlsbGluZ01vZGUgPz8gZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNUO1xuICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5zZXNzaW9uVGFibGVSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgIGNvbnN0IGVuY3J5cHRpb24gPSBwcm9wcy5zZXNzaW9uVGFibGVFbmNyeXB0aW9uID8/IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRDtcbiAgICBjb25zdCBlbmFibGVQSVRSID0gcHJvcHMuZW5hYmxlU2Vzc2lvblRhYmxlUG9pbnRJblRpbWVSZWNvdmVyeSA/PyB0cnVlO1xuXG4gICAgaWYgKGVuY3J5cHRpb24gPT09IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5DVVNUT01FUl9NQU5BR0VEICYmICFwcm9wcy5zZXNzaW9uVGFibGVFbmNyeXB0aW9uS2V5KSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgc2Vzc2lvblRhYmxlRW5jcnlwdGlvbktleSB3aGVuIHNlc3Npb25UYWJsZUVuY3J5cHRpb24gaXMgQ1VTVE9NRVJfTUFOQUdFRFwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBjb25zdCB0YWJsZU5hbWUgPSBwcm9wcy5zZXNzaW9uVGFibGVOYW1lID09PSB1bmRlZmluZWRcbiAgICAgID8gdW5kZWZpbmVkXG4gICAgICA6IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHByb3BzLnNlc3Npb25UYWJsZU5hbWUsIFwic2Vzc2lvblRhYmxlTmFtZVwiKTtcblxuICAgIHJldHVybiBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJTZXNzaW9uVGFibGVcIiwge1xuICAgICAgdGFibGVOYW1lLFxuICAgICAgYmlsbGluZ01vZGUsXG4gICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogXCJwa1wiLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgc29ydEtleTogeyBuYW1lOiBcInNrXCIsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiBcInR0bFwiLFxuICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgIGRlbGV0aW9uUHJvdGVjdGlvbjogcHJvcHMuc2Vzc2lvblRhYmxlRGVsZXRpb25Qcm90ZWN0aW9uLFxuICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IGVuYWJsZVBJVFIsXG4gICAgICB9LFxuICAgICAgZW5jcnlwdGlvbixcbiAgICAgIGVuY3J5cHRpb25LZXk6IHByb3BzLnNlc3Npb25UYWJsZUVuY3J5cHRpb25LZXksXG4gICAgICAuLi4oYmlsbGluZ01vZGUgPT09IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBST1ZJU0lPTkVEXG4gICAgICAgID8ge1xuICAgICAgICAgICAgcmVhZENhcGFjaXR5OiBwcm9wcy5zZXNzaW9uVGFibGVSZWFkQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICAgIHdyaXRlQ2FwYWNpdHk6IHByb3BzLnNlc3Npb25UYWJsZVdyaXRlQ2FwYWNpdHkgPz8gNSxcbiAgICAgICAgICB9XG4gICAgICAgIDoge30pLFxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVTdGFnZShcbiAgICBzdGFnZU9wdHM6IEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyU3RhZ2VPcHRpb25zLFxuICAgIHN0YWdlTmFtZTogc3RyaW5nLFxuICApOiBhcGlnd3YyLklTdGFnZSB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKCFuZWVkc0V4cGxpY2l0U3RhZ2Uoc3RhZ2VPcHRzLCBzdGFnZU5hbWUpKSB7XG4gICAgICByZXR1cm4gdGhpcy5hcGkuZGVmYXVsdFN0YWdlO1xuICAgIH1cblxuICAgIGNvbnN0IHN0YWdlID0gbmV3IGFwaWd3djIuSHR0cFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgaHR0cEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZU5hbWUsXG4gICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgdGhyb3R0bGU6IChzdGFnZU9wdHMudGhyb3R0bGluZ1JhdGVMaW1pdCAhPT0gdW5kZWZpbmVkIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkKVxuICAgICAgICA/IHtcbiAgICAgICAgICAgIHJhdGVMaW1pdDogc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQsXG4gICAgICAgICAgICBidXJzdExpbWl0OiBzdGFnZU9wdHMudGhyb3R0bGluZ0J1cnN0TGltaXQsXG4gICAgICAgICAgfVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICB9KTtcblxuICAgIGlmIChzdGFnZU9wdHMuYWNjZXNzTG9nZ2luZykge1xuICAgICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIiwge1xuICAgICAgICByZXRlbnRpb246IHN0YWdlT3B0cy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCxcbiAgICAgIH0pO1xuICAgICAgKHRoaXMgYXMgeyBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwIH0pLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICAgIGNvbnN0IGNmblN0YWdlID0gc3RhZ2Uubm9kZS5kZWZhdWx0Q2hpbGQgYXMgYXBpZ3d2Mi5DZm5TdGFnZTtcbiAgICAgIGNmblN0YWdlLmFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICBkZXN0aW5hdGlvbkFybjogbG9nR3JvdXAubG9nR3JvdXBBcm4sXG4gICAgICAgIGZvcm1hdDogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIHJlcXVlc3RJZDogXCIkY29udGV4dC5yZXF1ZXN0SWRcIixcbiAgICAgICAgICBpcDogXCIkY29udGV4dC5pZGVudGl0eS5zb3VyY2VJcFwiLFxuICAgICAgICAgIHJlcXVlc3RUaW1lOiBcIiRjb250ZXh0LnJlcXVlc3RUaW1lXCIsXG4gICAgICAgICAgaHR0cE1ldGhvZDogXCIkY29udGV4dC5odHRwTWV0aG9kXCIsXG4gICAgICAgICAgcm91dGVLZXk6IFwiJGNvbnRleHQucm91dGVLZXlcIixcbiAgICAgICAgICBzdGF0dXM6IFwiJGNvbnRleHQuc3RhdHVzXCIsXG4gICAgICAgICAgcHJvdG9jb2w6IFwiJGNvbnRleHQucHJvdG9jb2xcIixcbiAgICAgICAgICByZXNwb25zZUxlbmd0aDogXCIkY29udGV4dC5yZXNwb25zZUxlbmd0aFwiLFxuICAgICAgICAgIGludGVncmF0aW9uTGF0ZW5jeTogXCIkY29udGV4dC5pbnRlZ3JhdGlvbkxhdGVuY3lcIixcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIHJldHVybiBzdGFnZTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQ29udHJvbGxlckZ1bmN0aW9uKFxuICAgIHByb3BzOiBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlclByb3BzLFxuICAgIGltYWdlQXJuOiBzdHJpbmcsXG4gICAgY29ubmVjdG9yQXJuczogc3RyaW5nW10sXG4gICk6IGxhbWJkYS5GdW5jdGlvbiB7XG4gICAgY29uc3QgY29udHJvbGxlclByb3BzID0gcHJvcHMuY29udHJvbGxlcjtcbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IGJ1aWxkQ29udHJvbGxlckVudmlyb25tZW50KFxuICAgICAgY29udHJvbGxlclByb3BzLmVudmlyb25tZW50LFxuICAgICAge1xuICAgICAgICBbRU5WX0NPTlRSQUNUX05BTUVdOiBNSUNST1ZNX0NPTlRSQUNUX05BTUUsXG4gICAgICAgIFtFTlZfQ09OVFJBQ1RfVkVSU0lPTl06IE1JQ1JPVk1fQ09OVFJBQ1RfVkVSU0lPTixcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX0VORFBPSU5UXTogdGhpcy5lbmRwb2ludCxcbiAgICAgICAgW0VOVl9DT05UUk9MTEVSX0FVVEhfUkVRVUlSRURdOiBDT05UUk9MTEVSX0FVVEhfUkVRVUlSRUQsXG4gICAgICAgIFtFTlZfQ09OVFJPTExFUl9BVVRIX0RFRkFVTFRdOiBDT05UUk9MTEVSX0FVVEhfREVGQVVMVCxcbiAgICAgICAgW0VOVl9TRVNTSU9OX1JFR0lTVFJZX1RBQkxFXTogdGhpcy5zZXNzaW9uVGFibGUudGFibGVOYW1lLFxuICAgICAgICBbRU5WX0lNQUdFX1JFRl06IGltYWdlQXJuLFxuICAgICAgICBbRU5WX05FVFdPUktfQ09OTkVDVE9SX1JFRlNdOiBjb25uZWN0b3JBcm5zLmpvaW4oXCIsXCIpLFxuICAgICAgICAuLi4ocHJvcHMuZXhlY3V0aW9uUm9sZSA/IHsgW0VOVl9FWEVDVVRJT05fUk9MRV9BUk5dOiBwcm9wcy5leGVjdXRpb25Sb2xlLnJvbGVBcm4gfSA6IHt9KSxcbiAgICAgIH0sXG4gICAgKTtcblxuICAgIHJldHVybiBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsIFwiQ29udHJvbGxlckZ1bmN0aW9uXCIsIHtcbiAgICAgIGFyY2hpdGVjdHVyZTogY29udHJvbGxlclByb3BzLmFyY2hpdGVjdHVyZSA/PyBsYW1iZGEuQXJjaGl0ZWN0dXJlLkFSTV82NCxcbiAgICAgIHRyYWNpbmc6IGNvbnRyb2xsZXJQcm9wcy50cmFjaW5nID8/IGxhbWJkYS5UcmFjaW5nLkFDVElWRSxcbiAgICAgIG1lbW9yeVNpemU6IGNvbnRyb2xsZXJQcm9wcy5tZW1vcnlTaXplID8/IDUxMixcbiAgICAgIHRpbWVvdXQ6IGNvbnRyb2xsZXJQcm9wcy50aW1lb3V0ID8/IER1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgLi4uY29udHJvbGxlclByb3BzLFxuICAgICAgZW52aXJvbm1lbnQsXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGdyYW50TWljcm92bUNvbnRyb2xQbGFuZShcbiAgICBwcm9wczogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJQcm9wcyxcbiAgICBpbWFnZUFybjogc3RyaW5nLFxuICAgIGNvbm5lY3RvckFybnM6IHN0cmluZ1tdLFxuICApOiB2b2lkIHtcbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbFBsYW5lXCIsXG4gICAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgICBcImxhbWJkYTpDcmVhdGVNaWNyb3ZtQXV0aFRva2VuXCIsXG4gICAgICAgICAgXCJsYW1iZGE6R2V0TWljcm92bVwiLFxuICAgICAgICAgIFwibGFtYmRhOlJlc3VtZU1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpSdW5NaWNyb3ZtXCIsXG4gICAgICAgICAgXCJsYW1iZGE6U3VzcGVuZE1pY3Jvdm1cIixcbiAgICAgICAgICBcImxhbWJkYTpUZXJtaW5hdGVNaWNyb3ZtXCIsXG4gICAgICAgIF0sXG4gICAgICAgIHJlc291cmNlczogW2ltYWdlQXJuXSxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3koXG4gICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgIHNpZDogXCJBcHBUaGVvcnlNaWNyb3ZtTGlzdFwiLFxuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6TGlzdE1pY3Jvdm1zXCJdLFxuICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICB9KSxcbiAgICApO1xuXG4gICAgdGhpcy5jb250cm9sbGVyRnVuY3Rpb24uYWRkVG9Sb2xlUG9saWN5KFxuICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICBzaWQ6IFwiQXBwVGhlb3J5TWljcm92bVBhc3NOZXR3b3JrQ29ubmVjdG9yc1wiLFxuICAgICAgICBhY3Rpb25zOiBbXCJsYW1iZGE6UGFzc05ldHdvcmtDb25uZWN0b3JcIl0sXG4gICAgICAgIHJlc291cmNlczogY29ubmVjdG9yQXJucyxcbiAgICAgIH0pLFxuICAgICk7XG5cbiAgICBpZiAocHJvcHMuZXhlY3V0aW9uUm9sZSkge1xuICAgICAgcHJvcHMuZXhlY3V0aW9uUm9sZS5ncmFudFBhc3NSb2xlKHRoaXMuY29udHJvbGxlckZ1bmN0aW9uLmdyYW50UHJpbmNpcGFsKTtcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIGFkZENvbnRyb2xsZXJSb3V0ZXMoKTogdm9pZCB7XG4gICAgY29uc3Qgcm91dGVzOiBBcnJheTx7IGlkOiBzdHJpbmc7IG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kOyBwYXRoOiBzdHJpbmcgfT4gPSBbXG4gICAgICB7IGlkOiBcIkNyZWF0ZU1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogXCIvbWljcm92bXNcIiB9LFxuICAgICAgeyBpZDogXCJTdGFydE1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L3N0YXJ0XCIgfSxcbiAgICAgIHsgaWQ6IFwiU3RvcE1pY3Jvdm1cIiwgbWV0aG9kOiBhcGlnd3YyLkh0dHBNZXRob2QuUE9TVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L3N0b3BcIiB9LFxuICAgICAgeyBpZDogXCJTdGF0dXNNaWNyb3ZtXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9L3N0YXR1c1wiIH0sXG4gICAgICB7IGlkOiBcIkdldE1pY3Jvdm1TZXNzaW9uXCIsIG1ldGhvZDogYXBpZ3d2Mi5IdHRwTWV0aG9kLkdFVCwgcGF0aDogXCIvbWljcm92bXMve3Nlc3Npb25faWR9XCIgfSxcbiAgICBdO1xuXG4gICAgZm9yIChjb25zdCByb3V0ZSBvZiByb3V0ZXMpIHtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlcyh7XG4gICAgICAgIHBhdGg6IHJvdXRlLnBhdGgsXG4gICAgICAgIG1ldGhvZHM6IFtyb3V0ZS5tZXRob2RdLFxuICAgICAgICBpbnRlZ3JhdGlvbjogbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuSHR0cExhbWJkYUludGVncmF0aW9uKHJvdXRlLmlkLCB0aGlzLmNvbnRyb2xsZXJGdW5jdGlvbiwge1xuICAgICAgICAgIHBheWxvYWRGb3JtYXRWZXJzaW9uOiBhcGlnd3YyLlBheWxvYWRGb3JtYXRWZXJzaW9uLlZFUlNJT05fMl8wLFxuICAgICAgICB9KSxcbiAgICAgICAgYXV0aG9yaXplcjogdGhpcy5yb3V0ZUF1dGhvcml6ZXIsXG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gbmVlZHNFeHBsaWNpdFN0YWdlKHN0YWdlT3B0czogQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXJTdGFnZU9wdGlvbnMsIHN0YWdlTmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBzdGFnZU5hbWUgIT09IFwiJGRlZmF1bHRcIlxuICAgIHx8IHN0YWdlT3B0cy5hY2Nlc3NMb2dnaW5nID09PSB0cnVlXG4gICAgfHwgc3RhZ2VPcHRzLnRocm90dGxpbmdSYXRlTGltaXQgIT09IHVuZGVmaW5lZFxuICAgIHx8IHN0YWdlT3B0cy50aHJvdHRsaW5nQnVyc3RMaW1pdCAhPT0gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZVJlcXVpcmVkKHZhbHVlOiB1bmtub3duLCBwcm9wTmFtZTogc3RyaW5nKTogdm9pZCB7XG4gIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlID09PSBudWxsKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy4ke3Byb3BOYW1lfWApO1xuICB9XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCB8fCB2YWx1ZSA9PT0gbnVsbCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkID0gU3RyaW5nKHZhbHVlKS50cmltKCk7XG4gIGlmICghbm9ybWFsaXplZCkge1xuICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgcmVxdWlyZXMgcHJvcHMuJHtwcm9wTmFtZX1gKTtcbiAgfVxuICByZXR1cm4gbm9ybWFsaXplZDtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplTm9XaGl0ZXNwYWNlU3RyaW5nKHZhbHVlOiBzdHJpbmcgfCB1bmRlZmluZWQsIHByb3BOYW1lOiBzdHJpbmcsIG1heExlbmd0aDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IG5vcm1hbGl6ZVJlcXVpcmVkU3RyaW5nKHZhbHVlLCBwcm9wTmFtZSk7XG4gIGlmICghVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSAmJiAvXFxzLy50ZXN0KG5vcm1hbGl6ZWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogJHtwcm9wTmFtZX0gbXVzdCBub3QgY29udGFpbiB3aGl0ZXNwYWNlYCk7XG4gIH1cbiAgaWYgKCFUb2tlbi5pc1VucmVzb2x2ZWQodmFsdWUpICYmIG5vcm1hbGl6ZWQubGVuZ3RoID4gbWF4TGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogJHtwcm9wTmFtZX0gbXVzdCBiZSBhdCBtb3N0ICR7bWF4TGVuZ3RofSBjaGFyYWN0ZXJzYCk7XG4gIH1cbiAgcmV0dXJuIG5vcm1hbGl6ZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZUNvbm5lY3RvclJlZmVyZW5jZXMoXG4gIGNvbm5lY3RvcnM6IHJlYWRvbmx5IElBcHBUaGVvcnlNaWNyb3ZtTmV0d29ya0Nvbm5lY3RvcltdIHwgdW5kZWZpbmVkLFxuKTogc3RyaW5nW10ge1xuICBpZiAoIWNvbm5lY3RvcnMgfHwgY29ubmVjdG9ycy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBhdCBsZWFzdCAxIGVncmVzc05ldHdvcmtDb25uZWN0b3JzIGVudHJ5XCIpO1xuICB9XG4gIGlmIChjb25uZWN0b3JzLmxlbmd0aCA+IDEwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgc3VwcG9ydHMgYXQgbW9zdCAxMCBlZ3Jlc3NOZXR3b3JrQ29ubmVjdG9ycyBlbnRyaWVzXCIpO1xuICB9XG5cbiAgY29uc3QgYXJucyA9IGNvbm5lY3RvcnMubWFwKChjb25uZWN0b3IsIGluZGV4KSA9PiB7XG4gICAgaWYgKGNvbm5lY3RvciA9PT0gdW5kZWZpbmVkIHx8IGNvbm5lY3RvciA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlciByZXF1aXJlcyBwcm9wcy5lZ3Jlc3NOZXR3b3JrQ29ubmVjdG9yc1ske2luZGV4fV1gKTtcbiAgICB9XG4gICAgcmV0dXJuIG5vcm1hbGl6ZU5vV2hpdGVzcGFjZVN0cmluZyhcbiAgICAgIGNvbm5lY3Rvci5uZXR3b3JrQ29ubmVjdG9yQXJuLFxuICAgICAgYGVncmVzc05ldHdvcmtDb25uZWN0b3JzWyR7aW5kZXh9XS5uZXR3b3JrQ29ubmVjdG9yQXJuYCxcbiAgICAgIDIwNDgsXG4gICAgKTtcbiAgfSk7XG5cbiAgYXNzZXJ0Tm9EdXBsaWNhdGVzKGFybnMsIFwiZWdyZXNzTmV0d29ya0Nvbm5lY3RvcnMgbmV0d29ya0Nvbm5lY3RvckFyblwiKTtcbiAgcmV0dXJuIGFybnM7XG59XG5cbmZ1bmN0aW9uIGFzc2VydE5vRHVwbGljYXRlcyh2YWx1ZXM6IHJlYWRvbmx5IHN0cmluZ1tdLCBsYWJlbDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCB2YWx1ZSBvZiB2YWx1ZXMpIHtcbiAgICBpZiAoVG9rZW4uaXNVbnJlc29sdmVkKHZhbHVlKSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChzZWVuLmhhcyh2YWx1ZSkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXIgZG9lcyBub3QgYWxsb3cgZHVwbGljYXRlICR7bGFiZWx9IHZhbHVlc2ApO1xuICAgIH1cbiAgICBzZWVuLmFkZCh2YWx1ZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplSGVhZGVyTmFtZShoZWFkZXJOYW1lOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCB0cmltbWVkID0gU3RyaW5nKGhlYWRlck5hbWUgPz8gXCJcIikudHJpbSgpO1xuICBpZiAoIXRyaW1tZWQpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlNaWNyb3ZtQ29udHJvbGxlcjogYXV0aG9yaXplckhlYWRlck5hbWUgaXMgcmVxdWlyZWRcIik7XG4gIH1cbiAgcmV0dXJuIHRyaW1tZWQ7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVN0YWdlTmFtZShzdGFnZU5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIGNvbnN0IHRyaW1tZWQgPSBTdHJpbmcoc3RhZ2VOYW1lID8/IFwiXCIpLnRyaW0oKTtcbiAgaWYgKCF0cmltbWVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5TWljcm92bUNvbnRyb2xsZXI6IHN0YWdlTmFtZSBpcyByZXF1aXJlZFwiKTtcbiAgfVxuICByZXR1cm4gdHJpbW1lZDtcbn1cblxuZnVuY3Rpb24gYnVpbGRDb250cm9sbGVyRW52aXJvbm1lbnQoXG4gIHVzZXJFbnZpcm9ubWVudDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZCxcbiAgcmVzZXJ2ZWRFbnZpcm9ubWVudDogUmVjb3JkPHN0cmluZywgc3RyaW5nPixcbik6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4ge1xuICBjb25zdCBlbnZpcm9ubWVudDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHsgLi4uKHVzZXJFbnZpcm9ubWVudCA/PyB7fSkgfTtcbiAgZm9yIChjb25zdCBrZXkgb2YgUkVTRVJWRURfRU5WX0tFWVMpIHtcbiAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGVudmlyb25tZW50LCBrZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYEFwcFRoZW9yeU1pY3Jvdm1Db250cm9sbGVyOiBjb250cm9sbGVyLmVudmlyb25tZW50IGNhbm5vdCBvdmVycmlkZSByZXNlcnZlZCAke2tleX1gKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHsgLi4uZW52aXJvbm1lbnQsIC4uLnJlc2VydmVkRW52aXJvbm1lbnQgfTtcbn1cblxuZnVuY3Rpb24gc3RyaXBUcmFpbGluZ1NsYXNoKHVybDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHVybC5yZXBsYWNlKC9cXC8kLywgXCJcIik7XG59XG4iXX0=