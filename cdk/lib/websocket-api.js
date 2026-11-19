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
        const namingContext = props.namingContext;
        const logical = props.logicalName ?? (namingContext ? (0, logical_name_1.defaultLogicalName)(this) : undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryWebSocketApi", "apiName", "api_websocket", logical, props.apiName !== undefined);
        (0, refuse_explicit_name_1.refuseExplicitName)(namingContext, "AppTheoryWebSocketApi", "connectionTableName", "dynamodb_table", logical, props.connectionTableName !== undefined);
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
            this.connectionTable = new dynamodb.Table(this, "ConnectionTable", {
                tableName: derivedTableName && !derivedTableName.generated ? derivedTableName.name : props.connectionTableName,
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
            const contractName = namingContext && logical
                ? (0, standard_logging_1.accessLogGroupName)(namingContext, `logs/access/api/${logical}`)
                : undefined;
            const logGroup = props.accessLogGroup ??
                new logs.LogGroup(this, "AccessLogs", standard && namingContext && logical
                    ? {
                        logGroupName: contractName,
                        retention: (0, standard_logging_1.retentionFor)(namingContext.retentionDays),
                        removalPolicy: props.accessLogRemovalPolicy ?? aws_cdk_lib_1.RemovalPolicy.RETAIN,
                    }
                    : contractName !== undefined
                        ? {
                            logGroupName: contractName,
                            retention: props.accessLogRetention ?? logs.RetentionDays.ONE_WEEK,
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vic29ja2V0LWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIndlYnNvY2tldC1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE0QztBQUM1Qyx1RUFBeUQ7QUFDekQsc0VBQXdEO0FBQ3hELCtGQUFpRjtBQUNqRixtRUFBcUQ7QUFDckQseURBQTJDO0FBRTNDLDJEQUE2QztBQUM3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSxpRUFBMkc7QUFnRDNHLE1BQWEscUJBQXNCLFNBQVEsc0JBQVM7O0lBQ2xDLEdBQUcsQ0FBdUI7SUFDMUIsS0FBSyxDQUF5QjtJQUM5QixlQUFlLENBQW1CO0lBQ2xDLGNBQWMsQ0FBa0I7SUFFaEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFpQztRQUN6RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsU0FBUyxJQUFJLEtBQUssQ0FBQyxDQUFDLElBQUksRUFBRSxJQUFJLEtBQUssQ0FBQztRQUNuRSxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsYUFBYSxFQUFFLGVBQWUsS0FBSyxJQUFJLENBQUM7UUFDL0QsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsQ0FBQztRQUMxQyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsV0FBVyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxJQUFBLGlDQUFrQixFQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUM1RixJQUFBLHlDQUFrQixFQUFDLGFBQWEsRUFBRSx1QkFBdUIsRUFBRSxTQUFTLEVBQUUsZUFBZSxFQUFFLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxLQUFLLFNBQVMsQ0FBQyxDQUFDO1FBQzdILElB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O2dCQUMvQixJQUFJLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQy9DLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQzs7QUFqS0gsc0RBa0tDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgZGVmYXVsdExvZ2ljYWxOYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2dpY2FsLW5hbWVcIjtcbmltcG9ydCB7IHJlZnVzZUV4cGxpY2l0TmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvcmVmdXNlLWV4cGxpY2l0LW5hbWVcIjtcbmltcG9ydCB7IGFjY2Vzc0xvZ0dyb3VwTmFtZSwgcmV0ZW50aW9uRm9yLCB3ZWJTb2NrZXRBcGlBY2Nlc3NMb2dGb3JtYXQgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5V2ViU29ja2V0QXBpUHJvcHMge1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBjb25uZWN0SGFuZGxlcj86IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGRpc2Nvbm5lY3RIYW5kbGVyPzogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgZGVmYXVsdEhhbmRsZXI/OiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICByZWFkb25seSBlbmFibGVDb25uZWN0aW9uVGFibGU/OiBib29sZWFuO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVQYXJ0aXRpb25LZXlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVTb3J0S2V5TmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlVGltZVRvTGl2ZUF0dHJpYnV0ZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZUVuYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGVuYWJsZUFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBhY2Nlc3NMb2dGb3JtYXQ/OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdDtcblxuICAvKipcbiAgICogT3B0aW9uYWwgbmFtaW5nIGFuZCBsb2dnaW5nIGNvbnRleHQuXG4gICAqXG4gICAqIFdpdGggdGhlIHN0YW5kYXJkIGxvZ2dpbmcgcHJvZmlsZSBhY2Nlc3MgbG9nZ2luZyBpcyBvbiBieSBkZWZhdWx0IHRvIGEgbG9nXG4gICAqIGdyb3VwIG5hbWVkIGBsb2dzL2FjY2Vzcy9hcGkve2xvZ2ljYWxOYW1lfWAgY2FycnlpbmcgdGhlIGNvbnRyYWN0J3MgSlNPTlxuICAgKiBmaWVsZCBzZXQuIFBhc3MgYGVuYWJsZUFjY2Vzc0xvZ2dpbmc6IGZhbHNlYCB0byBvcHQgb3V0LlxuICAgKlxuICAgKiBXaXRoIG5vIGNvbnRleHQgdGhlIGNvbnN0cnVjdCBzeW50aGVzaXplcyBleGFjdGx5IGFzIGJlZm9yZS5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBuYW1pbmdDb250ZXh0PzogQXBwVGhlb3J5TmFtaW5nQ29udGV4dDtcblxuICAvKipcbiAgICogVGhlIEFQSSdzIGxvZ2ljYWwgbmFtZS4gRGVmYXVsdHMgdG8gdGhlIGtlYmFiLWNhc2VkIGNvbnN0cnVjdCBpZCB3aGVuIGFcbiAgICogbmFtaW5nIGNvbnRleHQgaXMgcHJlc2VudC5cbiAgICpcbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkXG4gICAqL1xuICByZWFkb25seSBsb2dpY2FsTmFtZT86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVdlYlNvY2tldEFwaSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuV2ViU29ja2V0QXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuV2ViU29ja2V0U3RhZ2U7XG4gIHB1YmxpYyByZWFkb25seSBjb25uZWN0aW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlXZWJTb2NrZXRBcGlQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBzdGFnZU5hbWUgPSBTdHJpbmcocHJvcHMuc3RhZ2VOYW1lID8/IFwiZGV2XCIpLnRyaW0oKSB8fCBcImRldlwiO1xuICAgIGNvbnN0IHN0YW5kYXJkID0gcHJvcHMubmFtaW5nQ29udGV4dD8uc3RhbmRhcmRMb2dnaW5nID09PSB0cnVlO1xuICAgIGNvbnN0IG5hbWluZ0NvbnRleHQgPSBwcm9wcy5uYW1pbmdDb250ZXh0O1xuICAgIGNvbnN0IGxvZ2ljYWwgPSBwcm9wcy5sb2dpY2FsTmFtZSA/PyAobmFtaW5nQ29udGV4dCA/IGRlZmF1bHRMb2dpY2FsTmFtZSh0aGlzKSA6IHVuZGVmaW5lZCk7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKG5hbWluZ0NvbnRleHQsIFwiQXBwVGhlb3J5V2ViU29ja2V0QXBpXCIsIFwiYXBpTmFtZVwiLCBcImFwaV93ZWJzb2NrZXRcIiwgbG9naWNhbCwgcHJvcHMuYXBpTmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUobmFtaW5nQ29udGV4dCwgXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGlcIiwgXCJjb25uZWN0aW9uVGFibGVOYW1lXCIsIFwiZHluYW1vZGJfdGFibGVcIiwgbG9naWNhbCwgcHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkKTtcbiAgICBjb25zdCBkZXJpdmVkQXBpTmFtZSA9IG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCA/IG5hbWluZ0NvbnRleHQucGh5c2ljYWxOYW1lKFwiYXBpX3dlYnNvY2tldFwiLCBsb2dpY2FsKSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjb25uZWN0SGFuZGxlciA9IHByb3BzLmNvbm5lY3RIYW5kbGVyID8/IHByb3BzLmhhbmRsZXI7XG4gICAgY29uc3QgZGlzY29ubmVjdEhhbmRsZXIgPSBwcm9wcy5kaXNjb25uZWN0SGFuZGxlciA/PyBwcm9wcy5oYW5kbGVyO1xuICAgIGNvbnN0IGRlZmF1bHRIYW5kbGVyID0gcHJvcHMuZGVmYXVsdEhhbmRsZXIgPz8gcHJvcHMuaGFuZGxlcjtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuV2ViU29ja2V0QXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IGRlcml2ZWRBcGlOYW1lICYmICFkZXJpdmVkQXBpTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkQXBpTmFtZS5uYW1lIDogcHJvcHMuYXBpTmFtZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHVzZVJvdXRlU3BlY2lmaWNIYW5kbGVycyA9XG4gICAgICBCb29sZWFuKHByb3BzLmNvbm5lY3RIYW5kbGVyKSB8fCBCb29sZWFuKHByb3BzLmRpc2Nvbm5lY3RIYW5kbGVyKSB8fCBCb29sZWFuKHByb3BzLmRlZmF1bHRIYW5kbGVyKTtcbiAgICBpZiAodXNlUm91dGVTcGVjaWZpY0hhbmRsZXJzKSB7XG4gICAgICBjb25zdCBjb25uZWN0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcIkNvbm5lY3RIYW5kbGVyXCIsIGNvbm5lY3RIYW5kbGVyKTtcbiAgICAgIGNvbnN0IGRpc2Nvbm5lY3RJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBcIkRpc2Nvbm5lY3RIYW5kbGVyXCIsXG4gICAgICAgIGRpc2Nvbm5lY3RIYW5kbGVyLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGRlZmF1bHRJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFwiRGVmYXVsdEhhbmRsZXJcIiwgZGVmYXVsdEhhbmRsZXIpO1xuXG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRjb25uZWN0XCIsIHsgaW50ZWdyYXRpb246IGNvbm5lY3RJbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRpc2Nvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbjogZGlzY29ubmVjdEludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGVmYXVsdFwiLCB7IGludGVncmF0aW9uOiBkZWZhdWx0SW50ZWdyYXRpb24gfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXCJIYW5kbGVyXCIsIHByb3BzLmhhbmRsZXIpO1xuXG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRjb25uZWN0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkaXNjb25uZWN0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkZWZhdWx0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2hvdWxkQ3JlYXRlQ29ubmVjdGlvblRhYmxlID1cbiAgICAgIChwcm9wcy5lbmFibGVDb25uZWN0aW9uVGFibGUgPz8gZmFsc2UpIHx8IEJvb2xlYW4ocHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZSk7XG4gICAgaWYgKHByb3BzLmNvbm5lY3Rpb25UYWJsZSAmJiBzaG91bGRDcmVhdGVDb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGkgc3VwcG9ydHMgZWl0aGVyIHByb3BzLmNvbm5lY3Rpb25UYWJsZSBvciBwcm9wcy5lbmFibGVDb25uZWN0aW9uVGFibGUvcHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZVwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuY29ubmVjdGlvblRhYmxlKSB7XG4gICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZTtcbiAgICB9IGVsc2UgaWYgKHNob3VsZENyZWF0ZUNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgY29uc3QgZGVyaXZlZFRhYmxlTmFtZSA9IG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICA/IG5hbWluZ0NvbnRleHQucGh5c2ljYWxOYW1lKFwiZHluYW1vZGJfdGFibGVcIiwgYCR7bG9naWNhbH0tY29ubmVjdGlvbnNgKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHBrTmFtZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVBhcnRpdGlvbktleU5hbWUgPz8gXCJQS1wiO1xuICAgICAgY29uc3Qgc2tOYW1lID0gcHJvcHMuY29ubmVjdGlvblRhYmxlU29ydEtleU5hbWUgPz8gXCJTS1wiO1xuICAgICAgY29uc3QgdHRsQXR0cmlidXRlID0gcHJvcHMuY29ubmVjdGlvblRhYmxlVGltZVRvTGl2ZUF0dHJpYnV0ZSA/PyBcInR0bFwiO1xuICAgICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgICBjb25zdCBlbmFibGVQSVRSID0gcHJvcHMuY29ubmVjdGlvblRhYmxlRW5hYmxlUG9pbnRJblRpbWVSZWNvdmVyeSA/PyB0cnVlO1xuXG4gICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZSA9IG5ldyBkeW5hbW9kYi5UYWJsZSh0aGlzLCBcIkNvbm5lY3Rpb25UYWJsZVwiLCB7XG4gICAgICAgIHRhYmxlTmFtZTogZGVyaXZlZFRhYmxlTmFtZSAmJiAhZGVyaXZlZFRhYmxlTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkVGFibGVOYW1lLm5hbWUgOiBwcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogcGtOYW1lLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICBzb3J0S2V5OiB7IG5hbWU6IHNrTmFtZSwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogdHRsQXR0cmlidXRlLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiBlbmFibGVQSVRSLFxuICAgICAgICB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5jb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIGNvbnN0IGhhbmRsZXJzID0gbmV3IFNldDxsYW1iZGEuSUZ1bmN0aW9uPihbY29ubmVjdEhhbmRsZXIsIGRpc2Nvbm5lY3RIYW5kbGVyLCBkZWZhdWx0SGFuZGxlcl0pO1xuICAgICAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzKSB7XG4gICAgICAgIHRoaXMuY29ubmVjdGlvblRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShoYW5kbGVyKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBsZXQgYWNjZXNzTG9nU2V0dGluZ3M6IGFwaWd3djIuSUFjY2Vzc0xvZ1NldHRpbmdzIHwgdW5kZWZpbmVkO1xuICAgIGlmIChwcm9wcy5lbmFibGVBY2Nlc3NMb2dnaW5nID8/IHN0YW5kYXJkKSB7XG4gICAgICBpZiAoc3RhbmRhcmQgJiYgIXByb3BzLmFjY2Vzc0xvZ0dyb3VwICYmICFsb2dpY2FsKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcIkFwcFRoZW9yeVdlYlNvY2tldEFwaSBzdGFuZGFyZCBsb2dnaW5nIHJlcXVpcmVzIGEgbG9naWNhbCBuYW1lXCIpO1xuICAgICAgfVxuICAgICAgY29uc3QgY29udHJhY3ROYW1lID0gbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsXG4gICAgICAgID8gYWNjZXNzTG9nR3JvdXBOYW1lKG5hbWluZ0NvbnRleHQsIGBsb2dzL2FjY2Vzcy9hcGkvJHtsb2dpY2FsfWApXG4gICAgICAgIDogdW5kZWZpbmVkO1xuICAgICAgY29uc3QgbG9nR3JvdXAgPVxuICAgICAgICBwcm9wcy5hY2Nlc3NMb2dHcm91cCA/P1xuICAgICAgICBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCBcIkFjY2Vzc0xvZ3NcIixcbiAgICAgICAgICBzdGFuZGFyZCAmJiBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBjb250cmFjdE5hbWUsXG4gICAgICAgICAgICAgIHJldGVudGlvbjogcmV0ZW50aW9uRm9yKG5hbWluZ0NvbnRleHQucmV0ZW50aW9uRGF5cyksXG4gICAgICAgICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmFjY2Vzc0xvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICAgICAgICB9XG4gICAgICAgICAgOiBjb250cmFjdE5hbWUgIT09IHVuZGVmaW5lZFxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBjb250cmFjdE5hbWUsXG4gICAgICAgICAgICAgICAgcmV0ZW50aW9uOiBwcm9wcy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgICAgICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmFjY2Vzc0xvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIDoge1xuICAgICAgICAgICAgICAgIHJldGVudGlvbjogcHJvcHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgICAgICAgICAgICByZW1vdmFsUG9saWN5OiBwcm9wcy5hY2Nlc3NMb2dSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOLFxuICAgICAgICAgICAgICB9KTtcbiAgICAgIHRoaXMuYWNjZXNzTG9nR3JvdXAgPSBsb2dHcm91cDtcblxuICAgICAgbG9nR3JvdXAuYWRkVG9SZXNvdXJjZVBvbGljeShcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIHByaW5jaXBhbHM6IFtuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJhcGlnYXRld2F5LmFtYXpvbmF3cy5jb21cIildLFxuICAgICAgICAgIGFjdGlvbnM6IFtcImxvZ3M6Q3JlYXRlTG9nU3RyZWFtXCIsIFwibG9nczpEZXNjcmliZUxvZ1N0cmVhbXNcIiwgXCJsb2dzOlB1dExvZ0V2ZW50c1wiXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtsb2dHcm91cC5sb2dHcm91cEFybl0sXG4gICAgICAgIH0pLFxuICAgICAgKTtcblxuICAgICAgY29uc3QgZm9ybWF0ID1cbiAgICAgICAgcHJvcHMuYWNjZXNzTG9nRm9ybWF0ID8/XG4gICAgICAgIChzdGFuZGFyZFxuICAgICAgICAgID8gYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGb3JtYXQuY3VzdG9tKHdlYlNvY2tldEFwaUFjY2Vzc0xvZ0Zvcm1hdCgpKVxuICAgICAgICAgIDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGb3JtYXQuY3VzdG9tKFxuICAgICAgICAgICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgcmVxdWVzdElkOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXF1ZXN0SWQoKSxcbiAgICAgICAgICAgICAgICBldmVudFR5cGU6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dEV2ZW50VHlwZSgpLFxuICAgICAgICAgICAgICAgIHJvdXRlS2V5OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSb3V0ZUtleSgpLFxuICAgICAgICAgICAgICAgIGNvbm5lY3Rpb25JZDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0Q29ubmVjdGlvbklkKCksXG4gICAgICAgICAgICAgICAgc3RhdHVzOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRTdGF0dXMoKSxcbiAgICAgICAgICAgICAgICByZXNwb25zZUxlbmd0aDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0UmVzcG9uc2VMZW5ndGgoKSxcbiAgICAgICAgICAgICAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dEludGVncmF0aW9uTGF0ZW5jeSgpLFxuICAgICAgICAgICAgICAgIHJlcXVlc3RUaW1lOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXF1ZXN0VGltZSgpLFxuICAgICAgICAgICAgICAgIGlwOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRJZGVudGl0eVNvdXJjZUlwKCksXG4gICAgICAgICAgICAgICAgdXNlckFnZW50OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRJZGVudGl0eVVzZXJBZ2VudCgpLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICkpO1xuXG4gICAgICBhY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgICAgZGVzdGluYXRpb246IG5ldyBhcGlnd3YyLkxvZ0dyb3VwTG9nRGVzdGluYXRpb24obG9nR3JvdXApLFxuICAgICAgICBmb3JtYXQsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHRoaXMuc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5XZWJTb2NrZXRTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgIHdlYlNvY2tldEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZU5hbWUsXG4gICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgYWNjZXNzTG9nU2V0dGluZ3MsXG4gICAgfSk7XG5cbiAgICB7XG4gICAgICBjb25zdCBoYW5kbGVycyA9IG5ldyBTZXQ8bGFtYmRhLklGdW5jdGlvbj4oW2Nvbm5lY3RIYW5kbGVyLCBkaXNjb25uZWN0SGFuZGxlciwgZGVmYXVsdEhhbmRsZXJdKTtcbiAgICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuICAgICAgICB0aGlzLnN0YWdlLmdyYW50TWFuYWdlbWVudEFwaUFjY2VzcyhoYW5kbGVyKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiJdfQ==