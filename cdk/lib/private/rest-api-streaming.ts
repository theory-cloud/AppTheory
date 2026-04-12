import * as apigw from "aws-cdk-lib/aws-apigateway";
import { createHash } from "node:crypto";

import { trimRepeatedChar } from "./string-utils";

export const REST_API_STREAMING_ROUTE_STAGE_VARIABLE_PREFIX = "APPTHEORYSTREAMINGV1";

export function normalizeRestApiRouteMethod(method: string): string {
  return String(method ?? "").trim().toUpperCase();
}

export function normalizeRestApiRoutePath(inputPath: string): string {
  const trimmed = trimRepeatedChar(String(inputPath ?? "").trim(), "/");
  if (!trimmed) return "/";

  const parts = trimmed.split("/")
    .map((part) => String(part ?? "").trim())
    .filter(Boolean);

  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function restApiStreamingRouteKey(method: string, path: string): string {
  return `${normalizeRestApiRouteMethod(method)} ${normalizeRestApiRoutePath(path)}`;
}

export function restApiStreamingRouteStageVariableName(method: string, path: string): string {
  const digest = createHash("sha256")
    .update(restApiStreamingRouteKey(method, path), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${REST_API_STREAMING_ROUTE_STAGE_VARIABLE_PREFIX}${digest}`;
}

export function markRestApiStageRouteAsStreaming(stage: apigw.Stage, method: string, path: string): void {
  const cfnStage = stage.node.defaultChild as apigw.CfnStage | undefined;
  if (!cfnStage) return;

  const variables = (cfnStage.variables && typeof cfnStage.variables === "object" && !Array.isArray(cfnStage.variables))
    ? { ...(cfnStage.variables as Record<string, string>) }
    : {};

  variables[restApiStreamingRouteStageVariableName(method, path)] = "1";
  cfnStage.variables = variables;
}
