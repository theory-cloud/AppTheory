import * as events from "aws-cdk-lib/aws-events";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryEventBridgeHandlerProps {
    readonly handler: lambda.IFunction;
    readonly schedule: events.Schedule;
    readonly ruleName?: string;
    readonly enabled?: boolean;
    readonly description?: string;
}
export declare class AppTheoryEventBridgeHandler extends Construct {
    readonly rule: events.Rule;
    constructor(scope: Construct, id: string, props: AppTheoryEventBridgeHandlerProps);
}
