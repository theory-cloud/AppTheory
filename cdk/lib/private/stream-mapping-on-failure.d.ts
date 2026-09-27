import type * as lambda from "aws-cdk-lib/aws-lambda";
/**
 * Rejects an unusable on-failure destination at construct time. The CDK event
 * source would otherwise fail later in synthesis with an opaque jsii binding
 * error instead of naming the construct and the expected type.
 */
export declare function assertEventSourceDlq(constructName: string, onFailure?: lambda.IEventSourceDlq): void;
