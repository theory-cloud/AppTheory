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
export declare class AppTheoryBucket extends Construct {
    /**
     * The bucket.
     */
    readonly bucket: s3.Bucket;
    constructor(scope: Construct, id: string, props: AppTheoryBucketProps);
}
