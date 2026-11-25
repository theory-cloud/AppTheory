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
    static [JSII_RTTI_SYMBOL_1] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryWebSocketApi", version: "7.5.0" };
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
        if (namingContext && logical) {
            // Contract section 11.4: declare the resource carrying the composed name.
            namingContext.declareName("api_websocket", logical, this.api);
        }
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
            if (namingContext && logical) {
                namingContext.declareName("dynamodb_table", `${logical}-connections`, this.connectionTable);
            }
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
            if (standard && namingContext && logical && !props.accessLogGroup) {
                namingContext.declareName("log_group", `logs/access/api/${logical}`, logGroup);
            }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vic29ja2V0LWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIndlYnNvY2tldC1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLDZDQUE0QztBQUM1Qyx1RUFBeUQ7QUFDekQsc0VBQXdEO0FBQ3hELCtGQUFpRjtBQUNqRixtRUFBcUQ7QUFDckQseURBQTJDO0FBRTNDLDJEQUE2QztBQUM3QywyQ0FBdUM7QUFFdkMseURBQTREO0FBQzVELHlFQUFvRTtBQUNwRSwrREFBc0U7QUFDdEUsaUVBQXVGO0FBc0R2RixNQUFhLHFCQUFzQixTQUFRLHNCQUFTOztJQUNsQyxHQUFHLENBQXVCO0lBQzFCLEtBQUssQ0FBeUI7SUFDOUIsZUFBZSxDQUFtQjtJQUNsQyxjQUFjLENBQWtCO0lBRWhELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFNBQVMsSUFBSSxLQUFLLENBQUMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxLQUFLLENBQUM7UUFDbkUsTUFBTSxRQUFRLEdBQUcsS0FBSyxDQUFDLGFBQWEsRUFBRSxlQUFlLEtBQUssSUFBSSxDQUFDO1FBQy9ELE1BQU0sYUFBYSxHQUFHLEtBQUssQ0FBQyxhQUFhLENBQUM7UUFDMUMsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLFdBQVcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsSUFBQSxpQ0FBa0IsRUFBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDNUYsSUFBQSx5Q0FBa0IsRUFBQyxhQUFhLEVBQUUsdUJBQXVCLEVBQUUsU0FBUyxFQUFFLGVBQWUsRUFBRSxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU8sS0FBSyxTQUFTLENBQUMs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LENBQUMsc0JBQXNCLENBQUMsUUFBUSxDQUFDO2dCQUN6RCxNQUFNO2FBQ1AsQ0FBQztRQUNKLENBQUM7UUFFRCxJQUFJLENBQUMsS0FBSyxHQUFHLElBQUksT0FBTyxDQUFDLGNBQWMsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO1lBQ3JELFlBQVksRUFBRSxJQUFJLENBQUMsR0FBRztZQUN0QixTQUFTO1lBQ1QsVUFBVSxFQUFFLElBQUk7WUFDaEIsaUJBQWlCO1NBQ2xCLENBQUMsQ0FBQztRQUVILENBQUM7WUFDQyxNQUFNLFFBQVEsR0FBRyxJQUFJLEdBQUcsQ0FBbUIsQ0FBQyxjQUFjLEVBQUUsaUJBQWlCLEVBQUUsY0FBYyxDQUFDLENBQUMsQ0FBQztZQUNoRyxLQUFLLE1BQU0sT0FBTyxJQUFJLFFBQVEsRUFBRSxDQUFDO2dCQUMvQixJQUFJLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQy9DLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQzs7QUFsTEgsc0RBbUxDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuaW1wb3J0IHsgZGVmYXVsdExvZ2ljYWxOYW1lIH0gZnJvbSBcIi4vcHJpdmF0ZS9sb2dpY2FsLW5hbWVcIjtcbmltcG9ydCB7IHJlZnVzZUV4cGxpY2l0TmFtZSB9IGZyb20gXCIuL3ByaXZhdGUvcmVmdXNlLWV4cGxpY2l0LW5hbWVcIjtcbmltcG9ydCB7IGRlZmF1bHREZWxldGlvblByb3RlY3Rpb24gfSBmcm9tIFwiLi9wcml2YXRlL3NlY3VyZS1kZWZhdWx0c1wiO1xuaW1wb3J0IHsgcmV0ZW50aW9uRm9yLCB3ZWJTb2NrZXRBcGlBY2Nlc3NMb2dGb3JtYXQgfSBmcm9tIFwiLi9wcml2YXRlL3N0YW5kYXJkLWxvZ2dpbmdcIjtcbmltcG9ydCB0eXBlIHsgQXBwVGhlb3J5TmFtaW5nQ29udGV4dCB9IGZyb20gXCIuL25hbWluZy1jb250ZXh0XCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5V2ViU29ja2V0QXBpUHJvcHMge1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBjb25uZWN0SGFuZGxlcj86IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGRpc2Nvbm5lY3RIYW5kbGVyPzogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgZGVmYXVsdEhhbmRsZXI/OiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICByZWFkb25seSBlbmFibGVDb25uZWN0aW9uVGFibGU/OiBib29sZWFuO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVQYXJ0aXRpb25LZXlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVTb3J0S2V5TmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlVGltZVRvTGl2ZUF0dHJpYnV0ZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZUVuYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuICAvKipcbiAgICogV2hldGhlciBkZWxldGlvbiBwcm90ZWN0aW9uIHNob3VsZCBiZSBlbmFibGVkIGZvciB0aGUgY29ubmVjdGlvbiB0YWJsZS5cbiAgICogQGRlZmF1bHQgdW5kZWZpbmVkICh3aXRoIG5vIG5hbWluZyBjb250ZXh0OiB0aGUgQVdTIGRlZmF1bHQsIG5vIGRlbGV0aW9uXG4gICAqIHByb3RlY3Rpb247IHVuZGVyIGEgZGVyaXZlZCBuYW1pbmcgY29udGV4dDogb24gZm9yIGEgUkVUQUlOIHRhYmxlLCBvZmYgb3RoZXJ3aXNlKVxuICAgKi9cbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlRGVsZXRpb25Qcm90ZWN0aW9uPzogYm9vbGVhbjtcblxuICByZWFkb25seSBlbmFibGVBY2Nlc3NMb2dnaW5nPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0PzogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGb3JtYXQ7XG5cbiAgLyoqXG4gICAqIE9wdGlvbmFsIG5hbWluZyBhbmQgbG9nZ2luZyBjb250ZXh0LlxuICAgKlxuICAgKiBXaXRoIHRoZSBzdGFuZGFyZCBsb2dnaW5nIHByb2ZpbGUgYWNjZXNzIGxvZ2dpbmcgaXMgb24gYnkgZGVmYXVsdCB0byBhIGxvZ1xuICAgKiBncm91cCBuYW1lZCBgbG9ncy9hY2Nlc3MvYXBpL3tsb2dpY2FsTmFtZX1gIGNhcnJ5aW5nIHRoZSBjb250cmFjdCdzIEpTT05cbiAgICogZmllbGQgc2V0LiBQYXNzIGBlbmFibGVBY2Nlc3NMb2dnaW5nOiBmYWxzZWAgdG8gb3B0IG91dC5cbiAgICpcbiAgICogV2l0aCBubyBjb250ZXh0IHRoZSBjb25zdHJ1Y3Qgc3ludGhlc2l6ZXMgZXhhY3RseSBhcyBiZWZvcmUuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbmFtaW5nQ29udGV4dD86IEFwcFRoZW9yeU5hbWluZ0NvbnRleHQ7XG5cbiAgLyoqXG4gICAqIFRoZSBBUEkncyBsb2dpY2FsIG5hbWUuIERlZmF1bHRzIHRvIHRoZSBrZWJhYi1jYXNlZCBjb25zdHJ1Y3QgaWQgd2hlbiBhXG4gICAqIG5hbWluZyBjb250ZXh0IGlzIHByZXNlbnQuXG4gICAqXG4gICAqIEBkZWZhdWx0IHVuZGVmaW5lZFxuICAgKi9cbiAgcmVhZG9ubHkgbG9naWNhbE5hbWU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlXZWJTb2NrZXRBcGkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLldlYlNvY2tldEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlnd3YyLldlYlNvY2tldFN0YWdlO1xuICBwdWJsaWMgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5V2ViU29ja2V0QXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gU3RyaW5nKHByb3BzLnN0YWdlTmFtZSA/PyBcImRldlwiKS50cmltKCkgfHwgXCJkZXZcIjtcbiAgICBjb25zdCBzdGFuZGFyZCA9IHByb3BzLm5hbWluZ0NvbnRleHQ/LnN0YW5kYXJkTG9nZ2luZyA9PT0gdHJ1ZTtcbiAgICBjb25zdCBuYW1pbmdDb250ZXh0ID0gcHJvcHMubmFtaW5nQ29udGV4dDtcbiAgICBjb25zdCBsb2dpY2FsID0gcHJvcHMubG9naWNhbE5hbWUgPz8gKG5hbWluZ0NvbnRleHQgPyBkZWZhdWx0TG9naWNhbE5hbWUodGhpcykgOiB1bmRlZmluZWQpO1xuICAgIHJlZnVzZUV4cGxpY2l0TmFtZShuYW1pbmdDb250ZXh0LCBcIkFwcFRoZW9yeVdlYlNvY2tldEFwaVwiLCBcImFwaU5hbWVcIiwgXCJhcGlfd2Vic29ja2V0XCIsIGxvZ2ljYWwsIHByb3BzLmFwaU5hbWUgIT09IHVuZGVmaW5lZCk7XG4gICAgcmVmdXNlRXhwbGljaXROYW1lKFxuICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgIFwiQXBwVGhlb3J5V2ViU29ja2V0QXBpXCIsXG4gICAgICBcImNvbm5lY3Rpb25UYWJsZU5hbWVcIixcbiAgICAgIFwiZHluYW1vZGJfdGFibGVcIixcbiAgICAgIGxvZ2ljYWwgPyBgJHtsb2dpY2FsfS1jb25uZWN0aW9uc2AgOiB1bmRlZmluZWQsXG4gICAgICBwcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lICE9PSB1bmRlZmluZWQsXG4gICAgKTtcbiAgICBjb25zdCBkZXJpdmVkQXBpTmFtZSA9IG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCA/IG5hbWluZ0NvbnRleHQucGh5c2ljYWxOYW1lKFwiYXBpX3dlYnNvY2tldFwiLCBsb2dpY2FsKSA6IHVuZGVmaW5lZDtcbiAgICBjb25zdCBjb25uZWN0SGFuZGxlciA9IHByb3BzLmNvbm5lY3RIYW5kbGVyID8/IHByb3BzLmhhbmRsZXI7XG4gICAgY29uc3QgZGlzY29ubmVjdEhhbmRsZXIgPSBwcm9wcy5kaXNjb25uZWN0SGFuZGxlciA/PyBwcm9wcy5oYW5kbGVyO1xuICAgIGNvbnN0IGRlZmF1bHRIYW5kbGVyID0gcHJvcHMuZGVmYXVsdEhhbmRsZXIgPz8gcHJvcHMuaGFuZGxlcjtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuV2ViU29ja2V0QXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IGRlcml2ZWRBcGlOYW1lICYmICFkZXJpdmVkQXBpTmFtZS5nZW5lcmF0ZWQgPyBkZXJpdmVkQXBpTmFtZS5uYW1lIDogcHJvcHMuYXBpTmFtZSxcbiAgICB9KTtcbiAgICBpZiAobmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsKSB7XG4gICAgICAvLyBDb250cmFjdCBzZWN0aW9uIDExLjQ6IGRlY2xhcmUgdGhlIHJlc291cmNlIGNhcnJ5aW5nIHRoZSBjb21wb3NlZCBuYW1lLlxuICAgICAgbmFtaW5nQ29udGV4dC5kZWNsYXJlTmFtZShcImFwaV93ZWJzb2NrZXRcIiwgbG9naWNhbCwgdGhpcy5hcGkpO1xuICAgIH1cblxuICAgIGNvbnN0IHVzZVJvdXRlU3BlY2lmaWNIYW5kbGVycyA9XG4gICAgICBCb29sZWFuKHByb3BzLmNvbm5lY3RIYW5kbGVyKSB8fCBCb29sZWFuKHByb3BzLmRpc2Nvbm5lY3RIYW5kbGVyKSB8fCBCb29sZWFuKHByb3BzLmRlZmF1bHRIYW5kbGVyKTtcbiAgICBpZiAodXNlUm91dGVTcGVjaWZpY0hhbmRsZXJzKSB7XG4gICAgICBjb25zdCBjb25uZWN0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcIkNvbm5lY3RIYW5kbGVyXCIsIGNvbm5lY3RIYW5kbGVyKTtcbiAgICAgIGNvbnN0IGRpc2Nvbm5lY3RJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBcIkRpc2Nvbm5lY3RIYW5kbGVyXCIsXG4gICAgICAgIGRpc2Nvbm5lY3RIYW5kbGVyLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGRlZmF1bHRJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFwiRGVmYXVsdEhhbmRsZXJcIiwgZGVmYXVsdEhhbmRsZXIpO1xuXG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRjb25uZWN0XCIsIHsgaW50ZWdyYXRpb246IGNvbm5lY3RJbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRpc2Nvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbjogZGlzY29ubmVjdEludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGVmYXVsdFwiLCB7IGludGVncmF0aW9uOiBkZWZhdWx0SW50ZWdyYXRpb24gfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXCJIYW5kbGVyXCIsIHByb3BzLmhhbmRsZXIpO1xuXG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRjb25uZWN0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkaXNjb25uZWN0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkZWZhdWx0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2hvdWxkQ3JlYXRlQ29ubmVjdGlvblRhYmxlID1cbiAgICAgIChwcm9wcy5lbmFibGVDb25uZWN0aW9uVGFibGUgPz8gZmFsc2UpIHx8IEJvb2xlYW4ocHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZSk7XG4gICAgaWYgKHByb3BzLmNvbm5lY3Rpb25UYWJsZSAmJiBzaG91bGRDcmVhdGVDb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGkgc3VwcG9ydHMgZWl0aGVyIHByb3BzLmNvbm5lY3Rpb25UYWJsZSBvciBwcm9wcy5lbmFibGVDb25uZWN0aW9uVGFibGUvcHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZVwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuY29ubmVjdGlvblRhYmxlKSB7XG4gICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZTtcbiAgICB9IGVsc2UgaWYgKHNob3VsZENyZWF0ZUNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgY29uc3QgZGVyaXZlZFRhYmxlTmFtZSA9IG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbFxuICAgICAgICA/IG5hbWluZ0NvbnRleHQucGh5c2ljYWxOYW1lKFwiZHluYW1vZGJfdGFibGVcIiwgYCR7bG9naWNhbH0tY29ubmVjdGlvbnNgKVxuICAgICAgICA6IHVuZGVmaW5lZDtcbiAgICAgIGNvbnN0IHBrTmFtZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVBhcnRpdGlvbktleU5hbWUgPz8gXCJQS1wiO1xuICAgICAgY29uc3Qgc2tOYW1lID0gcHJvcHMuY29ubmVjdGlvblRhYmxlU29ydEtleU5hbWUgPz8gXCJTS1wiO1xuICAgICAgY29uc3QgdHRsQXR0cmlidXRlID0gcHJvcHMuY29ubmVjdGlvblRhYmxlVGltZVRvTGl2ZUF0dHJpYnV0ZSA/PyBcInR0bFwiO1xuICAgICAgY29uc3QgcmVtb3ZhbFBvbGljeSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVJlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU47XG4gICAgICBjb25zdCBlbmFibGVQSVRSID0gcHJvcHMuY29ubmVjdGlvblRhYmxlRW5hYmxlUG9pbnRJblRpbWVSZWNvdmVyeSA/PyB0cnVlO1xuICAgICAgY29uc3QgZGVsZXRpb25Qcm90ZWN0aW9uID0gZGVmYXVsdERlbGV0aW9uUHJvdGVjdGlvbihcbiAgICAgICAgbmFtaW5nQ29udGV4dCxcbiAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgcHJvcHMuY29ubmVjdGlvblRhYmxlRGVsZXRpb25Qcm90ZWN0aW9uLFxuICAgICAgKTtcblxuICAgICAgdGhpcy5jb25uZWN0aW9uVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJDb25uZWN0aW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IGRlcml2ZWRUYWJsZU5hbWUgJiYgIWRlcml2ZWRUYWJsZU5hbWUuZ2VuZXJhdGVkID8gZGVyaXZlZFRhYmxlTmFtZS5uYW1lIDogcHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZSxcbiAgICAgICAgYmlsbGluZ01vZGU6IGR5bmFtb2RiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgICAgcGFydGl0aW9uS2V5OiB7IG5hbWU6IHBrTmFtZSwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgc29ydEtleTogeyBuYW1lOiBza05hbWUsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHRpbWVUb0xpdmVBdHRyaWJ1dGU6IHR0bEF0dHJpYnV0ZSxcbiAgICAgICAgcmVtb3ZhbFBvbGljeSxcbiAgICAgICAgZGVsZXRpb25Qcm90ZWN0aW9uOiBkZWxldGlvblByb3RlY3Rpb24sXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlTcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgICAgcG9pbnRJblRpbWVSZWNvdmVyeUVuYWJsZWQ6IGVuYWJsZVBJVFIsXG4gICAgICAgIH0sXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgICAgaWYgKG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCkge1xuICAgICAgICBuYW1pbmdDb250ZXh0LmRlY2xhcmVOYW1lKFwiZHluYW1vZGJfdGFibGVcIiwgYCR7bG9naWNhbH0tY29ubmVjdGlvbnNgLCB0aGlzLmNvbm5lY3Rpb25UYWJsZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuY29ubmVjdGlvblRhYmxlKSB7XG4gICAgICBjb25zdCBoYW5kbGVycyA9IG5ldyBTZXQ8bGFtYmRhLklGdW5jdGlvbj4oW2Nvbm5lY3RIYW5kbGVyLCBkaXNjb25uZWN0SGFuZGxlciwgZGVmYXVsdEhhbmRsZXJdKTtcbiAgICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuICAgICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZS5ncmFudFJlYWRXcml0ZURhdGEoaGFuZGxlcik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGV0IGFjY2Vzc0xvZ1NldHRpbmdzOiBhcGlnd3YyLklBY2Nlc3NMb2dTZXR0aW5ncyB8IHVuZGVmaW5lZDtcbiAgICBpZiAocHJvcHMuZW5hYmxlQWNjZXNzTG9nZ2luZyA/PyBzdGFuZGFyZCkge1xuICAgICAgaWYgKHN0YW5kYXJkICYmICFwcm9wcy5hY2Nlc3NMb2dHcm91cCAmJiAhbG9naWNhbCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGkgc3RhbmRhcmQgbG9nZ2luZyByZXF1aXJlcyBhIGxvZ2ljYWwgbmFtZVwiKTtcbiAgICAgIH1cbiAgICAgIGNvbnN0IGxvZ0dyb3VwID1cbiAgICAgICAgcHJvcHMuYWNjZXNzTG9nR3JvdXAgPz9cbiAgICAgICAgbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsXG4gICAgICAgICAgLy8gVGhlIGNvbnN0cnVjdC1jcmVhdGVkIGFjY2Vzcy1sb2cgZ3JvdXAgaXMgYSBsb2dnaW5nIHJlc291cmNlOiB0aGVcbiAgICAgICAgICAvLyBzdGFuZGFyZCBwcm9maWxlIG5hbWVzIGl0IGZyb20gdGhlIGNvbnRyYWN0LCBhbmQgdGhlIGxlZ2FjeSBwcm9maWxlXG4gICAgICAgICAgLy8ga2VlcHMgdG9kYXkncyBDbG91ZEZvcm1hdGlvbi1nZW5lcmF0ZWQgbmFtZSBhbmQgY29uc3VtZXMgbm8gZW50cnkuXG4gICAgICAgICAgc3RhbmRhcmQgJiYgbmFtaW5nQ29udGV4dCAmJiBsb2dpY2FsXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICAgIGxvZ0dyb3VwTmFtZTogbmFtaW5nQ29udGV4dC5sb2dHcm91cE5hbWUoYGxvZ3MvYWNjZXNzL2FwaS8ke2xvZ2ljYWx9YCksXG4gICAgICAgICAgICAgIHJldGVudGlvbjogcmV0ZW50aW9uRm9yKG5hbWluZ0NvbnRleHQucmV0ZW50aW9uRGF5cyksXG4gICAgICAgICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmFjY2Vzc0xvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICAgICAgICB9XG4gICAgICAgICAgOiB7XG4gICAgICAgICAgICAgIHJldGVudGlvbjogcHJvcHMuYWNjZXNzTG9nUmV0ZW50aW9uID8/IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgICAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuYWNjZXNzTG9nUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICAgICAgICAgIH0pO1xuICAgICAgdGhpcy5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuICAgICAgaWYgKHN0YW5kYXJkICYmIG5hbWluZ0NvbnRleHQgJiYgbG9naWNhbCAmJiAhcHJvcHMuYWNjZXNzTG9nR3JvdXApIHtcbiAgICAgICAgbmFtaW5nQ29udGV4dC5kZWNsYXJlTmFtZShcImxvZ19ncm91cFwiLCBgbG9ncy9hY2Nlc3MvYXBpLyR7bG9naWNhbH1gLCBsb2dHcm91cCk7XG4gICAgICB9XG5cbiAgICAgIGxvZ0dyb3VwLmFkZFRvUmVzb3VyY2VQb2xpY3koXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBwcmluY2lwYWxzOiBbbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIpXSxcbiAgICAgICAgICBhY3Rpb25zOiBbXCJsb2dzOkNyZWF0ZUxvZ1N0cmVhbVwiLCBcImxvZ3M6RGVzY3JpYmVMb2dTdHJlYW1zXCIsIFwibG9nczpQdXRMb2dFdmVudHNcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbbG9nR3JvdXAubG9nR3JvdXBBcm5dLFxuICAgICAgICB9KSxcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGZvcm1hdCA9XG4gICAgICAgIHByb3BzLmFjY2Vzc0xvZ0Zvcm1hdCA/P1xuICAgICAgICAoc3RhbmRhcmRcbiAgICAgICAgICA/IGFwaWdhdGV3YXkuQWNjZXNzTG9nRm9ybWF0LmN1c3RvbSh3ZWJTb2NrZXRBcGlBY2Nlc3NMb2dGb3JtYXQoKSlcbiAgICAgICAgICA6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRm9ybWF0LmN1c3RvbShcbiAgICAgICAgICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgIHJlcXVlc3RJZDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0UmVxdWVzdElkKCksXG4gICAgICAgICAgICAgICAgZXZlbnRUeXBlOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRFdmVudFR5cGUoKSxcbiAgICAgICAgICAgICAgICByb3V0ZUtleTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0Um91dGVLZXkoKSxcbiAgICAgICAgICAgICAgICBjb25uZWN0aW9uSWQ6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dENvbm5lY3Rpb25JZCgpLFxuICAgICAgICAgICAgICAgIHN0YXR1czogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0U3RhdHVzKCksXG4gICAgICAgICAgICAgICAgcmVzcG9uc2VMZW5ndGg6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlc3BvbnNlTGVuZ3RoKCksXG4gICAgICAgICAgICAgICAgaW50ZWdyYXRpb25MYXRlbmN5OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRJbnRlZ3JhdGlvbkxhdGVuY3koKSxcbiAgICAgICAgICAgICAgICByZXF1ZXN0VGltZTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0UmVxdWVzdFRpbWUoKSxcbiAgICAgICAgICAgICAgICBpcDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0SWRlbnRpdHlTb3VyY2VJcCgpLFxuICAgICAgICAgICAgICAgIHVzZXJBZ2VudDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0SWRlbnRpdHlVc2VyQWdlbnQoKSxcbiAgICAgICAgICAgICAgfSksXG4gICAgICAgICAgICApKTtcblxuICAgICAgYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgIGRlc3RpbmF0aW9uOiBuZXcgYXBpZ3d2Mi5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKGxvZ0dyb3VwKSxcbiAgICAgICAgZm9ybWF0LFxuICAgICAgfTtcbiAgICB9XG5cbiAgICB0aGlzLnN0YWdlID0gbmV3IGFwaWd3djIuV2ViU29ja2V0U3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICB3ZWJTb2NrZXRBcGk6IHRoaXMuYXBpLFxuICAgICAgc3RhZ2VOYW1lLFxuICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgIGFjY2Vzc0xvZ1NldHRpbmdzLFxuICAgIH0pO1xuXG4gICAge1xuICAgICAgY29uc3QgaGFuZGxlcnMgPSBuZXcgU2V0PGxhbWJkYS5JRnVuY3Rpb24+KFtjb25uZWN0SGFuZGxlciwgZGlzY29ubmVjdEhhbmRsZXIsIGRlZmF1bHRIYW5kbGVyXSk7XG4gICAgICBmb3IgKGNvbnN0IGhhbmRsZXIgb2YgaGFuZGxlcnMpIHtcbiAgICAgICAgdGhpcy5zdGFnZS5ncmFudE1hbmFnZW1lbnRBcGlBY2Nlc3MoaGFuZGxlcik7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG4iXX0=