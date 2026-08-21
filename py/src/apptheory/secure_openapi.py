from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any

from apptheory.openapi import OpenAPIFieldSpec, OpenAPIRequestSpec, OpenAPIRouteSpec, OpenAPISpec, generate_openapi
from apptheory.secure_types import SecureRoute


@dataclass(slots=True)
class OpenAPIAuthSchemes:
    """Document-level secure posture scheme bindings."""

    authenticated: list[str]
    internal_only: list[str]


@dataclass(slots=True)
class SecureOpenAPISpec:
    """Exact HTTP description accepted by SecureApp OpenAPI generation."""

    title: str
    version: str
    routes: list[OpenAPIRouteSpec]
    security_schemes: dict[str, dict[str, Any]]
    auth_schemes: OpenAPIAuthSchemes


def _mapping(value: Any) -> Mapping[str, Any]:
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    if isinstance(value, Mapping):
        return value
    raise TypeError("apptheory: secure openapi value must be an object")


def _canonical_route_key(method: str, path: str) -> tuple[str, str, str]:
    method_value = str(method or "").strip().upper()
    if not method_value:
        raise ValueError("apptheory: route method is empty")
    path_value = str(path or "").strip().split("?", 1)[0].strip() or "/"
    if not path_value.startswith("/"):
        path_value = f"/{path_value}"
    raw_segments = [] if path_value == "/" else path_value[1:].split("/")
    canonical: list[str] = []
    for index, raw in enumerate(raw_segments):
        segment = str(raw or "").strip()
        if not segment:
            raise ValueError("apptheory: invalid route pattern")
        if segment.startswith(":") and len(segment) > 1:
            segment = "{" + segment[1:] + "}"
        if segment.startswith("{") and segment.endswith("}"):
            name = segment[1:-1].strip()
            proxy = name.endswith("+")
            if proxy:
                name = name[:-1].strip()
            if not name or "{" in name or "}" in name or (proxy and index != len(raw_segments) - 1):
                raise ValueError("apptheory: invalid route pattern")
            canonical.append("{" + name + ("+" if proxy else "") + "}")
            continue
        if "{" in segment or "}" in segment:
            raise ValueError("apptheory: invalid route pattern")
        canonical.append(segment)
    canonical_path = "/" + "/".join(canonical) if canonical else "/"
    return method_value, canonical_path, f"{method_value} {canonical_path}"


def _copy_json(value: Any, seen: set[int]) -> Any:
    if value is None or isinstance(value, str | bool):
        return value
    if isinstance(value, int | float) and not isinstance(value, bool):
        raise ValueError("apptheory: secure openapi numeric values are not allowed")
    if isinstance(value, dict):
        marker = id(value)
        if marker in seen:
            raise ValueError("apptheory: secure openapi cyclic values are not allowed")
        seen.add(marker)
        try:
            out: dict[str, Any] = {}
            for key, item in value.items():
                if not isinstance(key, str):
                    raise ValueError("apptheory: secure openapi object keys must be strings")
                out[key] = _copy_json(item, seen)
            return out
        finally:
            seen.remove(marker)
    if isinstance(value, list):
        marker = id(value)
        if marker in seen:
            raise ValueError("apptheory: secure openapi cyclic values are not allowed")
        seen.add(marker)
        try:
            return [_copy_json(item, seen) for item in value]
        finally:
            seen.remove(marker)
    raise ValueError("apptheory: secure openapi runtime-specific values are not allowed")


def _normalize_names(values: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in values or []:
        value = str(raw or "").strip()
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def _normalize_security_schemes(value: Any) -> dict[str, Any]:
    copied = _copy_json(value, set())
    if not isinstance(copied, dict):
        raise ValueError("apptheory: secure openapi security schemes must be an object")
    out: dict[str, Any] = {}
    for raw_name, scheme in copied.items():
        name = str(raw_name).strip()
        if not name:
            raise ValueError("apptheory: secure openapi security scheme name is required")
        if name in out:
            raise ValueError(f"apptheory: secure openapi security scheme {name} is duplicated")
        out[name] = scheme
    return out


def _route_from_mapping(value: Any) -> OpenAPIRouteSpec:
    if isinstance(value, OpenAPIRouteSpec):
        return value
    raw = _mapping(value)
    response = raw.get("response") or {}
    request = raw.get("request") or {}
    request_fields = [OpenAPIFieldSpec(**dict(item)) for item in _mapping(request).get("fields", [])] if request else []
    from apptheory.openapi import OpenAPIResponseSpec

    response_fields = [OpenAPIFieldSpec(**dict(item)) for item in _mapping(response).get("fields", [])]
    return OpenAPIRouteSpec(
        method=str(raw.get("method", "")),
        path=str(raw.get("path", "")),
        operation_id=str(raw.get("operation_id", raw.get("operationId", ""))),
        response=OpenAPIResponseSpec(
            description=str(_mapping(response).get("description", "")), fields=response_fields
        ),
        summary=str(raw.get("summary", "")),
        tags=list(raw.get("tags") or []),
        success_status=raw.get("success_status", raw.get("successStatus")),
        request=OpenAPIRequestSpec(fields=request_fields),
    )


def generate_secure_openapi(  # noqa: C901
    routes: list[SecureRoute],
    spec: SecureOpenAPISpec | Mapping[str, Any],
) -> dict[str, Any]:
    raw = _mapping(spec)
    registered: dict[str, SecureRoute] = {}
    for route in routes:
        if route.surface != "http":
            continue
        _, _, key = _canonical_route_key(route.method, route.path)
        registered[key] = route

    described: dict[str, OpenAPIRouteSpec] = {}
    order: list[str] = []
    for value in raw.get("routes", []):
        route = _route_from_mapping(value)
        method, path, key = _canonical_route_key(route.method, route.path)
        if key in described:
            raise ValueError(f"apptheory: secure openapi route {key} is duplicated")
        described[key] = OpenAPIRouteSpec(
            method=method,
            path=path,
            operation_id=route.operation_id,
            response=route.response,
            summary=route.summary,
            tags=route.tags,
            success_status=route.success_status,
            request=route.request,
        )
        order.append(key)
    for key in registered:
        if key not in described:
            raise ValueError(f"apptheory: secure openapi missing route {key}")
    for key in described:
        if key not in registered:
            raise ValueError(f"apptheory: secure openapi extra route {key}")

    schemes = _normalize_security_schemes(raw.get("security_schemes", {}))
    auth_raw = _mapping(raw.get("auth_schemes", {}))
    authenticated = _normalize_names(list(auth_raw.get("authenticated") or []))
    internal = _normalize_names(list(auth_raw.get("internal_only", auth_raw.get("internalOnly")) or []))
    for name in authenticated + internal:
        if name not in schemes:
            raise ValueError(f"apptheory: secure openapi auth scheme {name} is not defined")

    joins: list[tuple[SecureRoute, OpenAPIRouteSpec, str, bool]] = []
    emitted: set[str] = set()
    for key in order:
        route = registered[key]
        description = described[key]
        path = description.path
        segments = [] if path == "/" else path[1:].split("/")
        proxy = bool(segments and segments[-1].startswith("{") and segments[-1].endswith("+}"))
        proxy_name = ""
        if proxy:
            proxy_name = segments[-1][1:-2].strip()
            segments[-1] = "{" + proxy_name + "}"
            path = "/" + "/".join(segments)
        emitted_key = f"{description.method} {path}"
        if emitted_key in emitted:
            raise ValueError(f"apptheory: secure openapi emitted route {emitted_key} collides")
        emitted.add(emitted_key)
        if route.posture in {"optional", "authenticated", "authenticated_any_of"} and not authenticated:
            raise ValueError("apptheory: secure openapi authenticated scheme binding is required")
        if route.posture == "internal_only" and not internal:
            raise ValueError("apptheory: secure openapi internal scheme binding is required")
        if proxy:
            fields = list(description.request.fields if description.request and description.request.fields else [])
            found = False
            for index, field in enumerate(fields):
                if field.source == "path" and field.name.strip() == proxy_name:
                    fields[index] = OpenAPIFieldSpec(
                        field=field.field,
                        source=field.source,
                        name=field.name,
                        type=field.type,
                        array=field.array,
                        required=True,
                        validation=field.validation,
                    )
                    found = True
            if not found:
                fields.append(
                    OpenAPIFieldSpec(field=proxy_name, source="path", name=proxy_name, type="string", required=True)
                )
            description = OpenAPIRouteSpec(
                method=description.method,
                path=path,
                operation_id=description.operation_id,
                response=description.response,
                summary=description.summary,
                tags=description.tags,
                success_status=description.success_status,
                request=OpenAPIRequestSpec(fields=fields),
            )
        joins.append((route, description, path, proxy))

    document = generate_openapi(
        OpenAPISpec(
            title=str(raw.get("title", "")), version=str(raw.get("version", "")), routes=[item[1] for item in joins]
        )
    )
    document["components"]["securitySchemes"] = schemes
    document["x-apptheory-contract-mode"] = "secure-v1"
    for route, description, path, proxy in joins:
        operation = document["paths"][path][description.method.lower()]
        operation["x-apptheory-auth-posture"] = route.posture
        if route.scopes:
            operation["x-apptheory-required-scopes"] = list(route.scopes)
        if proxy:
            operation["x-apptheory-proxy"] = True
        names = internal if route.posture == "internal_only" else authenticated
        if route.posture == "authenticated_any_of":
            security = [{name: [scope]} for name in names for scope in route.scopes]
        else:
            scopes = list(route.scopes) if route.posture == "authenticated" else []
            security = [{name: list(scopes)} for name in names]
        if route.posture == "public":
            security = []
        elif route.posture == "optional":
            security.append({})
        operation["security"] = security
    return document


def generate_secure_openapi_json(routes: list[SecureRoute], spec: SecureOpenAPISpec | Mapping[str, Any]) -> str:
    return json.dumps(generate_secure_openapi(routes, spec), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
