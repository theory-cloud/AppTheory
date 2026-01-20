import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
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
      pointInTimeRecovery: enablePITR,
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
}
