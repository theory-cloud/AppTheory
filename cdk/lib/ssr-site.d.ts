import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
export interface AppTheorySsrSiteProps {
    readonly ssrFunction: lambda.IFunction;
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
    readonly staticPathPatterns?: string[];
    readonly cacheTableName?: string;
    readonly wireRuntimeEnv?: boolean;
    /**
     * Additional headers to forward to the SSR origin (Lambda Function URL) via the origin request policy.
     *
     * The default AppTheory/FaceTheory-safe edge contract forwards only:
     * - `cloudfront-forwarded-proto`
     * - `cloudfront-viewer-address`
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
    readonly logsBucket?: s3.IBucket;
    readonly ssrUrl: lambda.FunctionUrl;
    readonly distribution: cloudfront.Distribution;
    readonly certificate?: acm.ICertificate;
    constructor(scope: Construct, id: string, props: AppTheorySsrSiteProps);
}
