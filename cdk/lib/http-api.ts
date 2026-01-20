import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface AppTheoryHttpApiProps {
  readonly handler: lambda.IFunction;
  readonly apiName?: string;
}

export class AppTheoryHttpApi extends Construct {
  public readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: AppTheoryHttpApiProps) {
    super(scope, id);

    this.api = new apigwv2.HttpApi(this, "Api", {
      apiName: props.apiName,
    });

    this.api.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("Root", props.handler, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    this.api.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new apigwv2Integrations.HttpLambdaIntegration("Proxy", props.handler, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });
  }
}
