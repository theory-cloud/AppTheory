import { Buffer } from "node:buffer";
import { createApp } from "./app.js";
import { CONTRACT_VERSION, ISSUER_MODE_FAMILY, ISSUER_MODE_ROUTE, PARAM_AGENT_ID, PARAM_CLIENT_NAMESPACE, PARAM_PARTNER_ID, authorizationServerPathForResourcePath, callbackPathForConfiguredPath, mcpPath, oauthAuthorizationServerPath, oauthAuthorizationServerSuffixPath, oauthAuthorizePath, oauthRegisterPath, oauthTokenPath, parseMcpPath, resourcePathFromProtectedResourcePath, supportedEndpointTemplates, supportedIssuerModes, supportedOAuthDiscoveryTemplates, supportedOAuthFacadeTemplates, } from "./mcproutes.js";
import { authorizationServerMetadataHandler, protectedResourceMetadataHandler, requireBearerTokenMiddleware, } from "./oauth/index.js";
import { originURL } from "./response.js";
export const URL_MODE_PUBLIC_BASE_URL = "public_base_url";
export const URL_MODE_REQUEST_HOST = "request_host";
export const TRANSPORT_POSTURES = [
    "iam",
    "jwt",
    "runtime-bearer",
    "none-public",
];
/** The golden-path OAuth capabilities. */
export function defaultCapabilities() {
    return {
        responseTypes: ["code"],
        grantTypes: ["authorization_code", "refresh_token"],
        tokenEndpointAuthMethods: ["none"],
        codeChallengeMethods: ["S256"],
    };
}
const METADATA_VARY_HEADER = "Host, X-Forwarded-Host, X-AppTheory-Original-Host, X-FaceTheory-Original-Host, Forwarded, CloudFront-Forwarded-Proto, X-Forwarded-Proto";
const ERROR_PREFIX = "AppTheoryMcpFacade:";
const MCP_METHODS = ["POST", "GET", "DELETE"];
/**
 * Thrown for a metadata request whose origin is missing, unsafe, or not
 * allowlisted. Rendered as HTTP 400 `{"error":"invalid_request_host"}`.
 */
class MetadataRequestError extends Error {
    constructor(message) {
        super(`${ERROR_PREFIX} ${message}`);
        this.name = "MetadataRequestError";
    }
}
/**
 * Installs the complete MCP OAuth facade described by the route-algebra
 * contract version and returns its route inventory. The helper owns
 * composition only: authorize and token routes are absent unless the
 * application supplies both handler factories.
 */
export function registerMcpFacade(app, config) {
    if (app === null || app === undefined) {
        throw new Error(`${ERROR_PREFIX} app is required`);
    }
    const normalized = normalizeConfig(config);
    const inventory = buildInventory(normalized);
    const registrations = buildRegistrations(normalized, inventory);
    registerRoutes(app, registrations);
    return cloneInventory(inventory);
}
function normalizeConfig(config) {
    if (config === null || config === undefined) {
        throw new Error(`${ERROR_PREFIX} config is required`);
    }
    if (config.mcpHandler === undefined || config.mcpHandler === null) {
        throw new Error(`${ERROR_PREFIX} MCP handler is required`);
    }
    const transportPosture = normalizeTransportPosture(config.transportPosture, config.requireBearerToken);
    const normalized = normalizeDerivedConfig(config);
    normalized.transportPosture = transportPosture;
    normalized.requireBearerToken = config.requireBearerToken;
    normalized.mcpHandler = config.mcpHandler;
    normalized.callbackHandler = config.callbackHandler ?? null;
    validatePostureSurfaceConfig(transportPosture, normalized.authorizeHandlers, normalized.registerHandlers, normalized.callbackHandler, normalized.rootAuthorizationServer);
    return normalized;
}
function normalizeDerivedConfig(config) {
    const issuerURL = normalizeHTTPSURL(config.issuerURL, true);
    if (issuerURL === null) {
        throw new Error(`${ERROR_PREFIX} issuer URL must be an absolute HTTPS URL without query or fragment`);
    }
    const jwksURI = normalizeHTTPSURL(config.jwksURI, false);
    if (jwksURI === null) {
        throw new Error(`${ERROR_PREFIX} JWKS URI must be an absolute HTTPS URL without fragment`);
    }
    let registrationEndpointURL = config.registrationEndpointURL ?? "";
    if (registrationEndpointURL.trim() === "") {
        const derived = absoluteURLForPath(issuerURL, "/register");
        if (derived === null) {
            throw new Error(`${ERROR_PREFIX} registration endpoint URL must be an absolute HTTPS URL without fragment`);
        }
        registrationEndpointURL = derived;
    }
    else {
        const normalized = normalizeHTTPSURL(registrationEndpointURL, false);
        if (normalized === null) {
            throw new Error(`${ERROR_PREFIX} registration endpoint URL must be an absolute HTTPS URL without fragment`);
        }
        registrationEndpointURL = normalized;
    }
    const { publicBaseURL, allowedHostnames } = normalizeURLMode(config);
    const issuerMode = normalizeIssuerMode(config.issuerMode);
    const upstreamCallbackPath = resolveCallbackPath(config.upstreamCallbackPath);
    const scopes = normalizeScopes(config.scopes);
    const capabilities = normalizeCapabilities(config.capabilities);
    const { authorizeHandlers, tokenHandlers } = buildApplicationHandlers(config.authorizeHandler, config.tokenHandler);
    const registerHandlers = buildRegisterHandlers(config.registerHandler);
    const { rootAuthorizationServer, rootDiscoveryPath } = normalizeRootDiscoveryConfig(config.rootAuthorizationServer);
    return {
        issuerURL,
        jwksURI,
        registrationEndpointURL,
        issuerMode,
        urlMode: config.urlMode,
        publicBaseURL,
        upstreamCallbackPath,
        allowedHostnames,
        scopes,
        capabilities,
        mcpHandler: config.mcpHandler,
        authorizeHandlers,
        tokenHandlers,
        registerHandlers,
        callbackHandler: config.callbackHandler ?? null,
        rootAuthorizationServer,
        rootDiscoveryPath,
        transportPosture: "iam",
        requireBearerToken: undefined,
    };
}
function normalizeIssuerMode(mode) {
    if (mode === undefined || mode === null || String(mode) === "") {
        return ISSUER_MODE_FAMILY;
    }
    if (!supportedIssuerModes().includes(mode)) {
        throw new Error(`${ERROR_PREFIX} IssuerMode ${JSON.stringify(mode)} must be one of family, route`);
    }
    return mode;
}
function resolveCallbackPath(configured) {
    try {
        return callbackPathForConfiguredPath(configured ?? "");
    }
    catch (err) {
        throw new Error(`${ERROR_PREFIX} upstream callback path must be an absolute path without query or fragment`, { cause: err });
    }
}
/**
 * The posture-derived inventory is authoritative: none-public attaches no OAuth
 * surface, so configuring any of it is a registration error rather than a
 * silently dropped route.
 */
function validatePostureSurfaceConfig(posture, authorizeHandlers, registerHandlers, callbackHandler, rootAuthorizationServer) {
    if (posture !== "none-public") {
        return;
    }
    if (authorizeHandlers !== null) {
        throw new Error(`${ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; authorize/token handlers must not be configured`);
    }
    if (registerHandlers !== null) {
        throw new Error(`${ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; RegisterHandler must not be configured`);
    }
    if (callbackHandler !== null) {
        throw new Error(`${ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; CallbackHandler must not be configured`);
    }
    if (rootAuthorizationServer !== null) {
        throw new Error(`${ERROR_PREFIX} TransportPosture none-public cannot enable RootAuthorizationServer`);
    }
}
function normalizeTransportPosture(posture, requireBearerToken) {
    const resolved = posture ?? "iam";
    if (!TRANSPORT_POSTURES.includes(resolved)) {
        throw new Error(`${ERROR_PREFIX} TransportPosture ${JSON.stringify(resolved)} must be one of iam, jwt, runtime-bearer, none-public`);
    }
    if (resolved === "runtime-bearer") {
        if (requireBearerToken === undefined || requireBearerToken === null) {
            throw new Error(`${ERROR_PREFIX} TransportPosture runtime-bearer requires RequireBearerToken`);
        }
        return resolved;
    }
    if (requireBearerToken !== undefined && requireBearerToken !== null) {
        if (resolved === "none-public") {
            throw new Error(`${ERROR_PREFIX} TransportPosture none-public cannot be combined with RequireBearerToken`);
        }
        throw new Error(`${ERROR_PREFIX} RequireBearerToken is only valid with TransportPosture runtime-bearer`);
    }
    return resolved;
}
function buildInventory(config) {
    const authorizationRoutesAttached = config.transportPosture !== "none-public";
    const endpoints = supportedEndpointTemplates();
    const facades = indexFacadeTemplates(supportedOAuthFacadeTemplates());
    const discovery = indexDiscoveryTemplates(supportedOAuthDiscoveryTemplates());
    if (endpoints.length !== facades.size ||
        endpoints.length !== discovery.size) {
        throw new Error(`${ERROR_PREFIX} incomplete ${CONTRACT_VERSION} route template inventory`);
    }
    const inventory = {
        contractVersion: CONTRACT_VERSION,
        routes: [],
        rootAuthorizationServerPattern: authorizationServerPathForResourcePath("/"),
        rootAuthorizationServerAttached: config.rootAuthorizationServer !== null && authorizationRoutesAttached,
        callbackPattern: config.upstreamCallbackPath,
        issuerMode: config.issuerMode,
    };
    for (const endpoint of endpoints) {
        const facade = facades.get(endpoint.kind);
        const discoveryTemplate = discovery.get(endpoint.kind);
        if (facade === undefined || discoveryTemplate === undefined) {
            throw new Error(`${ERROR_PREFIX} incomplete ${CONTRACT_VERSION} routes for endpoint kind ${JSON.stringify(endpoint.kind)}`);
        }
        inventory.routes.push({
            kind: endpoint.kind,
            mcpPattern: endpoint.mcpPattern,
            mcpMethods: [...MCP_METHODS],
            protectedResourcePattern: endpoint.protectedResourcePath,
            discoveryCanonicalPattern: discoveryTemplate.canonicalPattern,
            discoverySuffixPattern: discoveryTemplate.suffixPattern,
            authorizePattern: facade.authorizePattern,
            tokenPattern: facade.tokenPattern,
            registerPattern: facade.registerPattern,
            authorizationRoutesAttached,
        });
    }
    return inventory;
}
function normalizeURLMode(config) {
    if (config.urlMode === URL_MODE_PUBLIC_BASE_URL) {
        const publicBaseURL = normalizePublicBaseURL(config.publicBaseURL ?? "");
        if (publicBaseURL === null) {
            throw new Error(`${ERROR_PREFIX} public base URL mode requires an absolute HTTPS URL or loopback HTTP URL without a path, query, or fragment`);
        }
        if ((config.allowedHostnames ?? []).length !== 0) {
            throw new Error(`${ERROR_PREFIX} public base URL mode cannot configure allowed hostnames`);
        }
        return { publicBaseURL, allowedHostnames: new Set() };
    }
    if (config.urlMode === URL_MODE_REQUEST_HOST) {
        if ((config.publicBaseURL ?? "").trim() !== "") {
            throw new Error(`${ERROR_PREFIX} request-host mode cannot also configure a public base URL`);
        }
        return {
            publicBaseURL: "",
            allowedHostnames: normalizeAllowedHostnames(config.allowedHostnames),
        };
    }
    throw new Error(`${ERROR_PREFIX} URL mode must be public_base_url or request_host`);
}
function buildRegistrations(config, inventory) {
    const registrations = [];
    const authRequired = config.transportPosture === "iam" || config.transportPosture === "jwt";
    for (const route of inventory.routes) {
        const innerHandler = checkedMCPHandler(route.kind, config.mcpHandler);
        let mcpHandler = innerHandler;
        if (config.requireBearerToken !== undefined) {
            const middleware = requireBearerTokenMiddleware(config.requireBearerToken);
            mcpHandler = (ctx) => middleware(ctx, innerHandler);
        }
        registrations.push({
            method: "POST",
            pattern: route.mcpPattern,
            handler: mcpHandler,
            authRequired,
        }, {
            method: "GET",
            pattern: route.mcpPattern,
            handler: mcpHandler,
            authRequired,
        }, {
            method: "DELETE",
            pattern: route.mcpPattern,
            handler: mcpHandler,
            authRequired,
        });
        // The OAuth surface follows the posture-derived inventory, not mere handler
        // presence: under the none-public posture nothing OAuth-surface registers.
        if (!route.authorizationRoutesAttached) {
            continue;
        }
        registrations.push({
            method: "GET",
            pattern: route.protectedResourcePattern,
            handler: protectedResourceHandler(config, route.kind),
            authRequired: false,
        });
        const discoveryHandler = authorizationServerHandler(config, route.kind);
        registrations.push({
            method: "GET",
            pattern: route.discoveryCanonicalPattern,
            handler: discoveryHandler,
            authRequired: false,
        }, {
            method: "GET",
            pattern: route.discoverySuffixPattern,
            handler: discoveryHandler,
            authRequired: false,
        });
        if (config.authorizeHandlers !== null && config.tokenHandlers !== null) {
            registrations.push({
                method: "GET",
                pattern: route.authorizePattern,
                handler: checkedOAuthFacadeHandler(route.kind, true, config.authorizeHandlers[route.kind]),
                authRequired: false,
            }, {
                method: "POST",
                pattern: route.tokenPattern,
                handler: checkedOAuthFacadeHandler(route.kind, false, config.tokenHandlers[route.kind]),
                authRequired: false,
            });
        }
        if (config.registerHandlers !== null) {
            registrations.push({
                method: "POST",
                pattern: route.registerPattern,
                handler: checkedRegisterHandler(route.kind, config.registerHandlers[route.kind]),
                authRequired: false,
            });
        }
    }
    if (inventory.rootAuthorizationServerAttached) {
        if (config.rootAuthorizationServer === null ||
            config.rootDiscoveryPath !== inventory.rootAuthorizationServerPattern) {
            throw new Error(`${ERROR_PREFIX} root authorization-server inventory is inconsistent`);
        }
        registrations.push({
            method: "GET",
            pattern: inventory.rootAuthorizationServerPattern,
            handler: withMetadataHeaders(authorizationServerMetadataHandler(config.rootAuthorizationServer)),
            authRequired: false,
        });
    }
    if (inventory.callbackPattern !== "" && config.callbackHandler !== null) {
        registrations.push({
            method: "GET",
            pattern: inventory.callbackPattern,
            handler: config.callbackHandler,
            authRequired: false,
        });
    }
    validateRouteRegistrations(registrations);
    return registrations;
}
function validateRouteRegistrations(registrations) {
    const seen = new Set();
    const probe = createApp({ tier: "p0" });
    for (const registration of registrations) {
        const method = registration.method.trim().toUpperCase();
        const key = `${method} ${registration.pattern}`;
        if (method === "" ||
            registration.pattern === "" ||
            registration.handler === undefined ||
            registration.handler === null) {
            throw new Error(`${ERROR_PREFIX} invalid route inventory entry ${JSON.stringify(key)}`);
        }
        if (seen.has(key)) {
            throw new Error(`${ERROR_PREFIX} duplicate route inventory entry ${key}`);
        }
        seen.add(key);
        try {
            probe.handle(method, registration.pattern, registration.handler, {
                authRequired: registration.authRequired,
            });
        }
        catch (err) {
            throw new Error(`${ERROR_PREFIX} invalid or duplicate route inventory entry ${key}: ${errorMessage(err)}`, { cause: err });
        }
    }
}
function registerRoutes(app, registrations) {
    for (const registration of registrations) {
        try {
            app.handle(registration.method, registration.pattern, registration.handler, { authRequired: registration.authRequired });
        }
        catch (err) {
            throw new Error(`${ERROR_PREFIX} register ${registration.method} ${registration.pattern}: ${errorMessage(err)}`, { cause: err });
        }
    }
}
function indexFacadeTemplates(templates) {
    const indexed = new Map();
    for (const template of templates) {
        indexed.set(template.kind, template);
    }
    return indexed;
}
function indexDiscoveryTemplates(templates) {
    const indexed = new Map();
    for (const template of templates) {
        indexed.set(template.kind, template);
    }
    return indexed;
}
function buildApplicationHandlers(authorizeFactory, tokenFactory) {
    if ((authorizeFactory === undefined || authorizeFactory === null) &&
        (tokenFactory === undefined || tokenFactory === null)) {
        return { authorizeHandlers: null, tokenHandlers: null };
    }
    if (authorizeFactory === undefined ||
        authorizeFactory === null ||
        tokenFactory === undefined ||
        tokenFactory === null) {
        throw new Error(`${ERROR_PREFIX} authorize and token handler factories must be configured together`);
    }
    const authorizeHandlers = {};
    const tokenHandlers = {};
    for (const template of supportedEndpointTemplates()) {
        const authorize = authorizeFactory(template.kind);
        const token = tokenFactory(template.kind);
        if (authorize === undefined ||
            authorize === null ||
            token === undefined ||
            token === null) {
            throw new Error(`${ERROR_PREFIX} application handler factory returned nil for endpoint kind ${JSON.stringify(template.kind)}`);
        }
        authorizeHandlers[template.kind] = authorize;
        tokenHandlers[template.kind] = token;
    }
    return { authorizeHandlers, tokenHandlers };
}
function buildRegisterHandlers(factory) {
    if (factory === undefined || factory === null) {
        return null;
    }
    const handlers = {};
    for (const template of supportedEndpointTemplates()) {
        const handler = factory(template.kind);
        if (handler === undefined || handler === null) {
            throw new Error(`${ERROR_PREFIX} register handler factory returned nil for endpoint kind ${JSON.stringify(template.kind)}`);
        }
        handlers[template.kind] = handler;
    }
    return handlers;
}
function normalizeAllowedHostnames(configured) {
    if ((configured ?? []).length === 0) {
        throw new Error(`${ERROR_PREFIX} request-host mode requires at least one allowed hostname`);
    }
    const normalized = new Set();
    for (const raw of configured ?? []) {
        const hostname = normalizeAllowedHostname(raw);
        if (hostname === null) {
            throw new Error(`${ERROR_PREFIX} allowed hostname ${JSON.stringify(raw)} must be a hostname or hostname:port`);
        }
        normalized.add(hostname);
    }
    return normalized;
}
function normalizeRootDiscoveryConfig(config) {
    if (config === undefined || config === null) {
        return { rootAuthorizationServer: null, rootDiscoveryPath: "" };
    }
    const issuer = normalizeHTTPSURL(config.issuerURL, true);
    if (issuer === null) {
        throw new Error(`${ERROR_PREFIX} root discovery issuer URL must be an absolute HTTPS URL without query or fragment`);
    }
    const authorize = normalizeHTTPSURL(config.authorizationEndpointURL, false);
    if (authorize === null) {
        throw new Error(`${ERROR_PREFIX} root discovery authorization endpoint URL must be an absolute HTTPS URL without fragment`);
    }
    const token = normalizeHTTPSURL(config.tokenEndpointURL, false);
    if (token === null) {
        throw new Error(`${ERROR_PREFIX} root discovery token endpoint URL must be an absolute HTTPS URL without fragment`);
    }
    const registration = normalizeHTTPSURL(config.registrationEndpointURL, false);
    if (registration === null) {
        throw new Error(`${ERROR_PREFIX} root discovery registration endpoint URL must be an absolute HTTPS URL without fragment`);
    }
    const jwks = normalizeHTTPSURL(config.jwksURI, false);
    if (jwks === null) {
        throw new Error(`${ERROR_PREFIX} root discovery JWKS URI must be an absolute HTTPS URL without fragment`);
    }
    const scopes = normalizeNonEmptyList("root discovery scope", config.scopes);
    const capabilities = defaultCapabilities();
    return {
        rootAuthorizationServer: {
            issuer,
            authorization_endpoint: authorize,
            token_endpoint: token,
            registration_endpoint: registration,
            jwks_uri: jwks,
            response_types_supported: capabilities.responseTypes,
            grant_types_supported: capabilities.grantTypes,
            token_endpoint_auth_methods_supported: capabilities.tokenEndpointAuthMethods,
            code_challenge_methods_supported: capabilities.codeChallengeMethods,
            scopes_supported: scopes,
        },
        rootDiscoveryPath: authorizationServerPathForResourcePath("/"),
    };
}
function normalizeScopes(configured) {
    const templates = supportedEndpointTemplates();
    const supported = new Set(templates.map((template) => template.kind));
    for (const kind of Object.keys(configured ?? {})) {
        if (!supported.has(kind)) {
            throw new Error(`${ERROR_PREFIX} scopes configured for unsupported endpoint kind ${JSON.stringify(kind)}`);
        }
    }
    const normalized = {};
    for (const template of templates) {
        const scopes = configured?.[template.kind];
        if (scopes === undefined) {
            throw new Error(`${ERROR_PREFIX} scopes are required for endpoint kind ${JSON.stringify(template.kind)}`);
        }
        try {
            normalized[template.kind] = normalizeNonEmptyList("scope", scopes);
        }
        catch (err) {
            throw new Error(`${ERROR_PREFIX} endpoint kind ${JSON.stringify(template.kind)}: ${errorMessage(err)}`, { cause: err });
        }
    }
    return normalized;
}
function normalizeCapabilities(configured) {
    const defaults = defaultCapabilities();
    const opts = configured ?? {};
    return {
        responseTypes: normalizeNonEmptyList("response type", opts.responseTypes ?? defaults.responseTypes),
        grantTypes: normalizeNonEmptyList("grant type", opts.grantTypes ?? defaults.grantTypes),
        tokenEndpointAuthMethods: normalizeNonEmptyList("token endpoint auth method", opts.tokenEndpointAuthMethods ?? defaults.tokenEndpointAuthMethods),
        codeChallengeMethods: normalizeNonEmptyList("code challenge method", opts.codeChallengeMethods ?? defaults.codeChallengeMethods),
    };
}
/**
 * Trims each value, rejects an empty value, de-duplicates preserving order, and
 * requires at least one value.
 */
function normalizeNonEmptyList(label, values) {
    const seen = new Set();
    const normalized = [];
    for (const raw of values ?? []) {
        const value = String(raw ?? "").trim();
        if (value === "") {
            throw new Error(`${label} values cannot be empty`);
        }
        if (seen.has(value)) {
            continue;
        }
        seen.add(value);
        normalized.push(value);
    }
    if (normalized.length === 0) {
        throw new Error(`at least one ${label} is required`);
    }
    return normalized;
}
function checkedMCPHandler(kind, next) {
    return (ctx) => {
        let endpoint;
        try {
            endpoint = endpointFromMCPRequest(ctx);
        }
        catch {
            throw new Error(`${ERROR_PREFIX} request path does not identify endpoint kind ${JSON.stringify(kind)}`);
        }
        if (endpoint.kind !== kind) {
            throw new Error(`${ERROR_PREFIX} request path does not identify endpoint kind ${JSON.stringify(kind)}`);
        }
        return next(ctx);
    };
}
function checkedOAuthFacadeHandler(kind, authorize, next) {
    return (ctx) => {
        const endpoint = endpointFromRouteParams(ctx, kind);
        const expectedPath = authorize
            ? oauthAuthorizePath(endpoint)
            : oauthTokenPath(endpoint);
        if (ctx.request.path !== expectedPath) {
            throw new Error(`${ERROR_PREFIX} request path is not an OAuth facade path for endpoint kind ${JSON.stringify(kind)}`);
        }
        return next(ctx);
    };
}
function checkedRegisterHandler(kind, next) {
    return (ctx) => {
        const endpoint = endpointFromRouteParams(ctx, kind);
        const expectedPath = oauthRegisterPath(endpoint);
        if (ctx.request.path !== expectedPath) {
            throw new Error(`${ERROR_PREFIX} request path is not a registration path for endpoint kind ${JSON.stringify(kind)}`);
        }
        return next(ctx);
    };
}
function protectedResourceHandler(config, kind) {
    return serveMetadata((ctx) => {
        const endpoint = endpointFromProtectedResourceRequest(ctx);
        if (endpoint.kind !== kind) {
            throw new Error(`${ERROR_PREFIX} protected-resource path does not identify endpoint kind ${JSON.stringify(kind)}`);
        }
        const resourceURL = buildAbsoluteURL(config, ctx, mcpPath(endpoint));
        const authorizationServers = config.issuerMode === ISSUER_MODE_ROUTE
            ? [resourceURL]
            : [config.issuerURL];
        const metadata = {
            resource: resourceURL,
            authorization_servers: authorizationServers,
        };
        if (config.jwksURI) {
            metadata.jwks_uri = config.jwksURI;
        }
        const scopes = config.scopes[kind];
        if (scopes.length > 0) {
            metadata.scopes_supported = [...scopes];
        }
        return withMetadataHeaders(protectedResourceMetadataHandler(metadata))(ctx);
    });
}
function authorizationServerHandler(config, kind) {
    return serveMetadata((ctx) => {
        const endpoint = endpointFromDiscoveryRequest(ctx, kind);
        const authorizeURL = buildAbsoluteURL(config, ctx, oauthAuthorizePath(endpoint));
        const tokenURL = buildAbsoluteURL(config, ctx, oauthTokenPath(endpoint));
        const { issuer, registrationEndpoint } = routedIssuerAndRegistration(config, ctx, endpoint);
        const metadata = {
            issuer,
            authorization_endpoint: authorizeURL,
            token_endpoint: tokenURL,
            registration_endpoint: registrationEndpoint,
            jwks_uri: config.jwksURI,
            response_types_supported: [...config.capabilities.responseTypes],
            grant_types_supported: [...config.capabilities.grantTypes],
            token_endpoint_auth_methods_supported: [
                ...config.capabilities.tokenEndpointAuthMethods,
            ],
            code_challenge_methods_supported: [
                ...config.capabilities.codeChallengeMethods,
            ],
            scopes_supported: [...config.scopes[kind]],
        };
        return withMetadataHeaders(authorizationServerMetadataHandler(metadata))(ctx);
    });
}
/**
 * Wraps a metadata handler so a request-origin failure is rendered as its HTTP
 * 400 response instead of propagating as an internal error.
 */
function serveMetadata(build) {
    return async (ctx) => {
        try {
            return await build(ctx);
        }
        catch (err) {
            const response = metadataRequestFailure(err);
            if (response !== null) {
                return response;
            }
            throw err;
        }
    };
}
/**
 * Returns the issuer and registration endpoint the routed RFC 8414 document
 * advertises. In route issuer mode the route URL is the issuer and the
 * registration endpoint is the route's own derived /register path.
 */
function routedIssuerAndRegistration(config, ctx, endpoint) {
    if (config.issuerMode !== ISSUER_MODE_ROUTE) {
        return {
            issuer: config.issuerURL,
            registrationEndpoint: config.registrationEndpointURL,
        };
    }
    return {
        issuer: buildAbsoluteURL(config, ctx, mcpPath(endpoint)),
        registrationEndpoint: buildAbsoluteURL(config, ctx, oauthRegisterPath(endpoint)),
    };
}
function endpointFromMCPRequest(ctx) {
    if (ctx === null || ctx === undefined) {
        throw new Error(`${ERROR_PREFIX} request context is required`);
    }
    return parseMcpPath(ctx.request.path);
}
function endpointFromProtectedResourceRequest(ctx) {
    if (ctx === null || ctx === undefined) {
        throw new Error(`${ERROR_PREFIX} request context is required`);
    }
    const resourcePath = resourcePathFromProtectedResourcePath(ctx.request.path);
    return parseMcpPath(resourcePath);
}
function endpointFromDiscoveryRequest(ctx, kind) {
    const endpoint = endpointFromRouteParams(ctx, kind);
    const canonicalPath = oauthAuthorizationServerPath(endpoint);
    const suffixPath = oauthAuthorizationServerSuffixPath(endpoint);
    if (ctx.request.path !== canonicalPath && ctx.request.path !== suffixPath) {
        throw new Error(`${ERROR_PREFIX} request path is not a discovery path for endpoint kind ${JSON.stringify(kind)}`);
    }
    return endpoint;
}
function endpointFromRouteParams(ctx, kind) {
    if (ctx === null || ctx === undefined) {
        throw new Error(`${ERROR_PREFIX} request context is required`);
    }
    const candidate = {
        kind,
        clientNamespace: ctx.param(PARAM_CLIENT_NAMESPACE),
        partnerId: ctx.param(PARAM_PARTNER_ID),
        agentId: ctx.param(PARAM_AGENT_ID),
    };
    return parseMcpPath(mcpPath(candidate));
}
function buildAbsoluteURL(config, ctx, routePath) {
    let baseURL = config.publicBaseURL;
    if (config.urlMode === URL_MODE_REQUEST_HOST) {
        if (ctx === null || ctx === undefined) {
            throw new MetadataRequestError("request context is required for request-host URL mode");
        }
        const normalized = normalizeRequestOrigin(originURL(ctx.request.headers));
        if (normalized === null) {
            throw new MetadataRequestError("request host is missing or unsafe");
        }
        baseURL = normalized;
        const origin = parseAbsoluteURL(baseURL);
        if (origin === null) {
            throw new Error(`${ERROR_PREFIX} normalized request origin is invalid`);
        }
        if (!config.allowedHostnames.has(origin.host)) {
            throw new MetadataRequestError("request host is not allowlisted");
        }
    }
    const absolute = absoluteURLForPath(baseURL, routePath);
    if (absolute === null) {
        throw new Error(`${ERROR_PREFIX} cannot build absolute URL for route path ${JSON.stringify(routePath)}`);
    }
    return absolute;
}
/** Renders a metadata request-origin failure as its HTTP 400 response. */
function metadataRequestFailure(err) {
    if (!(err instanceof MetadataRequestError)) {
        return null;
    }
    return {
        status: 400,
        headers: {
            "cache-control": ["no-store"],
            "content-type": ["application/json; charset=utf-8"],
            vary: [METADATA_VARY_HEADER],
        },
        cookies: [],
        body: Buffer.from('{"error":"invalid_request_host"}', "utf8"),
        isBase64: false,
    };
}
function withMetadataHeaders(next) {
    return async (ctx) => {
        const response = await next(ctx);
        return {
            ...response,
            headers: {
                ...response.headers,
                "cache-control": ["no-store"],
                vary: [METADATA_VARY_HEADER],
            },
        };
    };
}
/** UTF-8 bytes that `encodePath` leaves unescaped, matching Go's `net/url`. */
const PATH_LITERAL_BYTES = (() => {
    const table = new Uint8Array(256);
    const literals = "-._~$&+,/:;=@";
    for (let code = 0; code < 256; code += 1) {
        const isAlphanumeric = (code >= 0x30 && code <= 0x39) ||
            (code >= 0x41 && code <= 0x5a) ||
            (code >= 0x61 && code <= 0x7a);
        table[code] = isAlphanumeric ? 1 : 0;
    }
    for (const ch of literals) {
        table[ch.charCodeAt(0)] = 1;
    }
    return table;
})();
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
/**
 * Percent-decodes a raw path into a byte string (one code unit per byte),
 * mirroring Go's `url.Parse`, which fails the whole parse on a malformed escape
 * such as `%zz`. Returns null on a malformed escape.
 */
function decodePathBytes(rawPath) {
    let decoded = "";
    let segment = "";
    let index = 0;
    while (index < rawPath.length) {
        const ch = rawPath[index] ?? "";
        if (ch !== "%") {
            segment += ch;
            index += 1;
            continue;
        }
        if (index + 2 >= rawPath.length) {
            return null;
        }
        const hex = rawPath.slice(index + 1, index + 3);
        if (!HEX_PAIR.test(hex)) {
            return null;
        }
        if (segment !== "") {
            decoded += utf8ByteString(segment);
            segment = "";
        }
        decoded += String.fromCharCode(Number.parseInt(hex, 16));
        index += 3;
    }
    if (segment !== "") {
        decoded += utf8ByteString(segment);
    }
    return decoded;
}
/** Re-encodes UTF-8 text as a byte string (one code unit per byte). */
function utf8ByteString(text) {
    let out = "";
    for (const byte of Buffer.from(text, "utf8")) {
        out += String.fromCharCode(byte);
    }
    return out;
}
/** Escapes a byte-string path with Go's `encodePath` rule (uppercase hex). */
function encodePathBytes(path) {
    let out = "";
    for (let index = 0; index < path.length; index += 1) {
        const code = path.charCodeAt(index);
        if (code < 256 && PATH_LITERAL_BYTES[code] === 1) {
            out += path[index];
        }
        else {
            out += `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
        }
    }
    return out;
}
/**
 * A minimal absolute-URL parser mirroring the Go facade's `url.Parse` usage.
 * An empty authority (for example `https:///token`) yields an empty host and is
 * rejected by {@link parseAbsoluteURL}.
 */
function parseURL(raw) {
    const trimmed = String(raw ?? "").trim();
    if (trimmed === "") {
        return null;
    }
    const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(trimmed);
    if (schemeMatch === null) {
        return null;
    }
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    let rest = trimmed.slice(schemeMatch[0].length);
    let authority = "";
    if (rest.startsWith("//")) {
        rest = rest.slice(2);
        let end = rest.length;
        for (let index = 0; index < rest.length; index += 1) {
            const ch = rest[index];
            if (ch === "/" || ch === "?" || ch === "#") {
                end = index;
                break;
            }
        }
        authority = rest.slice(0, end);
        rest = rest.slice(end);
    }
    let userinfo = "";
    let hostport = authority;
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
        userinfo = authority.slice(0, at);
        hostport = authority.slice(at + 1);
    }
    let hostname = hostport;
    let port = "";
    if (hostport.startsWith("[")) {
        const close = hostport.indexOf("]");
        if (close < 0) {
            return null;
        }
        hostname = hostport.slice(1, close);
        const after = hostport.slice(close + 1);
        if (after !== "") {
            if (!after.startsWith(":")) {
                return null;
            }
            port = after.slice(1);
        }
    }
    else {
        const colon = hostport.indexOf(":");
        if (colon >= 0) {
            hostname = hostport.slice(0, colon);
            port = hostport.slice(colon + 1);
        }
    }
    if (port !== "" && !/^\d+$/.test(port)) {
        return null;
    }
    let rawPath = rest;
    let hash = "";
    const hashIndex = rawPath.indexOf("#");
    if (hashIndex >= 0) {
        const fragment = rawPath.slice(hashIndex + 1);
        hash = fragment === "" ? "" : rawPath.slice(hashIndex);
        rawPath = rawPath.slice(0, hashIndex);
    }
    let search = "";
    const queryIndex = rawPath.indexOf("?");
    if (queryIndex >= 0) {
        search = rawPath.slice(queryIndex);
        rawPath = rawPath.slice(0, queryIndex);
    }
    const path = decodePathBytes(rawPath);
    if (path === null) {
        return null;
    }
    return {
        scheme,
        host: hostport,
        hostname,
        port,
        path,
        search,
        hash,
        hasUser: userinfo !== "",
    };
}
/** Mirrors the Go helper: a scheme, an authority, and no userinfo. */
function parseAbsoluteURL(raw) {
    const u = parseURL(raw);
    if (u === null) {
        return null;
    }
    if (u.scheme === "" || u.hostname === "" || u.hasUser || u.host === "") {
        return null;
    }
    return u;
}
function canonicalHostname(hostname) {
    const lower = hostname.toLowerCase().replace(/\.$/, "");
    if (lower.includes(":")) {
        return `[${lower}]`;
    }
    return lower;
}
function canonicalAuthority(u) {
    const hostname = canonicalHostname(u.hostname);
    if (hostname === "") {
        return "";
    }
    let port = u.port;
    if ((u.scheme === "https" && port === "443") ||
        (u.scheme === "http" && port === "80")) {
        port = "";
    }
    if (port !== "") {
        return joinHostPort(hostname.replace(/^\[/, "").replace(/\]$/, ""), port);
    }
    return hostname;
}
function joinHostPort(host, port) {
    if (host.includes(":")) {
        return `[${host}]:${port}`;
    }
    return `${host}:${port}`;
}
function normalizeHTTPSURL(raw, issuer) {
    const u = parseAbsoluteURL(raw);
    if (u === null || u.scheme !== "https" || u.hash !== "") {
        return null;
    }
    if (issuer && u.search !== "") {
        return null;
    }
    const authority = canonicalAuthority(u);
    if (authority === "") {
        return null;
    }
    // Go clears RawPath and re-serializes the decoded path, so `%41` becomes `A`.
    const decodedPath = issuer ? trimTrailingSlashes(u.path) : u.path;
    const path = encodePathBytes(decodedPath);
    const query = issuer ? "" : u.search;
    return `${u.scheme}://${authority}${path}${query}`;
}
function normalizePublicBaseURL(raw) {
    return normalizeRequestOrigin(raw);
}
function normalizeAllowedHostname(raw) {
    const value = String(raw ?? "").trim();
    if (value === "" || value.includes("/") || /[?#@]/.test(value)) {
        return null;
    }
    const u = parseURL(`https://${value}`);
    if (u === null ||
        u.hostname === "" ||
        u.hasUser ||
        u.search !== "" ||
        u.hash !== "") {
        return null;
    }
    const port = u.port;
    if (port === "80" || port === "443") {
        const hostname = canonicalHostname(u.hostname);
        return hostname === "" ? null : hostname;
    }
    const authority = canonicalAuthority(u);
    return authority === "" ? null : authority;
}
function absoluteURLForPath(baseURL, routePath) {
    const u = parseAbsoluteURL(baseURL);
    if (u === null || !routePath.startsWith("/")) {
        return null;
    }
    // Go keeps the parsed host verbatim and drops the query and fragment.
    const path = encodePathBytes(trimTrailingSlashes(u.path) + utf8ByteString(routePath));
    return `${u.scheme}://${u.host}${path}`;
}
/** Removes every trailing "/" without a backtracking regex (ReDoS-safe). */
function trimTrailingSlashes(value) {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 47) {
        end -= 1;
    }
    return value.slice(0, end);
}
/**
 * Validates and canonicalizes a request-derived origin. Accepts HTTPS, plus
 * HTTP only for loopback hosts, and removes scheme-default ports.
 */
export function normalizeRequestOrigin(raw) {
    const u = parseAbsoluteURL(raw);
    if (u === null ||
        u.hasUser ||
        u.hostname === "" ||
        u.search !== "" ||
        u.hash !== "") {
        return null;
    }
    if (u.path !== "" && u.path !== "/") {
        return null;
    }
    if (!isAllowedDiscoveryScheme(u.scheme, u.hostname)) {
        return null;
    }
    const authority = canonicalizeRequestOriginAuthority(u);
    if (authority === "") {
        return null;
    }
    return `${u.scheme}://${authority}`;
}
function canonicalizeRequestOriginAuthority(u) {
    const hostname = u.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "") {
        return "";
    }
    let port = u.port;
    if (port === defaultPortForScheme(u.scheme)) {
        port = "";
    }
    if (port !== "") {
        return joinHostPort(hostname, port);
    }
    if (hostname.includes(":")) {
        return `[${hostname}]`;
    }
    return hostname;
}
function defaultPortForScheme(scheme) {
    if (scheme === "https") {
        return "443";
    }
    if (scheme === "http") {
        return "80";
    }
    return "";
}
function isLoopbackHostname(host) {
    const value = host.trim().toLowerCase();
    if (value === "localhost" || value === "::1") {
        return true;
    }
    return /^127\./.test(value);
}
function isAllowedDiscoveryScheme(scheme, hostname) {
    return (scheme === "https" || (scheme === "http" && isLoopbackHostname(hostname)));
}
function cloneInventory(inventory) {
    return {
        contractVersion: inventory.contractVersion,
        routes: inventory.routes.map((route) => ({
            ...route,
            mcpMethods: [...route.mcpMethods],
        })),
        rootAuthorizationServerPattern: inventory.rootAuthorizationServerPattern,
        rootAuthorizationServerAttached: inventory.rootAuthorizationServerAttached,
        callbackPattern: inventory.callbackPattern,
        issuerMode: inventory.issuerMode,
    };
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=mcpfacade.js.map