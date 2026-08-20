import { Construct } from "constructs";
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
export declare class AppTheoryMcpProtectedResource extends Construct {
    constructor(scope: Construct, id: string, props: AppTheoryMcpProtectedResourceProps);
}
