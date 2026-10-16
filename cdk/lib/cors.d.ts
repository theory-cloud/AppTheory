import type * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import type { AppTheoryHttpApiCorsOptions } from "./http-api";
/**
 * Build the API Gateway v2 CORS preflight configuration shared by
 * `AppTheoryHttpApi` and the construct-owned `AppTheoryMcpServer` API.
 *
 * Internal to the package: it is not part of the exported jsii surface.
 */
export declare function buildCorsPreflight(input?: boolean | AppTheoryHttpApiCorsOptions): apigwv2.CorsPreflightOptions | undefined;
