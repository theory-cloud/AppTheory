import type * as lambda from "aws-cdk-lib/aws-lambda";

/**
 * Rejects an unusable on-failure destination at construct time. The CDK event
 * source would otherwise fail later in synthesis with an opaque jsii binding
 * error instead of naming the construct and the expected type.
 */
export function assertEventSourceDlq(constructName: string, onFailure?: lambda.IEventSourceDlq): void {
  if (onFailure === undefined) {
    return;
  }

  if (typeof (onFailure as { bind?: unknown }).bind !== "function") {
    throw new Error(
      `${constructName} requires onFailure to be a lambda.IEventSourceDlq ` +
        "(for example new lambdaEventSources.SqsDlq(queue) or new lambdaEventSources.SnsDlq(topic))",
    );
  }
}
