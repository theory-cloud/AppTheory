import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface AppTheoryWebSocketApiProps {
  readonly handler: lambda.IFunction;
  readonly apiName?: string;
  readonly stageName?: string;
}

export class AppTheoryWebSocketApi extends Construct {
  public readonly api: apigwv2.WebSocketApi;
  public readonly stage: apigwv2.WebSocketStage;

  constructor(scope: Construct, id: string, props: AppTheoryWebSocketApiProps) {
    super(scope, id);

    const stageName = String(props.stageName ?? "dev").trim() || "dev";

    this.api = new apigwv2.WebSocketApi(this, "Api", {
      apiName: props.apiName,
    });

    const integration = new apigwv2Integrations.WebSocketLambdaIntegration("Handler", props.handler);

    this.api.addRoute("$connect", { integration });
    this.api.addRoute("$disconnect", { integration });
    this.api.addRoute("$default", { integration });

    this.stage = new apigwv2.WebSocketStage(this, "Stage", {
      webSocketApi: this.api,
      stageName,
      autoDeploy: true,
    });

    this.stage.grantManagementApiAccess(props.handler);
  }
}

