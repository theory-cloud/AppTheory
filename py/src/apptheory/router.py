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
    segments: list[str]
    handler: object
    auth_required: bool


class Router:
    def __init__(self) -> None:
        self._routes: list[_Route] = []

    def add(self, method: str, pattern: str, handler: object, *, auth_required: bool = False) -> None:
        method_value = str(method or "").strip().upper()
        pattern_value = normalize_path(pattern)
        self._routes.append(
            _Route(
                method=method_value,
                pattern=pattern_value,
                segments=_split_path(pattern_value),
                handler=handler,
                auth_required=bool(auth_required),
            )
        )

    def match(self, method: str, path: str) -> tuple[Match | None, list[str]]:
        method_value = str(method or "").strip().upper()
        path_segments = _split_path(normalize_path(path))

        allowed: list[str] = []
        for route in self._routes:
            params = _match_path(route.segments, path_segments)
            if params is None:
                continue
            allowed.append(route.method)
            if route.method == method_value:
                return Match(handler=route.handler, params=params, auth_required=route.auth_required), allowed

        return None, allowed

    @staticmethod
    def format_allow_header(methods: list[str]) -> str:
        unique = {str(m or "").strip().upper() for m in methods if str(m or "").strip()}
        return ", ".join(sorted(unique))


def _split_path(path: str) -> list[str]:
    value = normalize_path(path).lstrip("/")
    if not value:
        return []
    return value.split("/")


def _match_path(pattern_segments: list[str], path_segments: list[str]) -> dict[str, str] | None:
    if len(pattern_segments) != len(path_segments):
        return None

    params: dict[str, str] = {}
    for pattern, segment in zip(pattern_segments, path_segments, strict=False):
        if not segment:
            return None
        if pattern.startswith("{") and pattern.endswith("}") and len(pattern) > 2:
            params[pattern[1:-1]] = segment
            continue
        if pattern != segment:
            return None

    return params
