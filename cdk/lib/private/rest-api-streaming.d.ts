import * as apigw from "aws-cdk-lib/aws-apigateway";
export declare const REST_API_STREAMING_ROUTE_STAGE_VARIABLE_PREFIX = "APPTHEORYSTREAMINGV1";
export declare function normalizeRestApiRouteMethod(method: string): string;
export declare function normalizeRestApiRoutePath(inputPath: string): string;
export declare function restApiStreamingRouteKey(method: string, path: string): string;
export declare function restApiStreamingRouteStageVariableName(method: string, path: string): string;
export declare function markRestApiStageRouteAsStreaming(stage: apigw.Stage, method: string, path: string): void;
