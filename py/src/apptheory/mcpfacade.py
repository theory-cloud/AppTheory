"""MCP OAuth facade route registrar.

Python port of the Go ``runtime/mcpfacade`` package and the verified
TypeScript port in ``ts/src/mcpfacade.ts``. The helper owns composition only:
every OAuth behavior (authorize, token, registration, callback) stays
application-owned and is mounted through handler factories.

Registration fails closed before any route is added: the configuration, the
transport-posture pairing, the derived route inventory, and the route
registrations are all validated first, so a rejected configuration leaves the
target app untouched.
"""

from __future__ import annotations

import json as jsonlib
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from apptheory.app import App, Handler, _resolve, create_app
from apptheory.cloudfront import origin_url
from apptheory.context import Context
from apptheory.mcproutes import (
    CONTRACT_VERSION,
    ISSUER_MODE_FAMILY,
    ISSUER_MODE_ROUTE,
    PARAM_AGENT_ID,
    PARAM_CLIENT_NAMESPACE,
    PARAM_PARTNER_ID,
    EndpointPath,
    authorization_server_path_for_resource_path,
    callback_path_for_configured_path,
    parse_mcp_path,
    resource_path_from_protected_resource_path,
    supported_endpoint_templates,
    supported_issuer_modes,
    supported_oauth_discovery_templates,
    supported_oauth_facade_templates,
)
from apptheory.oauth import RequireBearerTokenOptions, require_bearer_token_middleware
from apptheory.response import Response, normalize_response

_HTTPS_SCHEME = "https"
_HTTP_SCHEME = "http"

# URLMode selects the source of absolute URLs in facade metadata documents.
#
# URL_MODE_PUBLIC_BASE_URL uses FacadeConfig.public_base_url fixed at
# registration time; URL_MODE_REQUEST_HOST derives the origin from each
# normalized request.
URL_MODE_PUBLIC_BASE_URL = "public_base_url"
URL_MODE_REQUEST_HOST = "request_host"

# TRANSPORT_POSTURES is the closed transport-posture vocabulary.
TRANSPORT_POSTURES: tuple[str, ...] = ("iam", "jwt", "runtime-bearer", "none-public")

# METADATA_VARY_HEADER is the exact Vary header advertised by every facade
# metadata response, matching the Go and TypeScript runtimes.
METADATA_VARY_HEADER = (
    "Host, X-Forwarded-Host, X-AppTheory-Original-Host, X-FaceTheory-Original-Host, "
    "Forwarded, CloudFront-Forwarded-Proto, X-Forwarded-Proto"
)

_ERROR_PREFIX = "AppTheoryMcpFacade:"
_MCP_METHODS = ("POST", "GET", "DELETE")
_METADATA_REQUEST_BODY = b'{"error":"invalid_request_host"}'

# HandlerFactory returns an application-owned handler for one endpoint kind.
# Factories run during facade registration, never during request handling.
HandlerFactory = Callable[[str], Handler]


@dataclass(slots=True)
class FacadeCapabilities:
    """RFC 8414 capability lists advertised by the facade.

    ``None`` fields use :func:`default_capabilities`; a configured field
    replaces the default.
    """

    response_types: list[str] | None = None
    grant_types: list[str] | None = None
    token_endpoint_auth_methods: list[str] | None = None
    code_challenge_methods: list[str] | None = None


def default_capabilities() -> FacadeCapabilities:
    """Return the golden-path OAuth capabilities: code responses,
    authorization-code and refresh-token grants, public clients, and S256 PKCE.
    """
    return FacadeCapabilities(
        response_types=["code"],
        grant_types=["authorization_code", "refresh_token"],
        token_endpoint_auth_methods=["none"],
        code_challenge_methods=["S256"],
    )


@dataclass(slots=True)
class RootDiscoveryConfig:
    """Configures the optional, unscoped authorization-server discovery document.

    Every endpoint is fixed at registration time and belongs to the upstream
    authorization server.
    """

    issuer_url: str = ""
    authorization_endpoint_url: str = ""
    token_endpoint_url: str = ""
    registration_endpoint_url: str = ""
    jwks_uri: str = ""
    scopes: list[str] = field(default_factory=list)


@dataclass(slots=True)
class FacadeConfig:
    """Configures the complete route-algebra MCP OAuth facade."""

    issuer_url: str = ""
    jwks_uri: str = ""
    registration_endpoint_url: str = ""
    issuer_mode: str = ""
    url_mode: str = ""
    public_base_url: str = ""
    upstream_callback_path: str = ""
    allowed_hostnames: list[str] = field(default_factory=list)
    scopes: dict[str, list[str]] = field(default_factory=dict)
    capabilities: FacadeCapabilities | None = None
    mcp_handler: Handler | None = None
    authorize_handler: HandlerFactory | None = None
    token_handler: HandlerFactory | None = None
    register_handler: HandlerFactory | None = None
    callback_handler: Handler | None = None
    root_authorization_server: RootDiscoveryConfig | None = None
    transport_posture: str = "iam"
    require_bearer_token: RequireBearerTokenOptions | None = None


@dataclass(slots=True)
class FacadeRoute:
    """One endpoint-kind route family installed by the helper."""

    kind: str
    mcp_pattern: str
    mcp_methods: list[str]
    protected_resource_pattern: str
    discovery_canonical_pattern: str
    discovery_suffix_pattern: str
    authorize_pattern: str
    token_pattern: str
    register_pattern: str
    authorization_routes_attached: bool


@dataclass(slots=True)
class RouteInventory:
    """A defensive snapshot of the installed facade surface."""

    contract_version: str
    routes: list[FacadeRoute]
    root_authorization_server_pattern: str
    root_authorization_server_attached: bool
    callback_pattern: str
    issuer_mode: str


@dataclass(slots=True)
class _NormalizedConfig:
    issuer_url: str
    jwks_uri: str
    registration_endpoint_url: str
    issuer_mode: str
    url_mode: str
    public_base_url: str
    upstream_callback_path: str
    allowed_hostnames: set[str]
    scopes: dict[str, list[str]]
    capabilities: FacadeCapabilities
    mcp_handler: Handler
    authorize_handlers: dict[str, Handler] | None
    token_handlers: dict[str, Handler] | None
    register_handlers: dict[str, Handler] | None
    callback_handler: Handler | None
    root_authorization_server: dict[str, Any] | None
    root_discovery_path: str
    transport_posture: str
    require_bearer_token: RequireBearerTokenOptions | None


@dataclass(slots=True)
class _RouteRegistration:
    method: str
    pattern: str
    handler: Handler
    auth_required: bool


class _MetadataRequestError(Exception):
    """A metadata request whose origin is missing, unsafe, or not allowlisted.

    Rendered as HTTP 400 ``{"error":"invalid_request_host"}`` rather than the app
    error envelope.
    """

    def __init__(self, message: str) -> None:
        super().__init__(f"{_ERROR_PREFIX} {message}")


def register_mcp_facade(app: App | None, config: FacadeConfig) -> RouteInventory:
    """Install the complete MCP OAuth facade and return its route inventory.

    The helper owns composition only: authorize and token routes are absent
    unless the application supplies both handler factories. Registration fails
    closed before any route is added.
    """
    if app is None:
        raise ValueError(f"{_ERROR_PREFIX} app is required")
    normalized = _normalize_config(config)
    inventory = _build_inventory(normalized)
    registrations = _build_registrations(normalized, inventory)
    _register_routes(app, registrations)
    return _clone_inventory(inventory)


def _normalize_config(config: FacadeConfig | None) -> _NormalizedConfig:
    if config is None:
        raise ValueError(f"{_ERROR_PREFIX} config is required")
    mcp_handler = config.mcp_handler
    if mcp_handler is None:
        raise ValueError(f"{_ERROR_PREFIX} MCP handler is required")
    transport_posture = _normalize_transport_posture(config.transport_posture, config.require_bearer_token)
    normalized = _normalize_derived_config(config, mcp_handler)
    normalized.transport_posture = transport_posture
    normalized.require_bearer_token = config.require_bearer_token
    normalized.callback_handler = config.callback_handler
    _validate_posture_surface_config(
        transport_posture,
        normalized.authorize_handlers,
        normalized.register_handlers,
        normalized.callback_handler,
        normalized.root_authorization_server,
    )
    return normalized


def _normalize_derived_config(config: FacadeConfig, mcp_handler: Handler) -> _NormalizedConfig:
    issuer_url = _normalize_https_url(config.issuer_url, True)
    if issuer_url is None:
        raise ValueError(f"{_ERROR_PREFIX} issuer URL must be an absolute HTTPS URL without query or fragment")
    jwks_uri = _normalize_https_url(config.jwks_uri, False)
    if jwks_uri is None:
        raise ValueError(f"{_ERROR_PREFIX} JWKS URI must be an absolute HTTPS URL without fragment")

    registration_endpoint_url = config.registration_endpoint_url or ""
    if registration_endpoint_url.strip() == "":
        derived = _absolute_url_for_path(issuer_url, "/register")
        if derived is None:
            raise ValueError(
                f"{_ERROR_PREFIX} registration endpoint URL must be an absolute HTTPS URL without fragment"
            )
        registration_endpoint_url = derived
    else:
        normalized_registration = _normalize_https_url(registration_endpoint_url, False)
        if normalized_registration is None:
            raise ValueError(
                f"{_ERROR_PREFIX} registration endpoint URL must be an absolute HTTPS URL without fragment"
            )
        registration_endpoint_url = normalized_registration

    public_base_url, allowed_hostnames = _normalize_url_mode(config)
    issuer_mode = _normalize_issuer_mode(config.issuer_mode)
    upstream_callback_path = _resolve_callback_path(config.upstream_callback_path)
    scopes = _normalize_scopes(config.scopes)
    capabilities = _normalize_capabilities(config.capabilities)
    authorize_handlers, token_handlers = _build_application_handlers(config.authorize_handler, config.token_handler)
    register_handlers = _build_register_handlers(config.register_handler)
    root_authorization_server, root_discovery_path = _normalize_root_discovery_config(config.root_authorization_server)

    return _NormalizedConfig(
        issuer_url=issuer_url,
        jwks_uri=jwks_uri,
        registration_endpoint_url=registration_endpoint_url,
        issuer_mode=issuer_mode,
        url_mode=config.url_mode,
        public_base_url=public_base_url,
        upstream_callback_path=upstream_callback_path,
        allowed_hostnames=allowed_hostnames,
        scopes=scopes,
        capabilities=capabilities,
        mcp_handler=mcp_handler,
        authorize_handlers=authorize_handlers,
        token_handlers=token_handlers,
        register_handlers=register_handlers,
        callback_handler=config.callback_handler,
        root_authorization_server=root_authorization_server,
        root_discovery_path=root_discovery_path,
        transport_posture="iam",
        require_bearer_token=None,
    )


def _normalize_issuer_mode(mode: str | None) -> str:
    if not mode:
        return ISSUER_MODE_FAMILY
    if mode not in supported_issuer_modes():
        raise ValueError(f"{_ERROR_PREFIX} IssuerMode {_quote(mode)} must be one of family, route")
    return mode


def _resolve_callback_path(configured: str | None) -> str:
    try:
        return callback_path_for_configured_path(configured or "")
    except ValueError as err:
        raise ValueError(
            f"{_ERROR_PREFIX} upstream callback path must be an absolute path without query or fragment"
        ) from err


def _validate_posture_surface_config(
    posture: str,
    authorize_handlers: dict[str, Handler] | None,
    register_handlers: dict[str, Handler] | None,
    callback_handler: Handler | None,
    root_authorization_server: dict[str, Any] | None,
) -> None:
    """Make the posture-derived inventory authoritative.

    The none-public posture attaches no OAuth surface, so configuring any of it
    is a registration error rather than a silently dropped route.
    """
    if posture != "none-public":
        return
    if authorize_handlers is not None:
        raise ValueError(
            f"{_ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; "
            "authorize/token handlers must not be configured"
        )
    if register_handlers is not None:
        raise ValueError(
            f"{_ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; "
            "RegisterHandler must not be configured"
        )
    if callback_handler is not None:
        raise ValueError(
            f"{_ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; "
            "CallbackHandler must not be configured"
        )
    if root_authorization_server is not None:
        raise ValueError(f"{_ERROR_PREFIX} TransportPosture none-public cannot enable RootAuthorizationServer")


def _normalize_transport_posture(posture: str | None, require_bearer_token: RequireBearerTokenOptions | None) -> str:
    resolved = posture if posture else "iam"
    if resolved not in TRANSPORT_POSTURES:
        raise ValueError(
            f"{_ERROR_PREFIX} TransportPosture {_quote(resolved)} must be one of iam, jwt, runtime-bearer, none-public"
        )
    if resolved == "runtime-bearer":
        if require_bearer_token is None:
            raise ValueError(f"{_ERROR_PREFIX} TransportPosture runtime-bearer requires RequireBearerToken")
        return resolved
    if require_bearer_token is not None:
        if resolved == "none-public":
            raise ValueError(f"{_ERROR_PREFIX} TransportPosture none-public cannot be combined with RequireBearerToken")
        raise ValueError(f"{_ERROR_PREFIX} RequireBearerToken is only valid with TransportPosture runtime-bearer")
    return resolved


def _build_inventory(config: _NormalizedConfig) -> RouteInventory:
    authorization_routes_attached = config.transport_posture != "none-public"
    endpoints = supported_endpoint_templates()
    facades = _index_by_kind(supported_oauth_facade_templates())
    discovery = _index_by_kind(supported_oauth_discovery_templates())
    if len(endpoints) != len(facades) or len(endpoints) != len(discovery):
        raise ValueError(f"{_ERROR_PREFIX} incomplete {CONTRACT_VERSION} route template inventory")

    routes: list[FacadeRoute] = []
    for endpoint in endpoints:
        facade = facades.get(endpoint["kind"])
        discovery_template = discovery.get(endpoint["kind"])
        if facade is None or discovery_template is None:
            raise ValueError(
                f"{_ERROR_PREFIX} incomplete {CONTRACT_VERSION} routes for endpoint kind {_quote(endpoint['kind'])}"
            )
        routes.append(
            FacadeRoute(
                kind=endpoint["kind"],
                mcp_pattern=endpoint["mcp_pattern"],
                mcp_methods=list(_MCP_METHODS),
                protected_resource_pattern=endpoint["protected_resource_path"],
                discovery_canonical_pattern=discovery_template["canonical_pattern"],
                discovery_suffix_pattern=discovery_template["suffix_pattern"],
                authorize_pattern=facade["authorize_pattern"],
                token_pattern=facade["token_pattern"],
                register_pattern=facade["register_pattern"],
                authorization_routes_attached=authorization_routes_attached,
            )
        )
    return RouteInventory(
        contract_version=CONTRACT_VERSION,
        routes=routes,
        root_authorization_server_pattern=authorization_server_path_for_resource_path("/"),
        root_authorization_server_attached=config.root_authorization_server is not None
        and authorization_routes_attached,
        callback_pattern=config.upstream_callback_path,
        issuer_mode=config.issuer_mode,
    )


def _normalize_url_mode(config: FacadeConfig) -> tuple[str, set[str]]:
    if config.url_mode == URL_MODE_PUBLIC_BASE_URL:
        public_base_url = _normalize_public_base_url(config.public_base_url or "")
        if public_base_url is None:
            raise ValueError(
                f"{_ERROR_PREFIX} public base URL mode requires an absolute HTTPS URL or loopback HTTP URL "
                "without a path, query, or fragment"
            )
        if len(config.allowed_hostnames or []) != 0:
            raise ValueError(f"{_ERROR_PREFIX} public base URL mode cannot configure allowed hostnames")
        return public_base_url, set()
    if config.url_mode == URL_MODE_REQUEST_HOST:
        if (config.public_base_url or "").strip() != "":
            raise ValueError(f"{_ERROR_PREFIX} request-host mode cannot also configure a public base URL")
        return "", _normalize_allowed_hostnames(config.allowed_hostnames)
    raise ValueError(f"{_ERROR_PREFIX} URL mode must be public_base_url or request_host")


def _build_registrations(config: _NormalizedConfig, inventory: RouteInventory) -> list[_RouteRegistration]:
    registrations: list[_RouteRegistration] = []
    auth_required = config.transport_posture in ("iam", "jwt")
    for route in inventory.routes:
        handler = _checked_mcp_handler(route.kind, config.mcp_handler)
        if config.require_bearer_token is not None:
            handler = _with_bearer_assertion(config.require_bearer_token, handler)
        registrations.append(_RouteRegistration("POST", route.mcp_pattern, handler, auth_required))
        registrations.append(_RouteRegistration("GET", route.mcp_pattern, handler, auth_required))
        registrations.append(_RouteRegistration("DELETE", route.mcp_pattern, handler, auth_required))

        # The OAuth surface follows the posture-derived inventory, not mere
        # handler presence: under the none-public posture nothing OAuth-surface
        # registers, so the runtime surface cannot disagree with the CDK
        # construct's authorizationRoutesAttached inventory field.
        if not route.authorization_routes_attached:
            continue
        registrations.append(
            _RouteRegistration(
                "GET",
                route.protected_resource_pattern,
                _protected_resource_handler(config, route.kind),
                False,
            )
        )

        discovery_handler = _authorization_server_handler(config, route.kind)
        registrations.append(_RouteRegistration("GET", route.discovery_canonical_pattern, discovery_handler, False))
        registrations.append(_RouteRegistration("GET", route.discovery_suffix_pattern, discovery_handler, False))

        if config.authorize_handlers is not None and config.token_handlers is not None:
            registrations.append(
                _RouteRegistration(
                    "GET",
                    route.authorize_pattern,
                    _checked_oauth_facade_handler(route.kind, True, config.authorize_handlers[route.kind]),
                    False,
                )
            )
            registrations.append(
                _RouteRegistration(
                    "POST",
                    route.token_pattern,
                    _checked_oauth_facade_handler(route.kind, False, config.token_handlers[route.kind]),
                    False,
                )
            )
        if config.register_handlers is not None:
            registrations.append(
                _RouteRegistration(
                    "POST",
                    route.register_pattern,
                    _checked_register_handler(route.kind, config.register_handlers[route.kind]),
                    False,
                )
            )

    if inventory.root_authorization_server_attached:
        if (
            config.root_authorization_server is None
            or config.root_discovery_path != inventory.root_authorization_server_pattern
        ):
            raise ValueError(f"{_ERROR_PREFIX} root authorization-server inventory is inconsistent")
        root_document = config.root_authorization_server
        registrations.append(
            _RouteRegistration(
                "GET",
                inventory.root_authorization_server_pattern,
                _with_metadata_headers(lambda _ctx, _document=root_document: _metadata_response(_document)),
                False,
            )
        )
    if inventory.callback_pattern != "" and config.callback_handler is not None:
        registrations.append(_RouteRegistration("GET", inventory.callback_pattern, config.callback_handler, False))

    _validate_route_registrations(registrations)
    return registrations


def _validate_route_registrations(registrations: list[_RouteRegistration]) -> None:
    seen: set[str] = set()
    probe = create_app(tier="p0")
    for registration in registrations:
        method = str(registration.method or "").strip().upper()
        key = f"{method} {registration.pattern}"
        if method == "" or registration.pattern == "" or registration.handler is None:
            raise ValueError(f"{_ERROR_PREFIX} invalid route inventory entry {_quote(key)}")
        if key in seen:
            raise ValueError(f"{_ERROR_PREFIX} duplicate route inventory entry {key}")
        seen.add(key)
        try:
            probe.handle(method, registration.pattern, registration.handler, auth_required=registration.auth_required)
        except Exception as err:
            raise ValueError(f"{_ERROR_PREFIX} invalid or duplicate route inventory entry {key}: {err}") from err


def _register_routes(app: App, registrations: list[_RouteRegistration]) -> None:
    for registration in registrations:
        try:
            app.handle(
                registration.method,
                registration.pattern,
                registration.handler,
                auth_required=registration.auth_required,
            )
        except Exception as err:
            raise ValueError(f"{_ERROR_PREFIX} register {registration.method} {registration.pattern}: {err}") from err


def _index_by_kind(templates: list[dict[str, str]]) -> dict[str, dict[str, str]]:
    return {template["kind"]: template for template in templates}


def _build_application_handlers(
    authorize_factory: HandlerFactory | None,
    token_factory: HandlerFactory | None,
) -> tuple[dict[str, Handler] | None, dict[str, Handler] | None]:
    if authorize_factory is None and token_factory is None:
        return None, None
    if authorize_factory is None or token_factory is None:
        raise ValueError(f"{_ERROR_PREFIX} authorize and token handler factories must be configured together")
    authorize_handlers: dict[str, Handler] = {}
    token_handlers: dict[str, Handler] = {}
    for template in supported_endpoint_templates():
        kind = template["kind"]
        authorize = authorize_factory(kind)
        token = token_factory(kind)
        if authorize is None or token is None:
            raise ValueError(
                f"{_ERROR_PREFIX} application handler factory returned nil for endpoint kind {_quote(kind)}"
            )
        authorize_handlers[kind] = authorize
        token_handlers[kind] = token
    return authorize_handlers, token_handlers


def _build_register_handlers(factory: HandlerFactory | None) -> dict[str, Handler] | None:
    if factory is None:
        return None
    handlers: dict[str, Handler] = {}
    for template in supported_endpoint_templates():
        kind = template["kind"]
        handler = factory(kind)
        if handler is None:
            raise ValueError(f"{_ERROR_PREFIX} register handler factory returned nil for endpoint kind {_quote(kind)}")
        handlers[kind] = handler
    return handlers


def _normalize_allowed_hostnames(configured: list[str] | None) -> set[str]:
    values = list(configured or [])
    if not values:
        raise ValueError(f"{_ERROR_PREFIX} request-host mode requires at least one allowed hostname")
    normalized: set[str] = set()
    for raw in values:
        hostname = _normalize_allowed_hostname(raw)
        if hostname is None:
            raise ValueError(f"{_ERROR_PREFIX} allowed hostname {_quote(raw)} must be a hostname or hostname:port")
        normalized.add(hostname)
    return normalized


def _normalize_root_discovery_config(
    config: RootDiscoveryConfig | None,
) -> tuple[dict[str, Any] | None, str]:
    if config is None:
        return None, ""
    issuer = _normalize_https_url(config.issuer_url, True)
    if issuer is None:
        raise ValueError(
            f"{_ERROR_PREFIX} root discovery issuer URL must be an absolute HTTPS URL without query or fragment"
        )
    authorize = _normalize_https_url(config.authorization_endpoint_url, False)
    if authorize is None:
        raise ValueError(
            f"{_ERROR_PREFIX} root discovery authorization endpoint URL must be an absolute HTTPS URL without fragment"
        )
    token_endpoint = _normalize_https_url(config.token_endpoint_url, False)
    if token_endpoint is None:
        raise ValueError(
            f"{_ERROR_PREFIX} root discovery token endpoint URL must be an absolute HTTPS URL without fragment"
        )
    registration = _normalize_https_url(config.registration_endpoint_url, False)
    if registration is None:
        raise ValueError(
            f"{_ERROR_PREFIX} root discovery registration endpoint URL must be an absolute HTTPS URL without fragment"
        )
    jwks = _normalize_https_url(config.jwks_uri, False)
    if jwks is None:
        raise ValueError(f"{_ERROR_PREFIX} root discovery JWKS URI must be an absolute HTTPS URL without fragment")
    try:
        scopes = _normalize_non_empty_list("root discovery scope", config.scopes)
    except ValueError as err:
        raise ValueError(f"{_ERROR_PREFIX} {err}") from err
    capabilities = default_capabilities()
    document: dict[str, Any] = {
        "issuer": issuer,
        "authorization_endpoint": authorize,
        "token_endpoint": token_endpoint,
        "registration_endpoint": registration,
        "jwks_uri": jwks,
        "response_types_supported": list(capabilities.response_types or []),
        "grant_types_supported": list(capabilities.grant_types or []),
        "token_endpoint_auth_methods_supported": list(capabilities.token_endpoint_auth_methods or []),
        "code_challenge_methods_supported": list(capabilities.code_challenge_methods or []),
        "scopes_supported": scopes,
    }
    return document, authorization_server_path_for_resource_path("/")


def _normalize_scopes(configured: dict[str, list[str]] | None) -> dict[str, list[str]]:
    configured = dict(configured or {})
    templates = supported_endpoint_templates()
    supported = {template["kind"] for template in templates}
    for kind in configured:
        if kind not in supported:
            raise ValueError(f"{_ERROR_PREFIX} scopes configured for unsupported endpoint kind {_quote(kind)}")

    normalized: dict[str, list[str]] = {}
    for template in templates:
        kind = template["kind"]
        if kind not in configured:
            raise ValueError(f"{_ERROR_PREFIX} scopes are required for endpoint kind {_quote(kind)}")
        try:
            normalized[kind] = _normalize_non_empty_list("scope", configured[kind])
        except ValueError as err:
            raise ValueError(f"{_ERROR_PREFIX} endpoint kind {_quote(kind)}: {err}") from err
    return normalized


def _normalize_capabilities(configured: FacadeCapabilities | None) -> FacadeCapabilities:
    defaults = default_capabilities()
    specs: tuple[tuple[str, str, list[str]], ...] = (
        ("response type", "response_types", defaults.response_types or []),
        ("grant type", "grant_types", defaults.grant_types or []),
        ("token endpoint auth method", "token_endpoint_auth_methods", defaults.token_endpoint_auth_methods or []),
        ("code challenge method", "code_challenge_methods", defaults.code_challenge_methods or []),
    )
    resolved: dict[str, list[str]] = {}
    for label, attribute, fallback in specs:
        value = getattr(configured, attribute) if configured is not None else None
        if value is None:
            value = fallback
        try:
            resolved[attribute] = _normalize_non_empty_list(label, value)
        except ValueError as err:
            raise ValueError(f"{_ERROR_PREFIX} {err}") from err
    return FacadeCapabilities(**resolved)


def _normalize_non_empty_list(label: str, values: list[str] | None) -> list[str]:
    """Trim each value, reject an empty value, de-duplicate preserving order,
    and require at least one value.
    """
    seen: set[str] = set()
    normalized: list[str] = []
    for raw in values or []:
        value = str(raw or "").strip()
        if value == "":
            raise ValueError(f"{label} values cannot be empty")
        if value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    if not normalized:
        raise ValueError(f"at least one {label} is required")
    return normalized


def _checked_mcp_handler(kind: str, next_handler: Handler) -> Handler:
    def handler(ctx: Context) -> Response:
        try:
            endpoint = _endpoint_from_mcp_request(ctx)
        except Exception:  # noqa: BLE001
            raise ValueError(f"{_ERROR_PREFIX} request path does not identify endpoint kind {_quote(kind)}") from None
        if endpoint.kind != kind:
            raise ValueError(f"{_ERROR_PREFIX} request path does not identify endpoint kind {_quote(kind)}")
        return _resolve(next_handler(ctx))

    return handler


def _checked_oauth_facade_handler(kind: str, authorize: bool, next_handler: Handler) -> Handler:
    def handler(ctx: Context) -> Response:
        endpoint = _endpoint_from_route_params(ctx, kind)
        expected_path = endpoint.oauth_authorize_path() if authorize else endpoint.oauth_token_path()
        if ctx.request.path != expected_path:
            raise ValueError(
                f"{_ERROR_PREFIX} request path is not an OAuth facade path for endpoint kind {_quote(kind)}"
            )
        return _resolve(next_handler(ctx))

    return handler


def _checked_register_handler(kind: str, next_handler: Handler) -> Handler:
    def handler(ctx: Context) -> Response:
        endpoint = _endpoint_from_route_params(ctx, kind)
        expected_path = endpoint.oauth_register_path()
        if ctx.request.path != expected_path:
            raise ValueError(
                f"{_ERROR_PREFIX} request path is not a registration path for endpoint kind {_quote(kind)}"
            )
        return _resolve(next_handler(ctx))

    return handler


def _with_bearer_assertion(options: RequireBearerTokenOptions, next_handler: Handler) -> Handler:
    middleware = require_bearer_token_middleware(options)

    def handler(ctx: Context) -> Response:
        return _resolve(middleware(ctx, lambda inner: _resolve(next_handler(inner))))

    return handler


def _protected_resource_handler(config: _NormalizedConfig, kind: str) -> Handler:
    def build(ctx: Context) -> Response:
        endpoint = _endpoint_from_protected_resource_request(ctx)
        if endpoint.kind != kind:
            raise ValueError(f"{_ERROR_PREFIX} protected-resource path does not identify endpoint kind {_quote(kind)}")
        resource_url = _build_absolute_url(config, ctx, endpoint.mcp_path())
        authorization_servers = [resource_url] if config.issuer_mode == ISSUER_MODE_ROUTE else [config.issuer_url]
        document: dict[str, Any] = {
            "resource": resource_url,
            "authorization_servers": list(authorization_servers),
        }
        if config.jwks_uri:
            document["jwks_uri"] = config.jwks_uri
        scopes = config.scopes[kind]
        if scopes:
            document["scopes_supported"] = list(scopes)
        return _with_metadata_headers(lambda _ctx, _document=document: _metadata_response(_document))(ctx)

    return _serve_metadata(build)


def _authorization_server_handler(config: _NormalizedConfig, kind: str) -> Handler:
    def build(ctx: Context) -> Response:
        endpoint = _endpoint_from_discovery_request(ctx, kind)
        authorize_url = _build_absolute_url(config, ctx, endpoint.oauth_authorize_path())
        token_url = _build_absolute_url(config, ctx, endpoint.oauth_token_path())
        issuer, registration_endpoint = _routed_issuer_and_registration(config, ctx, endpoint)
        document: dict[str, Any] = {
            "issuer": issuer,
            "authorization_endpoint": authorize_url,
            "token_endpoint": token_url,
            "registration_endpoint": registration_endpoint,
            "jwks_uri": config.jwks_uri,
            "response_types_supported": list(config.capabilities.response_types or []),
            "grant_types_supported": list(config.capabilities.grant_types or []),
            "token_endpoint_auth_methods_supported": list(config.capabilities.token_endpoint_auth_methods or []),
            "code_challenge_methods_supported": list(config.capabilities.code_challenge_methods or []),
            "scopes_supported": list(config.scopes[kind]),
        }
        return _with_metadata_headers(lambda _ctx, _document=document: _metadata_response(_document))(ctx)

    return _serve_metadata(build)


def _serve_metadata(build: Callable[[Context], Response]) -> Handler:
    """Render a metadata request-origin failure as its HTTP 400 response."""

    def handler(ctx: Context) -> Response:
        try:
            return build(ctx)
        except Exception as err:
            response = _metadata_request_failure(err)
            if response is not None:
                return response
            raise

    return handler


def _routed_issuer_and_registration(config: _NormalizedConfig, ctx: Context, endpoint: EndpointPath) -> tuple[str, str]:
    """Return the issuer and registration endpoint the routed RFC 8414 document
    advertises.

    In route issuer mode the route URL is the issuer and the registration
    endpoint is the route's own derived /register path, so the advertised URL
    and the mounted route cannot drift.
    """
    if config.issuer_mode != ISSUER_MODE_ROUTE:
        return config.issuer_url, config.registration_endpoint_url
    return (
        _build_absolute_url(config, ctx, endpoint.mcp_path()),
        _build_absolute_url(config, ctx, endpoint.oauth_register_path()),
    )


def _endpoint_from_mcp_request(ctx: Context | None) -> EndpointPath:
    if ctx is None:
        raise ValueError(f"{_ERROR_PREFIX} request context is required")
    return parse_mcp_path(ctx.request.path)


def _endpoint_from_protected_resource_request(ctx: Context | None) -> EndpointPath:
    if ctx is None:
        raise ValueError(f"{_ERROR_PREFIX} request context is required")
    resource_path = resource_path_from_protected_resource_path(ctx.request.path)
    return parse_mcp_path(resource_path)


def _endpoint_from_discovery_request(ctx: Context | None, kind: str) -> EndpointPath:
    if ctx is None:
        raise ValueError(f"{_ERROR_PREFIX} request context is required")
    endpoint = _endpoint_from_route_params(ctx, kind)
    canonical_path = endpoint.oauth_authorization_server_path()
    suffix_path = endpoint.oauth_authorization_server_suffix_path()
    if ctx.request.path != canonical_path and ctx.request.path != suffix_path:
        raise ValueError(f"{_ERROR_PREFIX} request path is not a discovery path for endpoint kind {_quote(kind)}")
    return endpoint


def _endpoint_from_route_params(ctx: Context | None, kind: str) -> EndpointPath:
    if ctx is None:
        raise ValueError(f"{_ERROR_PREFIX} request context is required")
    candidate = EndpointPath(
        kind=kind,
        client_namespace=ctx.param(PARAM_CLIENT_NAMESPACE),
        partner_id=ctx.param(PARAM_PARTNER_ID),
        agent_id=ctx.param(PARAM_AGENT_ID),
    )
    return parse_mcp_path(candidate.mcp_path())


def _build_absolute_url(config: _NormalizedConfig, ctx: Context | None, route_path: str) -> str:
    base_url = config.public_base_url
    if config.url_mode == URL_MODE_REQUEST_HOST:
        if ctx is None:
            raise _MetadataRequestError("request context is required for request-host URL mode")
        normalized = normalize_request_origin(origin_url(ctx.request.headers))
        if normalized is None:
            raise _MetadataRequestError("request host is missing or unsafe")
        base_url = normalized
        origin = _parse_absolute_url(base_url)
        if origin is None:
            raise ValueError(f"{_ERROR_PREFIX} normalized request origin is invalid")
        if origin.host not in config.allowed_hostnames:
            raise _MetadataRequestError("request host is not allowlisted")
    absolute = _absolute_url_for_path(base_url, route_path)
    if absolute is None:
        raise ValueError(f"{_ERROR_PREFIX} cannot build absolute URL for route path {_quote(route_path)}")
    return absolute


def _metadata_request_failure(err: Exception) -> Response | None:
    if not isinstance(err, _MetadataRequestError):
        return None
    return normalize_response(
        Response(
            status=400,
            headers={
                "cache-control": ["no-store"],
                "content-type": ["application/json; charset=utf-8"],
                "vary": [METADATA_VARY_HEADER],
            },
            cookies=[],
            body=_METADATA_REQUEST_BODY,
            is_base64=False,
        )
    )


def _metadata_response(document: dict[str, Any]) -> Response:
    # Go marshals the document with json.Marshal, which emits compact JSON in
    # struct-field order. The framework ``json()`` helper sorts keys and would
    # not match, so the ordered document is serialized here verbatim.
    serialized = jsonlib.dumps(document, ensure_ascii=False, separators=(",", ":"))
    # Go's encoding/json HTML-escapes these characters, so replace them here to
    # keep the metadata document bytes identical across the Go/TS/Py runtimes.
    serialized = (
        serialized.replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )
    body = serialized.encode("utf-8")
    return normalize_response(
        Response(
            status=200,
            headers={"content-type": ["application/json; charset=utf-8"]},
            cookies=[],
            body=body,
            is_base64=False,
        )
    )


def _with_metadata_headers(next_handler: Callable[[Context], Response]) -> Callable[[Context], Response]:
    def handler(ctx: Context) -> Response:
        response = next_handler(ctx)
        if response is None:
            return response
        headers = response.headers if response.headers is not None else {}
        headers["cache-control"] = ["no-store"]
        headers["vary"] = [METADATA_VARY_HEADER]
        response.headers = headers
        return response

    return handler


# ---------------------------------------------------------------------------
# URL helpers (mirroring the Go facade's url normalization)
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _ParsedURL:
    scheme: str
    host: str  # host without userinfo, as given (trailing dot and case preserved)
    hostname: str  # host without brackets, as given
    # Host and hostname percent-decoded into byte strings (one Latin-1 code
    # point per decoded byte), mirroring Go's decoded ``url.URL.Host`` and
    # ``url.URL.Hostname()``. Re-encoding goes through ``_encode_host_bytes``.
    decoded_host: str
    decoded_hostname: str
    port: str
    # Percent-decoded path as a byte string (one Latin-1 code point per decoded
    # byte), mirroring Go's decoded ``url.URL.Path``. Re-encoding goes through
    # ``_encode_path_bytes``, never through the input text.
    path: str
    search: str  # raw query including the leading "?", as given
    hash: str  # raw fragment including the leading "#", or "" when empty/absent
    has_user: bool


_SCHEME_PATTERN = re.compile(r"^([A-Za-z][A-Za-z0-9+.-]*):")
_PORT_PATTERN = re.compile(r"^\d+$")
_HEX_PAIR_PATTERN = re.compile(r"^[0-9A-Fa-f]{2}$")
_HEX_DIGIT_PATTERN = re.compile(r"[0-9A-Fa-f]")
_DECIMAL_FIELD_PATTERN = re.compile(r"^[0-9]{1,3}$")


# UTF-8 bytes that Go's ``net/url`` ``encodePath`` leaves unescaped.
_PATH_LITERAL_BYTES = frozenset(
    (
        *range(0x30, 0x3A),
        *range(0x41, 0x5B),
        *range(0x61, 0x7B),
        *(ord(char) for char in "-._~$&+,/:;=@"),
    )
)

# ASCII bytes that Go's ``net/url`` leaves unescaped in a reg-name host.
_HOST_LITERAL_BYTES = frozenset(
    (
        *range(0x30, 0x3A),
        *range(0x41, 0x5B),
        *range(0x61, 0x7B),
        *(ord(char) for char in "!$&'()*+,;=:[]<>\"-._~"),
    )
)


def _contains_control_byte(value: str) -> bool:
    """True when the text carries a C0 control byte or DEL, which Go's ``net/url`` rejects."""
    return any(ord(char) < 0x20 or ord(char) == 0x7F for char in value)


def _valid_host_bytes(host: str) -> bool:
    """Mirror Go's ``url.Parse`` host validation (``unescape(host, encodeHost)``).

    A malformed percent escape, or an ASCII byte outside the reg-name set, fails
    the whole parse. Bytes above 0x7f and the redundant ``%25`` escape pass.
    """
    index = 0
    length = len(host)
    while index < length:
        if host[index] == "%":
            if index + 2 >= length:
                return False
            hex_digits = host[index + 1 : index + 3]
            if _HEX_PAIR_PATTERN.match(hex_digits) is None:
                return False
            if int(hex_digits, 16) < 0x80 and host[index : index + 3] != "%25":
                return False
            index += 3
            continue
        code = ord(host[index])
        if code < 0x80 and code not in _HOST_LITERAL_BYTES:
            return False
        index += 1
    return True


def _decode_path_bytes(raw_path: str) -> str | None:
    """Percent-decode a raw path into a byte string, or None on a bad escape.

    Mirrors Go's ``url.Parse``, which fails the whole parse on a malformed
    escape such as ``%zz``.
    """
    decoded = bytearray()
    segment: list[str] = []
    index = 0
    while index < len(raw_path):
        char = raw_path[index]
        if char != "%":
            segment.append(char)
            index += 1
            continue
        hex_digits = raw_path[index + 1 : index + 3]
        if len(hex_digits) != 2 or _HEX_PAIR_PATTERN.match(hex_digits) is None:
            return None
        if segment:
            decoded.extend("".join(segment).encode("utf-8"))
            segment = []
        decoded.append(int(hex_digits, 16))
        index += 3
    if segment:
        decoded.extend("".join(segment).encode("utf-8"))
    return decoded.decode("latin-1")


def _encode_path_bytes(path: str) -> str:
    """Escape a byte-string path with Go's ``encodePath`` rule (uppercase hex)."""
    encoded: list[str] = []
    for byte in path.encode("latin-1"):
        if byte in _PATH_LITERAL_BYTES:
            encoded.append(chr(byte))
        else:
            encoded.append(f"%{byte:02X}")
    return "".join(encoded)


def _utf8_sequence_length(byte: int) -> int:
    """Width of a UTF-8 lead byte, or 0 when the byte cannot start a sequence."""
    if byte < 0x80:
        return 1
    if 0xC2 <= byte <= 0xDF:
        return 2
    if 0xE0 <= byte <= 0xEF:
        return 3
    if 0xF0 <= byte <= 0xF4:
        return 4
    return 0


def _decode_utf8_lenient(value: str) -> str:
    """Decode a byte string the way Go's ``for range`` does.

    A valid UTF-8 sequence becomes its rune; every invalid byte becomes one
    U+FFFD, which is what ``strings.ToLower`` then sees.
    """
    raw = value.encode("latin-1")
    out: list[str] = []
    index = 0
    while index < len(raw):
        byte = raw[index]
        if byte < 0x80:
            out.append(chr(byte))
            index += 1
            continue
        size = _utf8_sequence_length(byte)
        if size > 1 and index + size <= len(raw):
            try:
                out.append(raw[index : index + size].decode("utf-8"))
                index += size
                continue
            except UnicodeDecodeError:
                pass
        out.append("\ufffd")
        index += 1
    return "".join(out)


def _lowercase_host_bytes(value: str) -> str:
    """Lowercase a decoded host byte string the way Go's ``strings.ToLower`` does."""
    return _decode_utf8_lenient(value).lower().encode("utf-8").decode("latin-1")


def _decode_host_bytes(host: str) -> str:
    """Percent-decode a raw host into a byte string, mirroring Go's ``unescape(host, encodeHost)``.

    The caller has already checked the escapes with :func:`_valid_host_bytes`.
    """
    decoded = _decode_path_bytes(host)
    return "" if decoded is None else decoded


def _encode_host_bytes(host: str) -> str:
    """Escape a byte-string host with Go's ``encodeHost`` rule (uppercase hex).

    Literal host bytes pass through; a literal percent and every UTF-8 byte are
    re-encoded, so ``%c3%a9`` becomes ``%C3%A9``.
    """
    encoded: list[str] = []
    for byte in host.encode("latin-1"):
        if byte < 0x80 and byte in _HOST_LITERAL_BYTES:
            encoded.append(chr(byte))
        else:
            encoded.append(f"%{byte:02X}")
    return "".join(encoded)


def _split_path_search_hash(rest: str) -> tuple[str, str, str] | None:
    """Split a path from its raw query and fragment, decoding the path bytes.

    Returns ``(path, search, hash_value)`` where ``search`` and ``hash_value``
    keep their leading delimiters, or None when the path carries a malformed
    percent escape. A bare trailing "#" is an empty fragment, matching Go.
    """
    hash_value = ""
    hash_index = rest.find("#")
    if hash_index >= 0:
        fragment = rest[hash_index + 1 :]
        hash_value = "" if fragment == "" else rest[hash_index:]
        rest = rest[:hash_index]
    search = ""
    query_index = rest.find("?")
    if query_index >= 0:
        search = rest[query_index:]
        rest = rest[:query_index]
    path = _decode_path_bytes(rest)
    if path is None:
        return None
    return path, search, hash_value


def _valid_ipv4_quad(text: str) -> bool:
    """Mirror Go's ``parseIPv4Fields`` for the dotted quad embedded in an IPv6 literal."""
    parts = text.split(".")
    if len(parts) != 4:
        return False
    for part in parts:
        if _DECIMAL_FIELD_PATTERN.match(part) is None:
            return False
        if len(part) > 1 and part.startswith("0"):
            return False
        if int(part) > 255:
            return False
    return True


def _ipv6_group_length(text: str) -> int:
    """Number of leading hex digits, or 0 when the text does not start with one."""
    digits = 0
    while digits < len(text) and _HEX_DIGIT_PATTERN.match(text[digits]) is not None:
        digits += 1
    return digits


def _valid_ipv6_embedded_ipv4(remainder: str, bits: int, ellipsis: int) -> bool:
    """Validate the dotted quad that replaces the final two 16-bit fields."""
    if ellipsis < 0 and bits != 12:
        return False
    if bits + 4 > 16:
        return False
    return _valid_ipv4_quad(remainder)


def _ipv6_address_is_complete(bits: int, remainder: str, ellipsis: int) -> bool:
    """Mirror the tail of netip's parser: no leftover text, and ``::`` expands to a zero field."""
    if remainder != "":
        return False
    if bits < 16:
        return ellipsis >= 0
    return ellipsis < 0


def _valid_ipv6_address(text: str) -> bool:
    """True when ``text`` is a bare IPv6 literal, mirroring ``netip.ParseAddr``.

    This is the address grammar RFC 3986 allows between square brackets; a zone
    identifier is stripped by the caller.
    """
    if text == "":
        return False
    remainder = text
    ellipsis = -1
    if remainder.startswith("::"):
        ellipsis = 0
        remainder = remainder[2:]
    bits = 0
    while bits < 16 and remainder != "":
        digits = _ipv6_group_length(remainder)
        if digits == 0 or digits > 4:
            return False
        if digits < len(remainder) and remainder[digits] == ".":
            if not _valid_ipv6_embedded_ipv4(remainder, bits, ellipsis):
                return False
            bits += 4
            remainder = ""
            break
        bits += 2
        remainder = remainder[digits:]
        if remainder == "":
            break
        if remainder[0] != ":":
            return False
        remainder = remainder[1:]
        if remainder == "":
            return False
        if remainder[0] != ":":
            continue
        if ellipsis >= 0:
            return False
        ellipsis = bits
        remainder = remainder[1:]
    return _ipv6_address_is_complete(bits, remainder, ellipsis)


def _valid_bracketed_hostname(raw: str) -> bool:
    """Mirror ``net/url``'s IP-literal rule.

    The text between square brackets must be an IPv6 address, optionally with a
    ``%25``-escaped zone identifier.
    """
    zone = raw.find("%25")
    if zone < 0:
        return _valid_ipv6_address(raw)
    return raw[zone + 3 :] != "" and _valid_ipv6_address(raw[:zone])


def _split_host_port(hostport: str) -> tuple[str, str] | None:
    """Split a host authority into ``(hostname, port)``, mirroring Go's host parse.

    Rejects a malformed IPv6 authority, a bracketed host that does not hold an
    IPv6 literal, a non-numeric port, and any host byte Go's ``net/url`` would
    reject (see :func:`_valid_host_bytes`).
    """
    hostname = hostport
    port = ""
    # Go's parseHost rejects any host whose last "[" is not the leading byte, so
    # a stray "[" outside a bracketed IP literal fails the whole parse. A stray
    # "]" is an ordinary reg-name byte and still passes.
    open_bracket = hostport.rfind("[")
    if open_bracket > 0:
        return None
    bracketed = open_bracket == 0
    if bracketed:
        close = hostport.find("]")
        if close < 0:
            return None
        hostname = hostport[1:close]
        after = hostport[close + 1 :]
        if after != "":
            if not after.startswith(":"):
                return None
            port = after[1:]
    else:
        colon = hostport.find(":")
        if colon >= 0:
            hostname = hostport[:colon]
            port = hostport[colon + 1 :]
    if port != "" and _PORT_PATTERN.match(port) is None:
        return None
    if not _valid_host_bytes(hostport):
        return None
    if bracketed and not _valid_bracketed_hostname(hostname):
        return None
    return hostname, port


def _parse_url(raw: str) -> _ParsedURL | None:
    """A minimal absolute-URL parser mirroring the Go facade's url.Parse usage.

    An empty authority (for example ``https:///token``) yields an empty host and
    is rejected by :func:`_parse_absolute_url`.
    """
    trimmed = str(raw or "").strip()
    if trimmed == "":
        return None
    if _contains_control_byte(trimmed):
        return None
    scheme_match = _SCHEME_PATTERN.match(trimmed)
    if scheme_match is None:
        return None
    scheme = scheme_match.group(1).lower()
    rest = trimmed[scheme_match.end() :]

    authority = ""
    if rest.startswith("//"):
        rest = rest[2:]
        end = len(rest)
        for index, char in enumerate(rest):
            if char in "/?#":
                end = index
                break
        authority = rest[:end]
        rest = rest[end:]

    userinfo = ""
    hostport = authority
    at_index = authority.rfind("@")
    if at_index >= 0:
        userinfo = authority[:at_index]
        hostport = authority[at_index + 1 :]

    split_host = _split_host_port(hostport)
    if split_host is None:
        return None
    hostname, port = split_host

    split = _split_path_search_hash(rest)
    if split is None:
        return None
    path, search, hash_value = split

    return _ParsedURL(
        scheme=scheme,
        host=hostport,
        hostname=hostname,
        decoded_host=_decode_host_bytes(hostport),
        decoded_hostname=_decode_host_bytes(hostname),
        port=port,
        path=path,
        search=search,
        hash=hash_value,
        has_user=userinfo != "",
    )


def _parse_absolute_url(raw: str) -> _ParsedURL | None:
    """Mirror the Go helper: a scheme, an authority, and no userinfo."""
    parsed = _parse_url(raw)
    if parsed is None:
        return None
    if parsed.scheme == "" or parsed.hostname == "" or parsed.has_user or parsed.host == "":
        return None
    return parsed


def _canonical_hostname(decoded_hostname: str) -> str:
    """Canonicalize a decoded hostname.

    Go lowercases the decoded host and drops one trailing root dot, then
    re-brackets an IPv6 literal.
    """
    lowered = _lowercase_host_bytes(decoded_hostname)
    if lowered.endswith("."):
        lowered = lowered[:-1]
    if ":" in lowered:
        return f"[{lowered}]"
    return lowered


def _canonical_authority(parsed: _ParsedURL) -> str:
    hostname = _canonical_hostname(parsed.decoded_hostname)
    if hostname == "":
        return ""
    port = parsed.port
    if (parsed.scheme == _HTTPS_SCHEME and port == "443") or (parsed.scheme == _HTTP_SCHEME and port == "80"):
        port = ""
    if port != "":
        return _join_host_port(hostname.removeprefix("[").removesuffix("]"), port)
    return hostname


def _join_host_port(host: str, port: str) -> str:
    if ":" in host:
        return f"[{host}]:{port}"
    return f"{host}:{port}"


def _normalize_https_url(raw: str, issuer: bool) -> str | None:
    parsed = _parse_absolute_url(raw)
    if parsed is None or parsed.scheme != _HTTPS_SCHEME or parsed.hash != "":
        return None
    if issuer and parsed.search != "":
        return None
    authority = _canonical_authority(parsed)
    if authority == "":
        return None
    # Go clears RawPath and re-serializes the decoded path, so ``%41`` becomes ``A``.
    decoded_path = parsed.path.rstrip("/") if issuer else parsed.path
    path = _encode_path_bytes(decoded_path)
    query = "" if issuer else parsed.search
    # Go re-escapes the decoded host, so ``%c3%a9`` becomes ``%C3%A9``.
    return f"{parsed.scheme}://{_encode_host_bytes(authority)}{path}{query}"


def _normalize_public_base_url(raw: str) -> str | None:
    return normalize_request_origin(raw)


def _normalize_allowed_hostname(raw: str) -> str | None:
    value = str(raw or "").strip()
    if value == "" or "/" in value or any(char in value for char in "?#@"):
        return None
    parsed = _parse_url(f"https://{value}")
    if parsed is None or parsed.hostname == "" or parsed.has_user or parsed.search != "" or parsed.hash != "":
        return None
    port = parsed.port
    if port in ("80", "443"):
        hostname = _canonical_hostname(parsed.decoded_hostname)
        return hostname or None
    authority = _canonical_authority(parsed)
    return authority or None


def _absolute_url_for_path(base_url: str, route_path: str) -> str | None:
    parsed = _parse_absolute_url(base_url)
    if parsed is None or not route_path.startswith("/"):
        return None
    # Go keeps the parsed authority's text and re-encodes it from its decoded bytes.
    decoded_path = parsed.path.rstrip("/") + route_path.encode("utf-8").decode("latin-1")
    path = _encode_path_bytes(decoded_path)
    return f"{parsed.scheme}://{_encode_host_bytes(parsed.decoded_host)}{path}"


def normalize_request_origin(raw: str) -> str | None:
    """Validate and canonicalize a request-derived origin.

    Accepts HTTPS, plus HTTP only for loopback hosts, and removes
    scheme-default ports.
    """
    parsed = _parse_absolute_url(raw)
    if parsed is None or parsed.has_user or parsed.hostname == "" or parsed.search != "" or parsed.hash != "":
        return None
    if parsed.path not in ("", "/"):
        return None
    if not _is_allowed_discovery_scheme(parsed.scheme, parsed.hostname):
        return None
    authority = _canonicalize_request_origin_authority(parsed)
    if authority == "":
        return None
    return f"{parsed.scheme}://{authority}"


def _canonicalize_request_origin_authority(parsed: _ParsedURL) -> str:
    hostname = parsed.hostname.lower()
    if hostname.endswith("."):
        hostname = hostname[:-1]
    if hostname == "":
        return ""
    port = parsed.port
    if port == _default_port_for_scheme(parsed.scheme):
        port = ""
    if port != "":
        return _join_host_port(hostname, port)
    if ":" in hostname:
        return f"[{hostname}]"
    return hostname


def _default_port_for_scheme(scheme: str) -> str:
    if scheme == _HTTPS_SCHEME:
        return "443"
    if scheme == _HTTP_SCHEME:
        return "80"
    return ""


def _is_loopback_hostname(host: str) -> bool:
    value = str(host or "").strip().lower()
    if value in ("localhost", "::1"):
        return True
    return value.startswith("127.")


def _is_allowed_discovery_scheme(scheme: str, hostname: str) -> bool:
    return scheme == _HTTPS_SCHEME or (scheme == _HTTP_SCHEME and _is_loopback_hostname(hostname))


def _clone_inventory(inventory: RouteInventory) -> RouteInventory:
    return RouteInventory(
        contract_version=inventory.contract_version,
        routes=[
            FacadeRoute(
                kind=route.kind,
                mcp_pattern=route.mcp_pattern,
                mcp_methods=list(route.mcp_methods),
                protected_resource_pattern=route.protected_resource_pattern,
                discovery_canonical_pattern=route.discovery_canonical_pattern,
                discovery_suffix_pattern=route.discovery_suffix_pattern,
                authorize_pattern=route.authorize_pattern,
                token_pattern=route.token_pattern,
                register_pattern=route.register_pattern,
                authorization_routes_attached=route.authorization_routes_attached,
            )
            for route in inventory.routes
        ],
        root_authorization_server_pattern=inventory.root_authorization_server_pattern,
        root_authorization_server_attached=inventory.root_authorization_server_attached,
        callback_pattern=inventory.callback_pattern,
        issuer_mode=inventory.issuer_mode,
    )


def _quote(value: Any) -> str:
    return jsonlib.dumps(str(value))
