import * as apigw from "aws-cdk-lib/aws-apigateway";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { AppTheoryCloudFrontLogFormat } from "../logging";
import type { AppTheoryNamingContext } from "../naming-context";
/**
 * The CloudFront standard-logging record fields, in delivery order
 * (contract section 3).
 */
export declare const CLOUD_FRONT_RECORD_FIELDS: string[];
/**
 * The API Gateway access-log field names and values for HTTP APIs.
 */
export declare function httpApiAccessLogFormat(): string;
/**
 * The API Gateway access-log field names and values for REST APIs.
 */
export declare function restApiAccessLogFormat(): apigw.AccessLogFormat;
/**
 * Resolve the numeric retention to the CloudWatch Logs enum. The context has
 * already validated the value against the accepted set.
 */
export declare function retentionFor(days: number): logs.RetentionDays;
/**
 * Create a standard-profile log group named from the naming contract.
 */
export declare function standardLogGroup(scope: Construct, id: string, context: AppTheoryNamingContext, logical: string): logs.LogGroup;
/**
 * Wire CloudFront standard logging through CloudWatch Logs vended delivery:
 * a delivery source, a delivery destination over the log group, and a delivery
 * carrying the contract's record fields.
 *
 * The contract requires these resources in `us-east-1`; a stack elsewhere is
 * out of v0.1, so synthesis fails instead of creating a delivery that cannot
 * receive CloudFront logs.
 */
export declare function enableCloudFrontStandardLogging(options: {
    readonly scope: Construct;
    readonly id: string;
    readonly context: AppTheoryNamingContext;
    readonly distribution: cloudfront.IDistribution;
    readonly logical: string;
    readonly format?: AppTheoryCloudFrontLogFormat;
}): logs.LogGroup;
/**
 * The bucket-name properties the naming contract requires. A derived profile
 * sets the account-regional namespace and prefix; a legacy profile supplies the
 * pinned full name.
 */
export declare function bucketNamingProps(context: AppTheoryNamingContext, logical: string, explicitName?: string): {
    bucketName?: string;
    bucketNamespace?: s3.BucketNamespace;
    bucketNamePrefix?: string;
};
