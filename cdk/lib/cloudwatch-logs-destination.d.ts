import * as iam from "aws-cdk-lib/aws-iam";
import type * as kinesis from "aws-cdk-lib/aws-kinesis";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
/**
 * Properties for AppTheoryCloudWatchLogsDestination.
 */
export interface AppTheoryCloudWatchLogsDestinationProps {
    /**
     * Kinesis Data Stream that receives CloudWatch Logs subscription records.
     */
    readonly stream: kinesis.IStream;
    /**
     * Optional physical CloudWatch Logs destination name.
     *
     * @default - deterministic name derived from the construct path
     */
    readonly destinationName?: string;
    /**
     * Explicit AWS account IDs allowed to create subscription filters against this destination.
     *
     * At least one allowed source account or organization ID is required. AppTheory does not
     * synthesize a broad default destination policy.
     *
     * @default []
     */
    readonly allowedSourceAccounts?: string[];
    /**
     * Explicit AWS Organizations IDs allowed to create subscription filters against this destination.
     *
     * Organization entries use a wildcard principal only with an `aws:PrincipalOrgID` condition.
     * At least one allowed source account or organization ID is required.
     *
     * @default []
     */
    readonly allowedOrganizationIds?: string[];
}
/**
 * CloudWatch Logs destination that delivers subscription records to Kinesis.
 *
 * The construct owns the destination, the CloudWatch Logs service role, and a fail-closed
 * destination policy. Subscription filter writers must be explicitly allowed by source account
 * and/or AWS Organization ID; no unconstrained wildcard principal is synthesized.
 */
export declare class AppTheoryCloudWatchLogsDestination extends Construct {
    /**
     * The CloudWatch Logs destination resource.
     */
    readonly destination: logs.CfnDestination;
    /**
     * IAM role assumed by CloudWatch Logs to write records to the target stream.
     */
    readonly serviceRole: iam.Role;
    /**
     * The destination ARN.
     */
    readonly destinationArn: string;
    /**
     * The destination name.
     */
    readonly destinationName: string;
    constructor(scope: Construct, id: string, props: AppTheoryCloudWatchLogsDestinationProps);
}
