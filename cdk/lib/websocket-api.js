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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryWebSocketApi", version: "7.5.0-rc" };
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vic29ja2V0LWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIndlYnNvY2tldC1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE0QztBQUM1Qyx1RUFBeUQ7QUFDekQsc0VBQXdEO0FBQ3hELCtGQUFpRjtBQUNqRixtRUFBcUQ7QUFDckQseURBQTJDO0FBRTNDLDJEQUE2QztBQUM3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSxpRUFBdUY7QUFnRHZGLE1BQWEscUJBQXNCLFNBQVEsc0JBQVM7O0lBQ2xDLEdBQUcsQ0FBdUI7SUFDMUIsS0FBSyxDQUF5QjtJQUM5QixlQUFlLENBQW1CO0lBQ2xDLGNBQWMsQ0FBa0I7SUFFaEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFpQztRQUN6RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsU0FBUyxJQUFJLEtBQUssQ0FBQyxDQUFDLElBQUksRUFBRSxJQUFJLEtBQUssQ0FBQztRQUNuRSxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsYUFBYSxFQUFFLGVBQWUsS0FBSyxJQUFJLENBQUM7UUFDL0QsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsQ0FBQztRQUMxQyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsV0FBVyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxJQUFBLGlDQUFrQixFQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUM1RixJQUFBLHlDQUFrQixFQUFDLGFBQWEsRUFBRSx1QkFBdUIsRUFBRSxTQUFTLEVBQUUsZUFBZSxFQUFFLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxLQUFLLFNBQVMsQ0FBQyxDQUFDO1FBQzdILElB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LE1BQU0sRUFBRSxVQUFVLENBQUMsY0FBYyxDQUFDLGFBQWEsRUFBRTt3QkFDakQsY0FBYyxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMscUJBQXFCLEVBQUU7d0JBQ2pFLGtCQUFrQixFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMseUJBQXlCLEVBQUU7d0JBQ3pFLFdBQVcsRUFBRSxVQUFVLENBQUMsY0FBYyxDQUFDLGtCQUFrQixFQUFFO3dCQUMzRCxFQUFFLEVBQUUsVUFBVSxDQUFDLGNBQWMsQ0FBQyx1QkFBdUIsRUFBRTt3QkFDdkQsU0FBUyxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMsd0JBQXdCLEVBQUU7cUJBQ2hFLENBQUMsQ0FDSCxDQUFDLENBQUM7WUFFVCxpQkFBaUIsR0FBRztnQkFDbEIsV0FBVyxFQUFFLElBQUksT0FBTyxDQUFDLHNCQUFzQixDQUFDLFFBQVEsQ0FBQztnQkFDekQsTUFBTTthQUNQLENBQUM7UUFDSixDQUFDO1FBRUQsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLE9BQU8sQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtZQUNyRCxZQUFZLEVBQUUsSUFBSSxDQUFDLEdBQUc7WUFDdEIsU0FBUztZQUNULFVBQVUsRUFBRSxJQUFJO1lBQ2hCLGlCQUFpQjtTQUNsQixDQUFDLENBQUM7UUFFSCxDQUFDO1lBQ0MsTUFBTSxRQUFRLEdBQUcsSUFBSSxHQUFHLENBQW1CLENBQUMsY0FBYyxFQUFFLGlCQUFpQixFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUM7WUFDaEcsS0FBSyxNQUFNLE9BQU8sSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDL0IsSUFBSSxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUMvQyxDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7O0FBbEtILHNEQW1LQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5pbXBvcnQgeyByZXRlbnRpb25Gb3IsIHdlYlNvY2tldEFwaUFjY2Vzc0xvZ0Zvcm1hdCB9IGZyb20gXCIuL3ByaXZhdGUvc3RhbmRhcmQtbG9nZ2luZ1wiO1xuaW1wb3J0IHR5cGUgeyBBcHBUaGVvcnlOYW1pbmdDb250ZXh0IH0gZnJvbSBcIi4vbmFtaW5nLWNvbnRleHRcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlXZWJTb2NrZXRBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGNvbm5lY3RIYW5kbGVyPzogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgZGlzY29ubmVjdEhhbmRsZXI/OiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBkZWZhdWx0SGFuZGxlcj86IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICByZWFkb25seSBjb25uZWN0aW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHJlYWRvbmx5IGVuYWJsZUNvbm5lY3Rpb25UYWJsZT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVBhcnRpdGlvbktleU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVNvcnRLZXlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVUaW1lVG9MaXZlQXR0cmlidXRlPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlRW5hYmxlUG9pbnRJblRpbWVSZWNvdmVyeT86IGJvb2xlYW47XG5cbiAgcmVhZG9ubHkgZW5hYmxlQWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IGFwaWdhdGV3YXkuQWNjZXNzTG9nRm9ybWF0O1xuXG4gIC8qKlxuICAgKiBPcHRpb25hbCBuYW1pbmcgYW5kIGxvZ2dpbmcgY29udGV4dC5cbiAgICpcbiAgICogV2l0aCB0aGUgc3RhbmRhcmQgbG9nZ2luZyBwcm9maWxlIGFjY2VzcyBsb2dnaW5nIGlzIG9uIGJ5IGRlZmF1bHQgdG8gYSBsb2dcbiAgICogZ3JvdXAgbmFtZWQgYGxvZ3MvYWNjZXNzL2FwaS97bG9naWNhbE5hbWV9YCBjYXJyeWluZyB0aGUgY29udHJhY3QncyBKU09OXG4gICAqIGZpZWxkIHNldC4gUGFzcyBgZW5hYmxlQWNjZXNzTG9nZ2luZzogZmFsc2VgIHRvIG9wdCBvdXQuXG4gICAqXG4gICAqIFdpdGggbm8gY29udGV4dCB0aGUgY29uc3RydWN0IHN5bnRoZXNpemVzIGV4YWN0bHkgYXMgYmVmb3JlLlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IG5hbWluZ0NvbnRleHQ/OiBBcHBUaGVvcnlOYW1pbmdDb250ZXh0O1xuXG4gIC8qKlxuICAgKiBUaGUgQVBJJ3MgbG9naWNhbCBuYW1lLiBEZWZhdWx0cyB0byB0aGUga2ViYWItY2FzZWQgY29uc3RydWN0IGlkIHdoZW4gYVxuICAgKiBuYW1pbmcgY29udGV4dCBpcyBwcmVzZW50LlxuICAgKlxuICAgKiBAZGVmYXVsdCB1bmRlZmluZWRcbiAgICovXG4gIHJlYWRvbmx5IGxvZ2ljYWxOYW1lPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5V2ViU29ja2V0QXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5XZWJTb2NrZXRBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3d2Mi5XZWJTb2NrZXRTdGFnZTtcbiAgcHVibGljIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVdlYlNvY2tldEFwaVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHN0YWdlTmFtZSA9IFN0cmluZyhwcm9wcy5zdGFnZU5hbWUgPz8gXCJkZXZcIikudHJpbSgpIHx8IFwiZGV2XCI7XG4gICAgY29uc3Qgc3RhbmRhcmQgPSBwcm9wcy5uYW1pbmdDb250ZXh0Py5zdGFuZGFyZExvZ2dpbmcgPT09IHRydWU7XG4gICAgY29uc3QgbmFtaW5nQ29udGV4dCA9IHByb3BzLm5hbWluZ0NvbnRleHQ7XG4gICAgY29uc3QgbG9naWNhbCA9IHByb3BzLmxvZ2ljYWxOYW1lID8/IChuYW1pbmdDb250ZXh0ID8gZGVmYXVsdExvZ2ljYWxOYW1lKHRoaXMpIDogdW5kZWZpbmVkKTtcbiAgICByZWZ1c2VFeHBsaWNpdE5hbWUobmFtaW5nQ29udGV4dCwgXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGlcIiwgXCJhcGlOYW1lXCIsIFwiYXBpX3dlYnNvY2tldFwiLCBsb2dpY2FsLCBwcm9wcy5hcGlOYW1lICE9PSB1bmRlZmluZWQpO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShcbiAgICAgIG5hbWluZ0NvbnRleHQsXG4gICAgICBcIkFwcFRoZW9yeVdlYlNvY2tldEFwaVwiLFxuICAgICAgXCJjb25uZWN0aW9uVGFibGVOYW1lXCIsXG4gICAgICBcImR5bmFtb2RiX3RhYmxlXCIsXG4gICAgICBsb2dpY2FsID8gYCR7bG9naWNhbH0tY29ubmVjdGlvbnNgIDogdW5kZWZpbmVkLFxuICAgICAgcHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZSAhPT0gdW5kZWZpbmVkLFxuICAgICk7XG4gICAgY29uc3QgZGVyaXZlZEFwaU5hbWUgPSBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwgPyBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImFwaV93ZWJzb2NrZXRcIiwgbG9naWNhbCkgOiB1bmRlZmluZWQ7XG4gICAgY29uc3QgY29ubmVjdEhhbmRsZXIgPSBwcm9wcy5jb25uZWN0SGFuZGxlciA/PyBwcm9wcy5oYW5kbGVyO1xuICAgIGNvbnN0IGRpc2Nvbm5lY3RIYW5kbGVyID0gcHJvcHMuZGlzY29ubmVjdEhhbmRsZXIgPz8gcHJvcHMuaGFuZGxlcjtcbiAgICBjb25zdCBkZWZhdWx0SGFuZGxlciA9IHByb3BzLmRlZmF1bHRIYW5kbGVyID8/IHByb3BzLmhhbmRsZXI7XG5cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnd3YyLldlYlNvY2tldEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBkZXJpdmVkQXBpTmFtZSAmJiAhZGVyaXZlZEFwaU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZEFwaU5hbWUubmFtZSA6IHByb3BzLmFwaU5hbWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCB1c2VSb3V0ZVNwZWNpZmljSGFuZGxlcnMgPVxuICAgICAgQm9vbGVhbihwcm9wcy5jb25uZWN0SGFuZGxlcikgfHwgQm9vbGVhbihwcm9wcy5kaXNjb25uZWN0SGFuZGxlcikgfHwgQm9vbGVhbihwcm9wcy5kZWZhdWx0SGFuZGxlcik7XG4gICAgaWYgKHVzZVJvdXRlU3BlY2lmaWNIYW5kbGVycykge1xuICAgICAgY29uc3QgY29ubmVjdEludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXCJDb25uZWN0SGFuZGxlclwiLCBjb25uZWN0SGFuZGxlcik7XG4gICAgICBjb25zdCBkaXNjb25uZWN0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgXCJEaXNjb25uZWN0SGFuZGxlclwiLFxuICAgICAgICBkaXNjb25uZWN0SGFuZGxlcixcbiAgICAgICk7XG4gICAgICBjb25zdCBkZWZhdWx0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcIkRlZmF1bHRIYW5kbGVyXCIsIGRlZmF1bHRIYW5kbGVyKTtcblxuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkY29ubmVjdFwiLCB7IGludGVncmF0aW9uOiBjb25uZWN0SW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkaXNjb25uZWN0XCIsIHsgaW50ZWdyYXRpb246IGRpc2Nvbm5lY3RJbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRlZmF1bHRcIiwgeyBpbnRlZ3JhdGlvbjogZGVmYXVsdEludGVncmF0aW9uIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFwiSGFuZGxlclwiLCBwcm9wcy5oYW5kbGVyKTtcblxuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkY29ubmVjdFwiLCB7IGludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGlzY29ubmVjdFwiLCB7IGludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGVmYXVsdFwiLCB7IGludGVncmF0aW9uIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHNob3VsZENyZWF0ZUNvbm5lY3Rpb25UYWJsZSA9XG4gICAgICAocHJvcHMuZW5hYmxlQ29ubmVjdGlvblRhYmxlID8/IGZhbHNlKSB8fCBCb29sZWFuKHByb3BzLmNvbm5lY3Rpb25UYWJsZU5hbWUpO1xuICAgIGlmIChwcm9wcy5jb25uZWN0aW9uVGFibGUgJiYgc2hvdWxkQ3JlYXRlQ29ubmVjdGlvblRhYmxlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5V2ViU29ja2V0QXBpIHN1cHBvcnRzIGVpdGhlciBwcm9wcy5jb25uZWN0aW9uVGFibGUgb3IgcHJvcHMuZW5hYmxlQ29ubmVjdGlvblRhYmxlL3Byb3BzLmNvbm5lY3Rpb25UYWJsZU5hbWVcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgdGhpcy5jb25uZWN0aW9uVGFibGUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGU7XG4gICAgfSBlbHNlIGlmIChzaG91bGRDcmVhdGVDb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIGNvbnN0IGRlcml2ZWRUYWJsZU5hbWUgPSBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgPyBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImR5bmFtb2RiX3RhYmxlXCIsIGAke2xvZ2ljYWx9LWNvbm5lY3Rpb25zYClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBwa05hbWUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVQYXJ0aXRpb25LZXlOYW1lID8/IFwiUEtcIjtcbiAgICAgIGNvbnN0IHNrTmFtZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVNvcnRLZXlOYW1lID8/IFwiU0tcIjtcbiAgICAgIGNvbnN0IHR0bEF0dHJpYnV0ZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVRpbWVUb0xpdmVBdHRyaWJ1dGUgPz8gXCJ0dGxcIjtcbiAgICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgICAgY29uc3QgZW5hYmxlUElUUiA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZUVuYWJsZVBvaW50SW5UaW1lUmVjb3ZlcnkgPz8gdHJ1ZTtcblxuICAgICAgdGhpcy5jb25uZWN0aW9uVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJDb25uZWN0aW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IGRlcml2ZWRUYWJsZU5hbWUgJiYgIWRlcml2ZWRUYWJsZU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZFRhYmxlTmFtZS5uYW1lIDogcHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IHBrTmFtZSwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgc29ydEtleTogeyBuYW1lOiBza05hbWUsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IHR0bEF0dHJpYnV0ZSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogZW5hYmxlUElUUixcbiAgICAgICAgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuY29ubmVjdGlvblRhYmxlKSB7XG4gICAgICBjb25zdCBoYW5kbGVycyA9IG5ldyBTZXQ8bGFtYmRhLklGdW5jdGlvbj4oW2Nvbm5lY3RIYW5kbGVyLCBkaXNjb25uZWN0SGFuZGxlciwgZGVmYXVsdEhhbmRsZXJdKTtcbiAgICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuICAgICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaGFuZGxlcik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGV0IGFjY2Vzc0xvZ1NldHRpbmdzOiBhcGlnd3YyLklBY2Nlc3NMb2dTZXR0aW5ncyB8IHVuZGVmaW5lZDtcbiAgICBpZiAocHJvcHMuZW5hYmxlQWNjZXNzTG9nZ2luZyA/PyBzdGFuZGFyZCkge1xuICAgICAgaWYgKHN0YW5kYXJkICYmICFwcm9wcy5hY2Nlc3NMb2dHcm91cCAmJiAhbG9naWNhbCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGkgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIGxvZ2ljYWwgbmFtZVwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxvZ0dyb3VwID1cbiAgICAgICAgcHJvcHMuYWNjZXNzTG9nR3JvdXAgPz9cbiAgICAgICAgbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsXG4gICAgICAgICAgLy8gVGhlIGNvbnN0cnVjdC1jcmVhdGVkIGFjY2Vzcy1sb2cgZ3JvdXAgaXMgYSBsb2dnaW5nIHJlc291cmNlOiB0aGVcbiAgICAgICAgICAvLyBzdGFuZGFyZCBwcm9maWxlIG5hbWVzIGl0IGZyb20gdGhlIGNvbnRyYWN0LCBhbmQgdGhlIGxlZ2FjeSBwcm9maWxlXG4gICAgICAgICAgLy8ga2VlcHMgdG9kYXkncyBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZSBhbmQgY29uc3VtZXMgbm8gZW50cnkuXG4gICAgICAgICAgc3RhbmRhcmQgJiYgbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogbmFtaW5nQ29udGV4dC5sb2dHcm91cE5hbWUoYGxvZ3MvYWNjZXNzL2FwaS8ke2xvZ2ljYWx9YCksXG4gICAgICAgICAgICAgIHJldGVudGlvbjogcmV0ZW50aW9uRm9yKG5hbWluZ0NvbnRleHQucmV0ZW50aW9uRGF5cyksXG4gICAgICAgICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmFjY2Vzc0xvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICAgICAgICB9XG4gICAgICAgICAgOiB7XG4gICAgICAgICAgICAgIHJldGVudGlvbjogcHJvcHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuYWNjZXNzTG9nUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICAgICAgICAgIH0pO1xuICAgICAgdGhpcy5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgICBsb2dHcm91cC5hZGRUb1Jlc291cmNlUG9saWN5KFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgcHJpbmNpcGFsczogW25ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiKV0sXG4gICAgICAgICAgYWN0aW9uczogW1wibG9nczpDcmVhdGVMb2dTdHJlYW1cIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiLCBcImxvZ3M6UHV0TG9nRXZlbnRzXCJdLFxuICAgICAgICAgIHJlc291cmNlczogW2xvZ0dyb3VwLmxvZ0dyb3VwQXJuXSxcbiAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgICBjb25zdCBmb3JtYXQgPVxuICAgICAgICBwcm9wcy5hY2Nlc3NMb2dGb3JtYXQgPz9cbiAgICAgICAgKHN0YW5kYXJkXG4gICAgICAgICAgPyBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20od2ViU29ja2V0QXBpQWNjZXNzTG9nRm9ybWF0KCkpXG4gICAgICAgICAgOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20oXG4gICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICByZXF1ZXN0SWQ6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlcXVlc3RJZCgpLFxuICAgICAgICAgICAgICAgIGV2ZW50VHlwZTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0RXZlbnRUeXBlKCksXG4gICAgICAgICAgICAgICAgcm91dGVLZXk6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJvdXRlS2V5KCksXG4gICAgICAgICAgICAgICAgY29ubmVjdGlvbklkOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRDb25uZWN0aW9uSWQoKSxcbiAgICAgICAgICAgICAgICBzdGF0dXM6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFN0YXR1cygpLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXNwb25zZUxlbmd0aCgpLFxuICAgICAgICAgICAgICAgIGludGVncmF0aW9uTGF0ZW5jeTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0SW50ZWdyYXRpb25MYXRlbmN5KCksXG4gICAgICAgICAgICAgICAgcmVxdWVzdFRpbWU6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlcXVlc3RUaW1lKCksXG4gICAgICAgICAgICAgICAgaXA6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dElkZW50aXR5U291cmNlSXAoKSxcbiAgICAgICAgICAgICAgICB1c2VyQWdlbnQ6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dElkZW50aXR5VXNlckFnZW50KCksXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgKSk7XG5cbiAgICAgIGFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICBkZXN0aW5hdGlvbjogbmV3IGFwaWd3djIuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihsb2dHcm91cCksXG4gICAgICAgIGZvcm1hdCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgdGhpcy5zdGFnZSA9IG5ldyBhcGlnd3YyLldlYlNvY2tldFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgd2ViU29ja2V0QXBpOiB0aGlzLmFwaSxcbiAgICAgIHN0YWdlTmFtZSxcbiAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICBhY2Nlc3NMb2dTZXR0aW5ncyxcbiAgICB9KTtcblxuICAgIHtcbiAgICAgIGNvbnN0IGhhbmRsZXJzID0gbmV3IFNldDxsYW1iZGEuSUZ1bmN0aW9uPihbY29ubmVjdEhhbmRsZXIsIGRpc2Nvbm5lY3RIYW5kbGVyLCBkZWZhdWx0SGFuZGxlcl0pO1xuICAgICAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzKSB7XG4gICAgICAgIHRoaXMuc3RhZ2UuZ3JhbnRNYW5hZ2VtZW50QXBpQWNjZXNzKGhhbmRsZXIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIl19