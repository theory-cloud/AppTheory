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
import { refuseExplicitName } from "./private/refuse-explicit-name";
import { defaultDeletionProtection } from "./private/secure-defaults";
import { retentionFor, webSocketApiAccessLogFormat } from "./private/standard-logging";
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
  /**
   * Whether deletion protection should be enabled for the connection table.
   * @default undefined (with no naming context: the AWS default, no deletion
   * protection; with a naming context: on for a RETAIN table, off otherwise)
   */
  readonly connectionTableDeletionProtection?: boolean;

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
    const namingContext = props.namingContext;
    const logical = props.logicalName ?? (namingContext ? defaultLogicalName(this) : undefined);
    refuseExplicitName(namingContext, "AppTheoryWebSocketApi", "apiName", "api_websocket", logical, props.apiName !== undefined);
    refuseExplicitName(
      namingContext,
      "AppTheoryWebSocketApi",
      "connectionTableName",
      "dynamodb_table",
      logical ? `${logical}-connections` : undefined,
      props.connectionTableName !== undefined,
    );
    const derivedApiName = namingContext && logical ? namingContext.physicalName("api_websocket", logical) : undefined;
    const connectHandler = props.connectHandler ?? props.handler;
    const disconnectHandler = props.disconnectHandler ?? props.handler;
    const defaultHandler = props.defaultHandler ?? props.handler;

    this.api = new apigwv2.WebSocketApi(this, "Api", {
      apiName: derivedApiName && !derivedApiName.generated ? derivedApiName.name : props.apiName,
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
      const derivedTableName = namingContext && logical
        ? namingContext.physicalName("dynamodb_table", `${logical}-connections`)
        : undefined;
      const pkName = props.connectionTablePartitionKeyName ?? "PK";
      const skName = props.connectionTableSortKeyName ?? "SK";
      const ttlAttribute = props.connectionTableTimeToLiveAttribute ?? "ttl";
      const removalPolicy = props.connectionTableRemovalPolicy ?? RemovalPolicy.RETAIN;
      const enablePITR = props.connectionTableEnablePointInTimeRecovery ?? true;
      const deletionProtection = defaultDeletionProtection(
        namingContext,
        removalPolicy,
        props.connectionTableDeletionProtection,
      );

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
        new logs.LogGroup(this, "AccessLogs",
          // The construct-created access-log group is a logging resource: the
          // standard profile names it from the contract, and the legacy profile
          // keeps today's CloudFormation-generated name and consumes no entry.
          standard && namingContext && logical
          ? {
              logGroupName: namingContext.logGroupName(`logs/access/api/${logical}`),
              retention: retentionFor(namingContext.retentionDays),
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
          ? apigateway.AccessLogFormat.custom(webSocketApiAccessLogFormat())
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
