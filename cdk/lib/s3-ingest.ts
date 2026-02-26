import { RemovalPolicy } from "aws-cdk-lib";
import type * as iam from "aws-cdk-lib/aws-iam";
import * as iamConcrete from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import type { AppTheoryQueueProps } from "./queue";
import { AppTheoryQueue } from "./queue";

function normalizeFilters(values?: string[]): string[] {
  if (!values) return [];
  const trimmed = values.map((value) => String(value).trim()).filter((value) => value.length > 0);
  return Array.from(new Set(trimmed));
}

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
export class AppTheoryS3Ingest extends Construct {
  public readonly bucket: s3.IBucket;
  public readonly queue?: sqs.IQueue;
  public readonly queueConstruct?: AppTheoryQueue;

  constructor(scope: Construct, id: string, props: AppTheoryS3IngestProps = {}) {
    super(scope, id);

    const enableEventBridge = props.enableEventBridge ?? false;

    if (props.bucket && props.bucketName) {
      throw new Error("AppTheoryS3Ingest does not allow bucketName when bucket is provided");
    }

    if (props.queueTarget && props.queueProps) {
      throw new Error("AppTheoryS3Ingest requires at most one of queueTarget or queueProps");
    }

    if (props.encryptionKey && props.encryption !== s3.BucketEncryption.KMS) {
      throw new Error("AppTheoryS3Ingest only supports encryptionKey when encryption is BucketEncryption.KMS");
    }

    if (!props.bucket) {
      const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
      const autoDeleteObjects = props.autoDeleteObjects ?? false;
      const encryption = props.encryption ?? s3.BucketEncryption.S3_MANAGED;

      if (encryption === s3.BucketEncryption.KMS && !props.encryptionKey) {
        throw new Error("AppTheoryS3Ingest requires encryptionKey when encryption is BucketEncryption.KMS");
      }

      this.bucket = new s3.Bucket(this, "Bucket", {
        bucketName: props.bucketName,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption,
        encryptionKey: props.encryptionKey,
        enforceSSL: true,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
        removalPolicy,
        autoDeleteObjects,
        eventBridgeEnabled: enableEventBridge,
      });
    } else {
      this.bucket = props.bucket;
      if (enableEventBridge) {
        this.bucket.enableEventBridgeNotification();
      }
    }

    if (props.queueProps) {
      this.queueConstruct = new AppTheoryQueue(this, "Queue", props.queueProps);
      this.queue = this.queueConstruct.queue;
    } else if (props.queueTarget) {
      this.queue = props.queueTarget;
    }

    if (this.queue) {
      const destination = new s3n.SqsDestination(this.queue);

      const prefixes = normalizeFilters(props.prefixes);
      const suffixes = normalizeFilters(props.suffixes);

      const prefixValues = prefixes.length > 0 ? prefixes : [undefined];
      const suffixValues = suffixes.length > 0 ? suffixes : [undefined];

      for (const prefix of prefixValues) {
        for (const suffix of suffixValues) {
          if (!prefix && !suffix) {
            this.bucket.addEventNotification(s3.EventType.OBJECT_CREATED, destination);
          } else {
            this.bucket.addEventNotification(s3.EventType.OBJECT_CREATED, destination, {
              prefix,
              suffix,
            });
          }
        }
      }
    }

    for (const grantee of props.grantReadTo ?? []) {
      this.bucket.grantRead(grantee);
    }
    for (const grantee of props.grantWriteTo ?? []) {
      this.bucket.grantWrite(grantee);
    }

    for (const principal of props.writerPrincipals ?? []) {
      this.bucket.addToResourcePolicy(
        new iamConcrete.PolicyStatement({
          principals: [principal],
          actions: ["s3:GetBucketLocation", "s3:ListBucketMultipartUploads"],
          resources: [this.bucket.bucketArn],
        }),
      );
      this.bucket.addToResourcePolicy(
        new iamConcrete.PolicyStatement({
          principals: [principal],
          actions: ["s3:AbortMultipartUpload", "s3:ListMultipartUploadParts", "s3:PutObject"],
          resources: [this.bucket.arnForObjects("*")],
        }),
      );
    }
  }
}

