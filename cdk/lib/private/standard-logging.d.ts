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
 * The API Gateway access-log field names and values for WebSocket APIs
 * (contract section 3, ADV-1311-5). The WebSocket logging-variables list has no
 * protocol, HTTP method or response length, so the shared HTTP field set does
 * not apply.
 */
export declare function webSocketApiAccessLogFormat(): string;
/**
 * The access-log group name for a construct-created group.
 *
 * With the standard logging profile the group is a contract log source and
 * takes no naming entry. Under a legacy naming profile the group is consumed
 * like any other resource, so a generated entry sets no name and a pin sets the
 * pinned name.
 */
export declare function accessLogGroupName(context: AppTheoryNamingContext, logical: string): string | undefined;
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
 * sets the account-regional namespace and prefix; a legacy pin supplies the
 * full name; a legacy generated entry sets no name so CloudFormation keeps
 * today's name and global namespace.
 */
export declare function bucketNamingProps(context: AppTheoryNamingContext, logical: string): {
    bucketName?: string;
    bucketNamespace?: s3.BucketNamespace;
    bucketNamePrefix?: string;
};
