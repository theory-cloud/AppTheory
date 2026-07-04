import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

/**
 * Traffic shifting mode for AppTheory-managed Lambda aliases.
 */
export enum AppTheoryLambdaTrafficShiftType {
  /**
   * Shift all traffic to the new version at once.
   */
  ALL_AT_ONCE = "ALL_AT_ONCE",

  /**
   * Shift one canary increment, wait, then shift the remaining traffic.
   */
  CANARY = "CANARY",

  /**
   * Shift traffic in equal linear increments.
   */
  LINEAR = "LINEAR",
}

/**
 * CodeDeploy deployment preferences for an AppTheory Lambda alias.
 */
export interface AppTheoryFunctionDeploymentOptions {
  /**
   * Traffic shifting mode.
   * @default AppTheoryLambdaTrafficShiftType.CANARY
   */
  readonly trafficShiftType?: AppTheoryLambdaTrafficShiftType;

  /**
   * Percentage shifted at each canary or linear increment.
   * @default 10
   */
  readonly percentage?: number;

  /**
   * Time between traffic shifts.
   * @default Duration.minutes(5) for canary, Duration.minutes(1) for linear
   */
  readonly interval?: Duration;

  /**
   * CloudWatch alarms that stop and roll back deployments.
   * @default []
   */
  readonly alarms?: cloudwatch.IAlarm[];

  /**
   * Lambda pre-traffic hook.
   * @default undefined
   */
  readonly preHook?: lambda.IFunction;

  /**
   * Lambda post-traffic hook.
   * @default undefined
   */
  readonly postHook?: lambda.IFunction;

  /**
   * CodeDeploy auto-rollback configuration.
   * @default CodeDeploy defaults
   */
  readonly autoRollback?: codedeploy.AutoRollbackConfig;
}

/**
 * Alias and provisioned-concurrency options for an AppTheory function.
 */
export interface AppTheoryFunctionAliasOptions {
  /**
   * Lambda alias name.
   * @default "live"
   */
  readonly name?: string;

  /**
   * Alias description.
   * @default undefined
   */
  readonly description?: string;

  /**
   * Provisioned concurrency configured on the alias.
   * @default undefined
   */
  readonly provisionedConcurrentExecutions?: number;

  /**
   * Optional CodeDeploy traffic shifting for this alias.
   * @default undefined
   */
  readonly deployment?: AppTheoryFunctionDeploymentOptions;
}

export interface AppTheoryFunctionProps extends lambda.FunctionProps {
  /**
   * Optional AppTheory-managed Lambda alias.
   *
   * When set, the alias points at the function's current version and can also
   * carry provisioned concurrency and CodeDeploy traffic shifting.
   *
   * @default undefined
   */
  readonly alias?: AppTheoryFunctionAliasOptions;
}

export class AppTheoryFunction extends Construct {
  public readonly fn: lambda.Function;
  public readonly logGroup?: logs.ILogGroupRef;
  public readonly alias?: lambda.Alias;
  public readonly deploymentGroup?: codedeploy.LambdaDeploymentGroup;

  constructor(scope: Construct, id: string, props: AppTheoryFunctionProps) {
    super(scope, id);

    const { alias, ...inputLambdaProps } = props;
    const lambdaProps: lambda.FunctionProps = { ...inputLambdaProps };
    const logRetention = lambdaProps.logRetention ?? logs.RetentionDays.ONE_MONTH;
    const logRemovalPolicy = lambdaProps.logRemovalPolicy;
    delete (lambdaProps as { logRetention?: logs.RetentionDays }).logRetention;
    delete (lambdaProps as { logRemovalPolicy?: unknown }).logRemovalPolicy;
    delete (lambdaProps as { logRetentionRetryOptions?: unknown }).logRetentionRetryOptions;
    delete (lambdaProps as { logRetentionRole?: unknown }).logRetentionRole;

    this.fn = new lambda.Function(this, "Function", {
      ...lambdaProps,
      architecture: lambdaProps.architecture ?? lambda.Architecture.ARM_64,
      tracing: lambdaProps.tracing ?? lambda.Tracing.ACTIVE,
      memorySize: lambdaProps.memorySize ?? 256,
      timeout: lambdaProps.timeout ?? Duration.seconds(10),
    });

    if (lambdaProps.logGroup) {
      (this as { logGroup?: logs.ILogGroupRef }).logGroup = lambdaProps.logGroup;
    } else {
      const logGroup = new logs.LogGroup(this, "LogGroup", {
        logGroupName: `/aws/lambda/${this.fn.functionName}`,
        retention: logRetention,
        removalPolicy: logRemovalPolicy,
      });
      (this as { logGroup?: logs.ILogGroupRef }).logGroup = logGroup;
    }

    if (alias) {
      this.configureAlias(alias);
    }
  }

  private configureAlias(options: AppTheoryFunctionAliasOptions): void {
    const aliasName = String(options.name ?? "live").trim();
    if (!aliasName) {
      throw new Error("AppTheoryFunction alias.name must not be empty");
    }

    const alias = new lambda.Alias(this, "Alias", {
      aliasName,
      version: this.fn.currentVersion,
      description: options.description,
      provisionedConcurrentExecutions: options.provisionedConcurrentExecutions,
    });
    (this as { alias?: lambda.Alias }).alias = alias;

    if (options.deployment) {
      const deploymentGroup = new codedeploy.LambdaDeploymentGroup(this, "DeploymentGroup", {
        alias,
        deploymentConfig: deploymentConfigFor(this, options.deployment),
        alarms: options.deployment.alarms,
        preHook: options.deployment.preHook,
        postHook: options.deployment.postHook,
        autoRollback: options.deployment.autoRollback,
      });
      (this as { deploymentGroup?: codedeploy.LambdaDeploymentGroup }).deploymentGroup = deploymentGroup;
    }
  }
}

function deploymentConfigFor(scope: Construct, options: AppTheoryFunctionDeploymentOptions): codedeploy.ILambdaDeploymentConfig {
  const type = options.trafficShiftType ?? AppTheoryLambdaTrafficShiftType.CANARY;
  switch (type) {
    case AppTheoryLambdaTrafficShiftType.ALL_AT_ONCE:
      return codedeploy.LambdaDeploymentConfig.ALL_AT_ONCE;
    case AppTheoryLambdaTrafficShiftType.LINEAR:
      return new codedeploy.LambdaDeploymentConfig(scope, "LinearDeploymentConfig", {
        trafficRouting: codedeploy.TrafficRouting.timeBasedLinear({
          percentage: normalizedPercentage(options.percentage),
          interval: options.interval ?? Duration.minutes(1),
        }),
      });
    case AppTheoryLambdaTrafficShiftType.CANARY:
      return new codedeploy.LambdaDeploymentConfig(scope, "CanaryDeploymentConfig", {
        trafficRouting: codedeploy.TrafficRouting.timeBasedCanary({
          percentage: normalizedPercentage(options.percentage),
          interval: options.interval ?? Duration.minutes(5),
        }),
      });
    default:
      throw new Error(`AppTheoryFunction unsupported deployment type: ${String(type)}`);
  }
}

function normalizedPercentage(input?: number): number {
  const value = input ?? 10;
  if (!Number.isFinite(value) || value <= 0 || value >= 100) {
    throw new Error("AppTheoryFunction deployment percentage must be greater than 0 and less than 100");
  }
  return value;
}
