import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryFunctionProps extends lambda.FunctionProps {
}
export declare class AppTheoryFunction extends Construct {
    readonly fn: lambda.Function;
    constructor(scope: Construct, id: string, props: AppTheoryFunctionProps);
}
