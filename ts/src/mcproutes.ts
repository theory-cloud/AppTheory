export const CONTRACT_VERSION = "m17.mcp-route-algebra/v2";
export const CONTRACT_VERSION_V1 = "m17.mcp-route-algebra/v1";

export type IssuerMode = "family" | "route";

export const ISSUER_MODE_FAMILY: IssuerMode = "family";
export const ISSUER_MODE_ROUTE: IssuerMode = "route";

export function supportedIssuerModes(): IssuerMode[] {
  return [ISSUER_MODE_FAMILY, ISSUER_MODE_ROUTE];
}

export const PARAM_CLIENT_NAMESPACE = "client_namespace";
export const PARAM_PARTNER_ID = "partner_id";
export const PARAM_AGENT_ID = "agent_id";

export const PROTECTED_RESOURCE_PREFIX =
  "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_PREFIX =
  "/.well-known/oauth-authorization-server";

export const DEFAULT_CALLBACK_PATH = "/_oauth/mcp/callback";
export const CALLBACK_PATTERN_KEY = "upstream_callback";

export type EndpointKind =
  "namespace" | "partner_namespace" | "agent" | "partner_agent";

export const ENDPOINT_KIND_NAMESPACE: EndpointKind = "namespace";
export const ENDPOINT_KIND_PARTNER_NAMESPACE: EndpointKind =
  "partner_namespace";
export const ENDPOINT_KIND_AGENT: EndpointKind = "agent";
export const ENDPOINT_KIND_PARTNER_AGENT: EndpointKind = "partner_agent";

export const NAMESPACE_MCP_PATTERN = "/{client_namespace}/mcp";
export const PARTNER_NAMESPACE_MCP_PATTERN =
  "/{client_namespace}/partners/{partner_id}/mcp";
export const AGENT_MCP_PATTERN = "/{client_namespace}/agents/{agent_id}/mcp";
export const PARTNER_AGENT_MCP_PATTERN =
  "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp";

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

export function protectedResourcePathForResourcePath(
  resourcePath: string,
): string {
  const normalized = normalizePath(resourcePath);
  if (normalized === "/") {
    return PROTECTED_RESOURCE_PREFIX;
  }
  return `${PROTECTED_RESOURCE_PREFIX}${normalized}`;
}

export function authorizationServerPathForResourcePath(
  resourcePath: string,
): string {
  const normalized = normalizePath(resourcePath);
  if (normalized === "/") {
    return AUTHORIZATION_SERVER_PREFIX;
  }
  return `${AUTHORIZATION_SERVER_PREFIX}${normalized}`;
}

export function authorizationAuthorizePathForResourcePath(
  resourcePath: string,
): string {
  return `${authorizationServerPathForResourcePath(resourcePath)}/authorize`;
}

export function authorizationTokenPathForResourcePath(
  resourcePath: string,
): string {
  return `${authorizationServerPathForResourcePath(resourcePath)}/token`;
}

export function authorizationRegisterPathForResourcePath(
  resourcePath: string,
): string {
  return `${authorizationServerPathForResourcePath(resourcePath)}/register`;
}

export function authorizationServerSuffixPathForResourcePath(
  resourcePath: string,
): string {
  const normalized = normalizePath(resourcePath);
  if (normalized === "/") {
    return AUTHORIZATION_SERVER_PREFIX;
  }
  return `${normalized}${AUTHORIZATION_SERVER_PREFIX}`;
}

export function resourcePathFromProtectedResourcePath(
  protectedResourcePath: string,
): string {
  const normalized = normalizePath(protectedResourcePath);
  if (normalized === PROTECTED_RESOURCE_PREFIX) {
    return "/";
  }
  if (!normalized.startsWith(`${PROTECTED_RESOURCE_PREFIX}/`)) {
    throw new Error(
      `mcproutes: unsupported protected resource path ${JSON.stringify(normalized)}`,
    );
  }
  return normalizePath(normalized.slice(PROTECTED_RESOURCE_PREFIX.length));
}

export function protectedResourcePathFromMcpPath(mcpPath: string): string {
  return protectedResourcePathForResourcePath(mcpPath);
}

export function supportedEndpointTemplates(): EndpointTemplate[] {
  return endpointTemplateSeeds().map(({ kind, pattern }) => ({
    kind,
    mcpPattern: pattern,
    protectedResourcePath: protectedResourcePathForResourcePath(pattern),
  }));
}

export function supportedOAuthFacadeTemplates(): OAuthFacadeTemplate[] {
  return endpointTemplateSeeds().map(({ kind, pattern }) => ({
    kind,
    authorizePattern: authorizationAuthorizePathForResourcePath(pattern),
    tokenPattern: authorizationTokenPathForResourcePath(pattern),
    registerPattern: authorizationRegisterPathForResourcePath(pattern),
  }));
}

export function supportedOAuthDiscoveryTemplates(): OAuthDiscoveryTemplate[] {
  return endpointTemplateSeeds().map(({ kind, pattern }) => ({
    kind,
    canonicalPattern: authorizationServerPathForResourcePath(pattern),
    suffixPattern: authorizationServerSuffixPathForResourcePath(pattern),
  }));
}

export function parseMcpPath(rawPath: string): EndpointPath {
  const unnormalized = endpointFromSegments(
    splitPathBeforeDotNormalization(rawPath),
  );
  if (unnormalized !== undefined) {
    validateParsedEndpoint(unnormalized, rawPath);
    return unnormalized;
  }

  const endpoint = endpointFromSegments(splitPath(normalizePath(rawPath)));
  if (endpoint === undefined) {
    throw new Error(
      `mcproutes: unsupported MCP path ${JSON.stringify(rawPath)}`,
    );
  }
  validateParsedEndpoint(endpoint, rawPath);
  return endpoint;
}

export function validateEndpointPath(endpoint: EndpointPath): void {
  if (!isPathSegment(endpoint.clientNamespace)) {
    throw new Error(
      "mcproutes: client_namespace must be a non-empty path segment",
    );
  }

  const partnerId = endpoint.partnerId;
  const agentId = endpoint.agentId;
  switch (endpoint.kind) {
    case ENDPOINT_KIND_NAMESPACE:
      if (hasIdentifier(partnerId) || hasIdentifier(agentId)) {
        throw new Error(
          "mcproutes: namespace endpoint cannot include partner or agent identifiers",
        );
      }
      return;
    case ENDPOINT_KIND_PARTNER_NAMESPACE:
      if (!isPathSegment(partnerId)) {
        throw new Error(
          "mcproutes: partner_id must be a non-empty path segment",
        );
      }
      if (hasIdentifier(agentId)) {
        throw new Error(
          "mcproutes: partner namespace endpoint cannot include agent_id",
        );
      }
      return;
    case ENDPOINT_KIND_AGENT:
      if (!isPathSegment(agentId)) {
        throw new Error("mcproutes: agent_id must be a non-empty path segment");
      }
      if (hasIdentifier(partnerId)) {
        throw new Error("mcproutes: agent endpoint cannot include partner_id");
      }
      return;
    case ENDPOINT_KIND_PARTNER_AGENT:
      if (!isPathSegment(partnerId)) {
        throw new Error(
          "mcproutes: partner_id must be a non-empty path segment",
        );
      }
      if (!isPathSegment(agentId)) {
        throw new Error("mcproutes: agent_id must be a non-empty path segment");
      }
      return;
    default:
      throw new Error(
        `mcproutes: unsupported endpoint kind ${JSON.stringify(endpoint.kind)}`,
      );
  }
}

export function mcpPath(endpoint: EndpointPath): string {
  validateEndpointPath(endpoint);
  switch (endpoint.kind) {
    case ENDPOINT_KIND_NAMESPACE:
      return `/${endpoint.clientNamespace}/mcp`;
    case ENDPOINT_KIND_PARTNER_NAMESPACE:
      return `/${endpoint.clientNamespace}/partners/${endpoint.partnerId}/mcp`;
    case ENDPOINT_KIND_AGENT:
      return `/${endpoint.clientNamespace}/agents/${endpoint.agentId}/mcp`;
    case ENDPOINT_KIND_PARTNER_AGENT:
      return `/${endpoint.clientNamespace}/partners/${endpoint.partnerId}/agents/${endpoint.agentId}/mcp`;
    default:
      throw new Error(
        `mcproutes: unsupported endpoint kind ${JSON.stringify(endpoint.kind)}`,
      );
  }
}

export function protectedResourcePath(endpoint: EndpointPath): string {
  return protectedResourcePathForResourcePath(mcpPath(endpoint));
}

export function oauthAuthorizationServerPath(endpoint: EndpointPath): string {
  return authorizationServerPathForResourcePath(mcpPath(endpoint));
}

export function oauthAuthorizePath(endpoint: EndpointPath): string {
  return authorizationAuthorizePathForResourcePath(mcpPath(endpoint));
}

export function oauthTokenPath(endpoint: EndpointPath): string {
  return authorizationTokenPathForResourcePath(mcpPath(endpoint));
}

export function oauthRegisterPath(endpoint: EndpointPath): string {
  return authorizationRegisterPathForResourcePath(mcpPath(endpoint));
}

export function oauthAuthorizationServerSuffixPath(
  endpoint: EndpointPath,
): string {
  return authorizationServerSuffixPathForResourcePath(mcpPath(endpoint));
}

export function supportedStageGlobalRoutes(): StageGlobalRoute[] {
  return [
    {
      name: CALLBACK_PATTERN_KEY,
      pattern: DEFAULT_CALLBACK_PATH,
      methods: ["GET"],
    },
  ];
}

export function callbackPathForConfiguredPath(configured: string): string {
  const trimmed = trimASCIIWhitespace(configured);
  if (trimmed === "") {
    return DEFAULT_CALLBACK_PATH;
  }
  return normalizeCallbackPath(trimmed);
}

export function normalizeCallbackPath(rawPath: string): string {
  const trimmed = trimASCIIWhitespace(rawPath);
  if (trimmed === "" || !trimmed.startsWith("/")) {
    throw new Error(
      `mcproutes: callback path must be absolute ${JSON.stringify(rawPath)}`,
    );
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error(
      `mcproutes: callback path must not include a query or fragment ${JSON.stringify(rawPath)}`,
    );
  }
  for (const segment of trimmed.split("/")) {
    if (segment === "." || segment === "..") {
      throw new Error(
        `mcproutes: callback path must not use dot segments ${JSON.stringify(rawPath)}`,
      );
    }
  }
  return normalizePath(trimmed);
}

function endpointTemplateSeeds(): Array<{
  kind: EndpointKind;
  pattern: string;
}> {
  return [
    { kind: ENDPOINT_KIND_NAMESPACE, pattern: NAMESPACE_MCP_PATTERN },
    {
      kind: ENDPOINT_KIND_PARTNER_NAMESPACE,
      pattern: PARTNER_NAMESPACE_MCP_PATTERN,
    },
    { kind: ENDPOINT_KIND_AGENT, pattern: AGENT_MCP_PATTERN },
    { kind: ENDPOINT_KIND_PARTNER_AGENT, pattern: PARTNER_AGENT_MCP_PATTERN },
  ];
}

function endpointFromSegments(segments: string[]): EndpointPath | undefined {
  if (segments.length === 2) {
    const [clientNamespace, suffix] = segments;
    if (suffix === "mcp" && clientNamespace !== undefined) {
      return { kind: ENDPOINT_KIND_NAMESPACE, clientNamespace };
    }
  }
  if (segments.length === 4) {
    const [clientNamespace, marker, identifier, suffix] = segments;
    if (
      marker === "partners" &&
      suffix === "mcp" &&
      clientNamespace !== undefined &&
      identifier !== undefined
    ) {
      return {
        kind: ENDPOINT_KIND_PARTNER_NAMESPACE,
        clientNamespace,
        partnerId: identifier,
      };
    }
    if (
      marker === "agents" &&
      suffix === "mcp" &&
      clientNamespace !== undefined &&
      identifier !== undefined
    ) {
      return {
        kind: ENDPOINT_KIND_AGENT,
        clientNamespace,
        agentId: identifier,
      };
    }
  }
  if (segments.length === 6) {
    const [
      clientNamespace,
      partnerMarker,
      partnerId,
      agentMarker,
      agentId,
      suffix,
    ] = segments;
    if (
      partnerMarker === "partners" &&
      agentMarker === "agents" &&
      suffix === "mcp" &&
      clientNamespace !== undefined &&
      partnerId !== undefined &&
      agentId !== undefined
    ) {
      return {
        kind: ENDPOINT_KIND_PARTNER_AGENT,
        clientNamespace,
        partnerId,
        agentId,
      };
    }
  }
  return undefined;
}

function validateParsedEndpoint(endpoint: EndpointPath, rawPath: string): void {
  try {
    validateEndpointPath(endpoint);
  } catch (error) {
    throw new Error(
      `mcproutes: invalid MCP path ${JSON.stringify(rawPath)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasIdentifier(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

function trimASCIIWhitespace(value: string): string {
  let start = 0;
  while (
    start < value.length &&
    isASCIIWhitespaceCode(value.charCodeAt(start))
  ) {
    start += 1;
  }

  let end = value.length;
  while (end > start && isASCIIWhitespaceCode(value.charCodeAt(end - 1))) {
    end -= 1;
  }

  return value.slice(start, end);
}

function isASCIIWhitespaceCode(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13 ||
    code === 32
  );
}

function normalizePath(rawPath: string): string {
  let normalized = trimASCIIWhitespace(rawPath);
  if (normalized === "") {
    return "/";
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function splitPathBeforeDotNormalization(rawPath: string): string[] {
  return trimASCIIWhitespace(rawPath)
    .split("/")
    .filter((segment) => segment !== "");
}

function splitPath(normalizedPath: string): string[] {
  const trimmed = normalizedPath.startsWith("/")
    ? normalizedPath.slice(1)
    : normalizedPath;
  if (trimmed === "") {
    return [];
  }
  return trimmed.split("/");
}

function isPathSegment(value: string | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = trimASCIIWhitespace(value);
  return (
    trimmed !== "" &&
    trimmed !== "." &&
    trimmed !== ".." &&
    !value.includes("/")
  );
}
