import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
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
 * The construct owns one hardened, versioned bucket and the one-action IAM
 * grant path for namespace bundles. Literal inputs produce exact-key grants;
 * unresolved token inputs defer exactness to deploy-time IAM evaluation. It
 * does not issue temporary credentials, mint bundle identifiers, or define
 * artifact URI schemes.
 */
export declare class AppTheoryS3VersionedIngress extends Construct {
    /** Canonical object-key root for every namespace release bundle. */
    static readonly KEY_ROOT = "ns/";
    /** CloudFormation-resolved physical bucket name. */
    readonly bucketName: string;
    /** CloudFormation-resolved bucket ARN. */
    readonly bucketArn: string;
    /** Canonical object-key root for every namespace release bundle. */
    readonly keyRoot: string;
    private readonly bucket;
    constructor(scope: Construct, id: string, props?: AppTheoryS3VersionedIngressProps);
    /**
     * Grant one principal `s3:PutObject` on one namespace bundle resource.
     *
     * `s3:PutObject` inherently covers multipart create, part upload, and
     * completion on the same key; separate abort and part-listing actions remain
     * ungranted. Literal location values are validated at synthesis. CDK tokens
     * skip value validation and defer exactness to deploy-time IAM evaluation;
     * missing inputs still fail closed before any grant is added.
     */
    grantUpload(grantee: iam.IGrantable, namespaceSlug: string, bundleId: string): iam.Grant;
    /**
     * Grant one principal permission to read one pinned namespace bundle version.
     *
     * The grant includes only `s3:GetObjectVersion`. Literal inputs target one
     * exact bundle key; token inputs defer exactness to deploy-time IAM
     * evaluation. Unversioned reads and bucket listing remain ungranted.
     */
    grantVersionedRead(grantee: iam.IGrantable, namespaceSlug: string, bundleId: string): iam.Grant;
    private grantExactObject;
}
