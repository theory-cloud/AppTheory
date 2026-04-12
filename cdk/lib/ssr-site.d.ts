import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
export declare enum AppTheorySsrSiteMode {
    /**
     * Lambda Function URL is the default origin. Direct S3 behaviors are used only for
     * immutable assets and any explicitly configured static path patterns.
     */
    SSR_ONLY = "ssr-only",
    /**
     * S3 is the primary HTML origin and Lambda SSR/ISR is the fallback. FaceTheory hydration
     * data routes are kept on S3 and the edge rewrites extensionless paths to `/index.html`.
     */
    SSG_ISR = "ssg-isr"
}
export interface AppTheorySsrSiteProps {
    readonly ssrFunction: lambda.IFunction;
    /**
     * Explicit deployment mode for the site topology.
     *
     * - `ssr-only`: Lambda Function URL is the default origin
     * - `ssg-isr`: S3 is the primary HTML origin and Lambda is the fallback
     *
     * Existing implicit behavior maps to `ssr-only`.
     * @default AppTheorySsrSiteMode.SSR_ONLY
     */
    readonly mode?: AppTheorySsrSiteMode;
    /**
     * Lambda Function URL invoke mode for the SSR origin.
     * @default lambda.InvokeMode.RESPONSE_STREAM
     */
    readonly invokeMode?: lambda.InvokeMode;
    /**
     * Function URL auth type for the SSR origin.
     *
     * AppTheory defaults this to `AWS_IAM` so CloudFront reaches the SSR origin
     * through a signed Origin Access Control path. Set `NONE` only as an explicit
     * compatibility override for legacy public Function URL deployments.
     * @default lambda.FunctionUrlAuthType.AWS_IAM
     */
    readonly ssrUrlAuthType?: lambda.FunctionUrlAuthType;
    readonly assetsBucket?: s3.IBucket;
    readonly assetsPath?: string;
    readonly assetsKeyPrefix?: string;
    readonly assetsManifestKey?: string;
    /**
     * Optional S3 bucket used by FaceTheory ISR HTML storage (`S3HtmlStore`).
     *
     * When provided, AppTheory grants the SSR function read/write access and wires:
     * - `FACETHEORY_ISR_BUCKET`
     * - `FACETHEORY_ISR_PREFIX`
     */
    readonly htmlStoreBucket?: s3.IBucket;
    /**
     * S3 key prefix used by FaceTheory ISR HTML storage.
     * @default isr
     */
    readonly htmlStoreKeyPrefix?: string;
    /**
     * Additional CloudFront path patterns to route directly to the S3 origin.
     *
     * In `ssg-isr` mode, `/_facetheory/data/*` is added automatically.
     * Example custom direct-S3 path: "/marketing/*"
     */
    readonly staticPathPatterns?: string[];
    /**
     * Optional TableTheory/DynamoDB table used for FaceTheory ISR metadata and lease coordination.
     *
     * When provided, AppTheory grants the SSR function read/write access and wires the
     * metadata table aliases expected by the documented FaceTheory deployment shape.
     */
    readonly isrMetadataTable?: dynamodb.ITable;
    /**
     * Optional ISR/cache metadata table name to wire when you are not passing `isrMetadataTable`.
     *
     * Prefer `isrMetadataTable` when AppTheory should also grant access to the SSR Lambda.
     */
    readonly isrMetadataTableName?: string;
    /**
     * Legacy alias for `isrMetadataTableName`.
     * @deprecated prefer `isrMetadataTable` or `isrMetadataTableName`
     */
    readonly cacheTableName?: string;
    readonly wireRuntimeEnv?: boolean;
    /**
     * Additional headers to forward to the SSR origin (Lambda Function URL) via the origin request policy.
     *
     * The default AppTheory/FaceTheory-safe edge contract forwards only:
     * - `cloudfront-forwarded-proto`
     * - `cloudfront-viewer-address`
     * - `x-apptheory-original-host`
     * - `x-apptheory-original-uri`
     * - `x-facetheory-original-host`
     * - `x-facetheory-original-uri`
     * - `x-request-id`
     * - `x-tenant-id`
     *
     * Use this to opt in to additional app-specific headers such as
     * `x-facetheory-tenant`. `host` and `x-forwarded-proto` are rejected because
     * they break or bypass the supported origin model.
     */
    readonly ssrForwardHeaders?: string[];
    readonly enableLogging?: boolean;
    readonly logsBucket?: s3.IBucket;
    /**
     * CloudFront response headers policy applied to SSR and direct-S3 behaviors.
     *
     * If omitted, AppTheory provisions a FaceTheory-aligned baseline policy at the CDN
     * layer: HSTS, nosniff, frame-options, referrer-policy, XSS protection, and a
     * restrictive permissions-policy. Content-Security-Policy remains origin-defined.
     */
    readonly responseHeadersPolicy?: cloudfront.IResponseHeadersPolicy;
    readonly removalPolicy?: RemovalPolicy;
    readonly autoDeleteObjects?: boolean;
    readonly domainName?: string;
    readonly hostedZone?: route53.IHostedZone;
    readonly certificateArn?: string;
    readonly webAclId?: string;
}
export declare class AppTheorySsrSite extends Construct {
    readonly assetsBucket: s3.IBucket;
    readonly assetsKeyPrefix: string;
    readonly assetsManifestKey: string;
    readonly htmlStoreBucket?: s3.IBucket;
    readonly htmlStoreKeyPrefix?: string;
    readonly isrMetadataTable?: dynamodb.ITable;
    readonly logsBucket?: s3.IBucket;
    readonly ssrUrl: lambda.FunctionUrl;
    readonly distribution: cloudfront.Distribution;
    readonly certificate?: acm.ICertificate;
    readonly responseHeadersPolicy: cloudfront.IResponseHeadersPolicy;
    constructor(scope: Construct, id: string, props: AppTheorySsrSiteProps);
}
