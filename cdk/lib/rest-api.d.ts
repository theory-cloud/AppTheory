import * as apigw from "aws-cdk-lib/aws-apigateway";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
export interface AppTheoryRestApiProps {
    readonly handler: lambda.IFunction;
    readonly apiName?: string;
    /**
     * Whether API Gateway console test invocations should be granted Lambda invoke permissions.
     *
     * When false, the construct suppresses the extra `test-invoke-stage` Lambda permissions
     * that CDK adds for each REST API method. This reduces Lambda resource policy size while
     * preserving deployed-stage invoke permissions.
     *
     * @default true
     */
    readonly allowTestInvoke?: boolean;
    /**
     * Whether Lambda invoke permissions should be scoped to individual REST API methods.
     *
     * When false, the construct grants one API-scoped invoke permission per Lambda instead of
     * one permission per method/path pair. This is the scalable choice for large front-controller
     * APIs that route many REST paths to the same Lambda.
     *
     * @default true
     */
    readonly scopePermissionToMethod?: boolean;
}
export interface AppTheoryRestApiRouteOptions {
    readonly streaming?: boolean;
}
export declare class AppTheoryRestApi extends Construct {
    readonly api: apigw.RestApi;
    private readonly handler;
    private readonly allowTestInvoke;
    private readonly scopePermissionToMethod;
    constructor(scope: Construct, id: string, props: AppTheoryRestApiProps);
    addRoute(path: string, methods?: string[], options?: AppTheoryRestApiRouteOptions): void;
}
