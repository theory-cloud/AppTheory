import { Duration, RemovalPolicy } from "aws-cdk-lib";
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
export declare class AppTheoryKinesisStream extends Construct {
    /**
     * The Kinesis stream, created or imported.
     */
    readonly stream: kinesis.IStream;
    /**
     * The ARN of the stream.
     */
    readonly streamArn: string;
    /**
     * The name of the stream.
     */
    readonly streamName: string;
    constructor(scope: Construct, id: string, props?: AppTheoryKinesisStreamProps);
    /**
     * Grant read permissions for this stream and its contents.
     */
    grantRead(grantee: iam.IGrantable): iam.Grant;
    /**
     * Grant write permissions for this stream and its contents.
     */
    grantWrite(grantee: iam.IGrantable): iam.Grant;
    /**
     * Grant read/write permissions for this stream and its contents.
     */
    grantReadWrite(grantee: iam.IGrantable): iam.Grant;
}
