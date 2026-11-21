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
exports.AppTheoryWebSocketApi = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigateway = __importStar(require("aws-cdk-lib/aws-apigateway"));
const apigwv2 = __importStar(require("aws-cdk-lib/aws-apigatewayv2"));
const apigwv2Integrations = __importStar(require("aws-cdk-lib/aws-apigatewayv2-integrations"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const iam = __importStar(require("aws-cdk-lib/aws-iam"));
const logs = __importStar(require("aws-cdk-lib/aws-logs"));
const constructs_1 = require("constructs");
const logical_name_1 = require("./private/logical-name");
const refuse_explicit_name_1 = require("./private/refuse-explicit-name");
const secure_defaults_1 = require("./private/secure-defaults");
const standard_logging_1 = require("./private/standard-logging");
class AppTheoryWebSocketApi extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryWebSocketApi", version: "7.5.0-rc.1" };
    api;
    stage;
    connectionTable;
    accessLogGroup;
    constructor(scope, id, props) {
        super(scope, id);
        const stageName = String(props.stageName ?? "dev").trim() || "dev";
        const standard = props.namingContext?.standardLogging === true;
        const namingContext = props.namingContext;
        const logical = props.logicalName ?? (namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryWebSocketApi", "apiName", "api_websocket", logical, props.apiName !== undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryWebSocketApi", "connectionTableName", "dynamodb_table", logical ? `${logical}-connections` : undefined, props.connectionTableName !== undefined);
        const derivedApiName = namingContext && logical ? namingContext.physicalName("api_websocket", logical) : undefined;
        const connectHandler = props.connectHandler ?? props.handler;
        const disconnectHandler = props.disconnectHandler ?? props.handler;
        const defaultHandler = props.defaultHandler ?? props.handler;
        this.api = new apigwv2.WebSocketApi(this, "Api", {
            apiName: derivedApiName && !derivedApiName.generated ? derivedApiName.name : props.apiName,
        });
        const useRouteSpecificHandlers = Boolean(props.connectHandler) || Boolean(props.disconnectHandler) || Boolean(props.defaultHandler);
        if (useRouteSpecificHandlers) {
            const connectIntegration = new apigwv2Integrations.WebSocketLambdaIntegration("ConnectHandler", connectHandler);
            const disconnectIntegration = new apigwv2Integrations.WebSocketLambdaIntegration("DisconnectHandler", disconnectHandler);
            const defaultIntegration = new apigwv2Integrations.WebSocketLambdaIntegration("DefaultHandler", defaultHandler);
            this.api.addRoute("$connect", { integration: connectIntegration });
            this.api.addRoute("$disconnect", { integration: disconnectIntegration });
            this.api.addRoute("$default", { integration: defaultIntegration });
        }
        else {
            const integration = new apigwv2Integrations.WebSocketLambdaIntegration("Handler", props.handler);
            this.api.addRoute("$connect", { integration });
            this.api.addRoute("$disconnect", { integration });
            this.api.addRoute("$default", { integration });
        }
        const shouldCreateConnectionTable = (props.enableConnectionTable ?? false) || Boolean(props.connectionTableName);
        if (props.connectionTable && shouldCreateConnectionTable) {
            throw new Error("AppTheoryWebSocketApi supports either props.connectionTable or props.enableConnectionTable/props.connectionTableName");
        }
        if (props.connectionTable) {
            this.connectionTable = props.connectionTable;
        }
        else if (shouldCreateConnectionTable) {
            const derivedTableName = namingContext && logical
                ? namingContext.physicalName("dynamodb_table", `${logical}-connections`)
                : undefined;
            const pkName = props.connectionTablePartitionKeyName ?? "PK";
            const skName = props.connectionTableSortKeyName ?? "SK";
            const ttlAttribute = props.connectionTableTimeToLiveAttribute ?? "ttl";
            const removalPolicy = props.connectionTableRemovalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
            const enablePITR = props.connectionTableEnablePointInTimeRecovery ?? true;
            const deletionProtection = (0, secure_defaults_1.defaultDeletionProtection)(namingContext, removalPolicy, props.connectionTableDeletionProtection);
            this.connectionTable = new dynamodb.Table(this, "ConnectionTable", {
                tableName: derivedTableName && !derivedTableName.generated ? derivedTableName.name : props.connectionTableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: pkName, type: dynamodb.AttributeType.STRING },
                sortKey: { name: skName, type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: ttlAttribute,
                removalPolicy,
                deletionProtection: deletionProtection,
                pointInTimeRecoverySpecification: {
                    pointInTimeRecoveryEnabled: enablePITR,
                },
                encryption: dynamodb.TableEncryption.AWS_MANAGED,
            });
        }
        if (this.connectionTable) {
            const handlers = new Set([connectHandler, disconnectHandler, defaultHandler]);
            for (const handler of handlers) {
                this.connectionTable.grantReadWriteData(handler);
            }
        }
        let accessLogSettings;
        if (props.enableAccessLogging ?? standard) {
            if (standard && !props.accessLogGroup && !logical) {
                throw new Error("AppTheoryWebSocketApi standard logging requires a logical name");
            }
            const logGroup = props.accessLogGroup ??
                new logs.LogGroup(this, "AccessLogs", 
                // The construct-created access-log group is a logging resource: the
                // standard profile names it from the contract, and the legacy profile
                // keeps today's CloudFormation-generated name and consumes no entry.
                standard && namingContext && logical
                    ? {
                        logGroupName: namingContext.logGroupName(`logs/access/api/${logical}`),
                        retention: (0, standard_logging_1.retentionFor)(namingContext.retentionDays),
                        removalPolicy: props.accessLogRemovalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN,
                    }
                    : {
                        retention: props.accessLogRetention ?? logs.RetentionDays.ONE_WEEK,
                        removalPolicy: props.accessLogRemovalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN,
                    });
            this.accessLogGroup = logGroup;
            logGroup.addToResourcePolicy(new iam.PolicyStatement({
                principals: [new iam.ServicePrincipal("apigateway.amazonaws.com")],
                actions: ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"],
                resources: [logGroup.logGroupArn],
            }));
            const format = props.accessLogFormat ??
                (standard
                    ? apigateway.AccessLogFormat.custom((0, standard_logging_1.webSocketApiAccessLogFormat)())
                    : apigateway.AccessLogFormat.custom(JSON.stringify({
                        requestId: apigateway.AccessLogField.contextRequestId(),
                        eventType: apigateway.AccessLogField.contextEventType(),
                        routeKey: apigateway.AccessLogField.contextRouteKey(),
                        connectionId: apigateway.AccessLogField.contextConnectionId(),
                        status: apigateway.AccessLogField.contextStatus(),
                        responseLength: apigateway.AccessLogField.contextResponseLength(),
                        integrationLatency: apigateway.AccessLogField.contextIntegrationLatency(),
                        requestTime: apigateway.AccessLogField.contextRequestTime(),
                        ip: apigateway.AccessLogField.contextIdentitySourceIp(),
                        userAgent: apigateway.AccessLogField.contextIdentityUserAgent(),
                    })));
            accessLogSettings = {
                destination: new apigwv2.LogGroupLogDestination(logGroup),
                format,
            };
        }
        this.stage = new apigwv2.WebSocketStage(this, "Stage", {
            webSocketApi: this.api,
            stageName,
            autoDeploy: true,
            accessLogSettings,
        });
        {
            const handlers = new Set([connectHandler, disconnectHandler, defaultHandler]);
            for (const handler of handlers) {
                this.stage.grantManagementApiAccess(handler);
            }
        }
    }
}
exports.AppTheoryWebSocketApi = AppTheoryWebSocketApi;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vic29ja2V0LWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIndlYnNvY2tldC1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE0QztBQUM1Qyx1RUFBeUQ7QUFDekQsc0VBQXdEO0FBQ3hELCtGQUFpRjtBQUNqRixtRUFBcUQ7QUFDckQseURBQTJDO0FBRTNDLDJEQUE2QztBQUM3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSwrREFBc0U7QUFDdEUsaUVBQXVGO0FBc0R2RixNQUFhLHFCQUFzQixTQUFRLHNCQUFTOztJQUNsQyxHQUFHLENBQXVCO0lBQzFCLEtBQUssQ0FBeUI7SUFDOUIsZUFBZSxDQUFtQjtJQUNsQyxjQUFjLENBQWtCO0lBRWhELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFNBQVMsSUFBSSxLQUFLLENBQUMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxLQUFLLENBQUM7UUFDbkUsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLGFBQWEsRUFBRSxlQUFlLEtBQUssSUFBSSxDQUFDO1FBQy9ELE1BQU0sYUFBYSxHQUFHLEtBQUssQ0FBQyxhQUFhLENBQUM7UUFDMUMsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsSUFBQSxpQ0FBa0IsRUFBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDNUYsSUFBQSx5Q0FBa0IsRUFBQyxhQUFhLEVBQUUsdUJBQXVCLEVBQUUsU0FBUyxFQUFFLGVBQWUsRUFBRSxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU8sS0FBSyxTQUFTLENBQUMs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Q0FBQztRQUNILENBQUM7SUFDSCxDQUFDOztBQXhLSCxzREF5S0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5pbXBvcnQgeyBkZWZhdWx0TG9naWNhbE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL2xvZ2ljYWwtbmFtZVwiO1xuaW1wb3J0IHsgcmVmdXNlRXhwbGljaXROYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9yZWZ1c2UtZXhwbGljaXQtbmFtZVwiO1xuaW1wb3J0IHsgZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbiB9IGZyb20gXCIuL3ByaXZhdGUvc2VjdXJlLWRlZmF1bHRzXCI7XG5pbXBvcnQgeyByZXRlbnRpb25Gb3IsIHdlYlNvY2tldEFwaUFjY2Vzc0xvZ0Zvcm1hdCB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlXZWJTb2NrZXRBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGNvbm5lY3RIYW5kbGVyPzogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgZGlzY29ubmVjdEhhbmRsZXI/OiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBkZWZhdWx0SGFuZGxlcj86IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICByZWFkb25seSBjb25uZWN0aW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHJlYWRvbmx5IGVuYWJsZUNvbm5lY3Rpb25UYWJsZT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVBhcnRpdGlvbktleU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVNvcnRLZXlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVUaW1lVG9MaXZlQXR0cmlidXRlPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlRW5hYmxlUG9pbnRJblRpbWVSZWNvdmVyeT86IGJvb2xlYW47XG4gIC8qKlxuICAgKiBXaGV0aGVyIGRlbGV0aW9uIHByb3RlY3Rpb24gc2hvdWxkIGJlIGVuYWJsZWQgZm9yIHRoZSBjb25uZWN0aW9uIHRhYmxlLlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWQgKHdpdGggbm8gbmFtaW5nIGNvbnRleHQ6IHRoZSBBV1MgZGVmYXVsdCwgbm8gZGVsZXRpb25cbiAgICogcHJvdGVjdGlvbjsgdW5kZXIgYSBkZXJpdmVkIG5hbWluZyBjb250ZXh0OiBvbiBmb3IgYSBSRVRBSU4gdGFibGUsIG9mZiBvdGhlcndpc2UpXG4gICAqL1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVEZWxldGlvblByb3RlY3Rpb24/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGVuYWJsZUFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBhY2Nlc3NMb2dGb3JtYXQ/OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAqXG4gICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSBhY2Nlc3MgbG9nZ2luZyBpcyBvbiBieSBkZWZhdWx0IHRvIGEgbG9nXG4gICAqIGdyb3VwIG5hbWVkIGBsb2dzL2FjY2Vzcy9hcGkve2xvZ2ljYWxOYW1lfWAgY2FycnlpbmcgdGhlIGNvbnRyYWN0J3MgSlNPTlxuICAgKiBmaWVsZCBzZXQuIFBhc3MgYGVuYWJsZUFjY2Vzc0xvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0LlxuICAgKlxuICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAvKipcbiAgICogVGhlIEFQSSdzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZCB3aGVuIGFcbiAgICogbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVdlYlNvY2tldEFwaSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuV2ViU29ja2V0QXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuV2ViU29ja2V0U3RhZ2U7XG4gIHB1YmxpYyByZWFkb25seSBjb25uZWN0aW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlXZWJTb2NrZXRBcGlQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBzdGFnZU5hbWUgPSBTdHJpbmcocHJvcHMuc3RhZ2VOYW1lID8/IFwiZGV2XCIpLnRyaW0oKSB8fCBcImRldlwiO1xuICAgIGNvbnN0IHN0YW5kYXJkID0gcHJvcHMubmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlO1xuICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAobmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKG5hbWluZ0NvbnRleHQsIFwiQXBwVGhlb3J5V2ViU29ja2V0QXBpXCIsIFwiYXBpTmFtZVwiLCBcImFwaV93ZWJzb2NrZXRcIiwgbG9naWNhbCwgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUoXG4gICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGlcIixcbiAgICAgIFwiY29ubmVjdGlvblRhYmxlTmFtZVwiLFxuICAgICAgXCJkeW5hbW9kYl90YWJsZVwiLFxuICAgICAgbG9naWNhbCA/IGAke2xvZ2ljYWx9LWNvbm5lY3Rpb25zYCA6IHVuZGVmaW5lZCxcbiAgICAgIHByb3BzLmNvbm5lY3Rpb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZCxcbiAgICApO1xuICAgIGNvbnN0IGRlcml2ZWRBcGlOYW1lID0gbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsID8gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJhcGlfd2Vic29ja2V0XCIsIGxvZ2ljYWwpIDogdW5kZWZpbmVkO1xuICAgIGNvbnN0IGNvbm5lY3RIYW5kbGVyID0gcHJvcHMuY29ubmVjdEhhbmRsZXIgPz8gcHJvcHMuaGFuZGxlcjtcbiAgICBjb25zdCBkaXNjb25uZWN0SGFuZGxlciA9IHByb3BzLmRpc2Nvbm5lY3RIYW5kbGVyID8/IHByb3BzLmhhbmRsZXI7XG4gICAgY29uc3QgZGVmYXVsdEhhbmRsZXIgPSBwcm9wcy5kZWZhdWx0SGFuZGxlciA/PyBwcm9wcy5oYW5kbGVyO1xuXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5XZWJTb2NrZXRBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgYXBpTmFtZTogZGVyaXZlZEFwaU5hbWUgJiYgIWRlcml2ZWRBcGlOYW1lLmdlbmVyYXRlZCA/IGRlcml2ZWRBcGlOYW1lLm5hbWUgOiBwcm9wcy5hcGlOYW1lLFxuICAgIH0pO1xuXG4gICAgY29uc3QgdXNlUm91dGVTcGVjaWZpY0hhbmRsZXJzID1cbiAgICAgIEJvb2xlYW4ocHJvcHMuY29ubmVjdEhhbmRsZXIpIHx8IEJvb2xlYW4ocHJvcHMuZGlzY29ubmVjdEhhbmRsZXIpIHx8IEJvb2xlYW4ocHJvcHMuZGVmYXVsdEhhbmRsZXIpO1xuICAgIGlmICh1c2VSb3V0ZVNwZWNpZmljSGFuZGxlcnMpIHtcbiAgICAgIGNvbnN0IGNvbm5lY3RJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFwiQ29ubmVjdEhhbmRsZXJcIiwgY29ubmVjdEhhbmRsZXIpO1xuICAgICAgY29uc3QgZGlzY29ubmVjdEludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIFwiRGlzY29ubmVjdEhhbmRsZXJcIixcbiAgICAgICAgZGlzY29ubmVjdEhhbmRsZXIsXG4gICAgICApO1xuICAgICAgY29uc3QgZGVmYXVsdEludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXCJEZWZhdWx0SGFuZGxlclwiLCBkZWZhdWx0SGFuZGxlcik7XG5cbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGNvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbjogY29ubmVjdEludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGlzY29ubmVjdFwiLCB7IGludGVncmF0aW9uOiBkaXNjb25uZWN0SW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkZWZhdWx0XCIsIHsgaW50ZWdyYXRpb246IGRlZmF1bHRJbnRlZ3JhdGlvbiB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcIkhhbmRsZXJcIiwgcHJvcHMuaGFuZGxlcik7XG5cbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGNvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRpc2Nvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRlZmF1bHRcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBzaG91bGRDcmVhdGVDb25uZWN0aW9uVGFibGUgPVxuICAgICAgKHByb3BzLmVuYWJsZUNvbm5lY3Rpb25UYWJsZSA/PyBmYWxzZSkgfHwgQm9vbGVhbihwcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lKTtcbiAgICBpZiAocHJvcHMuY29ubmVjdGlvblRhYmxlICYmIHNob3VsZENyZWF0ZUNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeVdlYlNvY2tldEFwaSBzdXBwb3J0cyBlaXRoZXIgcHJvcHMuY29ubmVjdGlvblRhYmxlIG9yIHByb3BzLmVuYWJsZUNvbm5lY3Rpb25UYWJsZS9wcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmIChwcm9wcy5jb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIHRoaXMuY29ubmVjdGlvblRhYmxlID0gcHJvcHMuY29ubmVjdGlvblRhYmxlO1xuICAgIH0gZWxzZSBpZiAoc2hvdWxkQ3JlYXRlQ29ubmVjdGlvblRhYmxlKSB7XG4gICAgICBjb25zdCBkZXJpdmVkVGFibGVOYW1lID0gbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsXG4gICAgICAgID8gbmFtaW5nQ29udGV4dC5waHlzaWNhbE5hbWUoXCJkeW5hbW9kYl90YWJsZVwiLCBgJHtsb2dpY2FsfS1jb25uZWN0aW9uc2ApXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgcGtOYW1lID0gcHJvcHMuY29ubmVjdGlvblRhYmxlUGFydGl0aW9uS2V5TmFtZSA/PyBcIlBLXCI7XG4gICAgICBjb25zdCBza05hbWUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVTb3J0S2V5TmFtZSA/PyBcIlNLXCI7XG4gICAgICBjb25zdCB0dGxBdHRyaWJ1dGUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVUaW1lVG9MaXZlQXR0cmlidXRlID8/IFwidHRsXCI7XG4gICAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuY29ubmVjdGlvblRhYmxlUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICAgIGNvbnN0IGVuYWJsZVBJVFIgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVFbmFibGVQb2ludEluVGltZVJlY292ZXJ5ID8/IHRydWU7XG4gICAgICBjb25zdCBkZWxldGlvblByb3RlY3Rpb24gPSBkZWZhdWx0RGVsZXRpb25Qcm90ZWN0aW9uKFxuICAgICAgICBuYW1pbmdDb250ZXh0LFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBwcm9wcy5jb25uZWN0aW9uVGFibGVEZWxldGlvblByb3RlY3Rpb24sXG4gICAgICApO1xuXG4gICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIkNvbm5lY3Rpb25UYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZTogZGVyaXZlZFRhYmxlTmFtZSAmJiAhZGVyaXZlZFRhYmxlTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkVGFibGVOYW1lLm5hbWUgOiBwcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogcGtOYW1lLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICBzb3J0S2V5OiB7IG5hbWU6IHNrTmFtZSwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogdHRsQXR0cmlidXRlLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBkZWxldGlvblByb3RlY3Rpb246IGRlbGV0aW9uUHJvdGVjdGlvbixcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogZW5hYmxlUElUUixcbiAgICAgICAgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuY29ubmVjdGlvblRhYmxlKSB7XG4gICAgICBjb25zdCBoYW5kbGVycyA9IG5ldyBTZXQ8bGFtYmRhLklGdW5jdGlvbj4oW2Nvbm5lY3RIYW5kbGVyLCBkaXNjb25uZWN0SGFuZGxlciwgZGVmYXVsdEhhbmRsZXJdKTtcbiAgICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuICAgICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaGFuZGxlcik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGV0IGFjY2Vzc0xvZ1NldHRpbmdzOiBhcGlnd3YyLklBY2Nlc3NMb2dTZXR0aW5ncyB8IHVuZGVmaW5lZDtcbiAgICBpZiAocHJvcHMuZW5hYmxlQWNjZXNzTG9nZ2luZyA/PyBzdGFuZGFyZCkge1xuICAgICAgaWYgKHN0YW5kYXJkICYmICFwcm9wcy5hY2Nlc3NMb2dHcm91cCAmJiAhbG9naWNhbCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGkgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIGxvZ2ljYWwgbmFtZVwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxvZ0dyb3VwID1cbiAgICAgICAgcHJvcHMuYWNjZXNzTG9nR3JvdXAgPz9cbiAgICAgICAgbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsXG4gICAgICAgICAgLy8gVGhlIGNvbnN0cnVjdC1jcmVhdGVkIGFjY2Vzcy1sb2cgZ3JvdXAgaXMgYSBsb2dnaW5nIHJlc291cmNlOiB0aGVcbiAgICAgICAgICAvLyBzdGFuZGFyZCBwcm9maWxlIG5hbWVzIGl0IGZyb20gdGhlIGNvbnRyYWN0LCBhbmQgdGhlIGxlZ2FjeSBwcm9maWxlXG4gICAgICAgICAgLy8ga2VlcHMgdG9kYXkncyBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZSBhbmQgY29uc3VtZXMgbm8gZW50cnkuXG4gICAgICAgICAgc3RhbmRhcmQgJiYgbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogbmFtaW5nQ29udGV4dC5sb2dHcm91cE5hbWUoYGxvZ3MvYWNjZXNzL2FwaS8ke2xvZ2ljYWx9YCksXG4gICAgICAgICAgICAgIHJldGVudGlvbjogcmV0ZW50aW9uRm9yKG5hbWluZ0NvbnRleHQucmV0ZW50aW9uRGF5cyksXG4gICAgICAgICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmFjY2Vzc0xvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICAgICAgICB9XG4gICAgICAgICAgOiB7XG4gICAgICAgICAgICAgIHJldGVudGlvbjogcHJvcHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuYWNjZXNzTG9nUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICAgICAgICAgIH0pO1xuICAgICAgdGhpcy5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgICBsb2dHcm91cC5hZGRUb1Jlc291cmNlUG9saWN5KFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgcHJpbmNpcGFsczogW25ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiKV0sXG4gICAgICAgICAgYWN0aW9uczogW1wibG9nczpDcmVhdGVMb2dTdHJlYW1cIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiLCBcImxvZ3M6UHV0TG9nRXZlbnRzXCJdLFxuICAgICAgICAgIHJlc291cmNlczogW2xvZ0dyb3VwLmxvZ0dyb3VwQXJuXSxcbiAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgICBjb25zdCBmb3JtYXQgPVxuICAgICAgICBwcm9wcy5hY2Nlc3NMb2dGb3JtYXQgPz9cbiAgICAgICAgKHN0YW5kYXJkXG4gICAgICAgICAgPyBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20od2ViU29ja2V0QXBpQWNjZXNzTG9nRm9ybWF0KCkpXG4gICAgICAgICAgOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20oXG4gICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICByZXF1ZXN0SWQ6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlcXVlc3RJZCgpLFxuICAgICAgICAgICAgICAgIGV2ZW50VHlwZTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0RXZlbnRUeXBlKCksXG4gICAgICAgICAgICAgICAgcm91dGVLZXk6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJvdXRlS2V5KCksXG4gICAgICAgICAgICAgICAgY29ubmVjdGlvbklkOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRDb25uZWN0aW9uSWQoKSxcbiAgICAgICAgICAgICAgICBzdGF0dXM6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFN0YXR1cygpLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXNwb25zZUxlbmd0aCgpLFxuICAgICAgICAgICAgICAgIGludGVncmF0aW9uTGF0ZW5jeTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0SW50ZWdyYXRpb25MYXRlbmN5KCksXG4gICAgICAgICAgICAgICAgcmVxdWVzdFRpbWU6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlcXVlc3RUaW1lKCksXG4gICAgICAgICAgICAgICAgaXA6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dElkZW50aXR5U291cmNlSXAoKSxcbiAgICAgICAgICAgICAgICB1c2VyQWdlbnQ6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dElkZW50aXR5VXNlckFnZW50KCksXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgKSk7XG5cbiAgICAgIGFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICBkZXN0aW5hdGlvbjogbmV3IGFwaWd3djIuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihsb2dHcm91cCksXG4gICAgICAgIGZvcm1hdCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgdGhpcy5zdGFnZSA9IG5ldyBhcGlnd3YyLldlYlNvY2tldFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgd2ViU29ja2V0QXBpOiB0aGlzLmFwaSxcbiAgICAgIHN0YWdlTmFtZSxcbiAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICBhY2Nlc3NMb2dTZXR0aW5ncyxcbiAgICB9KTtcblxuICAgIHtcbiAgICAgIGNvbnN0IGhhbmRsZXJzID0gbmV3IFNldDxsYW1iZGEuSUZ1bmN0aW9uPihbY29ubmVjdEhhbmRsZXIsIGRpc2Nvbm5lY3RIYW5kbGVyLCBkZWZhdWx0SGFuZGxlcl0pO1xuICAgICAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzKSB7XG4gICAgICAgIHRoaXMuc3RhZ2UuZ3JhbnRNYW5hZ2VtZW50QXBpQWNjZXNzKGhhbmRsZXIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIl19