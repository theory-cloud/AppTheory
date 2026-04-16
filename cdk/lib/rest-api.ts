import * as apigw from "aws-cdk-lib/aws-apigateway";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

import { markRestApiStageRouteAsStreaming } from "./private/rest-api-streaming";
import { trimRepeatedChar } from "./private/string-utils";

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

export class AppTheoryRestApi extends Construct {
  public readonly api: apigw.RestApi;
  private readonly handler: lambda.IFunction;
  private readonly allowTestInvoke: boolean;
  private readonly scopePermissionToMethod: boolean;

  constructor(scope: Construct, id: string, props: AppTheoryRestApiProps) {
    super(scope, id);

    this.handler = props.handler;
    this.allowTestInvoke = props.allowTestInvoke ?? true;
    this.scopePermissionToMethod = props.scopePermissionToMethod ?? true;
    this.api = new apigw.RestApi(this, "Api", {
      restApiName: props.apiName,
    });

    const defaultIntegration = new apigw.LambdaIntegration(this.handler, {
      proxy: true,
      allowTestInvoke: this.allowTestInvoke,
      scopePermissionToMethod: this.scopePermissionToMethod,
    });
    this.api.root.addMethod("ANY", defaultIntegration);
    this.api.root.addResource("{proxy+}").addMethod("ANY", defaultIntegration);
  }

  addRoute(path: string, methods: string[] = ["ANY"], options: AppTheoryRestApiRouteOptions = {}): void {
    const resource = resourceForPath(this.api, path);
    const integration = new apigw.LambdaIntegration(this.handler, {
      proxy: true,
      allowTestInvoke: this.allowTestInvoke,
      scopePermissionToMethod: this.scopePermissionToMethod,
      responseTransferMode: options.streaming ? apigw.ResponseTransferMode.STREAM : apigw.ResponseTransferMode.BUFFERED,
    });
    for (const method of methods) {
      const httpMethod = String(method ?? "").trim().toUpperCase();
      if (!httpMethod) continue;
      resource.addMethod(httpMethod, integration);
      if (options.streaming) {
        markRestApiStageRouteAsStreaming(this.api.deploymentStage, httpMethod, path);
      }
    }
  }
}

function resourceForPath(api: apigw.RestApi, inputPath: string): apigw.IResource {
  let current: apigw.IResource = api.root;
  const trimmed = trimRepeatedChar(String(inputPath ?? "").trim(), "/");
  if (!trimmed) return current;

  for (const segment of trimmed.split("/")) {
    const part = String(segment ?? "").trim();
    if (!part) continue;
    current = current.getResource(part) ?? current.addResource(part);
  }
  return current;
}
