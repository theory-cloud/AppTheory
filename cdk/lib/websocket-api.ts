import { RemovalPolicy } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface AppTheoryWebSocketApiProps {
  readonly handler: lambda.IFunction;
  readonly apiName?: string;
  readonly stageName?: string;

  readonly connectionTable?: dynamodb.ITable;
  readonly enableConnectionTable?: boolean;
  readonly connectionTableName?: string;
  readonly connectionTablePartitionKeyName?: string;
  readonly connectionTableSortKeyName?: string;
  readonly connectionTableTimeToLiveAttribute?: string;
  readonly connectionTableRemovalPolicy?: RemovalPolicy;
  readonly connectionTableEnablePointInTimeRecovery?: boolean;

  readonly enableAccessLogging?: boolean;
  readonly accessLogGroup?: logs.ILogGroup;
  readonly accessLogRetention?: logs.RetentionDays;
  readonly accessLogRemovalPolicy?: RemovalPolicy;
  readonly accessLogFormat?: apigateway.AccessLogFormat;
}

export class AppTheoryWebSocketApi extends Construct {
  public readonly api: apigwv2.WebSocketApi;
  public readonly stage: apigwv2.WebSocketStage;
  public readonly connectionTable?: dynamodb.ITable;
  public readonly accessLogGroup?: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: AppTheoryWebSocketApiProps) {
    super(scope, id);

    const stageName = String(props.stageName ?? "dev").trim() || "dev";

    this.api = new apigwv2.WebSocketApi(this, "Api", {
      apiName: props.apiName,
    });

    const integration = new apigwv2Integrations.WebSocketLambdaIntegration("Handler", props.handler);

    this.api.addRoute("$connect", { integration });
    this.api.addRoute("$disconnect", { integration });
    this.api.addRoute("$default", { integration });

    const shouldCreateConnectionTable =
      (props.enableConnectionTable ?? false) || Boolean(props.connectionTableName);
    if (props.connectionTable && shouldCreateConnectionTable) {
      throw new Error(
        "AppTheoryWebSocketApi supports either props.connectionTable or props.enableConnectionTable/props.connectionTableName",
      );
    }

    if (props.connectionTable) {
      this.connectionTable = props.connectionTable;
    } else if (shouldCreateConnectionTable) {
      const pkName = props.connectionTablePartitionKeyName ?? "PK";
      const skName = props.connectionTableSortKeyName ?? "SK";
      const ttlAttribute = props.connectionTableTimeToLiveAttribute ?? "ttl";
      const removalPolicy = props.connectionTableRemovalPolicy ?? RemovalPolicy.RETAIN;
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

    let accessLogSettings: apigwv2.IAccessLogSettings | undefined;
    if (props.enableAccessLogging ?? false) {
      const logGroup =
        props.accessLogGroup ??
        new logs.LogGroup(this, "AccessLogs", {
          retention: props.accessLogRetention ?? logs.RetentionDays.ONE_WEEK,
          removalPolicy: props.accessLogRemovalPolicy ?? RemovalPolicy.RETAIN,
        });
      this.accessLogGroup = logGroup;

      logGroup.addToResourcePolicy(
        new iam.PolicyStatement({
          principals: [new iam.ServicePrincipal("apigateway.amazonaws.com")],
          actions: ["logs:CreateLogStream", "logs:DescribeLogStreams", "logs:PutLogEvents"],
          resources: [logGroup.logGroupArn],
        }),
      );

      const format =
        props.accessLogFormat ??
        apigateway.AccessLogFormat.custom(
          JSON.stringify({
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
          }),
        );

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
