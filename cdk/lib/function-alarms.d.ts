import { Duration } from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryFunctionAlarmsProps {
    readonly fn: lambda.IFunction;
    readonly period?: Duration;
    readonly errorThreshold?: number;
    readonly throttleThreshold?: number;
}
export declare class AppTheoryFunctionAlarms extends Construct {
    readonly errors: cloudwatch.Alarm;
    readonly throttles: cloudwatch.Alarm;
    constructor(scope: Construct, id: string, props: AppTheoryFunctionAlarmsProps);
}
