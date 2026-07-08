import { Aws, Names, RemovalPolicy } from "aws-cdk-lib";
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
export class AppTheoryVectorIndex extends Construct {
  public readonly vectorBucket?: s3vectors.CfnVectorBucket;
  public readonly index: s3vectors.CfnIndex;
  public readonly vectorBucketName: string;
  public readonly vectorBucketArn: string;
  public readonly indexName: string;
  public readonly indexArn: string;
  public readonly dimension: number;

  constructor(scope: Construct, id: string, props: AppTheoryVectorIndexProps) {
    super(scope, id);

    if (!props) {
      throw new Error("AppTheoryVectorIndex requires props");
    }

    const indexName = String(props.indexName ?? "").trim();
    if (!indexName) {
      throw new Error("AppTheoryVectorIndex requires indexName");
    }
    if (!Number.isInteger(props.dimension) || props.dimension <= 0) {
      throw new Error("AppTheoryVectorIndex requires positive integer dimension");
    }

    const createVectorBucket = props.createVectorBucket ?? !props.existingVectorBucketName;
    if (createVectorBucket && props.existingVectorBucketName) {
      throw new Error("AppTheoryVectorIndex does not allow existingVectorBucketName when createVectorBucket is true");
    }
    if (!createVectorBucket && props.vectorBucketName) {
      throw new Error("AppTheoryVectorIndex does not allow vectorBucketName when createVectorBucket is false");
    }
    if (!createVectorBucket && !props.existingVectorBucketName) {
      throw new Error("AppTheoryVectorIndex requires existingVectorBucketName when createVectorBucket is false");
    }

    const removalPolicy = props.removalPolicy ?? RemovalPolicy.RETAIN;
    const encryptionConfiguration = props.encryptionKey
      ? { sseType: "aws:kms", kmsKeyArn: props.encryptionKey.keyArn }
      : { sseType: "AES256" };

    if (createVectorBucket) {
      const vectorBucketName = props.vectorBucketName ?? generatedVectorBucketName(this);
      this.vectorBucket = new s3vectors.CfnVectorBucket(this, "VectorBucket", {
        vectorBucketName,
        encryptionConfiguration,
      });
      this.vectorBucket.applyRemovalPolicy(removalPolicy);
      this.vectorBucketName = vectorBucketName;
      this.vectorBucketArn = this.vectorBucket.attrVectorBucketArn;
    } else {
      this.vectorBucketName = String(props.existingVectorBucketName).trim();
      this.vectorBucketArn = vectorBucketArnForName(this.vectorBucketName);
    }

    this.indexName = indexName;
    this.dimension = props.dimension;
    this.index = new s3vectors.CfnIndex(this, "Index", {
      vectorBucketName: this.vectorBucketName,
      indexName,
      dimension: props.dimension,
      distanceMetric: props.distanceMetric ?? "cosine",
      dataType: props.dataType ?? "float32",
      encryptionConfiguration,
      metadataConfiguration:
        props.nonFilterableMetadataKeys && props.nonFilterableMetadataKeys.length > 0
          ? { nonFilterableMetadataKeys: normalizeKeys(props.nonFilterableMetadataKeys) }
          : undefined,
    });
    this.index.applyRemovalPolicy(removalPolicy);
    if (this.vectorBucket) {
      this.index.addDependency(this.vectorBucket);
    }
    this.indexArn = this.index.attrIndexArn;

    for (const grantee of props.grantQueryTo ?? []) {
      this.grantQuery(grantee);
    }
    for (const grantee of props.grantReadVectorsTo ?? []) {
      this.grantReadVectors(grantee);
    }
    for (const grantee of props.grantWriteVectorsTo ?? []) {
      this.grantWriteVectors(grantee);
    }
    for (const grantee of props.grantManageTo ?? []) {
      this.grantManage(grantee);
    }
  }

  /** Bind canonical vectorstore environment variables to a Lambda function. */
  public bindEnvironment(fn: lambda.Function, options: AppTheoryVectorIndexBindOptions = {}): void {
    fn.addEnvironment("APPTHEORY_VECTOR_BUCKET_NAME", this.vectorBucketName);
    fn.addEnvironment("APPTHEORY_VECTOR_INDEX_NAME", this.indexName);
    fn.addEnvironment("APPTHEORY_VECTOR_INDEX_ARN", this.indexArn);
    fn.addEnvironment("APPTHEORY_VECTOR_DIMENSION", String(this.dimension));

    if (options.includeEmbedding ?? false) {
      this.bindTitanEmbeddingEnvironment(fn, options);
    }
  }

  /** Bind canonical Bedrock Titan embedding environment variables. */
  public bindTitanEmbeddingEnvironment(fn: lambda.Function, options: AppTheoryVectorIndexBindOptions = {}): void {
    fn.addEnvironment("APPTHEORY_EMBEDDING_PROVIDER", options.embeddingProvider ?? "bedrock");
    fn.addEnvironment("APPTHEORY_EMBEDDING_MODEL_ID", options.embeddingModelId ?? "amazon.titan-embed-text-v2:0");
    fn.addEnvironment("APPTHEORY_EMBEDDING_DIMENSIONS", String(options.embeddingDimensions ?? this.dimension));
    fn.addEnvironment("APPTHEORY_EMBEDDING_NORMALIZE", String(options.embeddingNormalize ?? true));
  }

  /** Grant QueryVectors permissions, including metadata/filter reads. */
  public grantQuery(grantee: iam.IGrantable): iam.Grant {
    return this.grant(
      grantee,
      "s3vectors:GetVectorBucket",
      "s3vectors:GetIndex",
      "s3vectors:GetVectors",
      "s3vectors:QueryVectors",
    );
  }

  /** Grant Get/List vector permissions without query or write. */
  public grantReadVectors(grantee: iam.IGrantable): iam.Grant {
    return this.grant(
      grantee,
      "s3vectors:GetVectorBucket",
      "s3vectors:GetIndex",
      "s3vectors:GetVectors",
      "s3vectors:ListVectors",
    );
  }

  /** Grant Put/Delete vector permissions. */
  public grantWriteVectors(grantee: iam.IGrantable): iam.Grant {
    return this.grant(
      grantee,
      "s3vectors:GetVectorBucket",
      "s3vectors:GetIndex",
      "s3vectors:PutVectors",
      "s3vectors:DeleteVectors",
    );
  }

  /** Grant read, query, write, and management permissions. */
  public grantManage(grantee: iam.IGrantable): iam.Grant {
    return this.grant(
      grantee,
      "s3vectors:GetVectorBucket",
      "s3vectors:GetIndex",
      "s3vectors:ListIndexes",
      "s3vectors:ListVectors",
      "s3vectors:GetVectors",
      "s3vectors:QueryVectors",
      "s3vectors:PutVectors",
      "s3vectors:DeleteVectors",
      "s3vectors:CreateIndex",
      "s3vectors:DeleteIndex",
      "s3vectors:CreateVectorBucket",
      "s3vectors:DeleteVectorBucket",
    );
  }

  /** Grant Bedrock InvokeModel for explicit Titan embedding helpers. */
  public grantBedrockInvokeModel(grantee: iam.IGrantable, modelResourceArn: string = "*"): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ["bedrock:InvokeModel"],
      resourceArns: [modelResourceArn],
    });
  }

  private grant(grantee: iam.IGrantable, ...actions: string[]): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions,
      resourceArns: [this.vectorBucketArn, this.indexArn],
    });
  }
}

function normalizeKeys(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value).trim()).filter((value) => value.length > 0)));
}

function vectorBucketArnForName(vectorBucketName: string): string {
  return `arn:${Aws.PARTITION}:s3vectors:${Aws.REGION}:${Aws.ACCOUNT_ID}:bucket/${vectorBucketName}`;
}

function generatedVectorBucketName(scope: Construct): string {
  const uniqueName = Names.uniqueResourceName(scope, { maxLength: 63, separator: "-" }).toLowerCase();
  return uniqueName.replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "a").replace(/-+$/, "0");
}
