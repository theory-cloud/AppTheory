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
            const contractName = !props.accessLogGroup && namingContext && logical
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vic29ja2V0LWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIndlYnNvY2tldC1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE0QztBQUM1Qyx1RUFBeUQ7QUFDekQsc0VBQXdEO0FBQ3hELCtGQUFpRjtBQUNqRixtRUFBcUQ7QUFDckQseURBQTJDO0FBRTNDLDJEQUE2QztBQUM3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSxpRUFBMkc7QUFnRDNHLE1BQWEscUJBQXNCLFNBQVEsc0JBQVM7O0lBQ2xDLEdBQUcsQ0FBdUI7SUFDMUIsS0FBSyxDQUF5QjtJQUM5QixlQUFlLENBQW1CO0lBQ2xDLGNBQWMsQ0FBa0I7SUFFaEQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFpQztRQUN6RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLE1BQU0sU0FBUyxHQUFHLE1BQU0sQ0FBQyxLQUFLLENBQUMsU0FBUyxJQUFJLEtBQUssQ0FBQyxDQUFDLElBQUksRUFBRSxJQUFJLEtBQUssQ0FBQztRQUNuRSxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsYUFBYSxFQUFFLGVBQWUsS0FBSyxJQUFJLENBQUM7UUFDL0QsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLGFBQWEsQ0FBQztRQUMxQyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsV0FBVyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxJQUFBLGlDQUFrQixFQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUM1RixJQUFBLHlDQUFrQixFQUFDLGFBQWEsRUFBRSx1QkFBdUIsRUFBRSxTQUFTLEVBQUUsZUFBZSxFQUFFLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTyxLQUFLLFNBQVMsQ0FBQyxDQUFDO1FBQzdILElB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LE9BQU8sSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDL0IsSUFBSSxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUMvQyxDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7O0FBaktILHNEQWtLQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmltcG9ydCB7IGRlZmF1bHRMb2dpY2FsTmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvbG9naWNhbC1uYW1lXCI7XG5pbXBvcnQgeyByZWZ1c2VFeHBsaWNpdE5hbWUgfSBmcm9tIFwiLi9wcml2YXRlL3JlZnVzZS1leHBsaWNpdC1uYW1lXCI7XG5pbXBvcnQgeyBhY2Nlc3NMb2dHcm91cE5hbWUsIHJldGVudGlvbkZvciwgd2ViU29ja2V0QXBpQWNjZXNzTG9nRm9ybWF0IH0gZnJvbSBcIi4vcHJpdmF0ZS9zdGFuZGFyZC1sb2dnaW5nXCI7XG5pbXBvcnQgdHlwZSB7IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQgfSBmcm9tIFwiLi9uYW1pbmctY29udGV4dFwiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVdlYlNvY2tldEFwaVByb3BzIHtcbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgY29ubmVjdEhhbmRsZXI/OiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBkaXNjb25uZWN0SGFuZGxlcj86IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGRlZmF1bHRIYW5kbGVyPzogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcmVhZG9ubHkgZW5hYmxlQ29ubmVjdGlvblRhYmxlPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlUGFydGl0aW9uS2V5TmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlU29ydEtleU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVRpbWVUb0xpdmVBdHRyaWJ1dGU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVFbmFibGVQb2ludEluVGltZVJlY292ZXJ5PzogYm9vbGVhbjtcblxuICByZWFkb25seSBlbmFibGVBY2Nlc3NMb2dnaW5nPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0PzogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGb3JtYXQ7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgKlxuICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgYWNjZXNzIGxvZ2dpbmcgaXMgb24gYnkgZGVmYXVsdCB0byBhIGxvZ1xuICAgKiBncm91cCBuYW1lZCBgbG9ncy9hY2Nlc3MvYXBpL3tsb2dpY2FsTmFtZX1gIGNhcnJ5aW5nIHRoZSBjb250cmFjdCdzIEpTT05cbiAgICogZmllbGQgc2V0LiBQYXNzIGBlbmFibGVBY2Nlc3NMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dC5cbiAgICpcbiAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBBUEkncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlbiBhXG4gICAqIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlXZWJTb2NrZXRBcGkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLldlYlNvY2tldEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlnd3YyLldlYlNvY2tldFN0YWdlO1xuICBwdWJsaWMgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5V2ViU29ja2V0QXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gU3RyaW5nKHByb3BzLnN0YWdlTmFtZSA/PyBcImRldlwiKS50cmltKCkgfHwgXCJkZXZcIjtcbiAgICBjb25zdCBzdGFuZGFyZCA9IHByb3BzLm5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZTtcbiAgICBjb25zdCBuYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeVdlYlNvY2tldEFwaVwiLCBcImFwaU5hbWVcIiwgXCJhcGlfd2Vic29ja2V0XCIsIGxvZ2ljYWwsIHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKG5hbWluZ0NvbnRleHQsIFwiQXBwVGhlb3J5V2ViU29ja2V0QXBpXCIsIFwiY29ubmVjdGlvblRhYmxlTmFtZVwiLCBcImR5bmFtb2RiX3RhYmxlXCIsIGxvZ2ljYWwsIHByb3BzLmNvbm5lY3Rpb25UYWJsZU5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgY29uc3QgZGVyaXZlZEFwaU5hbWUgPSBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWwgPyBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImFwaV93ZWJzb2NrZXRcIiwgbG9naWNhbCkgOiB1bmRlZmluZWQ7XG4gICAgY29uc3QgY29ubmVjdEhhbmRsZXIgPSBwcm9wcy5jb25uZWN0SGFuZGxlciA/PyBwcm9wcy5oYW5kbGVyO1xuICAgIGNvbnN0IGRpc2Nvbm5lY3RIYW5kbGVyID0gcHJvcHMuZGlzY29ubmVjdEhhbmRsZXIgPz8gcHJvcHMuaGFuZGxlcjtcbiAgICBjb25zdCBkZWZhdWx0SGFuZGxlciA9IHByb3BzLmRlZmF1bHRIYW5kbGVyID8/IHByb3BzLmhhbmRsZXI7XG5cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnd3YyLldlYlNvY2tldEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBkZXJpdmVkQXBpTmFtZSAmJiAhZGVyaXZlZEFwaU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZEFwaU5hbWUubmFtZSA6IHByb3BzLmFwaU5hbWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCB1c2VSb3V0ZVNwZWNpZmljSGFuZGxlcnMgPVxuICAgICAgQm9vbGVhbihwcm9wcy5jb25uZWN0SGFuZGxlcikgfHwgQm9vbGVhbihwcm9wcy5kaXNjb25uZWN0SGFuZGxlcikgfHwgQm9vbGVhbihwcm9wcy5kZWZhdWx0SGFuZGxlcik7XG4gICAgaWYgKHVzZVJvdXRlU3BlY2lmaWNIYW5kbGVycykge1xuICAgICAgY29uc3QgY29ubmVjdEludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXCJDb25uZWN0SGFuZGxlclwiLCBjb25uZWN0SGFuZGxlcik7XG4gICAgICBjb25zdCBkaXNjb25uZWN0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcbiAgICAgICAgXCJEaXNjb25uZWN0SGFuZGxlclwiLFxuICAgICAgICBkaXNjb25uZWN0SGFuZGxlcixcbiAgICAgICk7XG4gICAgICBjb25zdCBkZWZhdWx0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcIkRlZmF1bHRIYW5kbGVyXCIsIGRlZmF1bHRIYW5kbGVyKTtcblxuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkY29ubmVjdFwiLCB7IGludGVncmF0aW9uOiBjb25uZWN0SW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkaXNjb25uZWN0XCIsIHsgaW50ZWdyYXRpb246IGRpc2Nvbm5lY3RJbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRlZmF1bHRcIiwgeyBpbnRlZ3JhdGlvbjogZGVmYXVsdEludGVncmF0aW9uIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFwiSGFuZGxlclwiLCBwcm9wcy5oYW5kbGVyKTtcblxuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkY29ubmVjdFwiLCB7IGludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGlzY29ubmVjdFwiLCB7IGludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGVmYXVsdFwiLCB7IGludGVncmF0aW9uIH0pO1xuICAgIH1cblxuICAgIGNvbnN0IHNob3VsZENyZWF0ZUNvbm5lY3Rpb25UYWJsZSA9XG4gICAgICAocHJvcHMuZW5hYmxlQ29ubmVjdGlvblRhYmxlID8/IGZhbHNlKSB8fCBCb29sZWFuKHByb3BzLmNvbm5lY3Rpb25UYWJsZU5hbWUpO1xuICAgIGlmIChwcm9wcy5jb25uZWN0aW9uVGFibGUgJiYgc2hvdWxkQ3JlYXRlQ29ubmVjdGlvblRhYmxlKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgIFwiQXBwVGhlb3J5V2ViU29ja2V0QXBpIHN1cHBvcnRzIGVpdGhlciBwcm9wcy5jb25uZWN0aW9uVGFibGUgb3IgcHJvcHMuZW5hYmxlQ29ubmVjdGlvblRhYmxlL3Byb3BzLmNvbm5lY3Rpb25UYWJsZU5hbWVcIixcbiAgICAgICk7XG4gICAgfVxuXG4gICAgaWYgKHByb3BzLmNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgdGhpcy5jb25uZWN0aW9uVGFibGUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGU7XG4gICAgfSBlbHNlIGlmIChzaG91bGRDcmVhdGVDb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIGNvbnN0IGRlcml2ZWRUYWJsZU5hbWUgPSBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgPyBuYW1pbmdDb250ZXh0LnBoeXNpY2FsTmFtZShcImR5bmFtb2RiX3RhYmxlXCIsIGAke2xvZ2ljYWx9LWNvbm5lY3Rpb25zYClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBwa05hbWUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVQYXJ0aXRpb25LZXlOYW1lID8/IFwiUEtcIjtcbiAgICAgIGNvbnN0IHNrTmFtZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVNvcnRLZXlOYW1lID8/IFwiU0tcIjtcbiAgICAgIGNvbnN0IHR0bEF0dHJpYnV0ZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVRpbWVUb0xpdmVBdHRyaWJ1dGUgPz8gXCJ0dGxcIjtcbiAgICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgICAgY29uc3QgZW5hYmxlUElUUiA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZUVuYWJsZVBvaW50SW5UaW1lUmVjb3ZlcnkgPz8gdHJ1ZTtcblxuICAgICAgdGhpcy5jb25uZWN0aW9uVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJDb25uZWN0aW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IGRlcml2ZWRUYWJsZU5hbWUgJiYgIWRlcml2ZWRUYWJsZU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZFRhYmxlTmFtZS5uYW1lIDogcHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IHBrTmFtZSwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgc29ydEtleTogeyBuYW1lOiBza05hbWUsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IHR0bEF0dHJpYnV0ZSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeVNwZWNpZmljYXRpb246IHtcbiAgICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5RW5hYmxlZDogZW5hYmxlUElUUixcbiAgICAgICAgfSxcbiAgICAgICAgZW5jcnlwdGlvbjogZHluYW1vZGIuVGFibGVFbmNyeXB0aW9uLkFXU19NQU5BR0VELFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuY29ubmVjdGlvblRhYmxlKSB7XG4gICAgICBjb25zdCBoYW5kbGVycyA9IG5ldyBTZXQ8bGFtYmRhLklGdW5jdGlvbj4oW2Nvbm5lY3RIYW5kbGVyLCBkaXNjb25uZWN0SGFuZGxlciwgZGVmYXVsdEhhbmRsZXJdKTtcbiAgICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuICAgICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaGFuZGxlcik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGV0IGFjY2Vzc0xvZ1NldHRpbmdzOiBhcGlnd3YyLklBY2Nlc3NMb2dTZXR0aW5ncyB8IHVuZGVmaW5lZDtcbiAgICBpZiAocHJvcHMuZW5hYmxlQWNjZXNzTG9nZ2luZyA/PyBzdGFuZGFyZCkge1xuICAgICAgaWYgKHN0YW5kYXJkICYmICFwcm9wcy5hY2Nlc3NMb2dHcm91cCAmJiAhbG9naWNhbCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGkgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIGxvZ2ljYWwgbmFtZVwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGNvbnRyYWN0TmFtZSA9ICFwcm9wcy5hY2Nlc3NMb2dHcm91cCAmJiBuYW1pbmdDb250ZXh0ICYmIGxvZ2ljYWxcbiAgICAgICAgPyBhY2Nlc3NMb2dHcm91cE5hbWUobmFtaW5nQ29udGV4dCwgYGxvZ3MvYWNjZXNzL2FwaS8ke2xvZ2ljYWx9YClcbiAgICAgICAgOiB1bmRlZmluZWQ7XG4gICAgICBjb25zdCBsb2dHcm91cCA9XG4gICAgICAgIHByb3BzLmFjY2Vzc0xvZ0dyb3VwID8/XG4gICAgICAgIG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLFxuICAgICAgICAgIHN0YW5kYXJkICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICAgID8ge1xuICAgICAgICAgICAgICBsb2dHcm91cE5hbWU6IGNvbnRyYWN0TmFtZSxcbiAgICAgICAgICAgICAgcmV0ZW50aW9uOiByZXRlbnRpb25Gb3IobmFtaW5nQ29udGV4dC5yZXRlbnRpb25EYXlzKSxcbiAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuYWNjZXNzTG9nUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICAgICAgICAgIH1cbiAgICAgICAgICA6IGNvbnRyYWN0TmFtZSAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICBsb2dHcm91cE5hbWU6IGNvbnRyYWN0TmFtZSxcbiAgICAgICAgICAgICAgICByZXRlbnRpb246IHByb3BzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuYWNjZXNzTG9nUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgOiB7XG4gICAgICAgICAgICAgICAgcmV0ZW50aW9uOiBwcm9wcy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgICAgICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmFjY2Vzc0xvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgdGhpcy5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgICBsb2dHcm91cC5hZGRUb1Jlc291cmNlUG9saWN5KFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgcHJpbmNpcGFsczogW25ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiKV0sXG4gICAgICAgICAgYWN0aW9uczogW1wibG9nczpDcmVhdGVMb2dTdHJlYW1cIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiLCBcImxvZ3M6UHV0TG9nRXZlbnRzXCJdLFxuICAgICAgICAgIHJlc291cmNlczogW2xvZ0dyb3VwLmxvZ0dyb3VwQXJuXSxcbiAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgICBjb25zdCBmb3JtYXQgPVxuICAgICAgICBwcm9wcy5hY2Nlc3NMb2dGb3JtYXQgPz9cbiAgICAgICAgKHN0YW5kYXJkXG4gICAgICAgICAgPyBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20od2ViU29ja2V0QXBpQWNjZXNzTG9nRm9ybWF0KCkpXG4gICAgICAgICAgOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20oXG4gICAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICByZXF1ZXN0SWQ6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlcXVlc3RJZCgpLFxuICAgICAgICAgICAgICAgIGV2ZW50VHlwZTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0RXZlbnRUeXBlKCksXG4gICAgICAgICAgICAgICAgcm91dGVLZXk6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJvdXRlS2V5KCksXG4gICAgICAgICAgICAgICAgY29ubmVjdGlvbklkOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRDb25uZWN0aW9uSWQoKSxcbiAgICAgICAgICAgICAgICBzdGF0dXM6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFN0YXR1cygpLFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXNwb25zZUxlbmd0aCgpLFxuICAgICAgICAgICAgICAgIGludGVncmF0aW9uTGF0ZW5jeTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0SW50ZWdyYXRpb25MYXRlbmN5KCksXG4gICAgICAgICAgICAgICAgcmVxdWVzdFRpbWU6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlcXVlc3RUaW1lKCksXG4gICAgICAgICAgICAgICAgaXA6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dElkZW50aXR5U291cmNlSXAoKSxcbiAgICAgICAgICAgICAgICB1c2VyQWdlbnQ6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dElkZW50aXR5VXNlckFnZW50KCksXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgKSk7XG5cbiAgICAgIGFjY2Vzc0xvZ1NldHRpbmdzID0ge1xuICAgICAgICBkZXN0aW5hdGlvbjogbmV3IGFwaWd3djIuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihsb2dHcm91cCksXG4gICAgICAgIGZvcm1hdCxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgdGhpcy5zdGFnZSA9IG5ldyBhcGlnd3YyLldlYlNvY2tldFN0YWdlKHRoaXMsIFwiU3RhZ2VcIiwge1xuICAgICAgd2ViU29ja2V0QXBpOiB0aGlzLmFwaSxcbiAgICAgIHN0YWdlTmFtZSxcbiAgICAgIGF1dG9EZXBsb3k6IHRydWUsXG4gICAgICBhY2Nlc3NMb2dTZXR0aW5ncyxcbiAgICB9KTtcblxuICAgIHtcbiAgICAgIGNvbnN0IGhhbmRsZXJzID0gbmV3IFNldDxsYW1iZGEuSUZ1bmN0aW9uPihbY29ubmVjdEhhbmRsZXIsIGRpc2Nvbm5lY3RIYW5kbGVyLCBkZWZhdWx0SGFuZGxlcl0pO1xuICAgICAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzKSB7XG4gICAgICAgIHRoaXMuc3RhZ2UuZ3JhbnRNYW5hZ2VtZW50QXBpQWNjZXNzKGhhbmRsZXIpO1xuICAgICAgfVxuICAgIH1cbiAgfVxufVxuIl19