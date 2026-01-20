import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryWebSocketApiProps {
    readonly handler: lambda.IFunction;
    readonly apiName?: string;
    readonly stageName?: string;
}
export declare class AppTheoryWebSocketApi extends Construct {
    readonly api: apigwv2.WebSocketApi;
    readonly stage: apigwv2.WebSocketStage;
    constructor(scope: Construct, id: string, props: AppTheoryWebSocketApiProps);
}
