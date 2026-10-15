export declare const CONTRACT_VERSION = "m17.mcp-route-algebra/v2";
export declare const CONTRACT_VERSION_V1 = "m17.mcp-route-algebra/v1";
export type IssuerMode = "family" | "route";
export declare const ISSUER_MODE_FAMILY: IssuerMode;
export declare const ISSUER_MODE_ROUTE: IssuerMode;
export declare function supportedIssuerModes(): IssuerMode[];
export declare const PARAM_CLIENT_NAMESPACE = "client_namespace";
export declare const PARAM_PARTNER_ID = "partner_id";
export declare const PARAM_AGENT_ID = "agent_id";
export declare const PROTECTED_RESOURCE_PREFIX = "/.well-known/oauth-protected-resource";
export declare const AUTHORIZATION_SERVER_PREFIX = "/.well-known/oauth-authorization-server";
export declare const DEFAULT_CALLBACK_PATH = "/_oauth/mcp/callback";
export declare const CALLBACK_PATTERN_KEY = "upstream_callback";
export type EndpointKind = "namespace" | "partner_namespace" | "agent" | "partner_agent";
export declare const ENDPOINT_KIND_NAMESPACE: EndpointKind;
export declare const ENDPOINT_KIND_PARTNER_NAMESPACE: EndpointKind;
export declare const ENDPOINT_KIND_AGENT: EndpointKind;
export declare const ENDPOINT_KIND_PARTNER_AGENT: EndpointKind;
export declare const NAMESPACE_MCP_PATTERN = "/{client_namespace}/mcp";
export declare const PARTNER_NAMESPACE_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/mcp";
export declare const AGENT_MCP_PATTERN = "/{client_namespace}/agents/{agent_id}/mcp";
export declare const PARTNER_AGENT_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp";
export interface EndpointTemplate {
    kind: EndpointKind;
    mcpPattern: string;
    protectedResourcePath: string;
}
export interface OAuthFacadeTemplate {
    kind: EndpointKind;
    authorizePattern: string;
    tokenPattern: string;
    registerPattern: string;
}
export interface OAuthDiscoveryTemplate {
    kind: EndpointKind;
    canonicalPattern: string;
    suffixPattern: string;
}
export interface EndpointPath {
    kind: EndpointKind;
    clientNamespace: string;
    partnerId?: string;
    agentId?: string;
}
export interface StageGlobalRoute {
    name: string;
    pattern: string;
    methods: string[];
}
export declare function protectedResourcePathForResourcePath(resourcePath: string): string;
export declare function authorizationServerPathForResourcePath(resourcePath: string): string;
export declare function authorizationAuthorizePathForResourcePath(resourcePath: string): string;
export declare function authorizationTokenPathForResourcePath(resourcePath: string): string;
export declare function authorizationRegisterPathForResourcePath(resourcePath: string): string;
export declare function authorizationServerSuffixPathForResourcePath(resourcePath: string): string;
export declare function resourcePathFromProtectedResourcePath(protectedResourcePath: string): string;
export declare function protectedResourcePathFromMcpPath(mcpPath: string): string;
export declare function supportedEndpointTemplates(): EndpointTemplate[];
export declare function supportedOAuthFacadeTemplates(): OAuthFacadeTemplate[];
export declare function supportedOAuthDiscoveryTemplates(): OAuthDiscoveryTemplate[];
export declare function parseMcpPath(rawPath: string): EndpointPath;
export declare function validateEndpointPath(endpoint: EndpointPath): void;
export declare function mcpPath(endpoint: EndpointPath): string;
export declare function protectedResourcePath(endpoint: EndpointPath): string;
export declare function oauthAuthorizationServerPath(endpoint: EndpointPath): string;
export declare function oauthAuthorizePath(endpoint: EndpointPath): string;
export declare function oauthTokenPath(endpoint: EndpointPath): string;
export declare function oauthRegisterPath(endpoint: EndpointPath): string;
export declare function oauthAuthorizationServerSuffixPath(endpoint: EndpointPath): string;
export declare function supportedStageGlobalRoutes(): StageGlobalRoute[];
export declare function callbackPathForConfiguredPath(configured: string): string;
export declare function normalizeCallbackPath(rawPath: string): string;
//# sourceMappingURL=mcproutes.d.ts.map