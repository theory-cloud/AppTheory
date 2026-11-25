import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import type { AppTheoryNamingContext } from "./naming-context";
import { refuseExplicitName } from "./private/refuse-explicit-name";
import { secureDefaults } from "./private/secure-defaults";

/**
 * Properties for an `AppTheoryBucket`.
 */
export interface AppTheoryBucketProps extends s3.BucketProps {
  /**
   * The naming context that derives the bucket name.
   */
  readonly namingContext: AppTheoryNamingContext;

  /**
   * The bucket's logical name.
   */
  readonly logical: string;
}

/**
 * An S3 bucket whose physical name comes from the resource-naming contract.
 *
 * With a derived profile the bucket uses the account-regional namespace and the
 * contract's prefix. With a legacy profile a pin supplies the full name
 * verbatim, and a generated entry sets no name at all so CloudFormation keeps
 * today's name and global namespace. The pinned aws-cdk-lib L2
 * (`aws-cdk-lib` 2.277.0) exposes `bucketNamespace` and `bucketNamePrefix`, so
 * no L1 property override is needed; CloudFormation appends
 * `-{account}-{region}-an` to the prefix.
 *
 * Under a derived profile the bucket also enforces TLS (`enforceSSL: true`),
 * which is the bucket-policy condition Security Hub S3.5 asks for. An explicit
 * `enforceSSL` still wins. Server access logging (S3.9) stays opt-in through the
 * inherited `serverAccessLogsBucket` and `serverAccessLogsPrefix` props, because
 * a log target costs money; the target bucket is the caller's and consumes no
 * naming entry (resource-naming contract section 4).
 */
export class AppTheoryBucket extends Construct {
  /**
   * The bucket.
   */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: AppTheoryBucketProps) {
    super(scope, id);

    const { namingContext, logical, ...bucketProps } = props;
    refuseExplicitName(namingContext, "AppTheoryBucket", "bucketName", "s3_bucket", logical, bucketProps.bucketName !== undefined);
    refuseExplicitName(
      namingContext,
      "AppTheoryBucket",
      "bucketNamePrefix",
      "s3_bucket",
      logical,
      bucketProps.bucketNamePrefix !== undefined,
    );
    refuseExplicitName(
      namingContext,
      "AppTheoryBucket",
      "bucketNamespace",
      "s3_bucket",
      logical,
      bucketProps.bucketNamespace !== undefined,
    );
    const composed = namingContext.physicalName("s3_bucket", logical);
    const resolvedProps = {
      ...bucketProps,
      enforceSSL: bucketProps.enforceSSL ?? (secureDefaults(namingContext) ? true : undefined),
    };

    if (composed.generated) {
      if (bucketProps.bucketNamePrefix !== undefined || bucketProps.bucketNamespace !== undefined) {
        throw new Error(
          `AppTheoryBucket cannot honor an account-regional prefix when s3_bucket:${logical} is a generated entry; CloudFormation generates the name and the bucket keeps the global namespace`,
        );
      }
      this.bucket = new s3.Bucket(this, "Bucket", { ...resolvedProps });
    } else if (composed.pinned) {
      if (bucketProps.bucketNamePrefix !== undefined || bucketProps.bucketNamespace !== undefined) {
        throw new Error(
          `AppTheoryBucket cannot honor an account-regional prefix when the pin for s3_bucket:${logical} owns the name`,
        );
      }
      this.bucket = new s3.Bucket(this, "Bucket", { ...resolvedProps, bucketName: composed.name });
    } else {
      if (composed.bucketNamePrefix === undefined) {
        throw new Error(`AppTheoryBucket requires an account-regional prefix for s3_bucket:${logical}`);
      }
      this.bucket = new s3.Bucket(this, "Bucket", {
        ...resolvedProps,
        bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
        bucketNamePrefix: composed.bucketNamePrefix,
      });
    }
    // Contract section 11.4: declare the resource carrying the composed name.
    namingContext.declareName("s3_bucket", logical, this.bucket);
  }
}
