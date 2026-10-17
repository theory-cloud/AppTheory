import { Duration } from "aws-cdk-lib";
import type * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";

import type { AppTheoryHttpApiCorsOptions } from "./http-api";

/**
 * Build the API Gateway v2 CORS preflight configuration shared by
 * `AppTheoryHttpApi` and the construct-owned `AppTheoryMcpServer` API.
 *
 * Internal to the package: it is not part of the exported jsii surface.
 */
export function buildCorsPreflight(
  input?: boolean | AppTheoryHttpApiCorsOptions,
): apigwv2.CorsPreflightOptions | undefined {
  if (!input) {
    return undefined;
  }
  const options = input === true ? {} : input;
  return {
    allowOrigins: options.allowOrigins ?? ["*"],
    allowMethods: (options.allowMethods ?? ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
      .map((method) => String(method).trim().toUpperCase())
      .filter((method) => method) as apigwv2.CorsHttpMethod[],
    allowHeaders: options.allowHeaders ?? ["content-type", "authorization", "x-request-id", "x-tenant-id"],
    exposeHeaders: options.exposeHeaders ?? ["x-request-id"],
    allowCredentials: options.allowCredentials ?? false,
    maxAge: options.maxAge ?? Duration.minutes(10),
  };
}
