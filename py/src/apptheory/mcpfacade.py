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

import base64
import contextlib
import json as jsonlib
import re
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from typing import Any, cast
from urllib.parse import quote_plus

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
from apptheory.oauth import (
    ERROR_INVALID_GRANT,
    ERROR_REAUTH_REQUIRED,
    ERROR_TEMPORARILY_UNAVAILABLE,
    ERROR_UPSTREAM,
    AuthorizationRequest,
    CodeExchangeRequest,
    Provider,
    ProviderError,
    RefreshRequest,
    RequireBearerTokenOptions,
    Stores,
    TokenExpectations,
    TokenSet,
    canonical_resource_url,
    canonicalize_issuer_url,
    new_pkce_code_verifier,
    pkce_challenge_s256,
    pkce_verify_s256,
    require_bearer_token_middleware,
)
from apptheory.oauth.store import (
    STATUS_ACTIVE,
    STATUS_EXPIRED,
    STATUS_ISSUED,
    STATUS_REVOKED,
    AuthorizationCodeRecord,
    AuthorizationCodeStore,
    BrokerLockedError,
    BrokerRevokedError,
    BrokerVersionConflictError,
    ClientRecord,
    ClientStore,
    RateLimitBucketKey,
    RateLimitStore,
    RouteRefreshBrokerRecord,
    RouteRefreshBrokerStore,
    TransactionRecord,
    TransactionStore,
    hash_key,
)
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

# Status values the front channel writes into the store records it mints.
_FRONT_CHANNEL_TRANSACTION_STATUS_PENDING = "pending"

# Bounds every front-channel POST body before it is parsed. The bound is a
# framework default, deliberately not a FacadeConfig field or an environment
# variable, so no adopter can widen the door; it applies to the raw request
# bytes and a body strictly larger than it fails closed with invalid_request.
# The token endpoint consumes it today and the DCR JSON body will inherit the
# same bound, so the name stays endpoint-neutral.
_FRONT_CHANNEL_MAX_REQUEST_BODY_BYTES = 16384

# The hex digits Go's url.QueryUnescape accepts inside a %XX escape.
_HEX_DIGITS = frozenset("0123456789abcdefABCDEF")

# _FACADE_ERROR_DESCRIPTIONS is the closed, fixed client-facing error vocabulary
# of the front channel (DESIGN section 8). Every rejection of one error code
# carries the same description, so the response never distinguishes an unknown
# key from a used one (THREAT_MODEL cross-cutting: no oracle).
_FACADE_ERROR_DESCRIPTIONS: dict[str, str] = {
    "invalid_client": "the client is not registered",
    "invalid_request": "the request is missing or has an invalid parameter",
    "invalid_target": "the resource is not the resource this route authorizes",
    "invalid_grant": "the grant is invalid, expired, or already used",
    "invalid_scope": "the requested scope is not exactly the granted scope set",
    "unsupported_grant_type": "the grant type is not supported",
    "upstream_error": "the upstream authorization server could not complete the request",
    "temporarily_unavailable": "the token endpoint is temporarily unavailable",
}

# The brokered refresh framework defaults (DESIGN section 8.4 mechanic 4,
# THREAT_MODEL T6, operator ruling R3). Every value is a framework constant:
# deliberately not a ``FacadeConfig`` field and not an environment variable, so
# no adopter can widen the door and Go, TypeScript, and Python can only agree on
# one number set. Each value is pinned by a test.
#
# _FRONT_CHANNEL_MAX_REFRESH_HANDLE_BYTES bounds the presented route handle in
# bytes, checked before any other work. The framework mints a handle as 32 random
# bytes (43 base64url characters), so 512 is far above every legitimate handle
# while still bounding an unauthenticated caller's payload.
_FRONT_CHANNEL_MAX_REFRESH_HANDLE_BYTES = 512

# _REFRESH_GRACE_WINDOW_SECONDS is how long the successor token response is
# replayed to a client that presents the rotated (previous) handle. It is the
# lost-response window of ruling R2: a client whose 200 never arrived replays the
# same request and receives byte-identical successor tokens instead of provoking
# a second upstream call. It is measured on the injected framework clock.
_REFRESH_GRACE_WINDOW_SECONDS = 30

# _REFRESH_COALESCE_WAIT_CAP_SECONDS bounds how long a caller that lost the
# refresh lock race waits for the winner's rotation before being told to retry.
# It is the operational backpressure bound of ruling R2 and is deliberately
# shorter than the broker's lock TTL (``UTC_NOW_LOCK_TTL_SECONDS``, 15 s), so a
# waiter can never outlive the lock it is waiting on and steal it.
_REFRESH_COALESCE_WAIT_CAP_SECONDS = 3.0

# _REFRESH_COALESCE_POLL_INTERVAL_SECONDS is how often a waiter re-reads the
# broker record while the lock is held. It is the granularity of the wait, not a
# security decision, and it only has to be small enough that a completed rotation
# is observed well inside the wait cap.
_REFRESH_COALESCE_POLL_INTERVAL_SECONDS = 0.05

# _REFRESH_REVOKE_CHAIN_LIMIT bounds the reuse-detection revoke walk of ruling
# R1.4: the walk follows the successor handle each revoked record names, so the
# limit is what keeps a crafted or cyclic stored value from looping. The real
# chain of one facade-opened grant is one link.
_REFRESH_REVOKE_CHAIN_LIMIT = 8

# _REFRESH_RETRY_AFTER_SECONDS is the fixed Retry-After the refresh 503 class
# carries. Unlike the registration endpoint there is no rate-limit window to
# derive a delay from: the caller was refused either because another caller holds
# the in-flight lock or because a store could not answer, and both are worth
# exactly one second of backoff.
_REFRESH_RETRY_AFTER_SECONDS = 1

# The RFC 7636 S256 challenge alphabet (base64url) and the one length the shape
# check accepts.
_S256_CHALLENGE_ALPHABET = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
_S256_CHALLENGE_LENGTH = 43

# RFC 8252 section 7.3 loopback hosts whose ephemeral port may vary.
_LOOPBACK_HOSTS = frozenset(("127.0.0.1", "::1", "localhost"))

# RFC 7591 DCR framework defaults (DESIGN section 8.3 / THREAT_MODEL T5). They
# are constants, so no adopter can widen the public registration door with a
# FacadeConfig field or an environment variable: every POST /register decision
# is bounded by these fixed values.
#
# _DCR_RATE_LIMIT is the per-route registration budget of one rate-limit window.
# It is deliberately small: a legitimate client registers once, so a caller that
# needs more is abusing the endpoint. The window matches the reference store's
# own default window. _DCR_MAX_REDIRECT_URIS bounds the redirect URI list one
# client may register: a metadata-list bound, not a redirect policy, because each
# entry still has to pass the https-or-loopback rule. _DCR_MAX_CLIENT_NAME_BYTES
# and _DCR_MAX_SCOPE_BYTES bound the two free-text metadata members in UTF-8
# bytes; both are stored for display only and never parsed.
_DCR_RATE_LIMIT = 10
_DCR_RATE_LIMIT_WINDOW_SECONDS = 60
_DCR_MAX_REDIRECT_URIS = 10
_DCR_MAX_CLIENT_NAME_BYTES = 256
_DCR_MAX_SCOPE_BYTES = 1024

# Registration vocabulary. These are the only metadata values the framework
# accepts, so a port cannot widen them by accident. The two names ruff reads as
# credentials are RFC 7591 metadata values, never secrets.
_DCR_TOKEN_ENDPOINT_AUTH_METHOD_NONE = "none"  # noqa: S105
_DCR_GRANT_TYPE_AUTHORIZATION_CODE = "authorization_code"
_DCR_GRANT_TYPE_REFRESH_TOKEN = "refresh_token"  # noqa: S105
_DCR_RESPONSE_TYPE_CODE = "code"

# _DCR_MEMBERS are the RFC 7591 request members the facade reads. Every other
# JSON member of the body is ignored, exactly as RFC 7591 requires: a client that
# sends a member the facade does not understand still registers.
_DCR_MEMBERS = (
    "redirect_uris",
    "token_endpoint_auth_method",
    "grant_types",
    "response_types",
    "client_name",
    "scope",
)
# _DCR_LIST_MEMBERS are the members that decode as a JSON array of strings.
_DCR_LIST_MEMBERS = ("redirect_uris", "grant_types", "response_types")

# _DCR_OPERATION names the rate-limit operation bucket of the registration
# endpoint in the (identifier, resource, operation) rate-limit key.
_DCR_OPERATION = "dcr"

# _DCR_ANONYMOUS_IDENTIFIER is the shared rate-limit bucket identifier used when
# the runtime exposes no provider-derived source IP. An unidentifiable caller gets
# one shared per-route bucket rather than an unmetered one, which is the stricter
# fail-closed choice (THREAT_MODEL T5). It mirrors the transport middleware's
# anonymous identifier.
_DCR_ANONYMOUS_IDENTIFIER = "anonymous"

# _DCR_ERROR_DESCRIPTIONS is the closed, fixed client-facing error vocabulary of
# the registration endpoint (RFC 7591 section 3.2.2 plus the RFC 6749
# temporary-failure class). Every rejection of one error code carries the same
# description, so the response never distinguishes which metadata member failed
# and cannot be used as an oracle. It is deliberately separate from
# _FACADE_ERROR_DESCRIPTIONS: a client that sees one of these codes knows the
# failure came from registration, not from a token request.
_DCR_ERROR_DESCRIPTIONS: dict[str, str] = {
    "invalid_client_metadata": "the client metadata is missing or has an invalid value",
    "invalid_redirect_uri": "the redirect URI is not allowed for a public client",
    "temporarily_unavailable": "the registration endpoint is temporarily unavailable",
}

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
    # ``provider`` anchors the framework-owned front channel (DESIGN section 8).
    # When it is set, AppTheory owns ``/authorize``, the stage-global upstream
    # callback, and the ``/token`` authorization_code grant, and the rest of the
    # front-channel field set below is required. A ``None`` provider leaves the
    # front channel unowned: an application either supplies its own
    # ``authorize_handler``/``token_handler`` pair and ``callback_handler``, or
    # registers no OAuth surface at all. Setting any other front-channel field
    # without ``provider`` is a registration error.
    provider: Provider | None = None
    # ``stores`` supplies the five facade store SPIs the front channel persists
    # through (DESIGN section 7): transaction, authorization code, client,
    # route-refresh broker, and rate limit. All five are required when
    # ``provider`` is set. Each store owns its own TTL (DESIGN section 7 TTL
    # column), so no TTL is configured here.
    stores: Stores | None = None
    # ``upstream_client_id`` is the facade's own OAuth client registration at
    # the upstream provider (DESIGN section 8.1): the upstream authorize request
    # carries it and the server-side upstream code exchange presents it. It is
    # also the expected azp/client_id of an upstream access token the facade
    # validates (DESIGN section 5.2, section 6), so a token minted for another
    # client is refused.
    upstream_client_id: str = ""
    # ``upstream_issuer`` is the expected upstream issuer: the RFC 9207 ``iss``
    # value the upstream callback pins before consuming the transaction or
    # exchanging the code (DESIGN section 8.2) and the issuer the provider's
    # ``discovery`` call must verify before any published endpoint is trusted
    # (DESIGN section 5.2, section 6). It must be an absolute HTTPS URL with no
    # query or fragment, normalized like ``issuer_url``, and it is distinct from
    # the client-facing issuer.
    upstream_issuer: str = ""
    # ``lifecycle_scopes`` are scope values the facade adds to every upstream
    # authorize request but never requires from the MCP client, for example the
    # ``offline_access`` lifecycle scope that lets the upstream issue refresh
    # material (FRAMEWORK_VS_POLICY row 7). ``None`` adds none. Values are
    # validated like ``scopes``: trimmed, non-empty, and well-formed Unicode.
    lifecycle_scopes: list[str] | None = None
    # ``provider_hints`` supplies the opaque provider hints for one authorize
    # request (DESIGN section 6): it receives the request context and returns
    # the hint map, for example the ``account_id`` hint. A hint carries no
    # authority: the provider derives authentication account context from its
    # own validated binding, not from the hint (DESIGN section 6).
    provider_hints: Callable[[Context], dict[str, str]] | None = None


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
class _FrontChannelStores:
    """The five store SPIs the front channel drives, each narrowed to non-None.

    The front channel validates the full set at registration, so it drives them
    without per-call None checks.
    """

    transaction: TransactionStore
    authorization_code: AuthorizationCodeStore
    client: ClientStore
    route_refresh_broker: RouteRefreshBrokerStore
    rate_limit: RateLimitStore


@dataclass(slots=True)
class _FrontChannelConfig:
    """The validated front-channel field set of :class:`FacadeConfig`
    (DESIGN section 8): the provider adapter and stores the front channel drives,
    the facade's own upstream client, the expected upstream issuer, the
    injectable lifecycle scopes, and the opaque provider-hint seam.
    """

    provider: Provider
    stores: _FrontChannelStores
    upstream_client_id: str
    upstream_issuer: str
    lifecycle_scopes: list[str]
    provider_hints: Callable[[Context], dict[str, str]] | None


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
    front_channel: _FrontChannelConfig | None = None


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
    normalized.front_channel = _normalize_front_channel(config)
    _validate_posture_surface_config(
        transport_posture,
        normalized.authorize_handlers,
        normalized.register_handlers,
        normalized.callback_handler,
        normalized.root_authorization_server,
        normalized.front_channel is not None,
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
    front_channel: bool,
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
    if front_channel:
        raise ValueError(
            f"{_ERROR_PREFIX} TransportPosture none-public registers no OAuth surface; "
            "the front-channel field set must not be configured"
        )
    if root_authorization_server is not None:
        raise ValueError(f"{_ERROR_PREFIX} TransportPosture none-public cannot enable RootAuthorizationServer")


def _normalize_front_channel(config: FacadeConfig) -> _FrontChannelConfig | None:
    """Validate the framework-owned front-channel field set of ``FacadeConfig``
    (DESIGN section 8) and return it.

    The set is declared by ``provider``: when it is set, every other required
    front-channel field must be present and the application-owned handler
    factories that would otherwise claim the same routes must be absent. A
    ``None`` result means the front channel is not declared: the application
    either owns the OAuth surface through its handler factories or registers
    none.
    """
    if config.provider is None:
        name = _front_channel_field_outside_provider(config)
        if name is not None:
            raise ValueError(
                f"{_ERROR_PREFIX} {name} is set without Provider; the front-channel field set is anchored by Provider"
            )
        return None
    upstream_issuer = _normalize_https_url(config.upstream_issuer or "", True)
    if upstream_issuer is None:
        raise ValueError(
            f"{_ERROR_PREFIX} front channel upstream issuer must be an absolute HTTPS URL without query or fragment"
        )
    if not _valid_upstream_client_id(config.upstream_client_id or ""):
        raise ValueError(f"{_ERROR_PREFIX} front channel upstream client id is required and must be well-formed")
    if config.lifecycle_scopes:
        try:
            _normalize_non_empty_list("lifecycle scope", config.lifecycle_scopes)
        except ValueError as err:
            raise ValueError(f"{_ERROR_PREFIX} {err}") from err
    stores = _require_front_channel_stores(config.stores)
    if config.authorize_handler is not None or config.token_handler is not None:
        raise ValueError(
            f"{_ERROR_PREFIX} Provider owns the authorize and token routes; "
            "AuthorizeHandler and TokenHandler must not be configured with a front channel"
        )
    if config.register_handler is not None:
        raise ValueError(
            f"{_ERROR_PREFIX} Provider owns the register route; "
            "RegisterHandler must not be configured with a front channel"
        )
    if config.callback_handler is not None:
        raise ValueError(
            f"{_ERROR_PREFIX} Provider owns the stage-global callback; "
            "CallbackHandler must not be configured with a front channel"
        )
    return _FrontChannelConfig(
        provider=config.provider,
        stores=stores,
        upstream_client_id=(config.upstream_client_id or "").strip(),
        upstream_issuer=upstream_issuer,
        lifecycle_scopes=list(config.lifecycle_scopes or []),
        provider_hints=config.provider_hints,
    )


def _front_channel_field_outside_provider(config: FacadeConfig) -> str | None:
    """Return the first front-channel field set while ``provider`` is absent, so
    a partially configured front channel fails closed instead of half-registering.
    """
    if _front_channel_store_is_declared(config.stores):
        return "Stores"
    if (config.upstream_client_id or "").strip() != "":
        return "UpstreamClientID"
    if (config.upstream_issuer or "").strip() != "":
        return "UpstreamIssuer"
    if config.lifecycle_scopes:
        return "LifecycleScopes"
    if config.provider_hints is not None:
        return "ProviderHints"
    return None


def _front_channel_store_is_declared(stores: Stores | None) -> bool:
    if stores is None:
        return False
    return (
        stores.transaction is not None
        or stores.authorization_code is not None
        or stores.client is not None
        or stores.route_refresh_broker is not None
        or stores.rate_limit is not None
    )


def _require_front_channel_stores(stores: Stores | None) -> _FrontChannelStores:
    """Require every one of the five store SPIs DESIGN section 7 defines: a
    facade missing a store cannot persist the state its mechanics depend on, so
    it fails closed rather than degrading.
    """
    if stores is None:
        raise ValueError(
            f"{_ERROR_PREFIX} front channel requires all five stores; "
            "missing Transaction, AuthorizationCode, Client, RouteRefreshBroker, RateLimit"
        )
    missing = [
        name
        for name, value in (
            ("Transaction", stores.transaction),
            ("AuthorizationCode", stores.authorization_code),
            ("Client", stores.client),
            ("RouteRefreshBroker", stores.route_refresh_broker),
            ("RateLimit", stores.rate_limit),
        )
        if value is None
    ]
    if missing:
        raise ValueError(f"{_ERROR_PREFIX} front channel requires all five stores; missing {', '.join(missing)}")
    # Every field is proven non-None by the missing-store check above; the casts
    # carry that proof, which a list comprehension cannot express.
    return _FrontChannelStores(
        transaction=cast("TransactionStore", stores.transaction),
        authorization_code=cast("AuthorizationCodeStore", stores.authorization_code),
        client=cast("ClientStore", stores.client),
        route_refresh_broker=cast("RouteRefreshBrokerStore", stores.route_refresh_broker),
        rate_limit=cast("RateLimitStore", stores.rate_limit),
    )


def _valid_upstream_client_id(client_id: str) -> bool:
    """Report whether an upstream client id is usable: a non-empty,
    well-formed value. It is a registration identifier, not a secret.
    """
    value = (client_id or "").strip()
    if value == "" or "\x00" in value:
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


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
        if config.front_channel is not None:
            authorize_handler = _front_channel_authorize_handler(config, route.kind)
            token_handler = _front_channel_token_handler(config, route.kind)
            registrations.append(
                _RouteRegistration(
                    "GET",
                    route.authorize_pattern,
                    _checked_oauth_facade_handler(route.kind, True, authorize_handler),
                    False,
                )
            )
            registrations.append(
                _RouteRegistration(
                    "POST",
                    route.token_pattern,
                    _checked_oauth_facade_handler(route.kind, False, token_handler),
                    False,
                )
            )
            # The RFC 7591 registration route is part of the front channel, so it
            # follows the same posture-derived mount: it is never reached under
            # the none-public posture, where nothing of the OAuth surface
            # registers.
            registrations.append(
                _RouteRegistration(
                    "POST",
                    route.register_pattern,
                    _checked_register_handler(route.kind, _front_channel_register_handler(config, route.kind)),
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
    if inventory.callback_pattern != "" and config.front_channel is not None:
        registrations.append(
            _RouteRegistration("GET", inventory.callback_pattern, _front_channel_callback_handler(config), False)
        )

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
        try:
            value.encode("utf-8")
        except UnicodeEncodeError as err:
            raise ValueError(f"{label} values must be well-formed Unicode") from err
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
        if _request_host_allowlist_key(origin) not in config.allowed_hostnames:
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


def _require_metadata_failure(err: _MetadataRequestError) -> Response:
    failure = _metadata_request_failure(err)
    if failure is None:
        raise err
    return failure


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
# Framework-owned front channel (DESIGN section 8)
# ---------------------------------------------------------------------------


def _front_channel_authorize_handler(config: _NormalizedConfig, kind: str) -> Handler:
    def handler(ctx: Context) -> Response:
        return _handle_authorize(config, kind, ctx)

    return handler


def _front_channel_token_handler(config: _NormalizedConfig, kind: str) -> Handler:
    def handler(ctx: Context) -> Response:
        return _handle_token(config, kind, ctx)

    return handler


def _front_channel_register_handler(config: _NormalizedConfig, kind: str) -> Handler:
    """Build the framework-owned per-kind RFC 7591 registration handler. It is
    only called when the front-channel field set is declared, so the route is
    mounted exactly when the facade owns the OAuth surface.
    """

    def handler(ctx: Context) -> Response:
        return _handle_register(config, kind, ctx)

    return handler


def _front_channel_callback_handler(config: _NormalizedConfig) -> Handler:
    def handler(ctx: Context) -> Response:
        return _handle_callback(config, ctx)

    return handler


def _handle_authorize(config: _NormalizedConfig, kind: str, ctx: Context) -> Response:
    """Terminate the client-facing front channel (DESIGN section 8.1): validate
    the registered client and its exact redirect URI before any redirect, require
    S256 PKCE, record a single-use transaction, and send the browser upstream with
    the facade's own client, callback, PKCE verifier, fresh state, resource,
    hints, and clamped scope set.
    """
    try:
        return _handle_authorize_inner(config, kind, ctx)
    except _MetadataRequestError as err:
        return _require_metadata_failure(err)


def _handle_authorize_inner(config: _NormalizedConfig, kind: str, ctx: Context) -> Response:
    front = config.front_channel
    if front is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel is not configured")
    endpoint = _endpoint_from_route_params(ctx, kind)
    resource = _build_absolute_url(config, ctx, endpoint.mcp_path())
    issuer = _front_channel_route_issuer(config, ctx, endpoint)

    # Validation order (DESIGN section 8.1): client, redirect URI, response_type,
    # S256 PKCE, state, resource, scope. Errors raised before the redirect URI is
    # validated render an error page and never redirect.
    client_id = _first_query_value(ctx.request.query, "client_id")
    if client_id.strip() == "":
        return _facade_error_page(400, "invalid_request")
    client = front.stores.client.get(hash_key(client_id))
    if client is None:
        return _facade_error_page(400, "invalid_client")
    # The advertising route resource is the comparison value of the bound-route
    # check: it was resolved above with _build_absolute_url over the route MCP
    # path, the same derivation the registration handler bound the client record
    # with.
    if _client_bound_route_refused(client, resource):
        return _facade_error_page(400, "invalid_client")

    redirect_uri = _first_query_value(ctx.request.query, "redirect_uri")
    if not _registered_redirect_uri(client.redirect_uris, redirect_uri):
        # Open-redirect defense: an unmatched redirect URI never redirects.
        return _facade_error_page(400, "invalid_request")
    client_state = _first_query_value(ctx.request.query, "state")
    if _first_query_value(ctx.request.query, "response_type") != "code":
        return _facade_client_error_redirect(redirect_uri, issuer, client_state, "invalid_request")
    challenge = _first_query_value(ctx.request.query, "code_challenge")
    if _first_query_value(ctx.request.query, "code_challenge_method") != "S256" or not _valid_s256_challenge(challenge):
        return _facade_client_error_redirect(redirect_uri, issuer, client_state, "invalid_request")
    requested_resource = _first_query_value(ctx.request.query, "resource").strip()
    if requested_resource != "" and canonical_resource_url(requested_resource) != resource:
        return _facade_client_error_redirect(redirect_uri, issuer, client_state, "invalid_target")
    scopes, ok = _clamp_requested_scopes(ctx.request.query.get("scope") or [], config.scopes[kind])
    if not ok:
        return _facade_client_error_redirect(redirect_uri, issuer, client_state, "invalid_request")
    upstream_scopes = [*scopes, *front.lifecycle_scopes]

    hints: dict[str, str] = {}
    if front.provider_hints is not None:
        try:
            hints = dict(front.provider_hints(ctx) or {})
        except Exception:  # noqa: BLE001 - a fail-closed request-class rejection that never redirects
            return _facade_error_page(400, "invalid_request")

    upstream_state = _new_opaque_token()
    code_verifier = new_pkce_code_verifier()
    upstream_challenge = pkce_challenge_s256(code_verifier)
    callback_url = _build_absolute_url(config, ctx, config.upstream_callback_path)

    transaction = TransactionRecord(
        state_hash=hash_key(upstream_state),
        client_id_hash=hash_key(client_id),
        client_id=client_id,
        redirect_uri=redirect_uri,
        code_challenge=challenge,
        code_challenge_method="S256",
        client_state=client_state,
        encrypted_upstream_code_verifier=code_verifier,
        scopes=list(scopes),
        canonical_resource=resource,
        endpoint_kind=kind,
        client_namespace=endpoint.client_namespace,
        partner_id=endpoint.partner_id,
        agent_id=endpoint.agent_id,
        status=_FRONT_CHANNEL_TRANSACTION_STATUS_PENDING,
    )
    front.stores.transaction.put(transaction)

    try:
        upstream_url = front.provider.authorization_url(
            AuthorizationRequest(
                upstream_client_id=front.upstream_client_id,
                callback_url=callback_url,
                code_challenge=upstream_challenge,
                code_challenge_method="S256",
                state=upstream_state,
                resource=resource,
                scopes=upstream_scopes,
                hints=hints,
            )
        )
    except Exception:  # noqa: BLE001 - provider failure is the distinct 502 class
        return _facade_upstream_error_page()
    return _facade_upstream_redirect(upstream_url)


def _handle_callback(config: _NormalizedConfig, ctx: Context) -> Response:
    """Complete the upstream leg (DESIGN section 8.2): verify the upstream
    RFC 9207 ``iss`` before consuming the transaction or exchanging the code, so
    an absent or mismatched ``iss`` fails closed without touching state. Any
    provider failure after that is the distinct 502 ``upstream_error`` class,
    never the facade's own 400.
    """
    try:
        return _handle_callback_inner(config, ctx)
    except _MetadataRequestError as err:
        return _require_metadata_failure(err)


def _handle_callback_inner(config: _NormalizedConfig, ctx: Context) -> Response:
    front = config.front_channel
    if front is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel is not configured")
    expected_issuer = canonicalize_issuer_url(front.upstream_issuer)
    if expected_issuer is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel upstream issuer is not canonicalizable")
    claimed_issuer = canonicalize_issuer_url(_first_query_value(ctx.request.query, "iss"))
    if claimed_issuer is None or claimed_issuer != expected_issuer:
        return _facade_error_page(400, "invalid_request")
    code = _first_query_value(ctx.request.query, "code").strip()
    state = _first_query_value(ctx.request.query, "state").strip()
    if code == "" or state == "":
        return _facade_error_page(400, "invalid_request")

    transaction = front.stores.transaction.consume(hash_key(state))
    if transaction is None or transaction.status == STATUS_EXPIRED:
        # An unminted, replayed, and expired state are one response class: the
        # transaction store burns on first consume, so they are indistinguishable
        # and stay indistinguishable on purpose (T10).
        return _facade_error_page(400, "invalid_request")

    callback_url = _build_absolute_url(config, ctx, config.upstream_callback_path)
    try:
        token_set = front.provider.exchange_code(
            CodeExchangeRequest(
                code=code,
                upstream_client_id=front.upstream_client_id,
                callback_url=callback_url,
                code_verifier=transaction.encrypted_upstream_code_verifier,
            )
        )
    except Exception:  # noqa: BLE001 - provider failure is the distinct 502 class
        return _facade_upstream_error_page()
    try:
        claims = front.provider.validate_access_token(
            token_set.access_token,
            TokenExpectations(
                expected_issuer=front.upstream_issuer,
                expected_audience=transaction.canonical_resource,
                allowed_authorized_parties=[front.upstream_client_id],
            ),
        )
    except Exception:  # noqa: BLE001 - provider failure is the distinct 502 class
        return _facade_upstream_error_page()

    handle = _new_opaque_token()
    broker_store = front.stores.route_refresh_broker
    seeder_put = getattr(broker_store, "put", None)
    if not callable(seeder_put):
        raise ValueError(f"{_ERROR_PREFIX} route refresh broker store cannot be seeded")
    broker = RouteRefreshBrokerRecord(
        handle_hash=hash_key(handle),
        issuer=front.upstream_issuer,
        canonical_resource=transaction.canonical_resource,
        client_namespace=transaction.client_namespace,
        endpoint_kind=transaction.endpoint_kind,
        partner_id=transaction.partner_id,
        agent_id=transaction.agent_id,
        client_id_hash=transaction.client_id_hash,
        subject_id_hash=hash_key(claims.subject),
        scopes=list(transaction.scopes),
        scope_fingerprint=_facade_scope_fingerprint(transaction.scopes),
        encrypted_upstream_refresh_token=token_set.refresh_token,
        upstream_refresh_token_hash=hash_key(token_set.refresh_token),
        upstream_client_id=front.upstream_client_id,
        status=STATUS_ISSUED,
    )
    seeder_put(broker)

    facade_code = _new_opaque_token()
    code_record = AuthorizationCodeRecord(
        code_hash=hash_key(facade_code),
        client_id_hash=transaction.client_id_hash,
        client_id=transaction.client_id,
        redirect_uri=transaction.redirect_uri,
        code_challenge=transaction.code_challenge,
        code_challenge_method=transaction.code_challenge_method,
        scopes=list(transaction.scopes),
        canonical_resource=transaction.canonical_resource,
        endpoint_kind=transaction.endpoint_kind,
        client_namespace=transaction.client_namespace,
        partner_id=transaction.partner_id,
        agent_id=transaction.agent_id,
        route_refresh_handle_hash=broker.handle_hash,
        encrypted_route_refresh_handle=handle,
        encrypted_token_response=_encode_token_set(token_set),
        status=STATUS_ISSUED,
    )
    front.stores.authorization_code.put(code_record)

    issuer = _front_channel_route_issuer(
        config,
        ctx,
        EndpointPath(
            kind=transaction.endpoint_kind,
            client_namespace=transaction.client_namespace,
            partner_id=transaction.partner_id,
            agent_id=transaction.agent_id,
        ),
    )
    values: dict[str, list[str]] = {"code": [facade_code], "iss": [issuer]}
    if transaction.client_state != "":
        values["state"] = [transaction.client_state]
    return _facade_client_redirect(transaction.redirect_uri, values)


def _handle_token(config: _NormalizedConfig, kind: str, ctx: Context) -> Response:
    """Serve the token endpoint (DESIGN section 8.4). It owns the
    authorization_code grant and the brokered refresh grant; the refresh grant's
    mechanics live in the block below.
    """
    front = config.front_channel
    if front is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel is not configured")
    try:
        form = _parse_form(ctx.request.body)
    except (UnicodeDecodeError, ValueError):
        return _facade_error_page(400, "invalid_request")
    grant_type = _first_form_value(form, "grant_type")
    if grant_type == "":
        return _facade_error_page(400, "invalid_request")
    if grant_type == "authorization_code":
        try:
            return _handle_authorization_code_grant(config, kind, ctx, form)
        except _MetadataRequestError as err:
            return _require_metadata_failure(err)
    if grant_type == "refresh_token":
        try:
            return _handle_refresh_token_grant(config, kind, ctx, form)
        except _MetadataRequestError as err:
            return _require_metadata_failure(err)
    return _facade_error_page(400, "unsupported_grant_type")


def _handle_authorization_code_grant(
    config: _NormalizedConfig,
    kind: str,
    ctx: Context,
    form: dict[str, list[str]],
) -> Response:
    front = config.front_channel
    if front is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel is not configured")
    code = _first_form_value(form, "code").strip()
    redirect_uri = _first_form_value(form, "redirect_uri")
    verifier = _first_form_value(form, "code_verifier")
    if code == "" or redirect_uri.strip() == "" or verifier.strip() == "":
        return _facade_error_page(400, "invalid_request")
    client_id, failure = _token_client(config, kind, ctx, form)
    if failure is not None:
        return failure
    return _redeem_authorization_code(front, kind, form, code, redirect_uri, verifier, client_id)


def _token_client(
    config: _NormalizedConfig,
    kind: str,
    ctx: Context,
    form: dict[str, list[str]],
) -> tuple[str, Response | None]:
    """Authenticate the public client at the token endpoint: the client id must
    be registered, its record must claim the public auth method, and a record the
    registration handler bound to an advertising route must be presented at that
    same route (DESIGN section 8.3, THREAT_MODEL T5). A missing client id, an
    unknown client, and a route-mismatched client are the same ``invalid_client``
    response, so the response is not an oracle. The route resource is resolved
    before the store read, so an unresolvable request host fails closed for every
    client rather than only for a registered one.
    """
    front = config.front_channel
    if front is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel is not configured")
    client_id = _first_form_value(form, "client_id").strip()
    if client_id == "":
        return "", _facade_error_page(400, "invalid_client")
    endpoint = _endpoint_from_route_params(ctx, kind)
    route_resource = _build_absolute_url(config, ctx, endpoint.mcp_path())
    client = front.stores.client.get(hash_key(client_id))
    if client is None:
        return "", _facade_error_page(400, "invalid_client")
    # Only public clients are registered through the facade; a client record
    # that claims another authentication method fails closed.
    method = str(client.token_endpoint_auth_method or "").strip()
    if method != "" and method != "none":
        return "", _facade_error_page(400, "invalid_client")
    if _client_bound_route_refused(client, route_resource):
        return "", _facade_error_page(400, "invalid_client")
    return client_id, None


def _redeem_authorization_code(
    front: _FrontChannelConfig,
    kind: str,
    form: dict[str, list[str]],
    code: str,
    redirect_uri: str,
    verifier: str,
    client_id: str,
) -> Response:
    result = front.stores.authorization_code.consume(hash_key(code))
    if result is None:
        return _facade_error_page(400, "invalid_grant")
    if result.replayed:
        # T2: a replayed code revokes the broker record it minted, so the
        # refresh handle from that authorization dies with the replay.
        _revoke_replayed_broker(front, result.record)
        return _facade_error_page(400, "invalid_grant")
    if result.expired or result.record is None:
        return _facade_error_page(400, "invalid_grant")
    record = result.record
    if not _code_record_binding_matches(record, client_id, redirect_uri, kind):
        return _facade_error_page(400, "invalid_grant")
    if not _verifier_matches(verifier, record.code_challenge):
        return _facade_error_page(400, "invalid_grant")
    if not _requested_resource_matches(record, _first_form_value(form, "resource")):
        return _facade_error_page(400, "invalid_target")
    token_set = _decode_token_response(record.encrypted_token_response)
    return _facade_token_response(token_set, record.encrypted_route_refresh_handle)


def _revoke_replayed_broker(front: _FrontChannelConfig, record: AuthorizationCodeRecord | None) -> None:
    if record is None or not record.route_refresh_handle_hash:
        return
    with contextlib.suppress(KeyError):
        front.stores.route_refresh_broker.revoke(record.route_refresh_handle_hash)


def _code_record_binding_matches(record: AuthorizationCodeRecord, client_id: str, redirect_uri: str, kind: str) -> bool:
    return (
        record.client_id == client_id
        and record.redirect_uri == redirect_uri
        and record.endpoint_kind == kind
        and record.code_challenge_method == "S256"
    )


def _verifier_matches(verifier: str, challenge: str) -> bool:
    try:
        return pkce_verify_s256(verifier, challenge)
    except ValueError:
        return False


def _requested_resource_matches(record: AuthorizationCodeRecord, requested: str) -> bool:
    value = requested.strip()
    return value == "" or canonical_resource_url(value) == record.canonical_resource


def _decode_token_response(value: str) -> dict[str, Any]:
    try:
        token_set = jsonlib.loads(value)
    except ValueError as err:
        raise ValueError(f"{_ERROR_PREFIX} facade code record does not carry a token response: {err}") from err
    if not isinstance(token_set, dict):
        raise ValueError(f"{_ERROR_PREFIX} facade code record does not carry a token response")
    return token_set


# ---------------------------------------------------------------------------
# Brokered refresh grant (DESIGN section 8.4 mechanic 4)
# ---------------------------------------------------------------------------


def _handle_refresh_token_grant(
    config: _NormalizedConfig,
    kind: str,
    ctx: Context,
    form: dict[str, list[str]],
) -> Response:
    """Serve the brokered refresh half of the token endpoint (DESIGN section 8.4
    mechanic 4, journey step 9). The client presents the framework-minted opaque
    route handle the code exchange returned as ``refresh_token``; the broker
    record that handle is keyed by is the only place upstream refresh material
    lives, and neither that material nor an upstream ``id_token`` can reach the
    client.

    Validation order is ruling R1: cheap local checks first, and neither the lock
    nor the upstream call happens until the request is known valid. Concurrency
    is ruling R2: exactly one upstream refresh call per rotation however many
    callers present the same handle, a bounded wait for a caller that loses the
    lock race, and a thirty-second grace window in which the rotated (previous)
    handle replays the successor tokens byte-for-byte. Ruling R4 binds the
    request's scope and resource, and a handle is additionally bound to the route
    it was minted for (DESIGN section 7: the broker record binds resource, so a
    handle is a route handle).
    """
    front = config.front_channel
    if front is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel is not configured")
    # R1.1: bound the handle before anything else is read. The bound applies to
    # the presented bytes, so an oversized value costs the facade one comparison.
    handle = _first_form_value(form, "refresh_token")
    if handle.strip() == "" or _utf8_byte_length(handle) > _FRONT_CHANNEL_MAX_REFRESH_HANDLE_BYTES:
        return _facade_error_page(400, "invalid_request")
    # R1.2: identify the registered client through the existing token-client
    # check, which already performs the R1.1 client_id requirement (a missing or
    # empty client_id is its own first refusal), the DCR bound-route enforcement,
    # and the public-auth-method check. Its failure is returned verbatim.
    client_id, failure = _token_client(config, kind, ctx, form)
    if failure is not None:
        return failure
    # R1.5 (ruling R4): the bound resource a handle may be redeemed for is the
    # advertising route resource of the request being served — the same
    # derivation the record was bound with at authorize — so a handle minted for
    # one route cannot be redeemed at another. The parameter check of ruling R4
    # alone is not enough, because a request that omits ``resource`` is served as
    # if it asked for the bound resource; comparing the served route closes that.
    endpoint = _endpoint_from_route_params(ctx, kind)
    route_resource = _build_absolute_url(config, ctx, endpoint.mcp_path())
    # R2: the coalesce wait budget is measured with REAL elapsed time
    # (``time.monotonic``), never the framework clock, because the wait has to
    # terminate even when the framework clock is frozen or moved by a caller: it
    # is an operational backpressure bound, not a security decision. Grace,
    # record lifetime, and rotation timestamps all use the injected framework
    # clock (``ctx.now()``), which is what makes them deterministic and testable.
    start = time.monotonic()
    while True:
        record, response = _resolve_refresh_record(front, ctx, form, client_id, handle, route_resource)
        if response is not None:
            return response
        if record is None:  # pragma: no cover - _resolve_refresh_record always pairs one with the other
            return _facade_temporarily_unavailable_page()
        lock_owner = _new_opaque_token()
        try:
            locked = front.stores.route_refresh_broker.acquire_lock(record.handle_hash, lock_owner, record.version)
        except Exception as err:  # noqa: BLE001 - classified by _refresh_lock_failure
            failure, wait = _refresh_lock_failure(err, time.monotonic() - start)
            if failure is not None:
                return failure
            if wait:
                time.sleep(_REFRESH_COALESCE_POLL_INTERVAL_SECONDS)
            continue
        return _rotate_refresh_grant(config, ctx, record, locked)


def _refresh_lock_failure(err: Exception, elapsed: float) -> tuple[Response | None, bool]:
    """Classifies a failed lock acquisition (ruling R2's lock section) and
    returns the response that ends the request, or ``None`` to retry — waiting
    first when the returned bool is true. A held lock and a stale version are
    both retried until the coalesce cap, because the record may already carry the
    winner's completed rotation by the next read; a revoked or missing record is
    the same ``invalid_grant`` every unusable handle gets; and any other store
    failure is the retryable class, because a store that cannot answer the lock
    must not become an unlimited refresh path.
    """
    capped = elapsed >= _REFRESH_COALESCE_WAIT_CAP_SECONDS
    if isinstance(err, BrokerLockedError):
        if capped:
            return _facade_temporarily_unavailable_page(), False
        return None, True
    if isinstance(err, BrokerVersionConflictError):
        if capped:
            return _facade_temporarily_unavailable_page(), False
        return None, False
    if isinstance(err, (BrokerRevokedError, KeyError)):
        return _facade_error_page(400, "invalid_grant"), False
    return _facade_temporarily_unavailable_page(), False


def _resolve_refresh_record(
    front: _FrontChannelConfig,
    ctx: Context,
    form: dict[str, list[str]],
    client_id: str,
    handle: str,
    route_resource: str,
) -> tuple[RouteRefreshBrokerRecord | None, Response | None]:
    """Applies validation steps 3 to 6 of ruling R1 to the presented handle and
    returns the record whose lock may be acquired. A non-``None`` response ends
    the request here, without a lock and without an upstream call.
    """
    # R1.3: read the record the handle is keyed by. A missing record (which also
    # covers one whose local lifetime policy elapsed), a revoked record, a record
    # bound to another client, and a record bound to another route ALL render the
    # SAME invalid_grant body, so the response is never an oracle for which of
    # the four failed -- in particular, a handle redeemed at the wrong route is
    # indistinguishable from a handle that does not exist, which is what keeps
    # the route binding from becoming a handle-existence oracle. A store that
    # cannot answer is the retryable class.
    try:
        record = front.stores.route_refresh_broker.get(hash_key(handle))
    except Exception:  # noqa: BLE001 - a store that cannot answer is the retryable class
        return None, _facade_temporarily_unavailable_page()
    if record is None:
        return None, _facade_error_page(400, "invalid_grant")
    if (
        record.status == STATUS_REVOKED
        or record.client_id_hash != hash_key(client_id)
        or record.canonical_resource != route_resource
    ):
        return None, _facade_error_page(400, "invalid_grant")
    # R1.4 reuse: a non-zero grace deadline that has passed means the handle was
    # already rotated and the window in which the successor response can be
    # replayed has closed, so presenting it is reuse. The whole grant is revoked
    # before the client is told the grant is invalid.
    now = ctx.now()
    if record.grace_expires_at is not None and now >= record.grace_expires_at:
        return None, _revoke_reused_refresh_grant(front, record)
    # R1.5 (ruling R4): scope and resource are validated on EVERY refresh
    # request, including one that will be answered from the grace window, so a
    # request that asks for something other than what the record grants is
    # refused rather than silently served.
    failure = _refresh_request_binding_failure(form, record)
    if failure is not None:
        return None, failure
    # R1.6 grace: the rotation completed inside the window, so the successor
    # response is replayed byte-for-byte. This is the idempotent lost-response
    # path and also how a concurrent waiter is served.
    replay = _refresh_grace_response(record, now)
    if replay is not None:
        return None, replay
    return record, None


def _refresh_request_binding_failure(
    form: dict[str, list[str]],
    record: RouteRefreshBrokerRecord,
) -> Response | None:
    """Applies ruling R4 to one refresh request: a present ``resource`` member
    must canonicalize to the bound resource and a present ``scope`` member must
    fingerprint to exactly the granted scope set. Presence — not emptiness — is
    what triggers a check, so an absent member takes the recorded value
    (allowed), while a present but empty scope is the empty set and is therefore
    refused like any other non-exact set. A requesting-wider-or-subset mode is
    deliberately not built.
    """
    resource_present, resource = _present_form_value(form, "resource")
    if resource_present and canonical_resource_url(resource) != record.canonical_resource:
        return _facade_error_page(400, "invalid_target")
    scope_present, scope = _present_form_value(form, "scope")
    if scope_present and _facade_scope_fingerprint(scope.split()) != record.scope_fingerprint:
        return _facade_error_page(400, "invalid_scope")
    return None


def _present_form_value(form: dict[str, list[str]], name: str) -> tuple[bool, str]:
    """Reports whether the form carries the member at all, and returns its first
    value. ``dict.get`` cannot distinguish an absent member from a present empty
    one here, and ruling R4 needs exactly that distinction.
    """
    values = form.get(name)
    if not values:
        return False, ""
    return True, str(values[0])


def _refresh_grace_response(record: RouteRefreshBrokerRecord, now: datetime) -> Response | None:
    """Renders the stored successor response when the rotation is still inside
    its grace window (ruling R1.6). The body is the exact byte sequence the
    winning caller received, so the replay is byte-identical. A record that
    claims a live grace window but carries no stored response is an internal
    inconsistency: it is answered with the retryable class rather than an empty
    success or a false ``invalid_grant``, and it self-heals when the window
    closes and the request becomes reuse.
    """
    if record.grace_expires_at is None or now >= record.grace_expires_at:
        return None
    if record.encrypted_grace_refresh_response == "":
        return _facade_temporarily_unavailable_page()
    return _refresh_token_page(record.encrypted_grace_refresh_response.encode("utf-8"))


def _rotate_refresh_grant(
    config: _NormalizedConfig,
    ctx: Context,
    presented: RouteRefreshBrokerRecord,
    locked: RouteRefreshBrokerRecord,
) -> Response:
    """Performs the held-lock rotation of ruling R1 step 7. The lock is held when
    this is called, and the returned record is the presented one at version+1
    with status ``refreshing`` and the lock owner and expiry set.
    """
    front = config.front_channel
    if front is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel is not configured")
    # The ONE upstream refresh call of this rotation is made under the lock, with
    # the client that owns the recorded material.
    try:
        upstream = front.provider.refresh(
            RefreshRequest(
                refresh_material=locked.encrypted_upstream_refresh_token,
                upstream_client_id=locked.upstream_client_id,
            )
        )
    except Exception as err:  # noqa: BLE001 - mapped and unwound by _failed_refresh_grant
        return _failed_refresh_grant(config, presented, locked, err)
    handle = _new_opaque_token()
    successor = _successor_broker_record(presented, handle, upstream)
    # The successor response body is the token response the client receives and
    # the body the grace path replays. It carries the upstream access token
    # byte-for-byte and the framework's own handle, and never an id_token or any
    # upstream refresh material.
    body = _successor_token_body(upstream, handle)
    seeder_put = getattr(front.stores.route_refresh_broker, "put", None)
    if not callable(seeder_put):
        # The same fail-closed class the callback's broker seeding raises: a
        # broker store that cannot be seeded cannot hold the successor, so the
        # rotation cannot complete and no successor handle may be handed out.
        raise ValueError(f"{_ERROR_PREFIX} route refresh broker store cannot be seeded")
    seeder_put(successor)
    completed = replace(
        locked,
        encrypted_grace_refresh_response=body.decode("utf-8"),
        grace_expires_at=ctx.now() + timedelta(seconds=_REFRESH_GRACE_WINDOW_SECONDS),
        status=STATUS_ACTIVE,
        refresh_lock_owner="",
        refresh_lock_expires_at=None,
    )
    try:
        front.stores.route_refresh_broker.compare_and_swap(completed, locked.version)
    except Exception:  # noqa: BLE001 - a rotation that did not land is the retryable class
        # The rotation did not land, so the successor handle was never handed to
        # any client. Discard it and fail closed: a success response may never be
        # returned for state that was not persisted. The lock is left to expire,
        # because the compare-and-swap that would release it failed too.
        _discard_refresh_record(front, successor.handle_hash)
        return _facade_temporarily_unavailable_page()
    return _refresh_token_page(body)


def _failed_refresh_grant(
    config: _NormalizedConfig,
    presented: RouteRefreshBrokerRecord,
    locked: RouteRefreshBrokerRecord,
    upstream_error: Exception,
) -> Response:
    """Maps a failed upstream refresh call and unwinds the lock (ruling R1 step
    7's failure section). A terminal provider failure means the recorded upstream
    material is dead, so the presented record is revoked and the client is told
    ``invalid_grant``. Every other failure releases the lock and reports its
    typed response; a failure to release leaves the lock to expire and never
    becomes a success.
    """
    front = config.front_channel
    if front is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel is not configured")
    error_class = ERROR_TEMPORARILY_UNAVAILABLE
    if isinstance(upstream_error, ProviderError):
        error_class = upstream_error.error_class
    if error_class in (ERROR_INVALID_GRANT, ERROR_REAUTH_REQUIRED):
        if not _revoke_broker_record(front, presented.handle_hash):
            # The grant is dead upstream but could not be revoked here, so the
            # client is not told the handle is invalid while it is still live.
            return _facade_temporarily_unavailable_page()
        return _facade_error_page(400, "invalid_grant")
    if error_class == ERROR_UPSTREAM:
        _release_refresh_lock(front, presented, locked)
        return _facade_upstream_error_page()
    # ERROR_TEMPORARILY_UNAVAILABLE, and any provider failure the adapter did not
    # classify: transient by default, so the lock is released and the caller is
    # told to retry.
    _release_refresh_lock(front, presented, locked)
    return _facade_temporarily_unavailable_page()


def _revoke_reused_refresh_grant(front: _FrontChannelConfig, record: RouteRefreshBrokerRecord) -> Response:
    """Revokes the whole grant a reused handle belongs to (ruling R1.4) and
    renders the response. The presented record is revoked first, then every
    successor the chain names. A store failure during the walk is the retryable
    class rather than ``invalid_grant``: the client must not be allowed to act on
    state the facade could not revoke.
    """
    if not _revoke_refresh_chain(front, record):
        return _facade_temporarily_unavailable_page()
    return _facade_error_page(400, "invalid_grant")


def _revoke_refresh_chain(front: _FrontChannelConfig, record: RouteRefreshBrokerRecord) -> bool:
    """Revokes one record and the successors it names. The chain is what a
    rotation leaves behind: each rotated record stores its successor's token
    response, so parsing that response yields the successor handle to revoke
    next. A record that is already gone is not an error (revocation is
    idempotent) and a stored value that does not parse simply ends the walk, so
    the presented record is revoked either way. The walk is bounded by
    ``_REFRESH_REVOKE_CHAIN_LIMIT`` so a crafted or cyclic value can never loop.
    """
    current = record
    for _walked in range(_REFRESH_REVOKE_CHAIN_LIMIT):
        try:
            revoked = front.stores.route_refresh_broker.revoke(current.handle_hash)
        except Exception:  # noqa: BLE001 - a store that cannot revoke is the retryable class
            return False
        if revoked is None:
            return True
        successor_hash = _successor_handle_hash(revoked.encrypted_grace_refresh_response)
        if successor_hash is None:
            return True
        current = RouteRefreshBrokerRecord(handle_hash=successor_hash)
    return True


def _successor_handle_hash(stored: str) -> str | None:
    """Reads the successor handle a rotated record stored as its grace response.
    Only the handle is needed to revoke the successor, so the walk never has to
    read it. An unparseable value, an empty handle, and an oversized one all end
    the walk.
    """
    if stored == "":
        return None
    try:
        payload = jsonlib.loads(stored)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    handle = str(payload.get("refresh_token") or "").strip()
    if handle == "" or _utf8_byte_length(handle) > _FRONT_CHANNEL_MAX_REFRESH_HANDLE_BYTES:
        return None
    return hash_key(handle)


def _revoke_broker_record(front: _FrontChannelConfig, handle_hash: str) -> bool:
    """Revokes one broker record. A record that is already gone is not an error,
    because revocation is idempotent; every other store failure is reported.
    """
    try:
        front.stores.route_refresh_broker.revoke(handle_hash)
    except Exception:  # noqa: BLE001 - a store that cannot revoke is reported
        return False
    return True


def _discard_refresh_record(front: _FrontChannelConfig, handle_hash: str) -> None:
    """Discards a successor record that was persisted but never handed to a
    client. It is best effort: the handle is unreachable, so a failed discard
    only leaves a record nothing can present.
    """
    with contextlib.suppress(Exception):
        front.stores.route_refresh_broker.revoke(handle_hash)


def _release_refresh_lock(
    front: _FrontChannelConfig,
    presented: RouteRefreshBrokerRecord,
    locked: RouteRefreshBrokerRecord,
) -> None:
    """Returns a locked record to the status it had before the lock was taken,
    with the lock cleared, so a caller that failed for a transient reason can try
    again instead of waiting out the lock TTL. It is best effort: a failed release
    leaves the lock to expire, which delays the next attempt but never reports a
    success.
    """
    released = replace(
        locked,
        refresh_lock_owner="",
        refresh_lock_expires_at=None,
        status=presented.status,
    )
    with contextlib.suppress(Exception):
        front.stores.route_refresh_broker.compare_and_swap(released, locked.version)


def _successor_broker_record(
    presented: RouteRefreshBrokerRecord,
    handle: str,
    upstream: TokenSet,
) -> RouteRefreshBrokerRecord:
    """Builds the record the rotated handle is stored under. It carries the
    identity of the presented record unchanged — issuer, stage, resource,
    namespace, endpoint kind, partner, agent, client, subject, scopes, and the
    upstream client — so a handle is never rebound to new identity, and it takes
    the freshly rotated upstream refresh material when the upstream issued one.
    An upstream that rotates nothing leaves the previous material valid (RFC 6749
    section 6), so the presented material is carried forward.
    """
    material = str(upstream.refresh_token or "")
    if material.strip() == "":
        material = presented.encrypted_upstream_refresh_token
    return RouteRefreshBrokerRecord(
        handle_hash=hash_key(handle),
        issuer=presented.issuer,
        stage=presented.stage,
        canonical_resource=presented.canonical_resource,
        client_namespace=presented.client_namespace,
        endpoint_kind=presented.endpoint_kind,
        partner_id=presented.partner_id,
        agent_id=presented.agent_id,
        client_id_hash=presented.client_id_hash,
        subject_id_hash=presented.subject_id_hash,
        scopes=list(presented.scopes),
        scope_fingerprint=presented.scope_fingerprint,
        encrypted_upstream_refresh_token=material,
        upstream_refresh_token_hash=hash_key(material),
        upstream_client_id=presented.upstream_client_id,
        status=STATUS_ISSUED,
    )


def _successor_token_body(upstream: TokenSet, handle: str) -> bytes:
    """Renders the refresh success body: the same payload shape
    ``_facade_token_response`` renders, with the upstream access token
    byte-for-byte unmodified and the framework's successor handle as
    ``refresh_token``. No ``id_token`` and no upstream refresh material is ever
    part of it.
    """
    payload = _facade_token_payload(
        access_token=str(upstream.access_token or ""),
        token_type=str(upstream.token_type or ""),
        expires_in=upstream.expires_in,
        scope=str(upstream.scope or ""),
        refresh_handle=handle,
    )
    return jsonlib.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _refresh_token_page(body: bytes) -> Response:
    """Renders one refresh success with the fixed non-cacheable header set
    ``_facade_token_response`` uses, so the grace replay is byte-identical in
    status, headers, and body to the response the winning caller received.
    """
    return Response(
        status=200,
        headers={
            "content-type": ["application/json; charset=utf-8"],
            "cache-control": ["no-store"],
            "pragma": ["no-cache"],
        },
        cookies=[],
        body=body,
        is_base64=False,
    )


def _facade_temporarily_unavailable_page() -> Response:
    """The token endpoint's retryable failure class (RFC 6749 section 5.2
    ``temporarily_unavailable``): lock contention beyond the coalesce wait cap, a
    store or lock failure, and a transient provider failure. It mirrors the
    registration endpoint's page, with a fixed one-second ``Retry-After`` because
    there is no window to derive a delay from here.
    """
    response = _facade_error_page(503, "temporarily_unavailable")
    response.headers["retry-after"] = [str(_REFRESH_RETRY_AFTER_SECONDS)]
    return response


def _front_channel_route_issuer(config: _NormalizedConfig, ctx: Context, endpoint: EndpointPath) -> str:
    """The client-facing issuer: the route URL in route issuer mode and the
    configured family issuer otherwise (DESIGN section 3.3).
    """
    if config.issuer_mode != ISSUER_MODE_ROUTE:
        return config.issuer_url
    return _build_absolute_url(config, ctx, endpoint.mcp_path())


def _facade_token_response(token_set: dict[str, Any], refresh_handle: str) -> Response:
    # The token response the facade returns (DESIGN section 8.4): the upstream
    # access token byte-for-byte unmodified, the upstream token type, expiry, and
    # scope, and the framework-minted opaque refresh handle. It never carries an
    # id_token or any upstream refresh material.
    return _facade_json_response(
        200,
        _facade_token_payload(
            access_token=str(token_set.get("access_token") or ""),
            token_type=str(token_set.get("token_type") or ""),
            expires_in=token_set.get("expires_in"),
            scope=token_set.get("scope"),
            refresh_handle=refresh_handle,
        ),
    )


def _facade_token_payload(
    *,
    access_token: str,
    token_type: str,
    expires_in: Any,
    scope: Any,
    refresh_handle: str,
) -> dict[str, Any]:
    """The one token-response payload shape both the code exchange and the
    brokered refresh render, so a rotated handle and an exchanged handle are
    indistinguishable to the client. ``expires_in``, ``scope``, and
    ``refresh_token`` are the members Go's ``facadeTokenPayload`` marks
    ``omitempty``; ``access_token`` and ``token_type`` are always present, exactly
    as the unmarked Go fields are.
    """
    payload: dict[str, Any] = {"access_token": access_token, "token_type": token_type}
    if isinstance(expires_in, int) and not isinstance(expires_in, bool) and expires_in != 0:
        payload["expires_in"] = expires_in
    if isinstance(scope, str) and scope:
        payload["scope"] = scope
    if refresh_handle:
        payload["refresh_token"] = refresh_handle
    return payload


def _facade_error_page(status: int, code: str) -> Response:
    """Render a facade rejection that never redirects (DESIGN section
    8.1/8.2): the fixed error vocabulary, no upstream material, and no cacheable
    representation.
    """
    return _facade_json_response(
        status,
        {"error": code, "error_description": _FACADE_ERROR_DESCRIPTIONS.get(code, "")},
    )


def _facade_upstream_error_page() -> Response:
    """The gateway-class provider failure (DESIGN section 8.2): a distinct 502
    carrying ``upstream_error``, never the facade's 400 vocabulary.
    """
    return _facade_error_page(502, "upstream_error")


def _facade_client_error_redirect(redirect_uri: str, issuer: str, client_state: str, code: str) -> Response:
    """Send an authorization error back to the client's validated redirect URI,
    carrying the fixed error code, the client's own state, and the client-facing
    RFC 9207 ``iss`` (FRAMEWORK_VS_POLICY row 1).
    """
    values: dict[str, list[str]] = {"error": [code], "iss": [issuer]}
    description = _FACADE_ERROR_DESCRIPTIONS.get(code, "")
    if description:
        values["error_description"] = [description]
    if client_state:
        values["state"] = [client_state]
    return _facade_client_redirect(redirect_uri, values)


def _facade_client_redirect(target: str, values: dict[str, list[str]]) -> Response:
    """Append values to the client's redirect URI without rewriting the URI
    itself, so the redirect target stays byte-identical to the registered value.
    """
    location = target
    encoded = _encode_query(values)
    if encoded:
        separator = "&" if "?" in location else "?"
        location = location + separator + encoded
    return _facade_redirect(location)


def _facade_upstream_redirect(target: str) -> Response:
    """Send the browser to the upstream authorize URL."""
    return _facade_redirect(target)


def _facade_redirect(location: str) -> Response:
    return Response(
        status=302,
        headers={"location": [location], "cache-control": ["no-store"], "pragma": ["no-cache"]},
        cookies=[],
        body=b"",
        is_base64=False,
    )


def _facade_json_response(status: int, payload: dict[str, Any]) -> Response:
    body = jsonlib.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return Response(
        status=status,
        headers={
            "content-type": ["application/json; charset=utf-8"],
            "cache-control": ["no-store"],
            "pragma": ["no-cache"],
        },
        cookies=[],
        body=body,
        is_base64=False,
    )


def _encode_query(values: dict[str, list[str]]) -> str:
    """Mirror Go's ``url.Values.Encode``: keys sorted, ``quote_plus`` escaping."""
    parts: list[str] = []
    for key in sorted(values):
        encoded_key = quote_plus(str(key))
        parts.extend(f"{encoded_key}={quote_plus(str(value))}" for value in values[key])
    return "&".join(parts)


def _encode_token_set(token_set: Any) -> str:
    return jsonlib.dumps(
        {
            "access_token": token_set.access_token,
            "refresh_token": token_set.refresh_token,
            "token_type": token_set.token_type,
            "expires_in": int(token_set.expires_in or 0),
            "scope": token_set.scope,
            "id_token": token_set.id_token,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _new_opaque_token() -> str:
    """A URL-safe opaque token for authorization codes and refresh handles."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")


def _parse_form(body: Any) -> dict[str, list[str]]:
    """Parse an ``application/x-www-form-urlencoded`` body the way Go's
    ``url.ParseQuery`` does, so a body the Go and TypeScript front channels
    refuse cannot slip through here: segments are split on ``&`` and empty ones
    are skipped, a literal ``;`` anywhere in a segment fails the whole parse,
    each segment splits on its first ``=``, and both sides are unescaped with
    ``QueryUnescape`` semantics. A malformed or truncated ``%`` escape, an
    over-bound body, or invalid UTF-8 raises ``ValueError`` /
    ``UnicodeDecodeError`` and the caller answers ``400 invalid_request``.
    Repeated keys keep every value in order, so the first occurrence is
    ``form[name][0]`` just as Go's ``values.Get`` returns it.
    """
    if body is None:
        body = b""
    raw = body if isinstance(body, bytes) else str(body).encode("utf-8")
    if len(raw) > _FRONT_CHANNEL_MAX_REQUEST_BODY_BYTES:
        raise ValueError("front channel request body exceeds the framework bound")
    form: dict[str, list[str]] = {}
    for segment in raw.decode("utf-8").split("&"):
        if segment == "":
            continue
        if ";" in segment:
            raise ValueError("invalid semicolon separator in query")
        raw_key, _, raw_value = segment.partition("=")
        key = _query_unescape(raw_key)
        value = _query_unescape(raw_value)
        form.setdefault(key, []).append(value)
    return form


def _query_unescape(value: str) -> str:
    """Percent-decode one form component the way Go's ``QueryUnescape`` does:
    ``+`` is a space and a malformed ``%`` escape is an error. The result is a
    code-unit string (one code point per decoded byte), mirroring the byte
    string the TypeScript front channel builds, so an ASCII form value
    round-trips Go's raw-byte semantics.
    """
    out: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "%":
            if index + 2 >= len(value):
                raise ValueError(f"invalid URL escape {value[index : index + 3]!r}")
            hex_pair = value[index + 1 : index + 3]
            if any(digit not in _HEX_DIGITS for digit in hex_pair):
                raise ValueError(f"invalid URL escape {value[index : index + 3]!r}")
            out.append(chr(int(hex_pair, 16)))
            index += 3
            continue
        out.append(" " if char == "+" else char)
        index += 1
    return "".join(out)


def _first_query_value(query: dict[str, list[str]], name: str) -> str:
    values = query.get(name) or []
    return str(values[0]) if values else ""


def _first_form_value(form: dict[str, list[str]], name: str) -> str:
    values = form.get(name) or []
    return str(values[0]) if values else ""


def _client_bound_route_refused(client, route_resource: str) -> bool:
    """Report whether a client the registration handler bound to one advertising
    route is being presented at another (DESIGN section 8.3, THREAT_MODEL T5).

    The bound route is the route resource the registration handler derived, so the
    comparison is exact and no route can be reached by a generalized or prefix
    match. A record that carries no bound route was pre-registered by the
    application and is never refused. Both callers render a refused record with
    the same invalid_client response an unknown client gets, so the response is
    never an oracle for which route a client registered at and never names a
    route.
    """
    bound_route = str(client.bound_route or "").strip()
    return bound_route != "" and bound_route != route_resource


def _registered_redirect_uri(registered: list[str] | None, requested: str) -> bool:
    """Report whether the request redirect URI matches one of the client's
    registered URIs exactly, allowing RFC 8252 section 7.3 loopback port
    flexibility only.
    """
    if requested is None or requested.strip() == "":
        return False
    for candidate in registered or []:
        if candidate == requested:
            return True
        if _loopback_redirect_match(candidate, requested):
            return True
    return False


def _loopback_redirect_match(registered: str, requested: str) -> bool:
    """Allow the ephemeral-port form of RFC 8252 section 7.3: a loopback
    redirect URI matches on scheme, host, path, query and fragment while the port
    alone is free to differ -- or to be absent on either side -- because a native
    client obtains its loopback port from the OS at request time. The port is
    therefore the only component excluded from the comparison, so the match never
    widens beyond the client's own registered loopback redirect: the host must be
    the same loopback host and the scheme/path/query/fragment must match exactly
    (DESIGN section 8.1, "loopback port flexibility only").
    """
    registered_url = _parse_absolute_url(registered)
    if registered_url is None:
        return False
    requested_url = _parse_absolute_url(requested)
    if requested_url is None:
        return False
    if not _front_channel_loopback_host(registered_url.decoded_hostname) or not _front_channel_loopback_host(
        requested_url.decoded_hostname
    ):
        return False
    return (
        registered_url.decoded_hostname.lower() == requested_url.decoded_hostname.lower()
        and registered_url.scheme == requested_url.scheme
        and registered_url.path == requested_url.path
        and registered_url.search == requested_url.search
        and registered_url.hash == requested_url.hash
    )


def _front_channel_loopback_host(hostname: str) -> bool:
    return str(hostname or "").lower() in _LOOPBACK_HOSTS


def _valid_s256_challenge(challenge: str) -> bool:
    """Report whether a PKCE challenge is the RFC 7636 S256 shape: 43 base64url
    characters.
    """
    value = str(challenge or "")
    if len(value) != _S256_CHALLENGE_LENGTH:
        return False
    return all(character in _S256_CHALLENGE_ALPHABET for character in value)


def _clamp_requested_scopes(requested: list[str], allowed: list[str]) -> tuple[list[str], bool]:
    """Clamp a client request to the route scope set: an absent request takes
    the route set, a present one is intersected with it in route order, and a
    request that survives to nothing fails closed instead of silently broadening
    to the route set.
    """
    if not requested:
        return list(allowed), True
    wanted: set[str] = set()
    for raw in requested:
        wanted.update(str(raw).split())
    clamped = [value for value in allowed if value in wanted]
    if not clamped:
        return [], False
    return clamped, True


def _facade_scope_fingerprint(scopes: list[str]) -> str:
    return hash_key(" ".join(sorted(str(scope) for scope in scopes or [])))


# ---------------------------------------------------------------------------
# RFC 7591 dynamic client registration (DESIGN section 8.3)
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class _DcrClientRequest:
    """The JSON registration request (RFC 7591 section 2).

    ``redirect_uris``, ``grant_types``, and ``response_types`` are ``None`` when
    the member is absent, so an absent member (a missing required list, or a list
    that defaults) is distinguishable from a present but empty one (an invalid
    list).
    """

    redirect_uris: list[str] | None = None
    token_endpoint_auth_method: str = ""
    grant_types: list[str] | None = None
    response_types: list[str] | None = None
    client_name: str = ""
    scope: str = ""


@dataclass(slots=True)
class _DcrClientRegistration:
    """The validated, normalized metadata the facade stores and echoes back. It
    carries no secret: these are public clients.
    """

    redirect_uris: list[str]
    grant_types: list[str]
    response_types: list[str]


def _handle_register(config: _NormalizedConfig, kind: str, ctx: Context) -> Response:
    """Serve the derived POST /register route (DESIGN section 8.3): RFC 7591
    dynamic client registration of one public client, bound to the advertising
    route. It fails closed at every step, in this fixed order: the raw body
    bound, the per-route rate limit, the JSON parse, the metadata validation, and
    the store write. A request that is refused at any step gets one of the three
    fixed registration error codes and never a distinguishing detail.
    """
    try:
        return _handle_register_inner(config, kind, ctx)
    except _MetadataRequestError as err:
        return _require_metadata_failure(err)


def _handle_register_inner(config: _NormalizedConfig, kind: str, ctx: Context) -> Response:
    front = config.front_channel
    if front is None:
        raise ValueError(f"{_ERROR_PREFIX} front channel is not configured")
    body = _request_body_bytes(ctx.request.body)
    if len(body) > _FRONT_CHANNEL_MAX_REQUEST_BODY_BYTES:
        # Bound the raw body before it is parsed, so an oversized body costs the
        # facade nothing more than this comparison.
        return _dcr_invalid_client_metadata()
    failure = _dcr_register_rate_limit(front, kind, ctx)
    if failure is not None:
        return failure
    request, failure = _parse_dcr_request(body)
    if request is None:
        return _dcr_failure(failure, _dcr_invalid_client_metadata())
    registration, failure = _validate_dcr_request(request)
    if registration is None:
        return _dcr_failure(failure, _dcr_invalid_client_metadata())
    endpoint = _endpoint_from_route_params(ctx, kind)
    # The resource the client is bound to is the same route resource the
    # authorize handler computes for this endpoint kind, so the advertised route
    # and the persisted binding cannot drift.
    resource = _build_absolute_url(config, ctx, endpoint.mcp_path())
    client_id, failure = _persist_registered_client(front, registration, resource)
    if client_id is None:
        return _dcr_failure(failure, _dcr_unavailable_page(0))
    return _dcr_client_response(ctx, client_id, registration)


def _dcr_failure(failure: Response | None, fallback: Response) -> Response:
    """Return the failure a DCR step reported, or a fixed fail-closed response.

    Every DCR step that reports no value reports a failure with it, so the
    fallback is unreachable by contract; it exists so a missing value narrows for
    the type checker and a step that ever broke that contract would still deny
    rather than proceed.
    """
    return failure if failure is not None else fallback


def _dcr_register_rate_limit(front: _FrontChannelConfig, kind: str, ctx: Context) -> Response | None:
    """Spend one attempt in the per-route registration bucket before any other
    work (THREAT_MODEL T5). The store error and the over-budget outcome map to
    the same 429 response: a rate-limit store that cannot answer must not become
    an unlimited registration path, so an error fails closed rather than open. A
    ``None`` result means the attempt is within budget.
    """
    try:
        result = front.stores.rate_limit.check_and_increment(
            RateLimitBucketKey(
                identifier=_dcr_rate_limit_identifier(ctx),
                resource=str(kind),
                operation=_DCR_OPERATION,
                limit=_DCR_RATE_LIMIT,
                window_seconds=_DCR_RATE_LIMIT_WINDOW_SECONDS,
            )
        )
    except Exception:  # noqa: BLE001 - an answering failure is the same 429 class
        return _dcr_unavailable_page(0)
    if not result.allowed:
        return _dcr_unavailable_page(result.retry_after_seconds)
    return None


def _dcr_rate_limit_identifier(ctx: Context) -> str:
    """Key the registration bucket by the provider-derived source IP when the
    runtime exposes one, and fall back to one shared per-route bucket otherwise.
    The source IP comes from trusted provider request context only
    (``ctx.source_ip()``), never from a client-controlled forwarding header.
    """
    ip = ctx.source_ip().strip()
    return ip if ip != "" else _DCR_ANONYMOUS_IDENTIFIER


def _parse_dcr_request(body: bytes) -> tuple[_DcrClientRequest | None, Response | None]:
    """Decode the JSON body. Unknown members are ignored, which is the RFC 7591
    behavior the facade relies on: a member it does not understand must not fail
    the registration. Every malformed body -- including an empty one -- is one
    ``invalid_client_metadata`` response, as is a known member of the wrong JSON
    type, so the decode fails closed the way a typed decoder would.
    """
    try:
        decoded = jsonlib.loads(body, parse_constant=_reject_dcr_json_constant)
    except ValueError:
        return None, _dcr_invalid_client_metadata()
    if not isinstance(decoded, dict):
        return None, _dcr_invalid_client_metadata()
    members: dict[str, Any] = {}
    for raw_key, value in decoded.items():
        member = _dcr_member_name(str(raw_key))
        if member is not None:
            members[member] = value
    request = _DcrClientRequest()
    for member in _DCR_MEMBERS:
        if member not in members:
            continue
        value = members[member]
        if value is None:
            # A JSON null leaves the field at its zero value, so a null member
            # reads as absent: a null redirect_uris is missing metadata, not an
            # empty list.
            continue
        if member in _DCR_LIST_MEMBERS:
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                return None, _dcr_invalid_client_metadata()
            setattr(request, member, list(value))
            continue
        if not isinstance(value, str):
            return None, _dcr_invalid_client_metadata()
        setattr(request, member, value)
    return request, None


def _dcr_member_name(key: str) -> str | None:
    """Map one JSON member name to the request member it names, or ``None`` when
    it names none. The fold mirrors the Go decoder: an exact name wins, and an
    ASCII case-insensitive match identifies the same member otherwise.
    """
    if key in _DCR_MEMBERS:
        return key
    folded = "".join(chr(ord(char) + 32) if "A" <= char <= "Z" else char for char in key)
    return folded if folded in _DCR_MEMBERS else None


def _reject_dcr_json_constant(name: str) -> Any:
    """Reject the JSON ``NaN``/``Infinity`` literals Python's decoder accepts but
    Go's does not, so a body the Go facade refuses at parse time is refused here.
    """
    raise ValueError(f"invalid JSON constant {name}")


def _validate_dcr_request(
    request: _DcrClientRequest,
) -> tuple[_DcrClientRegistration | None, Response | None]:
    """Apply the DESIGN section 8.3 metadata rules to a parsed request and return
    the normalized metadata the facade stores. Each rule reports the fixed code of
    its class, never which member failed.
    """
    redirects, failure = _validated_dcr_redirect_uris(request.redirect_uris)
    if redirects is None:
        return None, _dcr_failure(failure, _dcr_invalid_client_metadata())
    if not _valid_dcr_token_endpoint_auth_method(request.token_endpoint_auth_method):
        return None, _dcr_invalid_client_metadata()
    grants, failure = _normalized_dcr_grant_types(request.grant_types)
    if grants is None:
        return None, _dcr_failure(failure, _dcr_invalid_client_metadata())
    responses, failure = _normalized_dcr_response_types(request.response_types)
    if responses is None:
        return None, _dcr_failure(failure, _dcr_invalid_client_metadata())
    if _utf8_byte_length(request.client_name) > _DCR_MAX_CLIENT_NAME_BYTES:
        return None, _dcr_invalid_client_metadata()
    if _utf8_byte_length(request.scope) > _DCR_MAX_SCOPE_BYTES:
        return None, _dcr_invalid_client_metadata()
    return _DcrClientRegistration(redirect_uris=redirects, grant_types=grants, response_types=responses), None


def _validated_dcr_redirect_uris(raw: list[str] | None) -> tuple[list[str] | None, Response | None]:
    """Enforce the redirect URI rule: the member is required, so an absent one is
    missing metadata (``invalid_client_metadata``); once present it must hold at
    least one and at most ``_DCR_MAX_REDIRECT_URIS`` entries, and every entry must
    be an absolute URL with no fragment that is either https on any host or http
    on a loopback host (RFC 8252 section 7.2/7.3, THREAT_MODEL T5). Any violation
    of the list value itself is ``invalid_redirect_uri``. Each accepted entry is
    returned trimmed and otherwise byte-identical, so the stored value is the one
    the client presented.
    """
    if raw is None:
        return None, _dcr_invalid_client_metadata()
    if len(raw) == 0 or len(raw) > _DCR_MAX_REDIRECT_URIS:
        return None, _dcr_invalid_redirect_uri()
    validated: list[str] = []
    for candidate in raw:
        redirect_uri = _valid_dcr_redirect_uri(candidate)
        if redirect_uri is None:
            return None, _dcr_invalid_redirect_uri()
        validated.append(redirect_uri)
    return validated, None


def _valid_dcr_redirect_uri(raw: str) -> str | None:
    """Return the trimmed form of one redirect URI when it is an absolute https
    URL or an absolute http loopback URL, and ``None`` otherwise.
    """
    candidate = str(raw or "").strip()
    if candidate == "":
        return None
    parsed = _parse_absolute_url(candidate)
    # A bare trailing "#" is an empty fragment and passes, exactly as Go's
    # url.Parse reports it.
    if parsed is None or parsed.hash != "":
        return None
    if parsed.scheme == _HTTPS_SCHEME:
        return candidate
    if parsed.scheme == _HTTP_SCHEME and _front_channel_loopback_host(parsed.hostname):
        return candidate
    return None


def _valid_dcr_token_endpoint_auth_method(raw: str) -> bool:
    """Enforce the public-client-only rule: the member is absent, empty, or
    exactly ``none``. Any other method -- a confidential one the facade cannot
    honor -- is refused rather than silently downgraded.
    """
    method = str(raw or "").strip()
    return method == "" or method == _DCR_TOKEN_ENDPOINT_AUTH_METHOD_NONE


def _normalized_dcr_grant_types(raw: list[str] | None) -> tuple[list[str] | None, Response | None]:
    """Enforce the grant type list: when the member is present, every value must
    be ``authorization_code`` or ``refresh_token`` and the list must include
    ``authorization_code``, because the facade only serves the
    authorization_code grant today. The result is trimmed and deduplicated in
    request order. An absent member means the RFC 7591 default,
    ``["authorization_code"]``.
    """
    if raw is None:
        return [_DCR_GRANT_TYPE_AUTHORIZATION_CODE], None
    normalized: list[str] = []
    seen: set[str] = set()
    includes_authorization_code = False
    for value in raw:
        value = str(value or "").strip()
        if value == _DCR_GRANT_TYPE_AUTHORIZATION_CODE:
            includes_authorization_code = True
        elif value != _DCR_GRANT_TYPE_REFRESH_TOKEN:
            return None, _dcr_invalid_client_metadata()
        if value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    if not includes_authorization_code:
        return None, _dcr_invalid_client_metadata()
    return normalized, None


def _normalized_dcr_response_types(raw: list[str] | None) -> tuple[list[str] | None, Response | None]:
    """Enforce the response type list: when the member is present, it must be
    non-empty and every value must be ``code``, so the normalized list is exactly
    ``["code"]``. An absent member means the same default.
    """
    if raw is None:
        return [_DCR_RESPONSE_TYPE_CODE], None
    if len(raw) == 0:
        return None, _dcr_invalid_client_metadata()
    for value in raw:
        if str(value or "").strip() != _DCR_RESPONSE_TYPE_CODE:
            return None, _dcr_invalid_client_metadata()
    return [_DCR_RESPONSE_TYPE_CODE], None


def _persist_registered_client(
    front: _FrontChannelConfig,
    registration: _DcrClientRegistration,
    bound_route: str,
) -> tuple[str | None, Response | None]:
    """Mint the server-assigned client id and store the record, hash-keyed and
    bound to the advertising route, so a client registered at one route can never
    be redeemed at another. The id is 32 random bytes (256 bits, well above the
    128-bit floor of DESIGN section 8.3). A store failure is the 429 class and
    never returns an id that was not persisted.
    """
    client_id = _new_opaque_token()
    record = ClientRecord(
        client_id_hash=hash_key(client_id),
        client_id=client_id,
        redirect_uris=list(registration.redirect_uris),
        token_endpoint_auth_method=_DCR_TOKEN_ENDPOINT_AUTH_METHOD_NONE,
        grant_types=list(registration.grant_types),
        response_types=list(registration.response_types),
        bound_route=bound_route,
    )
    try:
        front.stores.client.put(record)
    except Exception:  # noqa: BLE001 - a store that cannot persist fails closed
        return None, _dcr_unavailable_page(0)
    return client_id, None


def _dcr_client_response(
    ctx: Context,
    client_id: str | None,
    registration: _DcrClientRegistration,
) -> Response:
    """Render the 201 registration response: the server-assigned client id, its
    issue time, the validated metadata echoed back, and no secret of any kind.
    The body is bounded by the request bounds, so it cannot echo the request body
    or any error detail.
    """
    return _facade_json_response(
        201,
        {
            "client_id": str(client_id or ""),
            "client_id_issued_at": int(ctx.now().timestamp()),
            "redirect_uris": list(registration.redirect_uris),
            "token_endpoint_auth_method": _DCR_TOKEN_ENDPOINT_AUTH_METHOD_NONE,
            "grant_types": list(registration.grant_types),
            "response_types": list(registration.response_types),
        },
    )


def _dcr_invalid_client_metadata() -> Response:
    return _dcr_error_page(400, "invalid_client_metadata")


def _dcr_invalid_redirect_uri() -> Response:
    return _dcr_error_page(400, "invalid_redirect_uri")


def _dcr_unavailable_page(retry_after_seconds: Any) -> Response:
    """Render the registration 429 class: ``temporarily_unavailable`` with a
    ``retry-after`` of at least one second. The delay comes from the rate-limit
    store when it reported one and from the framework window otherwise. A
    registration store failure takes this same page, so a caller that cannot be
    served is told to come back rather than being left to guess.
    """
    response = _dcr_error_page(429, "temporarily_unavailable")
    response.headers["retry-after"] = [str(_dcr_retry_after_seconds(retry_after_seconds))]
    return response


def _dcr_retry_after_seconds(value: Any) -> int:
    """The whole seconds a client should wait: at least one second, and the
    framework window when no reset instant is known.
    """
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        seconds = 0
    return seconds if seconds >= 1 else _DCR_RATE_LIMIT_WINDOW_SECONDS


def _dcr_error_page(status: int, code: str) -> Response:
    """Render a registration rejection: the closed registration error vocabulary,
    the fixed description of that code, and no cacheable representation.
    """
    return _facade_json_response(
        status,
        {"error": code, "error_description": _DCR_ERROR_DESCRIPTIONS.get(code, "")},
    )


def _request_body_bytes(body: Any) -> bytes:
    """The raw request bytes a body bound is measured against."""
    if body is None:
        return b""
    if isinstance(body, bytes):
        return body
    if isinstance(body, bytearray):
        return bytes(body)
    return str(body).encode("utf-8")


def _utf8_byte_length(value: Any) -> int:
    """The UTF-8 byte length of a metadata string, the way Go measures a Go
    string with ``len``. A lone surrogate counts the three bytes of the U+FFFD
    the Go decoder substitutes for it.
    """
    return len(str(value or "").encode("utf-8", "surrogatepass"))


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

    hostport = authority
    at_index = authority.rfind("@")
    if at_index >= 0:
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
        # Go's parseAuthority treats the authority as carrying userinfo whenever
        # it holds an "@", so an empty userinfo ("https://@host/") is userinfo too.
        has_user=at_index >= 0,
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


def _request_host_allowlist_key(parsed: _ParsedURL) -> str:
    """The allowlist key for a normalized request origin.

    The allowlist is stored as decoded, canonicalized authorities (see
    :func:`_normalize_allowed_hostname`), so the request authority must be
    canonicalized the same way before the lookup: Go compares the decoded request
    host against the decoded allowlist set, while a raw comparison would reject
    every allowed hostname whose raw form differs from its canonical form
    (non-ASCII, percent-escaped, or an IPv6 zone). :func:`normalize_request_origin`
    has already lowercased the authority and stripped the request scheme's own
    default port, so only the decoded bytes need canonicalizing here.
    """
    hostname = _canonical_hostname(parsed.decoded_hostname)
    if hostname == "":
        return ""
    if parsed.port == "":
        return hostname
    return _join_host_port(hostname.removeprefix("[").removesuffix("]"), parsed.port)


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
