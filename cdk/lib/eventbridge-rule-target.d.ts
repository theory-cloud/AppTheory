import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryEventBridgeRuleTargetProps {
    /**
     * The Lambda function to invoke when the rule matches.
     */
    readonly handler: lambda.IFunction;
    /**
     * EventBridge event pattern for rule matching.
     *
     * Mutually exclusive with `schedule`.
     */
    readonly eventPattern?: events.EventPattern;
    /**
     * Schedule for rule triggering.
     *
     * Mutually exclusive with `eventPattern`.
     */
    readonly schedule?: events.Schedule;
    /**
     * Optional event bus to attach the rule to.
     * @default - the account default event bus
     */
    readonly eventBus?: events.IEventBus;
    /**
     * Optional rule name.
     * @default - CloudFormation-generated name
     */
    readonly ruleName?: string;
    /**
     * Whether the rule is enabled.
     * @default true
     */
    readonly enabled?: boolean;
    /**
     * Optional rule description.
     */
    readonly description?: string;
    /**
     * Optional configuration for the Lambda target (DLQ, input, retries, max event age, etc).
     * Passed through to `aws-events-targets.LambdaFunction`.
     */
    readonly targetProps?: targets.LambdaFunctionProps;
}
/**
 * Opinionated wiring for an EventBridge rule with a Lambda target.
 *
 * This construct intentionally enforces `eventPattern` XOR `schedule` (fail closed).
 * For schedule-only back-compat, see `AppTheoryEventBridgeHandler`.
 */
export declare class AppTheoryEventBridgeRuleTarget extends Construct {
    readonly rule: events.Rule;
    constructor(scope: Construct, id: string, props: AppTheoryEventBridgeRuleTargetProps);
}
