import { Stack } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";

import { AppTheoryRestApiRouter } from "./rest-api-router";

/**
 * Props for AppTheoryMcpProtectedResource.
 *
 * This construct adds the RFC9728 protected resource metadata endpoint required
 * by MCP auth (2025-06-18):
 * - GET `/.well-known/oauth-protected-resource`
 */
export interface AppTheoryMcpProtectedResourceProps {
  /**
   * The REST API router to attach the well-known endpoint to.
   */
  readonly router: AppTheoryRestApiRouter;

  /**
   * The canonical protected resource identifier.
   *
   * For Claude Remote MCP this should be your MCP endpoint URL (including `/mcp`),
   * e.g. `https://mcp.example.com/mcp`.
   */
  readonly resource: string;

  /**
   * One or more OAuth Authorization Server issuer/base URLs.
   *
   * Autheory should be the first (and usually only) entry.
   */
  readonly authorizationServers: string[];
}

/**
 * Adds `/.well-known/oauth-protected-resource` metadata (RFC9728) to a REST API.
 */
export class AppTheoryMcpProtectedResource extends Construct {
  constructor(scope: Construct, id: string, props: AppTheoryMcpProtectedResourceProps) {
    super(scope, id);

    const router = props.router;
    const resource = String(props.resource ?? "").trim();
    const authorizationServers = (props.authorizationServers ?? [])
      .map((s) => String(s ?? "").trim())
      .filter((s) => s.length > 0);

    if (!router) {
      throw new Error("AppTheoryMcpProtectedResource: router is required");
    }
    if (!resource) {
      throw new Error("AppTheoryMcpProtectedResource: resource is required");
    }
    if (authorizationServers.length === 0) {
      throw new Error("AppTheoryMcpProtectedResource: authorizationServers is required");
    }

    const wellKnown = router.api.root.getResource(".well-known") ?? router.api.root.addResource(".well-known");
    const endpoint = wellKnown.getResource("oauth-protected-resource")
      ?? wellKnown.addResource("oauth-protected-resource");

    const body = Stack.of(this).toJsonString({
      resource,
      authorization_servers: authorizationServers,
    });

    endpoint.addMethod("GET", new apigw.MockIntegration({
      requestTemplates: { "application/json": "{\"statusCode\": 200}" },
      passthroughBehavior: apigw.PassthroughBehavior.WHEN_NO_MATCH,
      integrationResponses: [
        {
          statusCode: "200",
          responseTemplates: {
            "application/json": body,
          },
          responseParameters: {
            "method.response.header.Content-Type": "'application/json; charset=utf-8'",
          },
        },
      ],
    }), {
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Content-Type": true,
          },
        },
      ],
    });
  }
}

