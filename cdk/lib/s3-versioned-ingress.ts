import { Duration, Fn, Token } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

const NAMESPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const BUNDLE_ID_PATTERN = /^rel_[0-9a-z]{26}$/;

/**
 * Props for the AppTheoryS3VersionedIngress construct.
 */
export interface AppTheoryS3VersionedIngressProps {
  /**
   * Physical name for the artifact ingress bucket.
   *
   * Token-valued names pass through to the S3 construct unchanged.
   * @default undefined (CloudFormation-generated name)
   */
  readonly bucketName?: string;
}

/**
 * Version-pinned artifact ingress bucket for Theory Cloud namespace releases.
 *
 * The construct owns one hardened, versioned bucket, its seven-day incomplete
 * multipart-upload reaping rule, and the one-action IAM grant path for
 * namespace bundles. Grant locations must be literal values, so every grant
 * targets one exact object key; unresolved token locations are rejected. It
 * does not issue temporary credentials, mint bundle identifiers, or define
 * artifact URI schemes.
 */
export class AppTheoryS3VersionedIngress extends Construct {
  /** Canonical object-key root for every namespace release bundle. */
  public static readonly KEY_ROOT = "ns/";

  /** CloudFormation-resolved physical bucket name. */
  public readonly bucketName: string;

  /** CloudFormation-resolved bucket ARN. */
  public readonly bucketArn: string;

  /** Canonical object-key root for every namespace release bundle. */
  public readonly keyRoot: string;

  private readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: AppTheoryS3VersionedIngressProps = {}) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, "Bucket", {
      bucketName: props.bucketName,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(7), enabled: true }],
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    });

    this.bucketName = this.bucket.bucketName;
    this.bucketArn = this.bucket.bucketArn;
    this.keyRoot = AppTheoryS3VersionedIngress.KEY_ROOT;
  }

  /**
   * Grant one principal `s3:PutObject` on one namespace bundle resource.
   *
   * `s3:PutObject` inherently covers multipart create, part upload, and
   * completion on the same key; separate abort and part-listing actions remain
   * ungranted. Location values must be literal strings: AppTheory validates them
   * at synthesis and rejects unresolved CDK tokens, because a grant cannot
   * guarantee an exact key for a location that CloudFormation only resolves at
   * deployment. Missing inputs still fail closed before any grant is added.
   */
  public grantUpload(grantee: iam.IGrantable, namespaceSlug: string, bundleId: string): iam.Grant {
    return this.grantExactObject(grantee, namespaceSlug, bundleId, "s3:PutObject");
  }

  /**
   * Grant one principal permission to read one pinned namespace bundle version.
   *
   * The grant includes only `s3:GetObjectVersion`. Inputs must be literal
   * strings and target one exact bundle key; unresolved CDK tokens are rejected.
   * Unversioned reads and bucket listing remain ungranted.
   */
  public grantVersionedRead(grantee: iam.IGrantable, namespaceSlug: string, bundleId: string): iam.Grant {
    return this.grantExactObject(grantee, namespaceSlug, bundleId, "s3:GetObjectVersion");
  }

  private grantExactObject(
    grantee: iam.IGrantable,
    namespaceSlug: string,
    bundleId: string,
    action: string,
  ): iam.Grant {
    if (!grantee || !grantee.grantPrincipal) {
      throw new Error("AppTheoryS3VersionedIngress requires a grantable principal");
    }

    const slug = validateLocationValue(namespaceSlug, "namespaceSlug", NAMESPACE_SLUG_PATTERN);
    const id = validateLocationValue(bundleId, "bundleId", BUNDLE_ID_PATTERN);
    const objectKey = Fn.join("", [AppTheoryS3VersionedIngress.KEY_ROOT, slug, "/", id]);

    return iam.Grant.addToPrincipal({
      grantee,
      actions: [action],
      resourceArns: [this.bucket.arnForObjects(objectKey)],
    });
  }
}

function validateLocationValue(value: string, propName: string, pattern: RegExp): string {
  if (value === undefined || value === null) {
    throw new Error(`AppTheoryS3VersionedIngress requires ${propName}`);
  }
  if (Token.isUnresolved(value)) {
    throw new Error(
      `AppTheoryS3VersionedIngress ${propName} must be a literal value; unresolved CDK tokens are rejected because AppTheory cannot guarantee an exact-key grant for a CloudFormation-resolved location`,
    );
  }
  if (!pattern.test(value)) {
    throw new Error(`AppTheoryS3VersionedIngress ${propName} must match ${pattern.source}`);
  }
  return value;
}
