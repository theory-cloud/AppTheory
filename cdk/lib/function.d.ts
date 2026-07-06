import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as codedeploy from "aws-cdk-lib/aws-codedeploy";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
/**
 * Traffic shifting mode for AppTheory-managed Lambda aliases.
 */
export declare enum AppTheoryLambdaTrafficShiftType {
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
    LINEAR = "LINEAR"
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
export declare class AppTheoryFunction extends Construct {
    readonly fn: lambda.Function;
    readonly logGroup?: logs.ILogGroupRef;
    readonly alias?: lambda.Alias;
    readonly deploymentGroup?: codedeploy.LambdaDeploymentGroup;
    constructor(scope: Construct, id: string, props: AppTheoryFunctionProps);
    private configureAlias;
}
