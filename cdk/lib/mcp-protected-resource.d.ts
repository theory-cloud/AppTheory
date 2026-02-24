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
export declare class AppTheoryMcpProtectedResource extends Construct {
    constructor(scope: Construct, id: string, props: AppTheoryMcpProtectedResourceProps);
}
