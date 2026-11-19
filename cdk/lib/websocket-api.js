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
const standard_logging_1 = require("./private/standard-logging");
class AppTheoryWebSocketApi extends constructs_1.Construct {
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryWebSocketApi", version: "7.4.0" };
    api;
    stage;
    connectionTable;
    accessLogGroup;
    constructor(scope, id, props) {
        super(scope, id);
        const stageName = String(props.stageName ?? "dev").trim() || "dev";
        const standard = props.namingContext?.standardLogging === true;
        const logical = props.logicalName ?? (props.namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        const connectHandler = props.connectHandler ?? props.handler;
        const disconnectHandler = props.disconnectHandler ?? props.handler;
        const defaultHandler = props.defaultHandler ?? props.handler;
        this.api = new apigwv2.WebSocketApi(this, "Api", {
            apiName: props.apiName,
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
            const pkName = props.connectionTablePartitionKeyName ?? "PK";
            const skName = props.connectionTableSortKeyName ?? "SK";
            const ttlAttribute = props.connectionTableTimeToLiveAttribute ?? "ttl";
            const removalPolicy = props.connectionTableRemovalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN;
            const enablePITR = props.connectionTableEnablePointInTimeRecovery ?? true;
            this.connectionTable = new dynamodb.Table(this, "ConnectionTable", {
                tableName: props.connectionTableName,
                billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
                partitionKey: { name: pkName, type: dynamodb.AttributeType.STRING },
                sortKey: { name: skName, type: dynamodb.AttributeType.STRING },
                timeToLiveAttribute: ttlAttribute,
                removalPolicy,
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
                new logs.LogGroup(this, "AccessLogs", standard && props.namingContext && logical
                    ? {
                        logGroupName: props.namingContext.logGroupName(`logs/access/api/${logical}`),
                        retention: (0, standard_logging_1.retentionFor)(props.namingContext.retentionDays),
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
                    ? apigateway.AccessLogFormat.custom(JSON.stringify({
                        requestId: apigateway.AccessLogField.contextRequestId(),
                        requestTime: apigateway.AccessLogField.contextRequestTime(),
                        routeKey: apigateway.AccessLogField.contextRouteKey(),
                        status: apigateway.AccessLogField.contextStatus(),
                        protocol: apigateway.AccessLogField.contextProtocol(),
                        responseLength: apigateway.AccessLogField.contextResponseLength(),
                        integrationLatency: apigateway.AccessLogField.contextIntegrationLatency(),
                        sourceIp: apigateway.AccessLogField.contextIdentitySourceIp(),
                    }))
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vic29ja2V0LWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIndlYnNvY2tldC1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE0QztBQUM1Qyx1RUFBeUQ7QUFDekQsc0VBQXdEO0FBQ3hELCtGQUFpRjtBQUNqRixtRUFBcUQ7QUFDckQseURBQTJDO0FBRTNDLDJEQUE2QztBQUM3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELGlFQUEwRDtBQWdEMUQsTUFBYSxxQkFBc0IsU0FBUSxzQkFBUzs7SUFDbEMsR0FBRyxDQUF1QjtJQUMxQixLQUFLLENBQXlCO0lBQzlCLGVBQWUsQ0FBbUI7SUFDbEMsY0FBYyxDQUFrQjtJQUVoRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQWlDO1FBQ3pFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFFakIsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLEtBQUssQ0FBQyxTQUFTLElBQUksS0FBSyxDQUFDLENBQUMsSUFBSSxFQUFFLElBQUksS0FBSyxDQUFDO1FBQ25FLE1BQU0sUUFBUSxHQUFHLEtBQUssQ0FBQyxhQUFhLEVBQUUsZUFBZSxLQUFLLElBQUksQ0FBQztRQUMvRCxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsV0FBVyxJQUFJLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsSUFBQSxpQ0FBa0IsRUFBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDbEcsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDO1FBQzdELE1BQU0saUJBQWlCLEdBQUcsS0FBSyxDQUFDLGlCQUFpQixJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUM7UUFDbkUsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMs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VyxFQUFFLElBQUksT0FBTyxDQUFDLHNCQUFzQixDQUFDLFFBQVEsQ0FBQztnQkFDekQsTUFBTTthQUNQLENBQUM7UUFDSixDQUFDO1FBRUQsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLE9BQU8sQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtZQUNyRCxZQUFZLEVBQUUsSUFBSSxDQUFDLEdBQUc7WUFDdEIsU0FBUztZQUNULFVBQVUsRUFBRSxJQUFJO1lBQ2hCLGlCQUFpQjtTQUNsQixDQUFDLENBQUM7UUFFSCxDQUFDO1lBQ0MsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLENBQW1CLENBQUMsY0FBYyxFQUFFLGlCQUFpQixFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUM7WUFDaEcsS0FBSyxNQUFNLE9BQU8sSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDL0IsSUFBSSxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUMvQyxDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7O0FBM0pILHNEQTRKQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyByZXRlbnRpb25Gb3IgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5V2ViU29ja2V0QXBpUHJvcHMge1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBjb25uZWN0SGFuZGxlcj86IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGRpc2Nvbm5lY3RIYW5kbGVyPzogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgZGVmYXVsdEhhbmRsZXI/OiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICByZWFkb25seSBlbmFibGVDb25uZWN0aW9uVGFibGU/OiBib29sZWFuO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVQYXJ0aXRpb25LZXlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVTb3J0S2V5TmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlVGltZVRvTGl2ZUF0dHJpYnV0ZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZUVuYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGVuYWJsZUFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBhY2Nlc3NMb2dGb3JtYXQ/OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAqXG4gICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSBhY2Nlc3MgbG9nZ2luZyBpcyBvbiBieSBkZWZhdWx0IHRvIGEgbG9nXG4gICAqIGdyb3VwIG5hbWVkIGBsb2dzL2FjY2Vzcy9hcGkve2xvZ2ljYWxOYW1lfWAgY2FycnlpbmcgdGhlIGNvbnRyYWN0J3MgSlNPTlxuICAgKiBmaWVsZCBzZXQuIFBhc3MgYGVuYWJsZUFjY2Vzc0xvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0LlxuICAgKlxuICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAvKipcbiAgICogVGhlIEFQSSdzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZCB3aGVuIGFcbiAgICogbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVdlYlNvY2tldEFwaSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuV2ViU29ja2V0QXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuV2ViU29ja2V0U3RhZ2U7XG4gIHB1YmxpYyByZWFkb25seSBjb25uZWN0aW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlXZWJTb2NrZXRBcGlQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBzdGFnZU5hbWUgPSBTdHJpbmcocHJvcHMuc3RhZ2VOYW1lID8/IFwiZGV2XCIpLnRyaW0oKSB8fCBcImRldlwiO1xuICAgIGNvbnN0IHN0YW5kYXJkID0gcHJvcHMubmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlO1xuICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAocHJvcHMubmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgY29uc3QgY29ubmVjdEhhbmRsZXIgPSBwcm9wcy5jb25uZWN0SGFuZGxlciA/PyBwcm9wcy5oYW5kbGVyO1xuICAgIGNvbnN0IGRpc2Nvbm5lY3RIYW5kbGVyID0gcHJvcHMuZGlzY29ubmVjdEhhbmRsZXIgPz8gcHJvcHMuaGFuZGxlcjtcbiAgICBjb25zdCBkZWZhdWx0SGFuZGxlciA9IHByb3BzLmRlZmF1bHRIYW5kbGVyID8/IHByb3BzLmhhbmRsZXI7XG5cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnd3YyLldlYlNvY2tldEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgIH0pO1xuXG4gICAgY29uc3QgdXNlUm91dGVTcGVjaWZpY0hhbmRsZXJzID1cbiAgICAgIEJvb2xlYW4ocHJvcHMuY29ubmVjdEhhbmRsZXIpIHx8IEJvb2xlYW4ocHJvcHMuZGlzY29ubmVjdEhhbmRsZXIpIHx8IEJvb2xlYW4ocHJvcHMuZGVmYXVsdEhhbmRsZXIpO1xuICAgIGlmICh1c2VSb3V0ZVNwZWNpZmljSGFuZGxlcnMpIHtcbiAgICAgIGNvbnN0IGNvbm5lY3RJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFwiQ29ubmVjdEhhbmRsZXJcIiwgY29ubmVjdEhhbmRsZXIpO1xuICAgICAgY29uc3QgZGlzY29ubmVjdEludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIFwiRGlzY29ubmVjdEhhbmRsZXJcIixcbiAgICAgICAgZGlzY29ubmVjdEhhbmRsZXIsXG4gICAgICApO1xuICAgICAgY29uc3QgZGVmYXVsdEludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXCJEZWZhdWx0SGFuZGxlclwiLCBkZWZhdWx0SGFuZGxlcik7XG5cbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGNvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbjogY29ubmVjdEludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGlzY29ubmVjdFwiLCB7IGludGVncmF0aW9uOiBkaXNjb25uZWN0SW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkZWZhdWx0XCIsIHsgaW50ZWdyYXRpb246IGRlZmF1bHRJbnRlZ3JhdGlvbiB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcIkhhbmRsZXJcIiwgcHJvcHMuaGFuZGxlcik7XG5cbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGNvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRpc2Nvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRlZmF1bHRcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBzaG91bGRDcmVhdGVDb25uZWN0aW9uVGFibGUgPVxuICAgICAgKHByb3BzLmVuYWJsZUNvbm5lY3Rpb25UYWJsZSA/PyBmYWxzZSkgfHwgQm9vbGVhbihwcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lKTtcbiAgICBpZiAocHJvcHMuY29ubmVjdGlvblRhYmxlICYmIHNob3VsZENyZWF0ZUNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeVdlYlNvY2tldEFwaSBzdXBwb3J0cyBlaXRoZXIgcHJvcHMuY29ubmVjdGlvblRhYmxlIG9yIHByb3BzLmVuYWJsZUNvbm5lY3Rpb25UYWJsZS9wcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmIChwcm9wcy5jb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIHRoaXMuY29ubmVjdGlvblRhYmxlID0gcHJvcHMuY29ubmVjdGlvblRhYmxlO1xuICAgIH0gZWxzZSBpZiAoc2hvdWxkQ3JlYXRlQ29ubmVjdGlvblRhYmxlKSB7XG4gICAgICBjb25zdCBwa05hbWUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVQYXJ0aXRpb25LZXlOYW1lID8/IFwiUEtcIjtcbiAgICAgIGNvbnN0IHNrTmFtZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVNvcnRLZXlOYW1lID8/IFwiU0tcIjtcbiAgICAgIGNvbnN0IHR0bEF0dHJpYnV0ZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVRpbWVUb0xpdmVBdHRyaWJ1dGUgPz8gXCJ0dGxcIjtcbiAgICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgICAgY29uc3QgZW5hYmxlUElUUiA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZUVuYWJsZVBvaW50SW5UaW1lUmVjb3ZlcnkgPz8gdHJ1ZTtcblxuICAgICAgdGhpcy5jb25uZWN0aW9uVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJDb25uZWN0aW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IHByb3BzLmNvbm5lY3Rpb25UYWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBwa05hbWUsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHNvcnRLZXk6IHsgbmFtZTogc2tOYW1lLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiB0dGxBdHRyaWJ1dGUsXG4gICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IGVuYWJsZVBJVFIsXG4gICAgICAgIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgY29uc3QgaGFuZGxlcnMgPSBuZXcgU2V0PGxhbWJkYS5JRnVuY3Rpb24+KFtjb25uZWN0SGFuZGxlciwgZGlzY29ubmVjdEhhbmRsZXIsIGRlZmF1bHRIYW5kbGVyXSk7XG4gICAgICBmb3IgKGNvbnN0IGhhbmRsZXIgb2YgaGFuZGxlcnMpIHtcbiAgICAgICAgdGhpcy5jb25uZWN0aW9uVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGhhbmRsZXIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBhY2Nlc3NMb2dTZXR0aW5nczogYXBpZ3d2Mi5JQWNjZXNzTG9nU2V0dGluZ3MgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHByb3BzLmVuYWJsZUFjY2Vzc0xvZ2dpbmcgPz8gc3RhbmRhcmQpIHtcbiAgICAgIGlmIChzdGFuZGFyZCAmJiAhcHJvcHMuYWNjZXNzTG9nR3JvdXAgJiYgIWxvZ2ljYWwpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiQXBwVGhlb3J5V2ViU29ja2V0QXBpIHN0YW5kYXJkIGxvZ2dpbmcgcmVxdWlyZXMgYSBsb2dpY2FsIG5hbWVcIik7XG4gICAgICB9XG4gICAgICBjb25zdCBsb2dHcm91cCA9XG4gICAgICAgIHByb3BzLmFjY2Vzc0xvZ0dyb3VwID8/XG4gICAgICAgIG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCBzdGFuZGFyZCAmJiBwcm9wcy5uYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBwcm9wcy5uYW1pbmdDb250ZXh0LmxvZ0dyb3VwTmFtZShgbG9ncy9hY2Nlc3MvYXBpLyR7bG9naWNhbH1gKSxcbiAgICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IocHJvcHMubmFtaW5nQ29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuYWNjZXNzTG9nUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICAgICAgICAgIH1cbiAgICAgICAgICA6IHtcbiAgICAgICAgICAgICAgcmV0ZW50aW9uOiBwcm9wcy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgICAgICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5hY2Nlc3NMb2dSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOLFxuICAgICAgICAgICAgfSk7XG4gICAgICB0aGlzLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICAgIGxvZ0dyb3VwLmFkZFRvUmVzb3VyY2VQb2xpY3koXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBwcmluY2lwYWxzOiBbbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIpXSxcbiAgICAgICAgICBhY3Rpb25zOiBbXCJsb2dzOkNyZWF0ZUxvZ1N0cmVhbVwiLCBcImxvZ3M6RGVzY3JpYmVMb2dTdHJlYW1zXCIsIFwibG9nczpQdXRMb2dFdmVudHNcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbbG9nR3JvdXAubG9nR3JvdXBBcm5dLFxuICAgICAgICB9KSxcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGZvcm1hdCA9XG4gICAgICAgIHByb3BzLmFjY2Vzc0xvZ0Zvcm1hdCA/P1xuICAgICAgICAoc3RhbmRhcmRcbiAgICAgICAgICA/IGFwaWdhdGV3YXkuQWNjZXNzTG9nRm9ybWF0LmN1c3RvbShcbiAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgIHJlcXVlc3RJZDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0UmVxdWVzdElkKCksXG4gICAgICAgICAgICAgICAgcmVxdWVzdFRpbWU6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlcXVlc3RUaW1lKCksXG4gICAgICAgICAgICAgICAgcm91dGVLZXk6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJvdXRlS2V5KCksXG4gICAgICAgICAgICAgICAgc3RhdHVzOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRTdGF0dXMoKSxcbiAgICAgICAgICAgICAgICBwcm90b2NvbDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0UHJvdG9jb2woKSxcbiAgICAgICAgICAgICAgICByZXNwb25zZUxlbmd0aDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0UmVzcG9uc2VMZW5ndGgoKSxcbiAgICAgICAgICAgICAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dEludGVncmF0aW9uTGF0ZW5jeSgpLFxuICAgICAgICAgICAgICAgIHNvdXJjZUlwOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRJZGVudGl0eVNvdXJjZUlwKCksXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGb3JtYXQuY3VzdG9tKFxuICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgcmVxdWVzdElkOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXF1ZXN0SWQoKSxcbiAgICAgICAgICAgICAgICBldmVudFR5cGU6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dEV2ZW50VHlwZSgpLFxuICAgICAgICAgICAgICAgIHJvdXRlS2V5OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSb3V0ZUtleSgpLFxuICAgICAgICAgICAgICAgIGNvbm5lY3Rpb25JZDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0Q29ubmVjdGlvbklkKCksXG4gICAgICAgICAgICAgICAgc3RhdHVzOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRTdGF0dXMoKSxcbiAgICAgICAgICAgICAgICByZXNwb25zZUxlbmd0aDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0UmVzcG9uc2VMZW5ndGgoKSxcbiAgICAgICAgICAgICAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dEludGVncmF0aW9uTGF0ZW5jeSgpLFxuICAgICAgICAgICAgICAgIHJlcXVlc3RUaW1lOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXF1ZXN0VGltZSgpLFxuICAgICAgICAgICAgICAgIGlwOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRJZGVudGl0eVNvdXJjZUlwKCksXG4gICAgICAgICAgICAgICAgdXNlckFnZW50OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRJZGVudGl0eVVzZXJBZ2VudCgpLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICkpO1xuXG4gICAgICBhY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgICAgZGVzdGluYXRpb246IG5ldyBhcGlnd3YyLkxvZ0dyb3VwTG9nRGVzdGluYXRpb24obG9nR3JvdXApLFxuICAgICAgICBmb3JtYXQsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHRoaXMuc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5XZWJTb2NrZXRTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgIHdlYlNvY2tldEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZU5hbWUsXG4gICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgYWNjZXNzTG9nU2V0dGluZ3MsXG4gICAgfSk7XG5cbiAgICB7XG4gICAgICBjb25zdCBoYW5kbGVycyA9IG5ldyBTZXQ8bGFtYmRhLklGdW5jdGlvbj4oW2Nvbm5lY3RIYW5kbGVyLCBkaXNjb25uZWN0SGFuZGxlciwgZGVmYXVsdEhhbmRsZXJdKTtcbiAgICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuICAgICAgICB0aGlzLnN0YWdlLmdyYW50TWFuYWdlbWVudEFwaUFjY2VzcyhoYW5kbGVyKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiJdfQ==