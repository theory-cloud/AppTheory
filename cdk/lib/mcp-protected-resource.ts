import { Stack, Token } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";

import { trimRepeatedChar } from "./private/string-utils";
import { AppTheoryRestApiRouter } from "./rest-api-router";

/**
 * Props for AppTheoryMcpProtectedResource.
 *
 * This construct adds the RFC9728 protected resource metadata endpoint required
 * by MCP auth (2025-06-18):
 * - GET `/.well-known/oauth-protected-resource/...resource path...`
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
   *
   * @deprecated Use AppTheoryMcpServer with runtime-served discovery. This
   * URL-valued compatibility prop is retained for existing static documents.
   */
  readonly resource: string;

  /**
  * One or more OAuth Authorization Server issuer/base URLs.
  *
  * Autheory should be the first (and usually only) entry.
   *
   * @deprecated Use AppTheoryMcpServer authorizationServerIssuer and jwksUri
   * props with the Go runtime discovery helper.
   */
  readonly authorizationServers: string[];

  /**
   * Explicit literal route path for the secondary synth-time-static document.
   *
   * When omitted, the path is derived from a literal `resource` URL for full
   * backwards compatibility. Set this only when a static mock integration is
   * genuinely required; namespace applications should use AppTheoryMcpServer
   * and runtime-served discovery instead.
   * @default derived from resource
   */
  readonly metadataPath?: string;
}

/**
 * Adds path-scoped `/.well-known/oauth-protected-resource/...` metadata (RFC9728) to a REST API.
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

    const endpoint = ensureResourcePath(
      router.api.root,
      props.metadataPath === undefined
        ? metadataPathFromResourceURL(resource)
        : normalizeMetadataPath(props.metadataPath),
    );

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

function metadataPathFromResourceURL(resource: string): string {
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    throw new Error("AppTheoryMcpProtectedResource: resource must be an absolute URL");
  }

  const resourcePath = decodeURIComponent(parsed.pathname || "");
  return `/.well-known/oauth-protected-resource${resourcePath}`;
}

function normalizeMetadataPath(metadataPath: string): string {
  if (Token.isUnresolved(metadataPath)) {
    throw new Error("AppTheoryMcpProtectedResource: metadataPath must be a synthesis-time literal path");
  }
  const normalized = String(metadataPath ?? "").trim();
  if (
    !normalized.startsWith("/")
    || normalized === "/"
    || normalized.endsWith("/")
    || normalized.includes("//")
    || /[?#{}]/.test(normalized)
  ) {
    throw new Error("AppTheoryMcpProtectedResource: metadataPath must be a literal absolute route path");
  }
  return normalized;
}

function ensureResourcePath(root: apigw.IResource, path: string): apigw.IResource {
  let current = root;
  const trimmed = trimRepeatedChar(String(path ?? "").trim(), "/");
  if (!trimmed) {
    return current;
  }

  for (const segment of trimmed.split("/")) {
    current = current.getResource(segment) ?? current.addResource(segment);
  }

  return current;
}
