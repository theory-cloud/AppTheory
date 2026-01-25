"use strict";
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppTheoryWebSocketApi = void 0;
const JSII_RTTI_SYMBOL_1 = Symbol.for("jsii.rtti");
const aws_cdk_lib_1 = require("aws-cdk-lib");
const apigateway = require("aws-cdk-lib/aws-apigateway");
const apigwv2 = require("aws-cdk-lib/aws-apigatewayv2");
const apigwv2Integrations = require("aws-cdk-lib/aws-apigatewayv2-integrations");
const dynamodb = require("aws-cdk-lib/aws-dynamodb");
const iam = require("aws-cdk-lib/aws-iam");
const logs = require("aws-cdk-lib/aws-logs");
const constructs_1 = require("constructs");
class AppTheoryWebSocketApi extends constructs_1.Construct {
    constructor(scope, id, props) {
        super(scope, id);
        const stageName = String(props.stageName ?? "dev").trim() || "dev";
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
                pointInTimeRecovery: enablePITR,
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
        if (props.enableAccessLogging ?? false) {
            const logGroup = props.accessLogGroup ??
                new logs.LogGroup(this, "AccessLogs", {
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
                apigateway.AccessLogFormat.custom(JSON.stringify({
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
                }));
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
_a = JSII_RTTI_SYMBOL_1;
AppTheoryWebSocketApi[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryWebSocketApi", version: "0.4.0" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vic29ja2V0LWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIndlYnNvY2tldC1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBNEM7QUFDNUMseURBQXlEO0FBQ3pELHdEQUF3RDtBQUN4RCxpRkFBaUY7QUFDakYscURBQXFEO0FBQ3JELDJDQUEyQztBQUUzQyw2Q0FBNkM7QUFDN0MsMkNBQXVDO0FBMEJ2QyxNQUFhLHFCQUFzQixTQUFRLHNCQUFTO0lBTWxELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFNBQVMsSUFBSSxLQUFLLENBQUMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxLQUFLLENBQUM7UUFDbkUsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDO1FBQzdELE1BQU0saUJBQWlCLEdBQUcsS0FBSyxDQUFDLGlCQUFpQixJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUM7UUFDbkUsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDO1FBRTdELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxPQUFPLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDL0MsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO1NBQ3ZCLENBQUMsQ0FBQztRQUVILE1BQU0sd0JBQXdCLEdBQzVCLE9BQU8sQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLElBQUksT0FBTyxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDckcsSUFBSSx3QkFBd0IsRUFBRSxDQUFDO1lBQzdCLE1BQU0sa0JBQWtCLEdB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QztZQUNoRyxLQUFLLE1BQU0sT0FBTyxJQUFJLFFBQVEsRUFBRSxDQUFDO2dCQUMvQixJQUFJLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQy9DLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQzs7QUFqSUgsc0RBa0lDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgUmVtb3ZhbFBvbGljeSB9IGZyb20gXCJhd3MtY2RrLWxpYlwiO1xuaW1wb3J0ICogYXMgYXBpZ2F0ZXdheSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXlcIjtcbmltcG9ydCAqIGFzIGFwaWd3djIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djJcIjtcbmltcG9ydCAqIGFzIGFwaWd3djJJbnRlZ3JhdGlvbnMgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5djItaW50ZWdyYXRpb25zXCI7XG5pbXBvcnQgKiBhcyBkeW5hbW9kYiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWR5bmFtb2RiXCI7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSBcImF3cy1jZGstbGliL2F3cy1pYW1cIjtcbmltcG9ydCB0eXBlICogYXMgbGFtYmRhIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbGFtYmRhXCI7XG5pbXBvcnQgKiBhcyBsb2dzIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtbG9nc1wiO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSBcImNvbnN0cnVjdHNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBBcHBUaGVvcnlXZWJTb2NrZXRBcGlQcm9wcyB7XG4gIHJlYWRvbmx5IGhhbmRsZXI6IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGNvbm5lY3RIYW5kbGVyPzogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgZGlzY29ubmVjdEhhbmRsZXI/OiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBkZWZhdWx0SGFuZGxlcj86IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGFwaU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IHN0YWdlTmFtZT86IHN0cmluZztcblxuICByZWFkb25seSBjb25uZWN0aW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHJlYWRvbmx5IGVuYWJsZUNvbm5lY3Rpb25UYWJsZT86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVBhcnRpdGlvbktleU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVNvcnRLZXlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVUaW1lVG9MaXZlQXR0cmlidXRlPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlRW5hYmxlUG9pbnRJblRpbWVSZWNvdmVyeT86IGJvb2xlYW47XG5cbiAgcmVhZG9ubHkgZW5hYmxlQWNjZXNzTG9nZ2luZz86IGJvb2xlYW47XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JldGVudGlvbj86IGxvZ3MuUmV0ZW50aW9uRGF5cztcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ0Zvcm1hdD86IGFwaWdhdGV3YXkuQWNjZXNzTG9nRm9ybWF0O1xufVxuXG5leHBvcnQgY2xhc3MgQXBwVGhlb3J5V2ViU29ja2V0QXBpIGV4dGVuZHMgQ29uc3RydWN0IHtcbiAgcHVibGljIHJlYWRvbmx5IGFwaTogYXBpZ3d2Mi5XZWJTb2NrZXRBcGk7XG4gIHB1YmxpYyByZWFkb25seSBzdGFnZTogYXBpZ3d2Mi5XZWJTb2NrZXRTdGFnZTtcbiAgcHVibGljIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcHVibGljIHJlYWRvbmx5IGFjY2Vzc0xvZ0dyb3VwPzogbG9ncy5JTG9nR3JvdXA7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IEFwcFRoZW9yeVdlYlNvY2tldEFwaVByb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkKTtcblxuICAgIGNvbnN0IHN0YWdlTmFtZSA9IFN0cmluZyhwcm9wcy5zdGFnZU5hbWUgPz8gXCJkZXZcIikudHJpbSgpIHx8IFwiZGV2XCI7XG4gICAgY29uc3QgY29ubmVjdEhhbmRsZXIgPSBwcm9wcy5jb25uZWN0SGFuZGxlciA/PyBwcm9wcy5oYW5kbGVyO1xuICAgIGNvbnN0IGRpc2Nvbm5lY3RIYW5kbGVyID0gcHJvcHMuZGlzY29ubmVjdEhhbmRsZXIgPz8gcHJvcHMuaGFuZGxlcjtcbiAgICBjb25zdCBkZWZhdWx0SGFuZGxlciA9IHByb3BzLmRlZmF1bHRIYW5kbGVyID8/IHByb3BzLmhhbmRsZXI7XG5cbiAgICB0aGlzLmFwaSA9IG5ldyBhcGlnd3YyLldlYlNvY2tldEFwaSh0aGlzLCBcIkFwaVwiLCB7XG4gICAgICBhcGlOYW1lOiBwcm9wcy5hcGlOYW1lLFxuICAgIH0pO1xuXG4gICAgY29uc3QgdXNlUm91dGVTcGVjaWZpY0hhbmRsZXJzID1cbiAgICAgIEJvb2xlYW4ocHJvcHMuY29ubmVjdEhhbmRsZXIpIHx8IEJvb2xlYW4ocHJvcHMuZGlzY29ubmVjdEhhbmRsZXIpIHx8IEJvb2xlYW4ocHJvcHMuZGVmYXVsdEhhbmRsZXIpO1xuICAgIGlmICh1c2VSb3V0ZVNwZWNpZmljSGFuZGxlcnMpIHtcbiAgICAgIGNvbnN0IGNvbm5lY3RJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFwiQ29ubmVjdEhhbmRsZXJcIiwgY29ubmVjdEhhbmRsZXIpO1xuICAgICAgY29uc3QgZGlzY29ubmVjdEludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXG4gICAgICAgIFwiRGlzY29ubmVjdEhhbmRsZXJcIixcbiAgICAgICAgZGlzY29ubmVjdEhhbmRsZXIsXG4gICAgICApO1xuICAgICAgY29uc3QgZGVmYXVsdEludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXCJEZWZhdWx0SGFuZGxlclwiLCBkZWZhdWx0SGFuZGxlcik7XG5cbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGNvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbjogY29ubmVjdEludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGlzY29ubmVjdFwiLCB7IGludGVncmF0aW9uOiBkaXNjb25uZWN0SW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkZWZhdWx0XCIsIHsgaW50ZWdyYXRpb246IGRlZmF1bHRJbnRlZ3JhdGlvbiB9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcIkhhbmRsZXJcIiwgcHJvcHMuaGFuZGxlcik7XG5cbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGNvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRpc2Nvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRlZmF1bHRcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBzaG91bGRDcmVhdGVDb25uZWN0aW9uVGFibGUgPVxuICAgICAgKHByb3BzLmVuYWJsZUNvbm5lY3Rpb25UYWJsZSA/PyBmYWxzZSkgfHwgQm9vbGVhbihwcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lKTtcbiAgICBpZiAocHJvcHMuY29ubmVjdGlvblRhYmxlICYmIHNob3VsZENyZWF0ZUNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIkFwcFRoZW9yeVdlYlNvY2tldEFwaSBzdXBwb3J0cyBlaXRoZXIgcHJvcHMuY29ubmVjdGlvblRhYmxlIG9yIHByb3BzLmVuYWJsZUNvbm5lY3Rpb25UYWJsZS9wcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lXCIsXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmIChwcm9wcy5jb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIHRoaXMuY29ubmVjdGlvblRhYmxlID0gcHJvcHMuY29ubmVjdGlvblRhYmxlO1xuICAgIH0gZWxzZSBpZiAoc2hvdWxkQ3JlYXRlQ29ubmVjdGlvblRhYmxlKSB7XG4gICAgICBjb25zdCBwa05hbWUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVQYXJ0aXRpb25LZXlOYW1lID8/IFwiUEtcIjtcbiAgICAgIGNvbnN0IHNrTmFtZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVNvcnRLZXlOYW1lID8/IFwiU0tcIjtcbiAgICAgIGNvbnN0IHR0bEF0dHJpYnV0ZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZVRpbWVUb0xpdmVBdHRyaWJ1dGUgPz8gXCJ0dGxcIjtcbiAgICAgIGNvbnN0IHJlbW92YWxQb2xpY3kgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVSZW1vdmFsUG9saWN5ID8/IFJlbW92YWxQb2xpY3kuUkVUQUlOO1xuICAgICAgY29uc3QgZW5hYmxlUElUUiA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZUVuYWJsZVBvaW50SW5UaW1lUmVjb3ZlcnkgPz8gdHJ1ZTtcblxuICAgICAgdGhpcy5jb25uZWN0aW9uVGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgXCJDb25uZWN0aW9uVGFibGVcIiwge1xuICAgICAgICB0YWJsZU5hbWU6IHByb3BzLmNvbm5lY3Rpb25UYWJsZU5hbWUsXG4gICAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICAgIHBhcnRpdGlvbktleTogeyBuYW1lOiBwa05hbWUsIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HIH0sXG4gICAgICAgIHNvcnRLZXk6IHsgbmFtZTogc2tOYW1lLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICB0aW1lVG9MaXZlQXR0cmlidXRlOiB0dGxBdHRyaWJ1dGUsXG4gICAgICAgIHJlbW92YWxQb2xpY3ksXG4gICAgICAgIHBvaW50SW5UaW1lUmVjb3Zlcnk6IGVuYWJsZVBJVFIsXG4gICAgICAgIGVuY3J5cHRpb246IGR5bmFtb2RiLlRhYmxlRW5jcnlwdGlvbi5BV1NfTUFOQUdFRCxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgY29uc3QgaGFuZGxlcnMgPSBuZXcgU2V0PGxhbWJkYS5JRnVuY3Rpb24+KFtjb25uZWN0SGFuZGxlciwgZGlzY29ubmVjdEhhbmRsZXIsIGRlZmF1bHRIYW5kbGVyXSk7XG4gICAgICBmb3IgKGNvbnN0IGhhbmRsZXIgb2YgaGFuZGxlcnMpIHtcbiAgICAgICAgdGhpcy5jb25uZWN0aW9uVGFibGUuZ3JhbnRSZWFkV3JpdGVEYXRhKGhhbmRsZXIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBhY2Nlc3NMb2dTZXR0aW5nczogYXBpZ3d2Mi5JQWNjZXNzTG9nU2V0dGluZ3MgfCB1bmRlZmluZWQ7XG4gICAgaWYgKHByb3BzLmVuYWJsZUFjY2Vzc0xvZ2dpbmcgPz8gZmFsc2UpIHtcbiAgICAgIGNvbnN0IGxvZ0dyb3VwID1cbiAgICAgICAgcHJvcHMuYWNjZXNzTG9nR3JvdXAgPz9cbiAgICAgICAgbmV3IGxvZ3MuTG9nR3JvdXAodGhpcywgXCJBY2Nlc3NMb2dzXCIsIHtcbiAgICAgICAgICByZXRlbnRpb246IHByb3BzLmFjY2Vzc0xvZ1JldGVudGlvbiA/PyBsb2dzLlJldGVudGlvbkRheXMuT05FX1dFRUssXG4gICAgICAgICAgcmVtb3ZhbFBvbGljeTogcHJvcHMuYWNjZXNzTG9nUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTixcbiAgICAgICAgfSk7XG4gICAgICB0aGlzLmFjY2Vzc0xvZ0dyb3VwID0gbG9nR3JvdXA7XG5cbiAgICAgIGxvZ0dyb3VwLmFkZFRvUmVzb3VyY2VQb2xpY3koXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBwcmluY2lwYWxzOiBbbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKFwiYXBpZ2F0ZXdheS5hbWF6b25hd3MuY29tXCIpXSxcbiAgICAgICAgICBhY3Rpb25zOiBbXCJsb2dzOkNyZWF0ZUxvZ1N0cmVhbVwiLCBcImxvZ3M6RGVzY3JpYmVMb2dTdHJlYW1zXCIsIFwibG9nczpQdXRMb2dFdmVudHNcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbbG9nR3JvdXAubG9nR3JvdXBBcm5dLFxuICAgICAgICB9KSxcbiAgICAgICk7XG5cbiAgICAgIGNvbnN0IGZvcm1hdCA9XG4gICAgICAgIHByb3BzLmFjY2Vzc0xvZ0Zvcm1hdCA/P1xuICAgICAgICBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdC5jdXN0b20oXG4gICAgICAgICAgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgcmVxdWVzdElkOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXF1ZXN0SWQoKSxcbiAgICAgICAgICAgIGV2ZW50VHlwZTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0RXZlbnRUeXBlKCksXG4gICAgICAgICAgICByb3V0ZUtleTogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0Um91dGVLZXkoKSxcbiAgICAgICAgICAgIGNvbm5lY3Rpb25JZDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0Q29ubmVjdGlvbklkKCksXG4gICAgICAgICAgICBzdGF0dXM6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFN0YXR1cygpLFxuICAgICAgICAgICAgcmVzcG9uc2VMZW5ndGg6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlc3BvbnNlTGVuZ3RoKCksXG4gICAgICAgICAgICBpbnRlZ3JhdGlvbkxhdGVuY3k6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dEludGVncmF0aW9uTGF0ZW5jeSgpLFxuICAgICAgICAgICAgcmVxdWVzdFRpbWU6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJlcXVlc3RUaW1lKCksXG4gICAgICAgICAgICBpcDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0SWRlbnRpdHlTb3VyY2VJcCgpLFxuICAgICAgICAgICAgdXNlckFnZW50OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRJZGVudGl0eVVzZXJBZ2VudCgpLFxuICAgICAgICAgIH0pLFxuICAgICAgICApO1xuXG4gICAgICBhY2Nlc3NMb2dTZXR0aW5ncyA9IHtcbiAgICAgICAgZGVzdGluYXRpb246IG5ldyBhcGlnd3YyLkxvZ0dyb3VwTG9nRGVzdGluYXRpb24obG9nR3JvdXApLFxuICAgICAgICBmb3JtYXQsXG4gICAgICB9O1xuICAgIH1cblxuICAgIHRoaXMuc3RhZ2UgPSBuZXcgYXBpZ3d2Mi5XZWJTb2NrZXRTdGFnZSh0aGlzLCBcIlN0YWdlXCIsIHtcbiAgICAgIHdlYlNvY2tldEFwaTogdGhpcy5hcGksXG4gICAgICBzdGFnZU5hbWUsXG4gICAgICBhdXRvRGVwbG95OiB0cnVlLFxuICAgICAgYWNjZXNzTG9nU2V0dGluZ3MsXG4gICAgfSk7XG5cbiAgICB7XG4gICAgICBjb25zdCBoYW5kbGVycyA9IG5ldyBTZXQ8bGFtYmRhLklGdW5jdGlvbj4oW2Nvbm5lY3RIYW5kbGVyLCBkaXNjb25uZWN0SGFuZGxlciwgZGVmYXVsdEhhbmRsZXJdKTtcbiAgICAgIGZvciAoY29uc3QgaGFuZGxlciBvZiBoYW5kbGVycykge1xuICAgICAgICB0aGlzLnN0YWdlLmdyYW50TWFuYWdlbWVudEFwaUFjY2VzcyhoYW5kbGVyKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiJdfQ==