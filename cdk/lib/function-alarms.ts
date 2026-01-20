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

export class AppTheoryFunctionAlarms extends Construct {
  public readonly errors: cloudwatch.Alarm;
  public readonly throttles: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: AppTheoryFunctionAlarmsProps) {
    super(scope, id);

    const period = props.period ?? Duration.minutes(5);
    const errorThreshold = props.errorThreshold ?? 1;
    const throttleThreshold = props.throttleThreshold ?? 1;

    this.errors = new cloudwatch.Alarm(this, "Errors", {
      metric: props.fn.metricErrors({ period }),
      threshold: errorThreshold,
      evaluationPeriods: 1,
    });

    this.throttles = new cloudwatch.Alarm(this, "Throttles", {
      metric: props.fn.metricThrottles({ period }),
      threshold: throttleThreshold,
      evaluationPeriods: 1,
    });
  }
}

