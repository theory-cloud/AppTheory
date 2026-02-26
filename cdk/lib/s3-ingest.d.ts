import { RemovalPolicy } from "aws-cdk-lib";
import type * as iam from "aws-cdk-lib/aws-iam";
import * as iamConcrete from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import type { AppTheoryQueueProps } from "./queue";
import { AppTheoryQueue } from "./queue";
export interface AppTheoryS3IngestProps {
    /**
     * Optional existing S3 bucket to use for ingest.
     *
     * If not provided, a new bucket will be created with secure defaults.
     */
    readonly bucket?: s3.IBucket;
    /**
     * Name for the ingest bucket (only used if bucket is not provided).
     */
    readonly bucketName?: string;
    /**
     * Removal policy for created resources.
     * @default RemovalPolicy.RETAIN
     */
    readonly removalPolicy?: RemovalPolicy;
    /**
     * Whether to auto-delete objects in a created bucket when removalPolicy is DESTROY.
     * @default false
     */
    readonly autoDeleteObjects?: boolean;
    /**
     * Whether to enable EventBridge notifications for the bucket.
     *
     * When creating a bucket, this sets `eventBridgeEnabled`.
     * When using an existing bucket, this calls `enableEventBridgeNotification()`.
     * @default false
     */
    readonly enableEventBridge?: boolean;
    /**
     * Optional SQS queue target for direct S3 -> SQS notifications.
     */
    readonly queueTarget?: sqs.IQueue;
    /**
     * Optional queue props to create an SQS queue for direct S3 -> SQS notifications.
     *
     * Mutually exclusive with `queueTarget`.
     */
    readonly queueProps?: AppTheoryQueueProps;
    /**
     * Object key prefixes to match for S3 -> SQS notifications.
     */
    readonly prefixes?: string[];
    /**
     * Object key suffixes to match for S3 -> SQS notifications.
     */
    readonly suffixes?: string[];
    /**
     * Optional bucket encryption setting (only used when creating a bucket).
     * @default s3.BucketEncryption.S3_MANAGED
     */
    readonly encryption?: s3.BucketEncryption;
    /**
     * Optional customer-managed KMS key (only used when creating a bucket).
     * Only valid when `encryption` is `s3.BucketEncryption.KMS`.
     */
    readonly encryptionKey?: kms.IKey;
    /**
     * Principals to grant read permissions to.
     */
    readonly grantReadTo?: iam.IGrantable[];
    /**
     * Principals to grant write permissions to.
     */
    readonly grantWriteTo?: iam.IGrantable[];
    /**
     * Cross-account writer principals to allow via bucket policy.
     *
     * This is intentionally explicit (bucket policy), rather than implicit magic.
     */
    readonly writerPrincipals?: iamConcrete.IPrincipal[];
}
/**
 * Secure “front door” S3 ingest wiring for import pipelines.
 *
 * This construct can:
 * - Create a secure bucket (or attach to an existing bucket)
 * - Enable S3 -> EventBridge notifications
 * - Configure S3 -> SQS notifications with prefix/suffix filters
 */
export declare class AppTheoryS3Ingest extends Construct {
    readonly bucket: s3.IBucket;
    readonly queue?: sqs.IQueue;
    readonly queueConstruct?: AppTheoryQueue;
    constructor(scope: Construct, id: string, props?: AppTheoryS3IngestProps);
}
