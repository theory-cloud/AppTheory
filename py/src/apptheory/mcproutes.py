"""AppTheory's versioned MCP route algebra.

Python port of the Go ``runtime/mcproutes`` package: every OAuth facade,
discovery, and registration route is derived from the four canonical MCP
patterns through pure functions, and concrete endpoint builders enforce the
same kind-to-identifier invariants. The ``m17.mcp-route-algebra`` contract is
shared with the Go and TypeScript runtimes through
``contract-tests/fixtures/routing/mcp-route-algebra/expectations.json``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

_MCP_SEGMENT = "mcp"
# ASCII-only trim cutset: tab, LF, VT, FF, CR, space (U+0009, U+000A, U+000B,
# U+000C, U+000D, U+0020). Unicode whitespace is deliberately not trimmed.
_ASCII_WHITESPACE_TRIM_CUTSET = "\t\n\v\f\r "
_ERROR_PREFIX = "mcproutes:"

# ContractVersion is the MCP route-algebra contract implemented by this module.
#
# v2 is a superset of v1: the four canonical MCP patterns and the v1
# derivations (protected resource, canonical/suffix discovery, authorize,
# token) are unchanged. v2 adds the derived register path per kind, one
# stage-global callback path, and the IssuerMode vocabulary for per-route
# issuer/resource derivation.
CONTRACT_VERSION = "m17.mcp-route-algebra/v2"
# ContractVersionV1 is the superseded read contract retained for compatibility.
CONTRACT_VERSION_V1 = "m17.mcp-route-algebra/v1"

# ParamClientNamespace is the canonical client-namespace route parameter name.
PARAM_CLIENT_NAMESPACE = "client_namespace"
# ParamPartnerID is the canonical partner route parameter name.
PARAM_PARTNER_ID = "partner_id"
# ParamAgentID is the canonical agent route parameter name.
PARAM_AGENT_ID = "agent_id"

# ProtectedResourcePrefix is the RFC 9728 protected-resource metadata prefix.
PROTECTED_RESOURCE_PREFIX = "/.well-known/oauth-protected-resource"
# AuthorizationServerPrefix is the RFC 8414 authorization-server metadata prefix.
AUTHORIZATION_SERVER_PREFIX = "/.well-known/oauth-authorization-server"

# DefaultCallbackPath is the stage-global upstream OAuth callback path.
#
# The callback is correlated by the single-use upstream state the facade minted,
# so one stage-global route is sufficient and no per-kind callback multiplies.
DEFAULT_CALLBACK_PATH = "/_oauth/mcp/callback"
# CallbackPatternKey names the stage-global callback route in the route model.
CALLBACK_PATTERN_KEY = "upstream_callback"

# IssuerMode selects how the facade derives each route's issuer and resource.
# IssuerModeFamily advertises one family-wide issuer for the whole facade; this is
# the current behavior and remains for single-tenant/root-only deployments.
ISSUER_MODE_FAMILY = "family"
# IssuerModeRoute makes each route its own authorization-server issuer: the route
# URL. Required for single-domain proxying of an upstream provider and for
# RFC 9207 iss-aware clients.
ISSUER_MODE_ROUTE = "route"

# EndpointKind identifies a canonical MCP endpoint shape.
ENDPOINT_KIND_NAMESPACE = "namespace"
ENDPOINT_KIND_PARTNER_NAMESPACE = "partner_namespace"
ENDPOINT_KIND_AGENT = "agent"
ENDPOINT_KIND_PARTNER_AGENT = "partner_agent"

# NamespaceMCPPattern is the canonical namespace MCP route pattern.
NAMESPACE_MCP_PATTERN = "/{client_namespace}/mcp"
# PartnerNamespaceMCPPattern is the canonical partner-scoped namespace MCP route pattern.
PARTNER_NAMESPACE_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/mcp"
# AgentMCPPattern is the canonical agent MCP route pattern.
AGENT_MCP_PATTERN = "/{client_namespace}/agents/{agent_id}/mcp"
# PartnerAgentMCPPattern is the canonical partner-scoped agent MCP route pattern.
PARTNER_AGENT_MCP_PATTERN = "/{client_namespace}/partners/{partner_id}/agents/{agent_id}/mcp"

_ENDPOINT_TEMPLATE_SEEDS: tuple[tuple[str, str], ...] = (
    (ENDPOINT_KIND_NAMESPACE, NAMESPACE_MCP_PATTERN),
    (ENDPOINT_KIND_PARTNER_NAMESPACE, PARTNER_NAMESPACE_MCP_PATTERN),
    (ENDPOINT_KIND_AGENT, AGENT_MCP_PATTERN),
    (ENDPOINT_KIND_PARTNER_AGENT, PARTNER_AGENT_MCP_PATTERN),
)


@dataclass(slots=True)
class EndpointPath:
    """A concrete canonical MCP endpoint."""

    kind: str
    client_namespace: str = ""
    partner_id: str = ""
    agent_id: str = ""

    def validate(self) -> None:
        """Validate kind-to-identifier consistency and path-segment safety."""
        validate_endpoint_path(self)

    def mcp_path(self) -> str:
        """Build the concrete MCP path for the endpoint."""
        return _mcp_path_for_endpoint(self)

    def protected_resource_path(self) -> str:
        """Build the endpoint's RFC 9728 protected-resource path."""
        return self._derive(protected_resource_path_for_resource_path)

    def oauth_authorization_server_path(self) -> str:
        """Build the endpoint's canonical RFC 8414 discovery path."""
        return self._derive(authorization_server_path_for_resource_path)

    def oauth_authorize_path(self) -> str:
        """Build the endpoint's authorization facade path."""
        return self._derive(authorization_authorize_path_for_resource_path)

    def oauth_token_path(self) -> str:
        """Build the endpoint's token facade path."""
        return self._derive(authorization_token_path_for_resource_path)

    def oauth_register_path(self) -> str:
        """Build the endpoint's dynamic-client registration path."""
        return self._derive(authorization_register_path_for_resource_path)

    def oauth_authorization_server_suffix_path(self) -> str:
        """Build the endpoint's suffix-compatible RFC 8414 discovery path."""
        return self._derive(authorization_server_suffix_path_for_resource_path)

    def _derive(self, derivation: Callable[[str], str]) -> str:
        return derivation(self.mcp_path())


@dataclass(slots=True)
class StageGlobalRoute:
    """A route not derived from an MCP endpoint kind, installed once per deployment."""

    name: str
    pattern: str
    methods: list[str]


def supported_issuer_modes() -> list[str]:
    """Return the closed IssuerMode vocabulary in contract order."""
    return [ISSUER_MODE_FAMILY, ISSUER_MODE_ROUTE]


def supported_endpoint_templates() -> list[dict[str, str]]:
    """Return every canonical MCP endpoint template in contract order."""
    return [
        {
            "kind": kind,
            "mcp_pattern": pattern,
            "protected_resource_path": protected_resource_path_for_resource_path(pattern),
        }
        for kind, pattern in _ENDPOINT_TEMPLATE_SEEDS
    ]


def supported_oauth_facade_templates() -> list[dict[str, str]]:
    """Return every canonical OAuth facade template in contract order."""
    return [
        {
            "kind": kind,
            "authorize_pattern": authorization_authorize_path_for_resource_path(pattern),
            "token_pattern": authorization_token_path_for_resource_path(pattern),
            "register_pattern": authorization_register_path_for_resource_path(pattern),
        }
        for kind, pattern in _ENDPOINT_TEMPLATE_SEEDS
    ]


def supported_oauth_discovery_templates() -> list[dict[str, str]]:
    """Return every canonical OAuth discovery template in contract order."""
    return [
        {
            "kind": kind,
            "canonical_pattern": authorization_server_path_for_resource_path(pattern),
            "suffix_pattern": authorization_server_suffix_path_for_resource_path(pattern),
        }
        for kind, pattern in _ENDPOINT_TEMPLATE_SEEDS
    ]


def supported_stage_global_routes() -> list[StageGlobalRoute]:
    """Return the stage-global route inventory in contract order.

    v2 adds exactly one stage-global route: the upstream OAuth callback. The
    callback path is overridable; this returns the contract default.
    """
    return [StageGlobalRoute(name=CALLBACK_PATTERN_KEY, pattern=DEFAULT_CALLBACK_PATH, methods=["GET"])]


def protected_resource_path_for_resource_path(resource_path: str) -> str:
    """Derive an RFC 9728 protected-resource path from a resource path."""
    resource_path = _normalize_path(resource_path)
    if resource_path == "/":
        return PROTECTED_RESOURCE_PREFIX
    return PROTECTED_RESOURCE_PREFIX + resource_path


def authorization_server_path_for_resource_path(resource_path: str) -> str:
    """Derive the canonical RFC 8414 discovery path from a resource path."""
    resource_path = _normalize_path(resource_path)
    if resource_path == "/":
        return AUTHORIZATION_SERVER_PREFIX
    return AUTHORIZATION_SERVER_PREFIX + resource_path


def authorization_authorize_path_for_resource_path(resource_path: str) -> str:
    """Derive the authorization facade path from a resource path."""
    return authorization_server_path_for_resource_path(resource_path) + "/authorize"


def authorization_token_path_for_resource_path(resource_path: str) -> str:
    """Derive the token facade path from a resource path."""
    return authorization_server_path_for_resource_path(resource_path) + "/token"


def authorization_register_path_for_resource_path(resource_path: str) -> str:
    """Derive the RFC 7591 dynamic-client registration facade path.

    The path is mounted beside the canonical RFC 8414 discovery path, and the
    routed discovery document advertises exactly this path as
    ``registration_endpoint``, so the advertised URL and the mounted route cannot
    drift.
    """
    return authorization_server_path_for_resource_path(resource_path) + "/register"


def authorization_server_suffix_path_for_resource_path(resource_path: str) -> str:
    """Derive the suffix-compatible RFC 8414 discovery path from a resource path."""
    resource_path = _normalize_path(resource_path)
    if resource_path == "/":
        return AUTHORIZATION_SERVER_PREFIX
    return resource_path + AUTHORIZATION_SERVER_PREFIX


def resource_path_from_protected_resource_path(protected_resource_path: str) -> str:
    """Recover a resource path from its RFC 9728 metadata path."""
    protected_resource_path = _normalize_path(protected_resource_path)
    if protected_resource_path == PROTECTED_RESOURCE_PREFIX:
        return "/"
    if not protected_resource_path.startswith(PROTECTED_RESOURCE_PREFIX + "/"):
        raise ValueError(f"{_ERROR_PREFIX} unsupported protected resource path {protected_resource_path!r}")
    return _normalize_path(protected_resource_path.removeprefix(PROTECTED_RESOURCE_PREFIX))


def protected_resource_path_from_mcp_path(mcp_path: str) -> str:
    """Derive the protected-resource path for an MCP path."""
    return protected_resource_path_for_resource_path(mcp_path)


def parse_mcp_path(raw_path: str) -> EndpointPath:
    """Parse a concrete MCP path after contract normalization.

    Dot segments are first resolved without normalization so that explicit ``.``
    and ``..`` identifiers are rejected instead of silently collapsed.
    """
    endpoint = _endpoint_from_segments(_split_path_before_dot_normalization(raw_path))
    if endpoint is not None:
        return _validated_endpoint(endpoint, raw_path)

    endpoint = _endpoint_from_segments(_split_path(_normalize_path(raw_path)))
    if endpoint is None:
        raise ValueError(f"{_ERROR_PREFIX} unsupported MCP path {raw_path!r}")
    return _validated_endpoint(endpoint, raw_path)


def validate_endpoint_path(endpoint: EndpointPath) -> None:
    """Validate kind-to-identifier consistency and path-segment safety."""
    if not _is_path_segment(endpoint.client_namespace):
        raise ValueError(f"{_ERROR_PREFIX} client_namespace must be a non-empty path segment")

    kind = endpoint.kind
    if kind == ENDPOINT_KIND_NAMESPACE:
        if endpoint.partner_id != "" or endpoint.agent_id != "":
            raise ValueError(f"{_ERROR_PREFIX} namespace endpoint cannot include partner or agent identifiers")
        return
    if kind == ENDPOINT_KIND_PARTNER_NAMESPACE:
        if not _is_path_segment(endpoint.partner_id):
            raise ValueError(f"{_ERROR_PREFIX} partner_id must be a non-empty path segment")
        if endpoint.agent_id != "":
            raise ValueError(f"{_ERROR_PREFIX} partner namespace endpoint cannot include agent_id")
        return
    if kind == ENDPOINT_KIND_AGENT:
        if not _is_path_segment(endpoint.agent_id):
            raise ValueError(f"{_ERROR_PREFIX} agent_id must be a non-empty path segment")
        if endpoint.partner_id != "":
            raise ValueError(f"{_ERROR_PREFIX} agent endpoint cannot include partner_id")
        return
    if kind == ENDPOINT_KIND_PARTNER_AGENT:
        if not _is_path_segment(endpoint.partner_id):
            raise ValueError(f"{_ERROR_PREFIX} partner_id must be a non-empty path segment")
        if not _is_path_segment(endpoint.agent_id):
            raise ValueError(f"{_ERROR_PREFIX} agent_id must be a non-empty path segment")
        return
    raise ValueError(f"{_ERROR_PREFIX} unsupported endpoint kind {kind!r}")


def callback_path_for_configured_path(configured: str) -> str:
    """Resolve the effective callback path, falling back to the contract default.

    An unset (or whitespace-only) configuration value resolves to
    ``DEFAULT_CALLBACK_PATH``; any other value must normalize to a valid
    absolute callback path.
    """
    configured = configured.strip(_ASCII_WHITESPACE_TRIM_CUTSET)
    if configured == "":
        return DEFAULT_CALLBACK_PATH
    return normalize_callback_path(configured)


def normalize_callback_path(raw_path: str) -> str:
    """Validate and normalize an absolute callback path.

    The path must be absolute, contain no query or fragment, and must not use a
    dot segment. It is normalized with the same rules as every other route path.
    """
    raw_path = raw_path.strip(_ASCII_WHITESPACE_TRIM_CUTSET)
    if raw_path == "" or not raw_path.startswith("/"):
        raise ValueError(f"{_ERROR_PREFIX} callback path must be absolute")
    if _contains_refused_route_path_bytes(raw_path):
        raise ValueError(
            f"{_ERROR_PREFIX} callback path must not contain a percent-encoded slash, "
            "an interior ASCII whitespace or control character, or a backslash"
        )
    if "?" in raw_path or "#" in raw_path:
        raise ValueError(f"{_ERROR_PREFIX} callback path must not contain a query or fragment")
    if any(segment in (".", "..") for segment in raw_path.split("/")):
        raise ValueError(f"{_ERROR_PREFIX} callback path must not contain a dot segment")
    return _normalize_path(raw_path)


def _validated_endpoint(endpoint: EndpointPath, raw_path: str) -> EndpointPath:
    try:
        validate_endpoint_path(endpoint)
    except ValueError as err:
        raise ValueError(f"{_ERROR_PREFIX} invalid MCP path {raw_path!r}: {err}") from err
    return endpoint


def _mcp_path_for_endpoint(endpoint: EndpointPath) -> str:
    validate_endpoint_path(endpoint)

    kind = endpoint.kind
    if kind == ENDPOINT_KIND_NAMESPACE:
        return f"/{endpoint.client_namespace}/mcp"
    if kind == ENDPOINT_KIND_PARTNER_NAMESPACE:
        return f"/{endpoint.client_namespace}/partners/{endpoint.partner_id}/mcp"
    if kind == ENDPOINT_KIND_AGENT:
        return f"/{endpoint.client_namespace}/agents/{endpoint.agent_id}/mcp"
    if kind == ENDPOINT_KIND_PARTNER_AGENT:
        return f"/{endpoint.client_namespace}/partners/{endpoint.partner_id}/agents/{endpoint.agent_id}/mcp"
    raise ValueError(f"{_ERROR_PREFIX} unsupported endpoint kind {kind!r}")


def _endpoint_from_segments(segments: list[str]) -> EndpointPath | None:
    if len(segments) == 2:
        if segments[1] == _MCP_SEGMENT:
            return EndpointPath(kind=ENDPOINT_KIND_NAMESPACE, client_namespace=segments[0])
        return None
    if len(segments) == 4:
        if segments[1] == "partners" and segments[3] == _MCP_SEGMENT:
            return EndpointPath(
                kind=ENDPOINT_KIND_PARTNER_NAMESPACE,
                client_namespace=segments[0],
                partner_id=segments[2],
            )
        if segments[1] == "agents" and segments[3] == _MCP_SEGMENT:
            return EndpointPath(
                kind=ENDPOINT_KIND_AGENT,
                client_namespace=segments[0],
                agent_id=segments[2],
            )
        return None
    if len(segments) == 6 and segments[1] == "partners" and segments[3] == "agents" and segments[5] == _MCP_SEGMENT:
        return EndpointPath(
            kind=ENDPOINT_KIND_PARTNER_AGENT,
            client_namespace=segments[0],
            partner_id=segments[2],
            agent_id=segments[4],
        )
    return None


def _normalize_path(raw_path: str) -> str:
    raw_path = raw_path.strip(_ASCII_WHITESPACE_TRIM_CUTSET)
    if raw_path == "":
        return "/"
    if not raw_path.startswith("/"):
        raw_path = "/" + raw_path

    segments: list[str] = []
    for segment in raw_path.split("/"):
        if segment in ("", "."):
            continue
        if segment == "..":
            if segments:
                segments.pop()
            continue
        segments.append(segment)
    if not segments:
        return "/"
    return "/" + "/".join(segments)


def _split_path_before_dot_normalization(raw_path: str) -> list[str]:
    return [segment for segment in raw_path.strip(_ASCII_WHITESPACE_TRIM_CUTSET).split("/") if segment != ""]


def _split_path(normalized_path: str) -> list[str]:
    normalized_path = normalized_path.removeprefix("/")
    if normalized_path == "":
        return []
    return normalized_path.split("/")


def _is_path_segment(value: str) -> bool:
    trimmed = value.strip(_ASCII_WHITESPACE_TRIM_CUTSET)
    return trimmed not in ("", ".", "..") and "/" not in value and not _contains_refused_route_path_bytes(trimmed)


def _contains_refused_route_path_bytes(value: str) -> bool:
    """Report whether a route path, already trimmed at its edges, carries the
    bytes the route algebra refuses: a percent-encoded slash, an interior ASCII
    whitespace or control character, or a backslash.
    """
    if "%2F" in value or "%2f" in value:
        return True
    return any(ord(char) <= 0x1F or ord(char) == 0x20 or ord(char) == 0x7F or char == "\\" for char in value)
