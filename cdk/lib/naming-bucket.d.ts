import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { AppTheoryNamingContext } from "./naming-context";
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
export declare class AppTheoryBucket extends Construct {
    /**
     * The bucket.
     */
    readonly bucket: s3.Bucket;
    constructor(scope: Construct, id: string, props: AppTheoryBucketProps);
}
