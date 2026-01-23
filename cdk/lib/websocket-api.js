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
        this.api = new apigwv2.WebSocketApi(this, "Api", {
            apiName: props.apiName,
        });
        const integration = new apigwv2Integrations.WebSocketLambdaIntegration("Handler", props.handler);
        this.api.addRoute("$connect", { integration });
        this.api.addRoute("$disconnect", { integration });
        this.api.addRoute("$default", { integration });
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
            this.connectionTable.grantReadWriteData(props.handler);
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
        this.stage.grantManagementApiAccess(props.handler);
    }
}
exports.AppTheoryWebSocketApi = AppTheoryWebSocketApi;
_a = JSII_RTTI_SYMBOL_1;
AppTheoryWebSocketApi[_a] = { fqn: "@theory-cloud/apptheory-cdk.AppTheoryWebSocketApi", version: "0.2.1" };
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoid2Vic29ja2V0LWFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIndlYnNvY2tldC1hcGkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7QUFBQSw2Q0FBNEM7QUFDNUMseURBQXlEO0FBQ3pELHdEQUF3RDtBQUN4RCxpRkFBaUY7QUFDakYscURBQXFEO0FBQ3JELDJDQUEyQztBQUUzQyw2Q0FBNkM7QUFDN0MsMkNBQXVDO0FBdUJ2QyxNQUFhLHFCQUFzQixTQUFRLHNCQUFTO0lBTWxELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBaUM7UUFDekUsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsQ0FBQztRQUVqQixNQUFNLFNBQVMsR0FBRyxNQUFNLENBQUMsS0FBSyxDQUFDLFNBQVMsSUFBSSxLQUFLLENBQUMsQ0FBQyxJQUFJLEVBQUUsSUFBSSxLQUFLLENBQUM7UUFFbkUsSUFBSSxDQUFDLEdBQUcsR0FBRyxJQUFJLE9BQU8sQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtZQUMvQyxPQUFPLEVBQUUsS0FBSyxDQUFDLE9BQU87U0FDdkIsQ0FBQyxDQUFDO1FBRUgsTUFBTSxXQUFXLEdBQUcsSUFBSSxtQkFBbUIsQ0FBQywwQkFBMEIsQ0FBQyxTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBRWpHLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLFVBQVUsRUFBRSxFQUFFLFdBQVcsRUFBRSxDQUFDLENBQUM7UUFDL0MsSUFBSSxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsYUFBYSxFQUFFLEVBQUUsV0FBVyxFQUFFLENBQUMsQ0FBQztRQUNsRCxJQUFJLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxVQUFVLEVBQUUsRUFBRSxXQUFXLEVBQUUsQ0FBQyxDQUFDO1FBRS9DLE1BQU0sMkJBQTJCLEdBQy9CLENBQUMsS0FBSyxDQUFDLHFCQUFxQixJQUFJLEtBQUssQ0FBQyxJQUFJLE9B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QUFTLEVBQUUsVUFBVSxDQUFDLGNBQWMsQ0FBQyxnQkFBZ0IsRUFBRTtvQkFDdkQsUUFBUSxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMsZUFBZSxFQUFFO29CQUNyRCxZQUFZLEVBQUUsVUFBVSxDQUFDLGNBQWMsQ0FBQyxtQkFBbUIsRUFBRTtvQkFDN0QsTUFBTSxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMsYUFBYSxFQUFFO29CQUNqRCxjQUFjLEVBQUUsVUFBVSxDQUFDLGNBQWMsQ0FBQyxxQkFBcUIsRUFBRTtvQkFDakUsa0JBQWtCLEVBQUUsVUFBVSxDQUFDLGNBQWMsQ0FBQyx5QkFBeUIsRUFBRTtvQkFDekUsV0FBVyxFQUFFLFVBQVUsQ0FBQyxjQUFjLENBQUMsa0JBQWtCLEVBQUU7b0JBQzNELEVBQUUsRUFBRSxVQUFVLENBQUMsY0FBYyxDQUFDLHVCQUF1QixFQUFFO29CQUN2RCxTQUFTLEVBQUUsVUFBVSxDQUFDLGNBQWMsQ0FBQyx3QkFBd0IsRUFBRTtpQkFDaEUsQ0FBQyxDQUNILENBQUM7WUFFSixpQkFBaUIsR0FBRztnQkFDbEIsV0FBVyxFQUFFLElBQUksT0FBTyxDQUFDLHNCQUFzQixDQUFDLFFBQVEsQ0FBQztnQkFDekQsTUFBTTthQUNQLENBQUM7UUFDSixDQUFDO1FBRUQsSUFBSSxDQUFDLEtBQUssR0FBRyxJQUFJLE9BQU8sQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLE9BQU8sRUFBRTtZQUNyRCxZQUFZLEVBQUUsSUFBSSxDQUFDLEdBQUc7WUFDdEIsU0FBUztZQUNULFVBQVUsRUFBRSxJQUFJO1lBQ2hCLGlCQUFpQjtTQUNsQixDQUFDLENBQUM7UUFFSCxJQUFJLENBQUMsS0FBSyxDQUFDLHdCQUF3QixDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNyRCxDQUFDOztBQXZHSCxzREF3R0MiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBSZW1vdmFsUG9saWN5IH0gZnJvbSBcImF3cy1jZGstbGliXCI7XG5pbXBvcnQgKiBhcyBhcGlnYXRld2F5IGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtYXBpZ2F0ZXdheVwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MiBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2MlwiO1xuaW1wb3J0ICogYXMgYXBpZ3d2MkludGVncmF0aW9ucyBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXl2Mi1pbnRlZ3JhdGlvbnNcIjtcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gXCJhd3MtY2RrLWxpYi9hd3MtZHluYW1vZGJcIjtcbmltcG9ydCAqIGFzIGlhbSBmcm9tIFwiYXdzLWNkay1saWIvYXdzLWlhbVwiO1xuaW1wb3J0IHR5cGUgKiBhcyBsYW1iZGEgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sYW1iZGFcIjtcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSBcImF3cy1jZGstbGliL2F3cy1sb2dzXCI7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tIFwiY29uc3RydWN0c1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIEFwcFRoZW9yeVdlYlNvY2tldEFwaVByb3BzIHtcbiAgcmVhZG9ubHkgaGFuZGxlcjogbGFtYmRhLklGdW5jdGlvbjtcbiAgcmVhZG9ubHkgYXBpTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgc3RhZ2VOYW1lPzogc3RyaW5nO1xuXG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZT86IGR5bmFtb2RiLklUYWJsZTtcbiAgcmVhZG9ubHkgZW5hYmxlQ29ubmVjdGlvblRhYmxlPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlTmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlUGFydGl0aW9uS2V5TmFtZT86IHN0cmluZztcbiAgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlU29ydEtleU5hbWU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVRpbWVUb0xpdmVBdHRyaWJ1dGU/OiBzdHJpbmc7XG4gIHJlYWRvbmx5IGNvbm5lY3Rpb25UYWJsZVJlbW92YWxQb2xpY3k/OiBSZW1vdmFsUG9saWN5O1xuICByZWFkb25seSBjb25uZWN0aW9uVGFibGVFbmFibGVQb2ludEluVGltZVJlY292ZXJ5PzogYm9vbGVhbjtcblxuICByZWFkb25seSBlbmFibGVBY2Nlc3NMb2dnaW5nPzogYm9vbGVhbjtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nUmV0ZW50aW9uPzogbG9ncy5SZXRlbnRpb25EYXlzO1xuICByZWFkb25seSBhY2Nlc3NMb2dSZW1vdmFsUG9saWN5PzogUmVtb3ZhbFBvbGljeTtcbiAgcmVhZG9ubHkgYWNjZXNzTG9nRm9ybWF0PzogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGb3JtYXQ7XG59XG5cbmV4cG9ydCBjbGFzcyBBcHBUaGVvcnlXZWJTb2NrZXRBcGkgZXh0ZW5kcyBDb25zdHJ1Y3Qge1xuICBwdWJsaWMgcmVhZG9ubHkgYXBpOiBhcGlnd3YyLldlYlNvY2tldEFwaTtcbiAgcHVibGljIHJlYWRvbmx5IHN0YWdlOiBhcGlnd3YyLldlYlNvY2tldFN0YWdlO1xuICBwdWJsaWMgcmVhZG9ubHkgY29ubmVjdGlvblRhYmxlPzogZHluYW1vZGIuSVRhYmxlO1xuICBwdWJsaWMgcmVhZG9ubHkgYWNjZXNzTG9nR3JvdXA/OiBsb2dzLklMb2dHcm91cDtcblxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQXBwVGhlb3J5V2ViU29ja2V0QXBpUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQpO1xuXG4gICAgY29uc3Qgc3RhZ2VOYW1lID0gU3RyaW5nKHByb3BzLnN0YWdlTmFtZSA/PyBcImRldlwiKS50cmltKCkgfHwgXCJkZXZcIjtcblxuICAgIHRoaXMuYXBpID0gbmV3IGFwaWd3djIuV2ViU29ja2V0QXBpKHRoaXMsIFwiQXBpXCIsIHtcbiAgICAgIGFwaU5hbWU6IHByb3BzLmFwaU5hbWUsXG4gICAgfSk7XG5cbiAgICBjb25zdCBpbnRlZ3JhdGlvbiA9IG5ldyBhcGlnd3YySW50ZWdyYXRpb25zLldlYlNvY2tldExhbWJkYUludGVncmF0aW9uKFwiSGFuZGxlclwiLCBwcm9wcy5oYW5kbGVyKTtcblxuICAgIHRoaXMuYXBpLmFkZFJvdXRlKFwiJGNvbm5lY3RcIiwgeyBpbnRlZ3JhdGlvbiB9KTtcbiAgICB0aGlzLmFwaS5hZGRSb3V0ZShcIiRkaXNjb25uZWN0XCIsIHsgaW50ZWdyYXRpb24gfSk7XG4gICAgdGhpcy5hcGkuYWRkUm91dGUoXCIkZGVmYXVsdFwiLCB7IGludGVncmF0aW9uIH0pO1xuXG4gICAgY29uc3Qgc2hvdWxkQ3JlYXRlQ29ubmVjdGlvblRhYmxlID1cbiAgICAgIChwcm9wcy5lbmFibGVDb25uZWN0aW9uVGFibGUgPz8gZmFsc2UpIHx8IEJvb2xlYW4ocHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZSk7XG4gICAgaWYgKHByb3BzLmNvbm5lY3Rpb25UYWJsZSAmJiBzaG91bGRDcmVhdGVDb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgXCJBcHBUaGVvcnlXZWJTb2NrZXRBcGkgc3VwcG9ydHMgZWl0aGVyIHByb3BzLmNvbm5lY3Rpb25UYWJsZSBvciBwcm9wcy5lbmFibGVDb25uZWN0aW9uVGFibGUvcHJvcHMuY29ubmVjdGlvblRhYmxlTmFtZVwiLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAocHJvcHMuY29ubmVjdGlvblRhYmxlKSB7XG4gICAgICB0aGlzLmNvbm5lY3Rpb25UYWJsZSA9IHByb3BzLmNvbm5lY3Rpb25UYWJsZTtcbiAgICB9IGVsc2UgaWYgKHNob3VsZENyZWF0ZUNvbm5lY3Rpb25UYWJsZSkge1xuICAgICAgY29uc3QgcGtOYW1lID0gcHJvcHMuY29ubmVjdGlvblRhYmxlUGFydGl0aW9uS2V5TmFtZSA/PyBcIlBLXCI7XG4gICAgICBjb25zdCBza05hbWUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVTb3J0S2V5TmFtZSA/PyBcIlNLXCI7XG4gICAgICBjb25zdCB0dGxBdHRyaWJ1dGUgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVUaW1lVG9MaXZlQXR0cmlidXRlID8/IFwidHRsXCI7XG4gICAgICBjb25zdCByZW1vdmFsUG9saWN5ID0gcHJvcHMuY29ubmVjdGlvblRhYmxlUmVtb3ZhbFBvbGljeSA/PyBSZW1vdmFsUG9saWN5LlJFVEFJTjtcbiAgICAgIGNvbnN0IGVuYWJsZVBJVFIgPSBwcm9wcy5jb25uZWN0aW9uVGFibGVFbmFibGVQb2ludEluVGltZVJlY292ZXJ5ID8/IHRydWU7XG5cbiAgICAgIHRoaXMuY29ubmVjdGlvblRhYmxlID0gbmV3IGR5bmFtb2RiLlRhYmxlKHRoaXMsIFwiQ29ubmVjdGlvblRhYmxlXCIsIHtcbiAgICAgICAgdGFibGVOYW1lOiBwcm9wcy5jb25uZWN0aW9uVGFibGVOYW1lLFxuICAgICAgICBiaWxsaW5nTW9kZTogZHluYW1vZGIuQmlsbGluZ01vZGUuUEFZX1BFUl9SRVFVRVNULFxuICAgICAgICBwYXJ0aXRpb25LZXk6IHsgbmFtZTogcGtOYW1lLCB0eXBlOiBkeW5hbW9kYi5BdHRyaWJ1dGVUeXBlLlNUUklORyB9LFxuICAgICAgICBzb3J0S2V5OiB7IG5hbWU6IHNrTmFtZSwgdHlwZTogZHluYW1vZGIuQXR0cmlidXRlVHlwZS5TVFJJTkcgfSxcbiAgICAgICAgdGltZVRvTGl2ZUF0dHJpYnV0ZTogdHRsQXR0cmlidXRlLFxuICAgICAgICByZW1vdmFsUG9saWN5LFxuICAgICAgICBwb2ludEluVGltZVJlY292ZXJ5OiBlbmFibGVQSVRSLFxuICAgICAgICBlbmNyeXB0aW9uOiBkeW5hbW9kYi5UYWJsZUVuY3J5cHRpb24uQVdTX01BTkFHRUQsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5jb25uZWN0aW9uVGFibGUpIHtcbiAgICAgIHRoaXMuY29ubmVjdGlvblRhYmxlLmdyYW50UmVhZFdyaXRlRGF0YShwcm9wcy5oYW5kbGVyKTtcbiAgICB9XG5cbiAgICBsZXQgYWNjZXNzTG9nU2V0dGluZ3M6IGFwaWd3djIuSUFjY2Vzc0xvZ1NldHRpbmdzIHwgdW5kZWZpbmVkO1xuICAgIGlmIChwcm9wcy5lbmFibGVBY2Nlc3NMb2dnaW5nID8/IGZhbHNlKSB7XG4gICAgICBjb25zdCBsb2dHcm91cCA9XG4gICAgICAgIHByb3BzLmFjY2Vzc0xvZ0dyb3VwID8/XG4gICAgICAgIG5ldyBsb2dzLkxvZ0dyb3VwKHRoaXMsIFwiQWNjZXNzTG9nc1wiLCB7XG4gICAgICAgICAgcmV0ZW50aW9uOiBwcm9wcy5hY2Nlc3NMb2dSZXRlbnRpb24gPz8gbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9XRUVLLFxuICAgICAgICAgIHJlbW92YWxQb2xpY3k6IHByb3BzLmFjY2Vzc0xvZ1JlbW92YWxQb2xpY3kgPz8gUmVtb3ZhbFBvbGljeS5SRVRBSU4sXG4gICAgICAgIH0pO1xuICAgICAgdGhpcy5hY2Nlc3NMb2dHcm91cCA9IGxvZ0dyb3VwO1xuXG4gICAgICBsb2dHcm91cC5hZGRUb1Jlc291cmNlUG9saWN5KFxuICAgICAgICBuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgcHJpbmNpcGFsczogW25ldyBpYW0uU2VydmljZVByaW5jaXBhbChcImFwaWdhdGV3YXkuYW1hem9uYXdzLmNvbVwiKV0sXG4gICAgICAgICAgYWN0aW9uczogW1wibG9nczpDcmVhdGVMb2dTdHJlYW1cIiwgXCJsb2dzOkRlc2NyaWJlTG9nU3RyZWFtc1wiLCBcImxvZ3M6UHV0TG9nRXZlbnRzXCJdLFxuICAgICAgICAgIHJlc291cmNlczogW2xvZ0dyb3VwLmxvZ0dyb3VwQXJuXSxcbiAgICAgICAgfSksXG4gICAgICApO1xuXG4gICAgICBjb25zdCBmb3JtYXQgPVxuICAgICAgICBwcm9wcy5hY2Nlc3NMb2dGb3JtYXQgPz9cbiAgICAgICAgYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGb3JtYXQuY3VzdG9tKFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgIHJlcXVlc3RJZDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0UmVxdWVzdElkKCksXG4gICAgICAgICAgICBldmVudFR5cGU6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dEV2ZW50VHlwZSgpLFxuICAgICAgICAgICAgcm91dGVLZXk6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dFJvdXRlS2V5KCksXG4gICAgICAgICAgICBjb25uZWN0aW9uSWQ6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dENvbm5lY3Rpb25JZCgpLFxuICAgICAgICAgICAgc3RhdHVzOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRTdGF0dXMoKSxcbiAgICAgICAgICAgIHJlc3BvbnNlTGVuZ3RoOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXNwb25zZUxlbmd0aCgpLFxuICAgICAgICAgICAgaW50ZWdyYXRpb25MYXRlbmN5OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRJbnRlZ3JhdGlvbkxhdGVuY3koKSxcbiAgICAgICAgICAgIHJlcXVlc3RUaW1lOiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0ZpZWxkLmNvbnRleHRSZXF1ZXN0VGltZSgpLFxuICAgICAgICAgICAgaXA6IGFwaWdhdGV3YXkuQWNjZXNzTG9nRmllbGQuY29udGV4dElkZW50aXR5U291cmNlSXAoKSxcbiAgICAgICAgICAgIHVzZXJBZ2VudDogYXBpZ2F0ZXdheS5BY2Nlc3NMb2dGaWVsZC5jb250ZXh0SWRlbnRpdHlVc2VyQWdlbnQoKSxcbiAgICAgICAgICB9KSxcbiAgICAgICAgKTtcblxuICAgICAgYWNjZXNzTG9nU2V0dGluZ3MgPSB7XG4gICAgICAgIGRlc3RpbmF0aW9uOiBuZXcgYXBpZ3d2Mi5Mb2dHcm91cExvZ0Rlc3RpbmF0aW9uKGxvZ0dyb3VwKSxcbiAgICAgICAgZm9ybWF0LFxuICAgICAgfTtcbiAgICB9XG5cbiAgICB0aGlzLnN0YWdlID0gbmV3IGFwaWd3djIuV2ViU29ja2V0U3RhZ2UodGhpcywgXCJTdGFnZVwiLCB7XG4gICAgICB3ZWJTb2NrZXRBcGk6IHRoaXMuYXBpLFxuICAgICAgc3RhZ2VOYW1lLFxuICAgICAgYXV0b0RlcGxveTogdHJ1ZSxcbiAgICAgIGFjY2Vzc0xvZ1NldHRpbmdzLFxuICAgIH0pO1xuXG4gICAgdGhpcy5zdGFnZS5ncmFudE1hbmFnZW1lbnRBcGlBY2Nlc3MocHJvcHMuaGFuZGxlcik7XG4gIH1cbn1cbiJdfQ==