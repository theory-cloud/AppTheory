from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from apptheory.aws_http import (
    apigw_v2_response_from_response,
    lambda_function_url_response_from_response,
    request_from_apigw_v2,
    request_from_lambda_function_url,
)
from apptheory.clock import Clock, RealClock
from apptheory.context import Context
from apptheory.errors import (
    AppError,
    error_response,
    error_response_with_request_id,
    response_for_error,
    response_for_error_with_request_id,
)
from apptheory.ids import IdGenerator, RealIdGenerator
from apptheory.request import Request, normalize_request
from apptheory.response import Response, normalize_response
from apptheory.router import Router
from apptheory.util import canonicalize_headers, clone_query

Handler = Callable[[Context], Response]
AuthHook = Callable[[Context], str]
PolicyHook = Callable[[Context], "PolicyDecision | None"]


@dataclass(slots=True)
class Limits:
    max_request_bytes: int = 0
    max_response_bytes: int = 0


@dataclass(slots=True)
class LogRecord:
    level: str
    event: str
    request_id: str
    tenant_id: str
    method: str
    path: str
    status: int
    error_code: str


@dataclass(slots=True)
class MetricRecord:
    name: str
    value: int
    tags: dict[str, str]


@dataclass(slots=True)
class SpanRecord:
    name: str
    attributes: dict[str, str]


@dataclass(slots=True)
class ObservabilityHooks:
    log: Callable[[LogRecord], None] | None = None
    metric: Callable[[MetricRecord], None] | None = None
    span: Callable[[SpanRecord], None] | None = None


@dataclass(slots=True)
class PolicyDecision:
    code: str
    message: str
    headers: dict[str, Any]

    def __init__(self, *, code: str, message: str, headers: dict[str, Any] | None = None) -> None:
        self.code = str(code)
        self.message = str(message)
        self.headers = dict(headers or {})


@dataclass(slots=True)
class App:
    _router: Router
    _clock: Clock
    _id_generator: IdGenerator
    _tier: str
    _limits: Limits
    _auth_hook: AuthHook | None
    _observability: ObservabilityHooks
    _policy_hook: PolicyHook | None

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        id_generator: IdGenerator | None = None,
        tier: str = "p2",
        limits: Limits | None = None,
        auth_hook: AuthHook | None = None,
        observability: ObservabilityHooks | None = None,
        policy_hook: PolicyHook | None = None,
    ) -> None:
        self._router = Router()
        self._clock = clock or RealClock()
        self._id_generator = id_generator or RealIdGenerator()
        tier_value = str(tier or "").strip().lower()
        if tier_value not in {"p0", "p1", "p2"}:
            tier_value = "p2"
        self._tier = tier_value
        self._limits = limits or Limits()
        self._auth_hook = auth_hook
        self._observability = observability or ObservabilityHooks()
        self._policy_hook = policy_hook

    def handle(self, method: str, pattern: str, handler: Handler, *, auth_required: bool = False) -> App:
        self._router.add(method, pattern, handler, auth_required=auth_required)
        return self

    def get(self, pattern: str, handler: Handler) -> App:
        return self.handle("GET", pattern, handler)

    def post(self, pattern: str, handler: Handler) -> App:
        return self.handle("POST", pattern, handler)

    def put(self, pattern: str, handler: Handler) -> App:
        return self.handle("PUT", pattern, handler)

    def delete(self, pattern: str, handler: Handler) -> App:
        return self.handle("DELETE", pattern, handler)

    def serve(self, request: Request, ctx: Any | None = None) -> Response:
        if self._tier == "p1":
            return self._serve_portable(request, ctx, enable_p2=False)
        if self._tier == "p2":
            return self._serve_portable(request, ctx, enable_p2=True)

        try:
            normalized = normalize_request(request)
        except Exception as exc:  # noqa: BLE001
            return response_for_error(exc)

        match, allowed = self._router.match(normalized.method, normalized.path)
        if match is None:
            if allowed:
                return error_response(
                    "app.method_not_allowed",
                    "method not allowed",
                    headers={"allow": [self._router.format_allow_header(allowed)]},
                )
            return error_response("app.not_found", "not found")

        request_ctx = Context(
            request=normalized,
            params=match.params,
            clock=self._clock,
            id_generator=self._id_generator,
            ctx=ctx,
        )

        try:
            resp = match.handler(request_ctx)
        except AppError as exc:
            return error_response(exc.code, exc.message)
        except Exception:  # noqa: BLE001
            return error_response("app.internal", "internal error")

        return normalize_response(resp)

    def _serve_portable(self, request: Request, ctx: Any | None, *, enable_p2: bool) -> Response:
        pre_headers = canonicalize_headers(request.headers)
        pre_query = clone_query(request.query)

        method = str(request.method or "").strip().upper()
        path = str(request.path or "").strip() or "/"

        request_id = _first_header_value(pre_headers, "x-request-id") or self._id_generator.new_id()
        origin = _first_header_value(pre_headers, "origin")
        tenant_id = _extract_tenant_id(pre_headers, pre_query)
        remaining_ms = _remaining_ms(ctx)

        trace = ["request_id", "recovery", "logging"]
        if origin:
            trace.append("cors")

        def finish(resp: Response, error_code: str = "") -> Response:
            out = _finalize_p1_response(resp, request_id, origin)
            if enable_p2:
                self._record_observability(method, path, request_id, tenant_id, out.status, error_code)
            return out

        if _is_cors_preflight(request.method, pre_headers):
            allow = _first_header_value(pre_headers, "access-control-request-method")
            resp = Response(
                status=204,
                headers={"access-control-allow-methods": [allow]},
                cookies=[],
                body=b"",
                is_base64=False,
            )
            return finish(normalize_response(resp))

        try:
            normalized = normalize_request(request)
        except Exception as exc:  # noqa: BLE001
            error_code = exc.code if isinstance(exc, AppError) else "app.internal"
            return finish(response_for_error_with_request_id(exc, request_id), error_code)

        method = normalized.method
        path = normalized.path
        tenant_id = _extract_tenant_id(normalized.headers, normalized.query)

        if self._limits.max_request_bytes > 0 and len(normalized.body) > self._limits.max_request_bytes:
            return finish(
                error_response_with_request_id("app.too_large", "request too large", request_id=request_id),
                "app.too_large",
            )

        match, allowed = self._router.match(normalized.method, normalized.path)
        if match is None:
            if allowed:
                return finish(
                    error_response_with_request_id(
                        "app.method_not_allowed",
                        "method not allowed",
                        headers={"allow": [self._router.format_allow_header(allowed)]},
                        request_id=request_id,
                    ),
                    "app.method_not_allowed",
                )
            return finish(error_response_with_request_id("app.not_found", "not found", request_id=request_id), "app.not_found")

        request_ctx = Context(
            request=normalized,
            params=match.params,
            clock=self._clock,
            id_generator=self._id_generator,
            ctx=ctx,
            request_id=request_id,
            tenant_id=tenant_id,
            auth_identity="",
            remaining_ms=remaining_ms,
            middleware_trace=trace,
        )

        if enable_p2 and self._policy_hook is not None:
            try:
                decision = self._policy_hook(request_ctx)
            except Exception as exc:  # noqa: BLE001
                error_code = exc.code if isinstance(exc, AppError) else "app.internal"
                return finish(response_for_error_with_request_id(exc, request_id), error_code)

            if decision is not None and str(getattr(decision, "code", "")).strip():
                code = str(decision.code).strip()
                message = str(getattr(decision, "message", "")).strip() or _default_policy_message(code)
                return finish(
                    error_response_with_request_id(code, message, headers=decision.headers, request_id=request_id),
                    code,
                )

        if match.auth_required:
            trace.append("auth")
            if self._auth_hook is None:
                return finish(
                    error_response_with_request_id("app.unauthorized", "unauthorized", request_id=request_id),
                    "app.unauthorized",
                )
            try:
                identity = self._auth_hook(request_ctx)
            except Exception as exc:  # noqa: BLE001
                error_code = exc.code if isinstance(exc, AppError) else "app.internal"
                return finish(response_for_error_with_request_id(exc, request_id), error_code)
            if not str(identity or "").strip():
                return finish(
                    error_response_with_request_id("app.unauthorized", "unauthorized", request_id=request_id),
                    "app.unauthorized",
                )
            request_ctx.auth_identity = str(identity)

        trace.append("handler")

        try:
            resp = match.handler(request_ctx)
        except AppError as exc:
            return finish(error_response_with_request_id(exc.code, exc.message, request_id=request_id), exc.code)
        except Exception as exc:  # noqa: BLE001
            return finish(response_for_error_with_request_id(exc, request_id), "app.internal")

        resp = normalize_response(resp)
        if self._limits.max_response_bytes > 0 and len(resp.body) > self._limits.max_response_bytes:
            return finish(
                error_response_with_request_id("app.too_large", "response too large", request_id=request_id),
                "app.too_large",
            )

        return finish(resp)

    def _record_observability(
        self,
        method: str,
        path: str,
        request_id: str,
        tenant_id: str,
        status: int,
        error_code: str,
    ) -> None:
        level = "info"
        if status >= 500:
            level = "error"
        elif status >= 400:
            level = "warn"

        if self._observability.log is not None:
            self._observability.log(
                LogRecord(
                    level=level,
                    event="request.completed",
                    request_id=request_id,
                    tenant_id=tenant_id,
                    method=method,
                    path=path,
                    status=int(status),
                    error_code=error_code,
                )
            )

        if self._observability.metric is not None:
            self._observability.metric(
                MetricRecord(
                    name="apptheory.request",
                    value=1,
                    tags={
                        "method": method,
                        "path": path,
                        "status": str(int(status)),
                        "error_code": error_code,
                        "tenant_id": tenant_id,
                    },
                )
            )

        if self._observability.span is not None:
            self._observability.span(
                SpanRecord(
                    name=f"http {method} {path}",
                    attributes={
                        "http.method": method,
                        "http.route": path,
                        "http.status_code": str(int(status)),
                        "request.id": request_id,
                        "tenant.id": tenant_id,
                        "error.code": error_code,
                    },
                )
            )

    def serve_apigw_v2(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        try:
            request = request_from_apigw_v2(event)
        except Exception as exc:  # noqa: BLE001
            return apigw_v2_response_from_response(response_for_error(exc))

        resp = self.serve(request, ctx)
        return apigw_v2_response_from_response(resp)

    def serve_lambda_function_url(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        try:
            request = request_from_lambda_function_url(event)
        except Exception as exc:  # noqa: BLE001
            return lambda_function_url_response_from_response(response_for_error(exc))

        resp = self.serve(request, ctx)
        return lambda_function_url_response_from_response(resp)


def create_app(
    *,
    clock: Clock | None = None,
    id_generator: IdGenerator | None = None,
    tier: str = "p2",
    limits: Limits | None = None,
    auth_hook: AuthHook | None = None,
    observability: ObservabilityHooks | None = None,
    policy_hook: PolicyHook | None = None,
) -> App:
    return App(
        clock=clock,
        id_generator=id_generator,
        tier=tier,
        limits=limits,
        auth_hook=auth_hook,
        observability=observability,
        policy_hook=policy_hook,
    )


def _first_header_value(headers: dict[str, list[str]], key: str) -> str:
    values = headers.get(str(key or "").strip().lower(), [])
    return values[0] if values else ""


def _extract_tenant_id(headers: dict[str, list[str]], query: dict[str, list[str]]) -> str:
    tenant = _first_header_value(headers, "x-tenant-id")
    if tenant:
        return tenant
    values = query.get("tenant", [])
    return values[0] if values else ""


def _is_cors_preflight(method: str, headers: dict[str, list[str]]) -> bool:
    return str(method or "").strip().upper() == "OPTIONS" and bool(
        _first_header_value(headers, "access-control-request-method")
    )


def _finalize_p1_response(resp: Response, request_id: str, origin: str) -> Response:
    headers = canonicalize_headers(resp.headers)
    if request_id:
        headers["x-request-id"] = [str(request_id)]
    if origin:
        headers["access-control-allow-origin"] = [str(origin)]
        headers["vary"] = ["origin"]
    return normalize_response(
        Response(
            status=resp.status,
            headers=headers,
            cookies=resp.cookies,
            body=resp.body,
            is_base64=resp.is_base64,
        )
    )


def _remaining_ms(ctx: Any | None) -> int:
    if ctx is None:
        return 0
    get_remaining = getattr(ctx, "get_remaining_time_in_millis", None)
    if callable(get_remaining):
        try:
            value = int(get_remaining())
        except Exception:  # noqa: BLE001
            return 0
        return value if value > 0 else 0

    if isinstance(ctx, dict) and "remaining_ms" in ctx:
        try:
            value = int(ctx.get("remaining_ms") or 0)
        except Exception:  # noqa: BLE001
            return 0
        return value if value > 0 else 0

    value = getattr(ctx, "remaining_ms", None)
    if value is None:
        return 0
    try:
        value_int = int(value)
    except Exception:  # noqa: BLE001
        return 0
    return value_int if value_int > 0 else 0


def _default_policy_message(code: str) -> str:
    match str(code or "").strip():
        case "app.rate_limited":
            return "rate limited"
        case "app.overloaded":
            return "overloaded"
        case _:
            return "internal error"
