import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as iam from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import { Construct } from "constructs";

export interface AppTheoryDynamoTableGsiProps {
  readonly indexName: string;
  readonly partitionKeyName: string;
  readonly partitionKeyType?: dynamodb.AttributeType;
  readonly sortKeyName?: string;
  readonly sortKeyType?: dynamodb.AttributeType;
  readonly projectionType?: dynamodb.ProjectionType;
  readonly nonKeyAttributes?: string[];
  readonly readCapacity?: number;
  readonly writeCapacity?: number;
}

export interface AppTheoryDynamoTableProps {
  readonly tableName: string;
  readonly partitionKeyName: string;
  readonly partitionKeyType?: dynamodb.AttributeType;
  readonly sortKeyName: string;
  readonly sortKeyType?: dynamodb.AttributeType;
  readonly timeToLiveAttribute?: string;
  readonly billingMode?: dynamodb.BillingMode;
  readonly readCapacity?: number;
  readonly writeCapacity?: number;
  readonly removalPolicy?: RemovalPolicy;
  readonly deletionProtection?: boolean;
  readonly enablePointInTimeRecovery?: boolean;
  readonly encryption?: dynamodb.TableEncryption;
  readonly encryptionKey?: kms.IKey;
  readonly enableStream?: boolean;
  readonly streamViewType?: dynamodb.StreamViewType;
  readonly globalSecondaryIndexes?: AppTheoryDynamoTableGsiProps[];

  readonly grantReadTo?: iam.IGrantable[];
  readonly grantWriteTo?: iam.IGrantable[];
  readonly grantReadWriteTo?: iam.IGrantable[];
  readonly grantStreamReadTo?: iam.IGrantable[];
}

export class AppTheoryDynamoTable extends Construct {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props: AppTheoryDynamoTableProps) {
    super(scope, id);

    const billingMode = props.billingMode ?? dynamodb.BillingMode.PAY_PER_REQUEST;
    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const ttlAttribute =
      props.timeToLiveAttribute === undefined ? undefined : String(props.timeToLiveAttribute).trim();
    const enablePITR = props.enablePointInTimeRecovery ?? true;
    const encryption = props.encryption ?? dynamodb.TableEncryption.AWS_MANAGED;
    const enableStream = props.enableStream ?? false;

    if (props.timeToLiveAttribute !== undefined && !ttlAttribute) {
      throw new Error("AppTheoryDynamoTable requires timeToLiveAttribute to be a non-empty string when provided");
    }

    if (encryption === dynamodb.TableEncryption.CUSTOMER_MANAGED && !props.encryptionKey) {
      throw new Error("AppTheoryDynamoTable requires encryptionKey when encryption is CUSTOMER_MANAGED");
    }

    const stream = enableStream
      ? (props.streamViewType ?? dynamodb.StreamViewType.NEW_AND_OLD_IMAGES)
      : undefined;

    this.table = new dynamodb.Table(this, "Table", {
      tableName: props.tableName,
      billingMode,
      partitionKey: {
        name: props.partitionKeyName,
        type: props.partitionKeyType ?? dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: props.sortKeyName,
        type: props.sortKeyType ?? dynamodb.AttributeType.STRING,
      },
      ...(ttlAttribute ? { timeToLiveAttribute: ttlAttribute } : {}),
      removalPolicy,
      deletionProtection: props.deletionProtection,
      pointInTimeRecovery: enablePITR,
      encryption,
      encryptionKey: props.encryptionKey,
      stream,
      ...(billingMode === dynamodb.BillingMode.PROVISIONED
        ? {
          readCapacity: props.readCapacity ?? 5,
          writeCapacity: props.writeCapacity ?? 5,
        }
        : {}),
    });

    for (const gsi of props.globalSecondaryIndexes ?? []) {
      this.table.addGlobalSecondaryIndex({
        indexName: gsi.indexName,
        partitionKey: {
          name: gsi.partitionKeyName,
          type: gsi.partitionKeyType ?? dynamodb.AttributeType.STRING,
        },
        sortKey: gsi.sortKeyName
          ? {
            name: gsi.sortKeyName,
            type: gsi.sortKeyType ?? dynamodb.AttributeType.STRING,
          }
          : undefined,
        projectionType: gsi.projectionType ?? dynamodb.ProjectionType.ALL,
        nonKeyAttributes: gsi.nonKeyAttributes,
        ...(billingMode === dynamodb.BillingMode.PROVISIONED
          ? {
            readCapacity: gsi.readCapacity ?? 5,
            writeCapacity: gsi.writeCapacity ?? 5,
          }
          : {}),
      });
    }

    for (const grantee of props.grantReadTo ?? []) {
      this.table.grantReadData(grantee);
    }
    for (const grantee of props.grantWriteTo ?? []) {
      this.table.grantWriteData(grantee);
    }
    for (const grantee of props.grantReadWriteTo ?? []) {
      this.table.grantReadWriteData(grantee);
    }
    if ((props.grantStreamReadTo ?? []).length > 0 && !enableStream) {
      throw new Error("AppTheoryDynamoTable requires enableStream when using grantStreamReadTo");
    }
    for (const grantee of props.grantStreamReadTo ?? []) {
      this.table.grantStreamRead(grantee);
    }
  }
}
