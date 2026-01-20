import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryHttpApiProps {
    readonly handler: lambda.IFunction;
    readonly apiName?: string;
}
export declare class AppTheoryHttpApi extends Construct {
    readonly api: apigwv2.HttpApi;
    constructor(scope: Construct, id: string, props: AppTheoryHttpApiProps);
}
