import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface AppTheoryEventBridgeHandlerProps {
  readonly handler: lambda.IFunction;
  readonly schedule: events.Schedule;
  readonly ruleName?: string;
  readonly enabled?: boolean;
  readonly description?: string;
}

export class AppTheoryEventBridgeHandler extends Construct {
  public readonly rule: events.Rule;

  constructor(scope: Construct, id: string, props: AppTheoryEventBridgeHandlerProps) {
    super(scope, id);

    this.rule = new events.Rule(this, "Rule", {
      ruleName: props.ruleName,
      description: props.description,
      schedule: props.schedule,
      enabled: props.enabled,
    });

    this.rule.addTarget(new targets.LambdaFunction(props.handler));
  }
}

