import { Token } from "aws-cdk-lib";
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
export class AppTheoryCloudWatchLogsSubscription extends Construct {
  /**
   * The CloudWatch Logs subscription filter resource.
   */
  public readonly subscriptionFilter: logs.CfnSubscriptionFilter;

  /**
   * The resolved log group name attached by the subscription filter.
   */
  public readonly logGroupName: string;

  /**
   * The destination ARN configured on the subscription filter.
   */
  public readonly destinationArn: string;

  /**
   * The rendered CloudWatch Logs filter pattern text.
   */
  public readonly filterPatternText: string;

  /**
   * The caller-provided delivery role ARN, if any.
   */
  public readonly roleArn?: string;

  constructor(scope: Construct, id: string, props: AppTheoryCloudWatchLogsSubscriptionProps) {
    super(scope, id);

    if (!props) {
      throw new Error("AppTheoryCloudWatchLogsSubscription requires props");
    }

    this.logGroupName = resolveLogGroupName(props);
    this.destinationArn = requiredNonEmptyString(props.destinationArn, "destinationArn");
    this.filterPatternText = resolveFilterPatternText(props);
    this.roleArn = resolveRoleArn(props);

    const filterName = optionalNonEmptyString(props.filterName, "filterName");
    const distribution = optionalDistribution(props.distribution);

    const subscriptionFilterProps: logs.CfnSubscriptionFilterProps = {
      destinationArn: this.destinationArn,
      filterPattern: this.filterPatternText,
      logGroupName: this.logGroupName,
      ...(filterName !== undefined ? { filterName } : {}),
      ...(distribution !== undefined ? { distribution } : {}),
      ...(this.roleArn !== undefined ? { roleArn: this.roleArn } : {}),
    };

    this.subscriptionFilter = new logs.CfnSubscriptionFilter(this, "SubscriptionFilter", subscriptionFilterProps);
  }
}

function resolveLogGroupName(props: AppTheoryCloudWatchLogsSubscriptionProps): string {
  requireExactlyOne(props.logGroup, "logGroup", props.logGroupName, "logGroupName");

  if (isProvided(props.logGroupName)) {
    return requiredNonEmptyString(props.logGroupName, "logGroupName");
  }

  return requiredNonEmptyString(props.logGroup?.logGroupName, "logGroup.logGroupName");
}

function resolveFilterPatternText(props: AppTheoryCloudWatchLogsSubscriptionProps): string {
  requireExactlyOne(props.filterPattern, "filterPattern", props.filterPatternText, "filterPatternText");

  if (isProvided(props.filterPatternText)) {
    return requiredString(props.filterPatternText, "filterPatternText");
  }

  return requiredString(props.filterPattern?.logPatternString, "filterPattern.logPatternString");
}

function resolveRoleArn(props: AppTheoryCloudWatchLogsSubscriptionProps): string | undefined {
  if (isProvided(props.role) && isProvided(props.roleArn)) {
    throw new Error("AppTheoryCloudWatchLogsSubscription accepts at most one of role or roleArn");
  }

  if (isProvided(props.roleArn)) {
    return requiredNonEmptyString(props.roleArn, "roleArn");
  }

  if (isProvided(props.role)) {
    return requiredNonEmptyString(props.role?.roleArn, "role.roleArn");
  }

  return undefined;
}

function requireExactlyOne(
  firstValue: unknown,
  firstName: string,
  secondValue: unknown,
  secondName: string,
): void {
  const firstProvided = isProvided(firstValue);
  const secondProvided = isProvided(secondValue);

  if (firstProvided === secondProvided) {
    throw new Error(`AppTheoryCloudWatchLogsSubscription requires exactly one of ${firstName} or ${secondName}`);
  }
}

function requiredNonEmptyString(value: string | undefined, propName: string): string {
  const normalized = requiredString(value, propName);

  if (Token.isUnresolved(normalized)) {
    return normalized;
  }

  const trimmed = normalized.trim();
  if (!trimmed) {
    throw new Error(`AppTheoryCloudWatchLogsSubscription: ${propName} cannot be empty`);
  }

  return trimmed;
}

function optionalNonEmptyString(value: string | undefined, propName: string): string | undefined {
  if (!isProvided(value)) {
    return undefined;
  }

  return requiredNonEmptyString(value, propName);
}

function requiredString(value: string | undefined, propName: string): string {
  if (!isProvided(value)) {
    throw new Error(`AppTheoryCloudWatchLogsSubscription requires ${propName}`);
  }

  if (typeof value !== "string") {
    throw new Error(`AppTheoryCloudWatchLogsSubscription: ${propName} must be a string`);
  }

  return value;
}

function optionalDistribution(distribution: logs.Distribution | undefined): logs.Distribution | undefined {
  if (!isProvided(distribution)) {
    return undefined;
  }

  if (Token.isUnresolved(distribution)) {
    return distribution;
  }

  if (distribution !== logs.Distribution.BY_LOG_STREAM && distribution !== logs.Distribution.RANDOM) {
    throw new Error("AppTheoryCloudWatchLogsSubscription: distribution must be ByLogStream or Random");
  }

  return distribution;
}

function isProvided(value: unknown): boolean {
  return value !== undefined && value !== null;
}
