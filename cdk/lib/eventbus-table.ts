import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface AppTheoryEventBusTableProps {
  readonly tableName?: string;
  readonly billingMode?: dynamodb.BillingMode;
  readonly removalPolicy?: RemovalPolicy;
  readonly timeToLiveAttribute?: string;
  readonly enablePointInTimeRecovery?: boolean;
  readonly enableStream?: boolean;
  readonly streamViewType?: dynamodb.StreamViewType;
  readonly enableEventIdIndex?: boolean;
  readonly readCapacity?: number;
  readonly writeCapacity?: number;
}

export interface AppTheoryEventBusTableBindingOptions {
  /**
   * Grant read-only access for replay/query consumers.
   * When false, the handler receives read/write access for publish + replay flows.
   * @default false
   */
  readonly readOnly?: boolean;

  /**
   * Environment variable name used for the table name binding.
   * AppTheory runtime code reads `APPTHEORY_EVENTBUS_TABLE_NAME` by default.
   * @default APPTHEORY_EVENTBUS_TABLE_NAME
   */
  readonly envVarName?: string;
}

export class AppTheoryEventBusTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: AppTheoryEventBusTableProps = {}) {
    super(scope, id);

    const billingMode = props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const ttlAttribute = props.timeToLiveAttribute ?? "ttl";
    const enablePITR = props.enablePointInTimeRecovery ?? true;
    const enableStream = props.enableStream ?? false;

    const stream = enableStream
      ? (props.streamViewType ?? dynamodb.StreamViewType.NEW_IMAGE)
      : undefined;

    this.table = new dynamodb.Table(this, "Table", {
      tableName: props.tableName,
      billingMode,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: ttlAttribute,
      removalPolicy,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: enablePITR,
      },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      stream,
      ...(billingMode === dynamodb.BillingMode.PROVISIONED
        ? {
            readCapacity: props.readCapacity ?? 5,
            writeCapacity: props.writeCapacity ?? 5,
          }
        : {}),
    });

    // Required by AppTheory `pkg/services` EventBus (GetEvent by ID).
    if (props.enableEventIdIndex ?? true) {
      this.table.addGlobalSecondaryIndex({
        indexName: "event-id-index",
        partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
        ...(billingMode === dynamodb.BillingMode.PROVISIONED
          ? {
              readCapacity: 5,
              writeCapacity: 5,
            }
          : {}),
      });
    }

    // Required for tenant-wide queries (Query without event_type).
    this.table.addGlobalSecondaryIndex({
      indexName: "tenant-timestamp-index",
      partitionKey: { name: "tenant_id", type: dynamodb.AttributeType.STRING },
      // TableTheory stores `time.Time` as a string, matching Lift's schema.
      sortKey: { name: "published_at", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
      ...(billingMode === dynamodb.BillingMode.PROVISIONED
        ? {
            readCapacity: 5,
            writeCapacity: 5,
          }
        : {}),
    });
  }

  /**
   * Binds the table to a Lambda function for EventBus publish/query/replay flows.
   */
  public bind(handler: lambda.IFunction, options: AppTheoryEventBusTableBindingOptions = {}): void {
    if (!handler) {
      throw new Error("AppTheoryEventBusTable: handler is required");
    }

    if (options.readOnly) {
      this.table.grantReadData(handler);
    } else {
      this.table.grantReadWriteData(handler);
    }

    this.addEnvironment(
      handler,
      options.envVarName ?? "APPTHEORY_EVENTBUS_TABLE_NAME",
      this.table.tableName,
    );
  }

  private addEnvironment(handler: lambda.IFunction, key: string, value: string): void {
    if ("addEnvironment" in handler && typeof handler.addEnvironment === "function") {
      handler.addEnvironment(key, value);
    }
  }
}
