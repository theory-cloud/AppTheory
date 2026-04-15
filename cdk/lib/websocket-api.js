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
AppTheoryWebSocketApi[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryWebSocketApi", version: "0.24.4" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vic29ja2V0LWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIndlYnNvY2tldC1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBNEM7QUFDNUMseURBQXlEO0FBQ3pELHdEQUF3RDtBQUN4RCxpRkFBaUY7QUFDakYscURBQXFEO0FBQ3JELDJDQUEyQztBQUUzQyw2Q0FBNkM7QUFDN0MsMkNBQXVDO0FBMEJ2QyxNQUFhLHFCQUFzQixTQUFRLHNCQUFTO0lBTWxELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFNBQVMsSUFBSSxLQUFLLENBQUMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxLQUFLLENBQUM7UUFDbkUsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDO1FBQzdELE1BQU0saUJBQWlCLEdBQUcsS0FBSyxDQUFDLGlCQUFpQixJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUM7UUFDbkUsTUFBTSxjQUFjLEdBQUcsS0FBSyxDQUFDLGNBQWMsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDO1FBRTdELElBQUksQ0FBQyxHQUFHLEdBQUcsSUFBSSxPQUFPLENBQUMsWUFBWSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7WUFDL0MsT0FBTyxFQUFFLEtBQUssQ0FBQyxPQUFPO1NBQ3ZCLENBQUMsQ0FBQztRQUVILE1BQU0sd0JBQXdCLEdBQzVCLE9BQU8sQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLElBQUksT0FBTyxDQUFDLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQyxJQUFJLE9BQU8sQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDckcsSUFBSSx3QkFBd0IsRUFBRSxDQUFDO1lBQzdCLE1BQU0sa0JBQWtCLEdB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QixFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUM7WUFDaEcsS0FBSyxNQUFNLE9BQU8sSUFBSSxRQUFRLEVBQUUsQ0FBQztnQkFDL0IsSUFBSSxDQUFDLEtBQUssQ0FBQyx3QkFBd0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztZQUMvQyxDQUFDO1FBQ0gsQ0FBQztJQUNILENBQUM7O0FBbklILHNEQW9JQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IFJlbW92YWxQb2xpY3kgfSBmcm9tIFwiYXdzLWNkay1saWJcIjtcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSBcImF3cy1jZGstbGliL2F3cy1hcGlnYXRld2F5XCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YyIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyXCI7XG5pbXBvcnQgKiBhcyBhcGlnd3YySW50ZWdyYXRpb25zIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheXYyLWludGVncmF0aW9uc1wiO1xuaW1wb3J0ICogYXMgZHluYW1vZGIgZnJvbSBcImF3cy1jZGstbGliL2F3cy1keW5hbW9kYlwiO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtaWFtXCI7XG5pbXBvcnQgdHlwZSAqIGFzIGxhbWJkYSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxhbWJkYVwiO1xuaW1wb3J0ICogYXMgbG9ncyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWxvZ3NcIjtcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gXCJjb25zdHJ1Y3RzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQXBwVGhlb3J5V2ViU29ja2V0QXBpUHJvcHMge1xuICByZWFkb25seSBoYW5kbGVyOiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBjb25uZWN0SGFuZGxlcj86IGxhbWJkYS5JRnVuY3Rpb247XG4gIHJlYWRvbmx5IGRpc2Nvbm5lY3RIYW5kbGVyPzogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgZGVmYXVsdEhhbmRsZXI/OiBsYW1iZGEuSUZ1bmN0aW9uO1xuICByZWFkb25seSBhcGlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBzdGFnZU5hbWU/OiBzdHJpbmc7XG5cbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICByZWFkb25seSBlbmFibGVDb25uZWN0aW9uVGFibGU/OiBib29sZWFuO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVQYXJ0aXRpb25LZXlOYW1lPzogc3RyaW5nO1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVTb3J0S2V5TmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlVGltZVRvTGl2ZUF0dHJpYnV0ZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlUmVtb3ZhbFBvbGljeT86IFJlbW92YWxQb2xpY3k7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZUVuYWJsZVBvaW50SW5UaW1lUmVjb3Zlcnk/OiBib29sZWFuO1xuXG4gIHJlYWRvbmx5IGVuYWJsZUFjY2Vzc0xvZ2dpbmc/OiBib29sZWFuO1xuICByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZXRlbnRpb24/OiBsb2dzLlJldGVudGlvbkRheXM7XG4gIHJlYWRvbmx5IGFjY2Vzc0xvZ1JlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBhY2Nlc3NMb2dGb3JtYXQ/OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdDtcbn1cblxuZXhwb3J0IGNsYXNzIEFwcFRoZW9yeVdlYlNvY2tldEFwaSBleHRlbmRzIENvbnN0cnVjdCB7XG4gIHB1YmxpYyByZWFkb25seSBhcGk6IGFwaWd3djIuV2ViU29ja2V0QXBpO1xuICBwdWJsaWMgcmVhZG9ubHkgc3RhZ2U6IGFwaWd3djIuV2ViU29ja2V0U3RhZ2U7XG4gIHB1YmxpYyByZWFkb25seSBjb25uZWN0aW9uVGFibGU/OiBkeW5hbW9kYi5JVGFibGU7XG4gIHB1YmxpYyByZWFkb25seSBhY2Nlc3NMb2dHcm91cD86IGxvZ3MuSUxvZ0dyb3VwO1xuXG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzOiBBcHBUaGVvcnlXZWJTb2NrZXRBcGlQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCk7XG5cbiAgICBjb25zdCBzdGFnZU5hbWUgPSBTdHJpbmcocHJvcHMuc3RhZ2VOYW1lID8/IFwiZGV2XCIpLnRyaW0oKSB8fCBcImRldlwiO1xuICAgIGNvbnN0IGNvbm5lY3RIYW5kbGVyID0gcHJvcHMuY29ubmVjdEhhbmRsZXIgPz8gcHJvcHMuaGFuZGxlcjtcbiAgICBjb25zdCBkaXNjb25uZWN0SGFuZGxlciA9IHByb3BzLmRpc2Nvbm5lY3RIYW5kbGVyID8/IHByb3BzLmhhbmRsZXI7XG4gICAgY29uc3QgZGVmYXVsdEhhbmRsZXIgPSBwcm9wcy5kZWZhdWx0SGFuZGxlciA/PyBwcm9wcy5oYW5kbGVyO1xuXG4gICAgdGhpcy5hcGkgPSBuZXcgYXBpZ3d2Mi5XZWJTb2NrZXRBcGkodGhpcywgXCJBcGlcIiwge1xuICAgICAgYXBpTmFtZTogcHJvcHMuYXBpTmFtZSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHVzZVJvdXRlU3BlY2lmaWNIYW5kbGVycyA9XG4gICAgICBCb29sZWFuKHByb3BzLmNvbm5lY3RIYW5kbGVyKSB8fCBCb29sZWFuKHByb3BzLmRpc2Nvbm5lY3RIYW5kbGVyKSB8fCBCb29sZWFuKHByb3BzLmRlZmF1bHRIYW5kbGVyKTtcbiAgICBpZiAodXNlUm91dGVTcGVjaWZpY0hhbmRsZXJzKSB7XG4gICAgICBjb25zdCBjb25uZWN0SW50ZWdyYXRpb24gPSBuZXcgYXBpZ3d2MkludGVncmF0aW9ucy5XZWJTb2NrZXRMYW1iZGFJbnRlZ3JhdGlvbihcIkNvbm5lY3RIYW5kbGVyXCIsIGNvbm5lY3RIYW5kbGVyKTtcbiAgICAgIGNvbnN0IGRpc2Nvbm5lY3RJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFxuICAgICAgICBcIkRpc2Nvbm5lY3RIYW5kbGVyXCIsXG4gICAgICAgIGRpc2Nvbm5lY3RIYW5kbGVyLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGRlZmF1bHRJbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFwiRGVmYXVsdEhhbmRsZXJcIiwgZGVmYXVsdEhhbmRsZXIpO1xuXG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRjb25uZWN0XCIsIHsgaW50ZWdyYXRpb246IGNvbm5lY3RJbnRlZ3JhdGlvbiB9KTtcbiAgICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGRpc2Nvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbjogZGlzY29ubmVjdEludGVncmF0aW9uIH0pO1xuICAgICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGVmYXVsdFwiLCB7IGludGVncmF0aW9uOiBkZWZhdWx0SW50ZWdyYXRpb24gfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IGludGVncmF0aW9uID0gbmV3IGFwaWd3djJJbnRlZ3JhdGlvbnMuV2ViU29ja2V0TGFtYmRhSW50ZWdyYXRpb24oXCJIYW5kbGVyXCIsIHByb3BzLmhhbmRsZXIpO1xuXG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRjb25uZWN0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkaXNjb25uZWN0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkZWZhdWx0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2hvdWxkQ3JlYXRlQ29ubmVjdGlvblRhYmxlID1cbiAgICAgIChwcm9wcy5lbmFibGVDb25uZWN0aW9uVGFibGUgPz8gZmFsc2UpIHx8IEJvb2xlYW4ocHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZSk7XG4gICAgaWYgKHByb3BzLmNvbm5lY3Rpb25UYWJsZSAmJiBzaG91bGRDcmVhdGVDb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGkgc3VwcG9ydHMgZWl0aGVyIHByb3BzLmNvbm5lY3Rpb25UYWJsZSBvciBwcm9wcy5lbmFibGVDb25uZWN0aW9uVGFibGUvcHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZVwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuY29ubmVjdGlvblRhYmxlKSB7XG4gICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZTtcbiAgICB9IGVsc2UgaWYgKHNob3VsZENyZWF0ZUNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgY29uc3QgcGtOYW1lID0gcHJvcHMuY29ubmVjdGlvblRhYmxlUGFydGl0aW9uS2V5TmFtZSA/PyBcIlBLXCI7XG4gICAgICBjb25zdCBza05hbWUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVTb3J0S2V5TmFtZSA/PyBcIlNLXCI7XG4gICAgICBjb25zdCB0dGxBdHRyaWJ1dGUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVUaW1lVG9MaXZlQXR0cmlidXRlID8/IFwidHRsXCI7XG4gICAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuY29ubmVjdGlvblRhYmxlUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICAgIGNvbnN0IGVuYWJsZVBJVFIgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVFbmFibGVQb2ludEluVGltZVJlY292ZXJ5ID8/IHRydWU7XG5cbiAgICAgIHRoaXMuY29ubmVjdGlvblRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiQ29ubmVjdGlvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBwcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogcGtOYW1lLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICBzb3J0S2V5OiB7IG5hbWU6IHNrTmFtZSwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogdHRsQXR0cmlidXRlLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5U3BlY2lmaWNhdGlvbjoge1xuICAgICAgICAgIHBvaW50SW5UaW1lUmVjb3ZlcnlFbmFibGVkOiBlbmFibGVQSVRSLFxuICAgICAgICB9LFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5jb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIGNvbnN0IGhhbmRsZXJzID0gbmV3IFNldDxsYW1iZGEuSUZ1bmN0aW9uPihbY29ubmVjdEhhbmRsZXIsIGRpc2Nvbm5lY3RIYW5kbGVyLCBkZWZhdWx0SGFuZGxlcl0pO1xuICAgICAgZm9yIChjb25zdCBoYW5kbGVyIG9mIGhhbmRsZXJzKSB7XG4gICAgICAgIHRoaXMuY29ubmVjdGlvblRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShoYW5kbGVyKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBsZXQgYWNjZXNzTG9nU2V0dGluZ3M6IGFwaWd3djIuSUFjY2Vzc0xvZ1NldHRpbmdzIHwgdW5kZWZpbmVkO1xuICAgIGlmIChwcm9wcy5lbmFibGVBY2Nlc3NMb2dnaW5nID8/IGZhbHNlKSB7XG4gICAgICBjb25zdCBsb2dHcm91cCA9XG4gICAgICAgIHByb3BzLmFjY2Vzc0xvZ0dyb3VwID8/XG4gICAgICAgIG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBwcm9wcy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmFjY2Vzc0xvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICAgIH0pO1xuICAgICAgdGhpcy5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgICBsb2dHcm91cC5hZGRUb1Jlc291cmNlUG9saWN5KFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgcHJpbmNpcGFsczogW25ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiKV0sXG4gICAgICAgICAgYWN0aW9uczogW1wibG9nczpDcmVhdGVMb2dTdHJlYW1cIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiLCBcImxvZ3M6UHV0TG9nRXZlbnRzXCJdLFxuICAgICAgICAgIHJlc291cmNlczogW2xvZ0dyb3VwLmxvZ0dyb3VwQXJuXSxcbiAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgICBjb25zdCBmb3JtYXQgPVxuICAgICAgICBwcm9wcy5hY2Nlc3NMb2dGb3JtYXQgPz9cbiAgICAgICAgYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGb3JtYXQuY3VzdG9tKFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIHJlcXVlc3RJZDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0UmVxdWVzdElkKCksXG4gICAgICAgICAgICBldmVudFR5cGU6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dEV2ZW50VHlwZSgpLFxuICAgICAgICAgICAgcm91dGVLZXk6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJvdXRlS2V5KCksXG4gICAgICAgICAgICBjb25uZWN0aW9uSWQ6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dENvbm5lY3Rpb25JZCgpLFxuICAgICAgICAgICAgc3RhdHVzOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRTdGF0dXMoKSxcbiAgICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXNwb25zZUxlbmd0aCgpLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25MYXRlbmN5OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRJbnRlZ3JhdGlvbkxhdGVuY3koKSxcbiAgICAgICAgICAgIHJlcXVlc3RUaW1lOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXF1ZXN0VGltZSgpLFxuICAgICAgICAgICAgaXA6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dElkZW50aXR5U291cmNlSXAoKSxcbiAgICAgICAgICAgIHVzZXJBZ2VudDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0SWRlbnRpdHlVc2VyQWdlbnQoKSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgKTtcblxuICAgICAgYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgIGRlc3RpbmF0aW9uOiBuZXcgYXBpZ3d2Mi5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKGxvZ0dyb3VwKSxcbiAgICAgICAgZm9ybWF0LFxuICAgICAgfTtcbiAgICB9XG5cbiAgICB0aGlzLnN0YWdlID0gbmV3IGFwaWd3djIuV2ViU29ja2V0U3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICB3ZWJTb2NrZXRBcGk6IHRoaXMuYXBpLFxuICAgICAgc3RhZ2VOYW1lLFxuICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgIGFjY2Vzc0xvZ1NldHRpbmdzLFxuICAgIH0pO1xuXG4gICAge1xuICAgICAgY29uc3QgaGFuZGxlcnMgPSBuZXcgU2V0PGxhbWJkYS5JRnVuY3Rpb24+KFtjb25uZWN0SGFuZGxlciwgZGlzY29ubmVjdEhhbmRsZXIsIGRlZmF1bHRIYW5kbGVyXSk7XG4gICAgICBmb3IgKGNvbnN0IGhhbmRsZXIgb2YgaGFuZGxlcnMpIHtcbiAgICAgICAgdGhpcy5zdGFnZS5ncmFudE1hbmFnZW1lbnRBcGlBY2Nlc3MoaGFuZGxlcik7XG4gICAgICB9XG4gICAgfVxuICB9XG59XG4iXX0=