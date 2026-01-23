import { RemovalPolicy } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
export interface AppTheorySsrSiteProps {
    readonly ssrFunction: lambda.IFunction;
    readonly invokeMode?: lambda.InvokeMode;
    readonly assetsBucket?: s3.IBucket;
    readonly assetsPath?: string;
    readonly assetsKeyPrefix?: string;
    readonly assetsManifestKey?: string;
    readonly cacheTableName?: string;
    readonly wireRuntimeEnv?: boolean;
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
