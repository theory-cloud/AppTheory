import { RemovalPolicy } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { defaultLogicalName } from "./private/logical-name";
import { retentionFor } from "./private/standard-logging";
import type { AppTheoryNamingContext } from "./naming-context";

export interface AppTheoryWebSocketApiProps {
  readonly handler: lambda.IFunction;
  readonly connectHandler?: lambda.IFunction;
  readonly disconnectHandler?: lambda.IFunction;
  readonly defaultHandler?: lambda.IFunction;
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

  /**
   * Optional naming and logging context.
   *
   * With the standard logging profile access logging is on by default to a log
   * group named `logs/access/api/{logicalName}` carrying the contract's JSON
   * field set. Pass `enableAccessLogging: false` to opt out.
   *
   * With no context the construct synthesizes exactly as before.
   *
   * @default undefined
   */
  readonly namingContext?: AppTheoryNamingContext;

  /**
   * The API's logical name. Defaults to the kebab-cased construct id when a
   * naming context is present.
   *
   * @default undefined
   */
  readonly logicalName?: string;
}

export class AppTheoryWebSocketApi extends Construct {
  public readonly api: apigwv2.WebSocketApi;
  public readonly stage: apigwv2.WebSocketStage;
  public readonly connectionTable?: dynamodb.ITable;
  public readonly accessLogGroup?: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: AppTheoryWebSocketApiProps) {
    super(scope, id);

    const stageName = String(props.stageName ?? "dev").trim() || "dev";
    const standard = props.namingContext?.standardLogging === true;
    const logical = props.logicalName ?? (props.namingContext ? defaultLogicalName(this) : undefined);
    const connectHandler = props.connectHandler ?? props.handler;
    const disconnectHandler = props.disconnectHandler ?? props.handler;
    const defaultHandler = props.defaultHandler ?? props.handler;

    this.api = new apigwv2.WebSocketApi(this, "Api", {
      apiName: props.apiName,
    });

    const useRouteSpecificHandlers =
      Boolean(props.connectHandler) || Boolean(props.disconnectHandler) || Boolean(props.defaultHandler);
    if (useRouteSpecificHandlers) {
      const connectIntegration = new apigwv2Integrations.WebSocketLambdaIntegration("ConnectHandler", connectHandler);
      const disconnectIntegration = new apigwv2Integrations.WebSocketLambdaIntegration(
        "DisconnectHandler",
        disconnectHandler,
      );
      const defaultIntegration = new apigwv2Integrations.WebSocketLambdaIntegration("DefaultHandler", defaultHandler);

      this.api.addRoute("$connect", { integration: connectIntegration });
      this.api.addRoute("$disconnect", { integration: disconnectIntegration });
      this.api.addRoute("$default", { integration: defaultIntegration });
    } else {
      const integration = new apigwv2Integrations.WebSocketLambdaIntegration("Handler", props.handler);

      this.api.addRoute("$connect", { integration });
      this.api.addRoute("$disconnect", { integration });
      this.api.addRoute("$default", { integration });
    }

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
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: enablePITR,
        },
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
      });
    }

    if (this.connectionTable) {
      const handlers = new Set<lambda.IFunction>([connectHandler, disconnectHandler, defaultHandler]);
      for (const handler of handlers) {
        this.connectionTable.grantReadWriteData(handler);
      }
    }

    let accessLogSettings: apigwv2.IAccessLogSettings | undefined;
    if (props.enableAccessLogging ?? standard) {
      if (standard && !props.accessLogGroup && !logical) {
        throw new Error("AppTheoryWebSocketApi standard logging requires a logical name");
      }
      const logGroup =
        props.accessLogGroup ??
        new logs.LogGroup(this, "AccessLogs", standard && props.namingContext && logical
          ? {
              logGroupName: props.namingContext.logGroupName(`logs/access/api/${logical}`),
              retention: retentionFor(props.namingContext.retentionDays),
              removalPolicy: props.accessLogRemovalPolicy ?? RemovalPolicy.RETAIN,
            }
          : {
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
        (standard
          ? apigateway.AccessLogFormat.custom(
              JSON.stringify({
                requestId: apigateway.AccessLogField.contextRequestId(),
                requestTime: apigateway.AccessLogField.contextRequestTime(),
                routeKey: apigateway.AccessLogField.contextRouteKey(),
                status: apigateway.AccessLogField.contextStatus(),
                protocol: apigateway.AccessLogField.contextProtocol(),
                responseLength: apigateway.AccessLogField.contextResponseLength(),
                integrationLatency: apigateway.AccessLogField.contextIntegrationLatency(),
                sourceIp: apigateway.AccessLogField.contextIdentitySourceIp(),
              }),
            )
          : apigateway.AccessLogFormat.custom(
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
            ));

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
      const handlers = new Set<lambda.IFunction>([connectHandler, disconnectHandler, defaultHandler]);
      for (const handler of handlers) {
        this.stage.grantManagementApiAccess(handler);
      }
    }
  }
}
