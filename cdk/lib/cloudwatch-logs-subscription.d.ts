import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
/**
 * Properties for AppTheoryCloudWatchLogsSubscription.
 */
export interface AppTheoryCloudWatchLogsSubscriptionProps {
    /**
     * Log group to attach the subscription filter to.
     *
     * Exactly one of `logGroup` or `logGroupName` is required.
     */
    readonly logGroup?: logs.ILogGroup;
    /**
     * Name of an existing log group to attach the subscription filter to.
     *
     * Exactly one of `logGroup` or `logGroupName` is required.
     */
    readonly logGroupName?: string;
    /**
     * Destination ARN that receives matching log events.
     *
     * The ARN may point to a Lambda function, Kinesis stream, Firehose delivery stream,
     * or a cross-account CloudWatch Logs destination. AppTheory does not create or
     * validate the destination-side resources.
     */
    readonly destinationArn: string;
    /**
     * CloudWatch Logs filter pattern.
     *
     * Exactly one of `filterPattern` or `filterPatternText` is required.
     */
    readonly filterPattern?: logs.IFilterPattern;
    /**
     * Raw CloudWatch Logs filter pattern text.
     *
     * Use an empty string when the subscription should match all events. Exactly one
     * of `filterPattern` or `filterPatternText` is required.
     */
    readonly filterPatternText?: string;
    /**
     * Delivery role assumed by CloudWatch Logs when the destination requires one.
     *
     * At most one of `role` or `roleArn` may be provided. AppTheory never synthesizes
     * a default delivery role for this source-side construct.
     */
    readonly role?: iam.IRole;
    /**
     * ARN of a caller-owned delivery role assumed by CloudWatch Logs.
     *
     * At most one of `role` or `roleArn` may be provided.
     */
    readonly roleArn?: string;
    /**
     * Optional physical subscription filter name.
     *
     * @default - CloudFormation assigns a name
     */
    readonly filterName?: string;
    /**
     * Method used to distribute log events to Kinesis destinations.
     *
     * @default - CloudWatch Logs default
     */
    readonly distribution?: logs.Distribution;
}
/**
 * Source-side CloudWatch Logs subscription filter.
 *
 * This construct wraps `AWS::Logs::SubscriptionFilter` without creating the
 * destination, ingestion pipeline, or IAM role. Callers must provide the exact
 * log group, destination ARN, filter pattern, and any delivery role required by
 * the selected destination type.
 */
export declare class AppTheoryCloudWatchLogsSubscription extends Construct {
    /**
     * The CloudWatch Logs subscription filter resource.
     */
    readonly subscriptionFilter: logs.CfnSubscriptionFilter;
    /**
     * The resolved log group name attached by the subscription filter.
     */
    readonly logGroupName: string;
    /**
     * The destination ARN configured on the subscription filter.
     */
    readonly destinationArn: string;
    /**
     * The rendered CloudWatch Logs filter pattern text.
     */
    readonly filterPatternText: string;
    /**
     * The caller-provided delivery role ARN, if any.
     */
    readonly roleArn?: string;
    constructor(scope: Construct, id: string, props: AppTheoryCloudWatchLogsSubscriptionProps);
}
