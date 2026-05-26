import { Duration, RemovalPolicy, Token } from "aws-cdk-lib";
import type * as iam from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import * as kinesis from "aws-cdk-lib/aws-kinesis";
import { Construct } from "constructs";

/**
 * Properties for AppTheoryKinesisStream.
 */
export interface AppTheoryKinesisStreamProps {
  /**
   * Existing Kinesis stream to wrap.
   *
   * When provided, create-time properties such as streamName, mode,
   * shardCount, retentionPeriod, encryption, encryptionKey, and
   * removalPolicy are rejected so imports cannot accidentally synthesize a
   * replacement stream.
   *
   * @default - create a new Kinesis Data Stream
   */
  readonly stream?: kinesis.IStream;

  /**
   * Optional physical stream name for a newly created stream.
   *
   * @default - CloudFormation-generated name
   */
  readonly streamName?: string;

  /**
   * Capacity mode for a newly created stream.
   *
   * @default kinesis.StreamMode.ON_DEMAND
   */
  readonly mode?: kinesis.StreamMode;

  /**
   * Shard count for provisioned streams.
   *
   * Only valid when mode is kinesis.StreamMode.PROVISIONED.
   *
   * @default 1 when mode is PROVISIONED
   */
  readonly shardCount?: number;

  /**
   * Retention period for stream records.
   *
   * @default - Kinesis default retention period
   */
  readonly retentionPeriod?: Duration;

  /**
   * Server-side encryption for a newly created stream.
   *
   * AppTheory supports AWS-managed Kinesis encryption and explicit
   * customer-managed KMS keys. Unencrypted streams are rejected.
   *
   * @default kinesis.StreamEncryption.MANAGED
   */
  readonly encryption?: kinesis.StreamEncryption;

  /**
   * Customer-managed KMS key for stream encryption.
   *
   * Requires encryption to be kinesis.StreamEncryption.KMS.
   *
   * @default - no customer-managed KMS key
   */
  readonly encryptionKey?: kms.IKey;

  /**
   * Removal policy for a newly created stream.
   *
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;

  /**
   * Principals to grant read permissions to.
   *
   * @default - No additional read grants
   */
  readonly grantReadTo?: iam.IGrantable[];

  /**
   * Principals to grant write permissions to.
   *
   * @default - No additional write grants
   */
  readonly grantWriteTo?: iam.IGrantable[];

  /**
   * Principals to grant read/write permissions to.
   *
   * @default - No additional read/write grants
   */
  readonly grantReadWriteTo?: iam.IGrantable[];
}

/**
 * AppTheory Kinesis Data Stream construct.
 *
 * Creates or wraps a single Kinesis Data Stream and exposes the stable stream
 * identity plus AppTheory grant helpers. Event source mappings and CloudWatch
 * Logs destinations are intentionally separate constructs.
 */
export class AppTheoryKinesisStream extends Construct {
  /**
   * The Kinesis stream, created or imported.
   */
  public readonly stream: kinesis.IStream;

  /**
   * The ARN of the stream.
   */
  public readonly streamArn: string;

  /**
   * The name of the stream.
   */
  public readonly streamName: string;

  constructor(scope: Construct, id: string, props: AppTheoryKinesisStreamProps = {}) {
    super(scope, id);

    if (props.stream) {
      validateImportedStreamProps(props);
      this.stream = props.stream;
    } else {
      this.stream = new kinesis.Stream(this, "Stream", streamProps(props));
    }

    this.streamArn = this.stream.streamArn;
    this.streamName = this.stream.streamName;

    for (const grantee of props.grantReadTo ?? []) {
      this.grantRead(grantee);
    }
    for (const grantee of props.grantWriteTo ?? []) {
      this.grantWrite(grantee);
    }
    for (const grantee of props.grantReadWriteTo ?? []) {
      this.grantReadWrite(grantee);
    }
  }

  /**
   * Grant read permissions for this stream and its contents.
   */
  public grantRead(grantee: iam.IGrantable): iam.Grant {
    return this.stream.grantRead(grantee);
  }

  /**
   * Grant write permissions for this stream and its contents.
   */
  public grantWrite(grantee: iam.IGrantable): iam.Grant {
    return this.stream.grantWrite(grantee);
  }

  /**
   * Grant read/write permissions for this stream and its contents.
   */
  public grantReadWrite(grantee: iam.IGrantable): iam.Grant {
    return this.stream.grantReadWrite(grantee);
  }
}

function streamProps(props: AppTheoryKinesisStreamProps): kinesis.StreamProps {
  const mode = props.mode ?? kinesis.StreamMode.ON_DEMAND;
  const encryption = props.encryption ?? kinesis.StreamEncryption.MANAGED;

  validateModeAndShardCount(mode, props.shardCount);
  validateEncryption(encryption, props.encryptionKey);

  return {
    streamName: props.streamName,
    streamMode: mode,
    shardCount: mode === kinesis.StreamMode.PROVISIONED ? (props.shardCount ?? 1) : undefined,
    retentionPeriod: props.retentionPeriod,
    encryption,
    encryptionKey: props.encryptionKey,
    removalPolicy: props.removalPolicy ?? RemovalPolicy.RETAIN,
  };
}

function validateImportedStreamProps(props: AppTheoryKinesisStreamProps): void {
  const forbidden: string[] = [];

  if (props.streamName !== undefined) forbidden.push("streamName");
  if (props.mode !== undefined) forbidden.push("mode");
  if (props.shardCount !== undefined) forbidden.push("shardCount");
  if (props.retentionPeriod !== undefined) forbidden.push("retentionPeriod");
  if (props.encryption !== undefined) forbidden.push("encryption");
  if (props.encryptionKey !== undefined) forbidden.push("encryptionKey");
  if (props.removalPolicy !== undefined) forbidden.push("removalPolicy");

  if (forbidden.length > 0) {
    throw new Error(
      `AppTheoryKinesisStream does not allow create-time properties with an imported stream: ${forbidden.join(", ")}`,
    );
  }
}

function validateModeAndShardCount(mode: kinesis.StreamMode, shardCount?: number): void {
  if (mode === kinesis.StreamMode.ON_DEMAND && shardCount !== undefined) {
    throw new Error("AppTheoryKinesisStream requires mode PROVISIONED when shardCount is provided");
  }

  if (mode !== kinesis.StreamMode.PROVISIONED || shardCount === undefined || Token.isUnresolved(shardCount)) {
    return;
  }

  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("AppTheoryKinesisStream requires shardCount to be a positive integer");
  }
}

function validateEncryption(encryption: kinesis.StreamEncryption, encryptionKey?: kms.IKey): void {
  if (encryption === kinesis.StreamEncryption.UNENCRYPTED) {
    throw new Error("AppTheoryKinesisStream requires stream encryption");
  }

  if (encryption === kinesis.StreamEncryption.KMS && !encryptionKey) {
    throw new Error("AppTheoryKinesisStream requires encryptionKey when encryption is StreamEncryption.KMS");
  }

  if (encryptionKey && encryption !== kinesis.StreamEncryption.KMS) {
    throw new Error("AppTheoryKinesisStream only supports encryptionKey when encryption is StreamEncryption.KMS");
  }
}
