import { CfnOutput, Duration, Stack } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

import { AppTheoryApiDomain } from "./api-domain";
import { AppTheoryFunction, type AppTheoryFunctionAliasOptions } from "./function";
import {
  AppTheoryHttpApi,
  type AppTheoryHttpApiCorsOptions,
  type AppTheoryHttpApiDomainOptions,
  type AppTheoryHttpApiWafOptions,
} from "./http-api";

export interface AppTheoryAppProps {
  readonly appName: string;
  readonly codeAssetPath?: string;
  readonly code?: lambda.Code;
  readonly runtime?: lambda.Runtime;
  readonly handler?: string;

  readonly environment?: Record<string, string>;
  readonly memorySize?: number;
  readonly timeoutSeconds?: number;
  readonly logRetention?: logs.RetentionDays;
  readonly logGroup?: logs.ILogGroupRef;
  readonly vpc?: ec2.IVpc;
  readonly vpcSubnets?: ec2.SubnetSelection;
  readonly securityGroups?: ec2.ISecurityGroup[];
  readonly allowAllOutbound?: boolean;
  readonly allowPublicSubnet?: boolean;
  readonly alias?: AppTheoryFunctionAliasOptions;

  readonly enableDatabase?: boolean;
  readonly databaseTableName?: string;
  readonly databasePartitionKey?: string;
  readonly databaseSortKey?: string;
  readonly databaseTable?: dynamodb.ITable;

  readonly enableRateLimiting?: boolean;
  readonly rateLimitTableName?: string;

  readonly domainName?: string;
  readonly certificateArn?: string;
  readonly domain?: AppTheoryHttpApiDomainOptions;
  readonly cors?: boolean | AppTheoryHttpApiCorsOptions;
  readonly waf?: boolean | AppTheoryHttpApiWafOptions;
  readonly hostedZone?: route53.IHostedZone;
  readonly stage?: apigwv2.IStage;
}

export class AppTheoryApp extends Construct {
  public readonly api: AppTheoryHttpApi;
  public readonly fn: AppTheoryFunction;
  public readonly databaseTable?: dynamodb.ITable;
  public readonly rateLimitTable?: dynamodb.ITable;
  public readonly domain?: AppTheoryApiDomain;
  public readonly alias?: lambda.Alias;

  constructor(scope: Construct, id: string, props: AppTheoryAppProps) {
    super(scope, id);

    const appName = String(props.appName ?? "").trim();
    if (!appName) {
      throw new Error("AppTheoryApp requires props.appName");
    }

    const code = props.code ?? (props.codeAssetPath ? lambda.Code.fromAsset(props.codeAssetPath) : undefined);
    if (!code) {
      throw new Error("AppTheoryApp requires either props.code or props.codeAssetPath");
    }

    const env: Record<string, string> = { ...(props.environment ?? {}) };

    if (props.databaseTable) {
      this.databaseTable = props.databaseTable;
      env.DYNAMODB_TABLE = this.databaseTable.tableName;
    } else if (props.enableDatabase) {
      const tableName = props.databaseTableName ?? `${appName}-table`;
      const partitionKeyName = props.databasePartitionKey ?? "ID";

      this.databaseTable = new dynamodb.Table(this, "Database", {
        tableName,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        partitionKey: { name: partitionKeyName, type: dynamodb.AttributeType.STRING },
        sortKey: props.databaseSortKey
          ? { name: props.databaseSortKey, type: dynamodb.AttributeType.STRING }
          : undefined,
        timeToLiveAttribute: "ttl",
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true,
        },
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
        stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      });

      env.DYNAMODB_TABLE = this.databaseTable.tableName;
    }

    if (props.enableRateLimiting) {
      const tableName = props.rateLimitTableName ?? `${appName}-rate-limits`;

      this.rateLimitTable = new dynamodb.Table(this, "RateLimitTable", {
        tableName,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
        timeToLiveAttribute: "ttl",
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true,
        },
        encryption: dynamodb.TableEncryption.AWS_MANAGED,
      });

      const rateLimitName = this.rateLimitTable.tableName;
      env.APPTHEORY_RATE_LIMIT_TABLE_NAME = rateLimitName;
      env.RATE_LIMIT_TABLE_NAME = rateLimitName;
      env.RATE_LIMIT_TABLE = rateLimitName;
      env.LIMITED_TABLE_NAME = rateLimitName;
    }

    this.fn = new AppTheoryFunction(this, "Function", {
      functionName: appName,
      runtime: props.runtime ?? lambda.Runtime.PROVIDED_AL2023,
      handler: props.handler ?? "bootstrap",
      code,
      environment: env,
      memorySize: props.memorySize,
      timeout: Duration.seconds(props.timeoutSeconds ?? 30),
      logRetention: props.logRetention,
      logGroup: props.logGroup,
      vpc: props.vpc,
      vpcSubnets: props.vpcSubnets,
      securityGroups: props.securityGroups,
      allowAllOutbound: props.allowAllOutbound,
      allowPublicSubnet: props.allowPublicSubnet,
      alias: props.alias,
    });
    (this as { alias?: lambda.Alias }).alias = this.fn.alias;

    if (this.databaseTable) {
      this.databaseTable.grantReadWriteData(this.fn.fn);
    }
    if (this.rateLimitTable) {
      this.rateLimitTable.grantReadWriteData(this.fn.fn);
    }

    this.api = new AppTheoryHttpApi(this, "API", {
      handler: this.fn.alias ?? this.fn.fn,
      apiName: `${appName}-api`,
      cors: props.cors,
      domain: normalizeDomainOptions(this, props),
      waf: props.waf,
    });
    (this as { domain?: AppTheoryApiDomain }).domain = this.api.domain;

    const stack = Stack.of(this);

    new CfnOutput(stack, "ApiUrl", {
      value: this.api.api.url ?? "",
      description: "API Gateway endpoint URL",
    });

    new CfnOutput(stack, "FunctionName", {
      value: this.fn.fn.functionName,
      description: "Lambda function name",
    });

    if (this.databaseTable) {
      new CfnOutput(stack, "DatabaseTableName", {
        value: this.databaseTable.tableName,
        description: "DynamoDB table name",
      });
    }
  }
}

function normalizeDomainOptions(scope: Construct, props: AppTheoryAppProps): AppTheoryHttpApiDomainOptions | undefined {
  if (props.domain && (props.domainName || props.certificateArn || props.hostedZone || props.stage)) {
    throw new Error("AppTheoryApp custom domain must use either props.domain or legacy domainName/certificateArn props");
  }
  if (props.domain) {
    return props.domain;
  }
  if (!props.domainName && !props.certificateArn) {
    return undefined;
  }
  if (!props.domainName || !props.certificateArn) {
    throw new Error("AppTheoryApp requires both props.domainName and props.certificateArn for custom domain");
  }
  return {
    domainName: props.domainName,
    certificate: acm.Certificate.fromCertificateArn(scope, "Certificate", props.certificateArn),
    hostedZone: props.hostedZone,
    stage: props.stage,
  };
}
