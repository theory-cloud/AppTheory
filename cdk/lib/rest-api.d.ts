import * as apigw from "aws-cdk-lib/aws-apigateway";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryRestApiProps {
    readonly handler: lambda.IFunction;
    readonly apiName?: string;
}
export interface AppTheoryRestApiRouteOptions {
    readonly streaming?: boolean;
}
export declare class AppTheoryRestApi extends Construct {
    readonly api: apigw.RestApi;
    private readonly handler;
    constructor(scope: Construct, id: string, props: AppTheoryRestApiProps);
    addRoute(path: string, methods?: string[], options?: AppTheoryRestApiRouteOptions): void;
}
