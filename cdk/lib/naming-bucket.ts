import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

import type { AppTheoryNamingContext } from "./naming-context";
import { AppTheoryNamingProfile } from "./naming";

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
 * contract's prefix. With a legacy profile the pinned full name is used
 * verbatim. The pinned aws-cdk-lib L2 (`aws-cdk-lib` 2.277.0) exposes
 * `bucketNamespace` and `bucketNamePrefix`, so no L1 property override is
 * needed; CloudFormation appends `-{account}-{region}-an` to the prefix.
 */
export class AppTheoryBucket extends Construct {
  /**
   * The bucket.
   */
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: AppTheoryBucketProps) {
    super(scope, id);

    const { namingContext, logical, ...bucketProps } = props;
    const composed = namingContext.physicalName("s3_bucket", logical);

    if (namingContext.namingProfile === AppTheoryNamingProfile.LEGACY) {
      if (bucketProps.bucketName !== undefined && bucketProps.bucketName !== composed.name) {
        throw new Error(
          `AppTheoryBucket cannot honor props.bucketName ${JSON.stringify(bucketProps.bucketName)} when the legacy pin for s3_bucket:${logical} is ${JSON.stringify(composed.name)}`,
        );
      }
      if (bucketProps.bucketNamePrefix !== undefined || bucketProps.bucketNamespace !== undefined) {
        throw new Error(
          `AppTheoryBucket cannot honor an account-regional prefix under a legacy naming profile; the pin for s3_bucket:${logical} owns the name`,
        );
      }
      this.bucket = new s3.Bucket(this, "Bucket", { ...bucketProps, bucketName: composed.name });
      return;
    }

    if (bucketProps.bucketName !== undefined) {
      throw new Error(
        `AppTheoryBucket derives the name for s3_bucket:${logical} from the naming context; omit props.bucketName or use the legacy profile with a pin`,
      );
    }
    if (composed.bucketNamePrefix === undefined) {
      throw new Error(`AppTheoryBucket requires an account-regional prefix for s3_bucket:${logical}`);
    }
    this.bucket = new s3.Bucket(this, "Bucket", {
      ...bucketProps,
      bucketNamespace: s3.BucketNamespace.ACCOUNT_REGIONAL,
      bucketNamePrefix: composed.bucketNamePrefix,
    });
  }
}
