import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as iam from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface AppTheoryJobsTableProps {
  /**
   * Optional table name.
   * @default - CloudFormation-generated name
   */
  readonly tableName?: string;

  /**
   * Billing mode for the table.
   * @default PAY_PER_REQUEST
   */
  readonly billingMode?: dynamodb.BillingMode;

  /**
   * Removal policy for the table.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Whether deletion protection should be enabled for the table.
   * @default - AWS default (no deletion protection)
   */
  readonly deletionProtection?: boolean;

  /**
   * TTL attribute name.
   * @default "ttl"
   */
  readonly timeToLiveAttribute?: string;

  /**
   * Whether point-in-time recovery should be enabled.
   * @default true
   */
  readonly enablePointInTimeRecovery?: boolean;

  /**
   * Table encryption setting.
   * @default AWS_MANAGED
   */
  readonly encryption?: dynamodb.TableEncryption;

  /**
   * Customer-managed KMS key (required when encryption is CUSTOMER_MANAGED).
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * Provisioned read capacity (only used when billingMode is PROVISIONED).
   * @default 5
   */
  readonly readCapacity?: number;

  /**
   * Provisioned write capacity (only used when billingMode is PROVISIONED).
   * @default 5
   */
  readonly writeCapacity?: number;

  /**
   * Principals to grant DynamoDB read permissions to.
   */
  readonly grantReadTo?: iam.IGrantable[];

  /**
   * Principals to grant DynamoDB write permissions to.
   */
  readonly grantWriteTo?: iam.IGrantable[];

  /**
   * Principals to grant DynamoDB read/write permissions to.
   */
  readonly grantReadWriteTo?: iam.IGrantable[];
}

/**
 * Opinionated DynamoDB table for import pipeline job ledgers.
 *
 * Canonical schema:
 * - PK: `pk` (string)
 * - SK: `sk` (string)
 *
 * Canonical GSIs (locked by ADR 0002):
 * - `status-created-index`: `status` (pk) + `created_at` (sk)
 * - `tenant-created-index`: `tenant_id` (pk) + `created_at` (sk)
 *
 * Canonical TTL attribute:
 * - `ttl` (configurable)
 */
export class AppTheoryJobsTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: AppTheoryJobsTableProps = {}) {
    super(scope, id);

    const billingMode = props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const ttlAttribute = props.timeToLiveAttribute ?? "ttl";
    const enablePITR = props.enablePointInTimeRecovery ?? true;
    const encryption = props.encryption ?? dynamodb.TableEncryption.AWS_MANAGED;

    if (encryption === dynamodb.TableEncryption.CUSTOMER_MANAGED && !props.encryptionKey) {
      throw new Error("AppTheoryJobsTable requires encryptionKey when encryption is CUSTOMER_MANAGED");
    }

    this.table = new dynamodb.Table(this, "Table", {
      tableName: props.tableName,
      billingMode,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: ttlAttribute,
      removalPolicy,
      deletionProtection: props.deletionProtection,
      pointInTimeRecovery: enablePITR,
      encryption,
      encryptionKey: props.encryptionKey,
      ...(billingMode === dynamodb.BillingMode.PROVISIONED
        ? {
            readCapacity: props.readCapacity ?? 5,
            writeCapacity: props.writeCapacity ?? 5,
          }
        : {}),
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "status-created-index",
      partitionKey: { name: "status", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      ...(billingMode === dynamodb.BillingMode.PROVISIONED
        ? {
            readCapacity: 5,
            writeCapacity: 5,
          }
        : {}),
    });

    this.table.addGlobalSecondaryIndex({
      indexName: "tenant-created-index",
      partitionKey: { name: "tenant_id", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "created_at", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      ...(billingMode === dynamodb.BillingMode.PROVISIONED
        ? {
            readCapacity: 5,
            writeCapacity: 5,
          }
        : {}),
    });

    for (const grantee of props.grantReadTo ?? []) {
      this.table.grantReadData(grantee);
    }
    for (const grantee of props.grantWriteTo ?? []) {
      this.table.grantWriteData(grantee);
    }
    for (const grantee of props.grantReadWriteTo ?? []) {
      this.table.grantReadWriteData(grantee);
    }
  }

  /**
   * Binds the canonical jobs table env var to a Lambda function.
   */
  public bindEnvironment(fn: lambda.Function): void {
    fn.addEnvironment("APPTHEORY_JOBS_TABLE_NAME", this.table.tableName);
  }

  /**
   * Grant DynamoDB read permissions.
   */
  public grantReadTo(grantee: iam.IGrantable): void {
    this.table.grantReadData(grantee);
  }

  /**
   * Grant DynamoDB write permissions.
   */
  public grantWriteTo(grantee: iam.IGrantable): void {
    this.table.grantWriteData(grantee);
  }

  /**
   * Grant DynamoDB read/write permissions.
   */
  public grantReadWriteTo(grantee: iam.IGrantable): void {
    this.table.grantReadWriteData(grantee);
  }
}
