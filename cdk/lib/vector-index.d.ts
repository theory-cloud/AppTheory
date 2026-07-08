import { RemovalPolicy } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as kms from "aws-cdk-lib/aws-kms";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import { Construct } from "constructs";
export interface AppTheoryVectorIndexProps {
    /**
     * Optional name for a created vector bucket.
     *
     * Mutually exclusive with `existingVectorBucketName`.
     */
    readonly vectorBucketName?: string;
    /**
     * Existing vector bucket name to attach the index to without creating a bucket.
     *
     * Mutually exclusive with `vectorBucketName` when `createVectorBucket` is true.
     */
    readonly existingVectorBucketName?: string;
    /**
     * Whether to create the vector bucket.
     *
     * @default true unless existingVectorBucketName is provided
     */
    readonly createVectorBucket?: boolean;
    /**
     * Required vector index name.
     */
    readonly indexName: string;
    /**
     * Required vector dimension. Titan Text Embeddings V2 commonly uses 1024.
     */
    readonly dimension: number;
    /**
     * Distance metric used by the vector index.
     * @default "cosine"
     */
    readonly distanceMetric?: string;
    /**
     * Vector data type.
     * @default "float32"
     */
    readonly dataType?: string;
    /**
     * Metadata keys that may be returned but not used as query filters.
     */
    readonly nonFilterableMetadataKeys?: string[];
    /**
     * KMS key for vector bucket/index encryption. When omitted, S3-managed AES256 encryption is used.
     */
    readonly encryptionKey?: kms.IKey;
    /**
     * Removal policy for created vector bucket and index resources.
     * @default RemovalPolicy.RETAIN
     */
    readonly removalPolicy?: RemovalPolicy;
    /** Principals to grant QueryVectors permissions to. */
    readonly grantQueryTo?: iam.IGrantable[];
    /** Principals to grant Get/List vector permissions to. */
    readonly grantReadVectorsTo?: iam.IGrantable[];
    /** Principals to grant Put/Delete vector permissions to. */
    readonly grantWriteVectorsTo?: iam.IGrantable[];
    /** Principals to grant read, query, write, and management permissions to. */
    readonly grantManageTo?: iam.IGrantable[];
}
export interface AppTheoryVectorIndexBindOptions {
    /**
     * Include Bedrock embedding environment variables in addition to vector index variables.
     * @default false
     */
    readonly includeEmbedding?: boolean;
    /**
     * Embedding provider name.
     * @default "bedrock"
     */
    readonly embeddingProvider?: string;
    /**
     * Bedrock embedding model id.
     * @default "amazon.titan-embed-text-v2:0"
     */
    readonly embeddingModelId?: string;
    /**
     * Embedding dimensions.
     * @default this.dimension
     */
    readonly embeddingDimensions?: number;
    /**
     * Whether embedding responses should be normalized.
     * @default true
     */
    readonly embeddingNormalize?: boolean;
}
/**
 * AppTheory's canonical S3 Vectors deployment primitive.
 *
 * The construct creates (or attaches to) one vector bucket and one vector index,
 * exposes stable AppTheory environment variables, and grants the narrow S3
 * Vectors and Bedrock permissions used by the runtime vectorstore helpers.
 */
export declare class AppTheoryVectorIndex extends Construct {
    readonly vectorBucket?: s3vectors.CfnVectorBucket;
    readonly index: s3vectors.CfnIndex;
    readonly vectorBucketName: string;
    readonly vectorBucketArn: string;
    readonly indexName: string;
    readonly indexArn: string;
    readonly dimension: number;
    constructor(scope: Construct, id: string, props: AppTheoryVectorIndexProps);
    /** Bind canonical vectorstore environment variables to a Lambda function. */
    bindEnvironment(fn: lambda.Function, options?: AppTheoryVectorIndexBindOptions): void;
    /** Bind canonical Bedrock Titan embedding environment variables. */
    bindTitanEmbeddingEnvironment(fn: lambda.Function, options?: AppTheoryVectorIndexBindOptions): void;
    /** Grant QueryVectors permissions, including metadata/filter reads. */
    grantQuery(grantee: iam.IGrantable): iam.Grant;
    /** Grant Get/List vector permissions without query or write. */
    grantReadVectors(grantee: iam.IGrantable): iam.Grant;
    /** Grant Put/Delete vector permissions. */
    grantWriteVectors(grantee: iam.IGrantable): iam.Grant;
    /** Grant read, query, write, and management permissions. */
    grantManage(grantee: iam.IGrantable): iam.Grant;
    /** Grant Bedrock InvokeModel for explicit Titan embedding helpers. */
    grantBedrockInvokeModel(grantee: iam.IGrantable, modelResourceArn?: string): iam.Grant;
    private grant;
}
