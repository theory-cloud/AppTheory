from __future__ import annotations

from dataclasses import dataclass

from apptheory.util import normalize_path


@dataclass(slots=True)
class Match:
    handler: object
    params: dict[str, str]
    auth_required: bool


@dataclass(slots=True)
class _Route:
    method: str
    pattern: str
    segments: list[tuple[str, str]]
    handler: object
    auth_required: bool
    static_count: int
    param_count: int
    has_proxy: bool
    order: int


class Router:
    def __init__(self) -> None:
        self._routes: list[_Route] = []

    def add(self, method: str, pattern: str, handler: object, *, auth_required: bool = False) -> None:
        method_value = str(method or "").strip().upper()
        parsed = _parse_route_segments(_split_path(pattern))
        if parsed is None:
            return
        segments, canonical_segments, static_count, param_count, has_proxy = parsed
        pattern_value = "/" + "/".join(canonical_segments) if canonical_segments else "/"
        self._routes.append(
            _Route(
                method=method_value,
                pattern=pattern_value,
                segments=segments,
                handler=handler,
                auth_required=bool(auth_required),
                static_count=static_count,
                param_count=param_count,
                has_proxy=has_proxy,
                order=len(self._routes),
            )
        )

    def match(self, method: str, path: str) -> tuple[Match | None, list[str]]:
        method_value = str(method or "").strip().upper()
        path_segments = _split_path(normalize_path(path))

        allowed: list[str] = []
        best: _Route | None = None
        best_params: dict[str, str] | None = None
        for route in self._routes:
            params = _match_route(route.segments, path_segments)
            if params is None:
                continue
            allowed.append(route.method)
            if route.method == method_value and (best is None or _route_more_specific(route, best)):
                best = route
                best_params = params

        if best is None or best_params is None:
            return None, allowed
        return Match(handler=best.handler, params=best_params, auth_required=best.auth_required), allowed

    @staticmethod
    def format_allow_header(methods: list[str]) -> str:
        unique = {str(m or "").strip().upper() for m in methods if str(m or "").strip()}
        return ", ".join(sorted(unique))


def _split_path(path: str) -> list[str]:
    value = normalize_path(path).lstrip("/")
    if not value:
        return []
    return value.split("/")


def _parse_route_segments(
    raw_segments: list[str],
) -> tuple[list[tuple[str, str]], list[str], int, int, bool] | None:
    segments: list[tuple[str, str]] = []
    canonical: list[str] = []
    static_count = 0
    param_count = 0
    has_proxy = False

    for idx, raw in enumerate(raw_segments):
        value = str(raw or "").strip()
        if not value:
            return None

        if value.startswith(":") and len(value) > 1:
            value = "{" + value[1:] + "}"

        if value.startswith("{") and value.endswith("}") and len(value) > 2:
            inner = value[1:-1].strip()
            if inner.endswith("+"):
                name = inner[:-1].strip()
                if not name:
                    return None
                if idx != len(raw_segments) - 1:
                    return None
                segments.append(("proxy", name))
                canonical.append("{" + name + "+}")
                has_proxy = True
                continue

            if not inner:
                return None
            segments.append(("param", inner))
            canonical.append("{" + inner + "}")
            param_count += 1
            continue

        segments.append(("static", value))
        canonical.append(value)
        static_count += 1

    return segments, canonical, static_count, param_count, has_proxy


def _match_route(pattern_segments: list[tuple[str, str]], path_segments: list[str]) -> dict[str, str] | None:
    if not pattern_segments:
        return {} if not path_segments else None

    kind, name = pattern_segments[-1]
    if kind == "proxy":
        prefix_len = len(pattern_segments) - 1
        if len(path_segments) <= prefix_len:
            return None

        params: dict[str, str] = {}
        for (p_kind, p_value), seg in zip(pattern_segments[:prefix_len], path_segments[:prefix_len], strict=False):
            if not seg:
                return None
            if p_kind == "static":
                if p_value != seg:
                    return None
            elif p_kind == "param":
                params[p_value] = seg
            else:
                return None

        params[name] = "/".join(path_segments[prefix_len:])
        return params

    if len(pattern_segments) != len(path_segments):
        return None

    params: dict[str, str] = {}
    for (p_kind, p_value), seg in zip(pattern_segments, path_segments, strict=False):
        if not seg:
            return None
        if p_kind == "static":
            if p_value != seg:
                return None
        elif p_kind == "param":
            params[p_value] = seg
        else:
            return None

    return params


def _route_more_specific(a: _Route, b: _Route) -> bool:
    if a.static_count != b.static_count:
        return a.static_count > b.static_count
    if a.param_count != b.param_count:
        return a.param_count > b.param_count
    if a.has_proxy != b.has_proxy:
        return (not a.has_proxy) and b.has_proxy
    if len(a.segments) != len(b.segments):
        return len(a.segments) > len(b.segments)
    return a.order < b.order
