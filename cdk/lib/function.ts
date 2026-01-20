import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface AppTheoryFunctionProps extends lambda.FunctionProps {}

export class AppTheoryFunction extends Construct {
  public readonly fn: lambda.Function;

  constructor(scope: Construct, id: string, props: AppTheoryFunctionProps) {
    super(scope, id);

    this.fn = new lambda.Function(this, "Function", {
      architecture: props.architecture ?? lambda.Architecture.ARM_64,
      tracing: props.tracing ?? lambda.Tracing.ACTIVE,
      memorySize: props.memorySize ?? 256,
      timeout: props.timeout ?? Duration.seconds(10),
      ...props,
    });
  }
}

