from __future__ import annotations

import asyncio
import inspect
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, TypeVar

from apptheory.aws_events import AppSyncResolverEvent
from apptheory.aws_http import (
    alb_target_group_response_from_response,
    apigw_proxy_response_from_response,
    apigw_v2_response_from_response,
    lambda_function_url_response_from_response,
    request_from_alb_target_group,
    request_from_apigw_proxy,
    request_from_apigw_v2,
    request_from_lambda_function_url,
)
from apptheory.cache import vary
from apptheory.clock import Clock, RealClock
from apptheory.context import AppSyncContext, Context, EventContext, WebSocketClientFactory, WebSocketContext
from apptheory.errors import (
    HTTP_ERROR_FORMAT_NESTED,
    AppError,
    AppTheoryError,
    error_response,
    error_response_with_format,
    error_response_with_request_id,
    error_response_with_request_id_and_format,
    normalize_http_error_format,
    response_for_error,
    response_for_error_with_format,
    response_for_error_with_request_id,
    response_for_error_with_request_id_and_format,
    status_for_error_code,
)
from apptheory.ids import IdGenerator, RealIdGenerator
from apptheory.request import Request, normalize_request
from apptheory.response import Response, normalize_response
from apptheory.router import Router
from apptheory.util import canonicalize_headers, clone_query

T = TypeVar("T")


def _resolve(value: T | Awaitable[T]) -> T:
    if not inspect.isawaitable(value):
        return value

    async def _await_any(awaitable: Awaitable[T]) -> T:
        return await awaitable

    try:
        return asyncio.run(_await_any(value))
    except RuntimeError as exc:  # pragma: no cover
        raise RuntimeError(
            "apptheory: cannot resolve awaitable from sync code while an event loop is running; "
            "call App.serve()/handle_lambda() from a synchronous entrypoint"
        ) from exc


Handler = Callable[[Context], Response | Awaitable[Response]]
NextHandler = Callable[[Context], Response]
Middleware = Callable[[Context, NextHandler], Response | Awaitable[Response]]
AuthHook = Callable[[Context], str | Awaitable[str]]
PolicyHook = Callable[[Context], "PolicyDecision | None | Awaitable[PolicyDecision | None]"]
EventHandler = Callable[[EventContext, dict[str, Any]], object | Awaitable[object]]
EventMiddleware = Callable[[EventContext, dict[str, Any], Callable[[], object]], object | Awaitable[object]]
SQSHandler = Callable[[EventContext, dict[str, Any]], None | Awaitable[None]]
KinesisHandler = Callable[[EventContext, dict[str, Any]], None | Awaitable[None]]
SNSHandler = Callable[[EventContext, dict[str, Any]], object | Awaitable[object]]
DynamoDBStreamHandler = Callable[[EventContext, dict[str, Any]], None | Awaitable[None]]
EventBridgeHandler = Callable[[EventContext, dict[str, Any]], object | Awaitable[object]]
WebSocketHandler = Callable[[Context], Response | Awaitable[Response]]


@dataclass(slots=True)
class EventBridgeSelector:
    rule_name: str = ""
    source: str = ""
    detail_type: str = ""


def event_bridge_rule(rule_name: str) -> EventBridgeSelector:
    return EventBridgeSelector(rule_name=str(rule_name or "").strip())


def event_bridge_pattern(source: str, detail_type: str) -> EventBridgeSelector:
    return EventBridgeSelector(source=str(source or "").strip(), detail_type=str(detail_type or "").strip())


@dataclass(slots=True)
class Limits:
    max_request_bytes: int = 0
    max_response_bytes: int = 0


@dataclass(slots=True)
class CORSConfig:
    allowed_origins: list[str] | None = None
    allow_credentials: bool = False
    allow_headers: list[str] | None = None


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
    _http_error_format: str
    _limits: Limits
    _cors: CORSConfig
    _auth_hook: AuthHook | None
    _observability: ObservabilityHooks
    _policy_hook: PolicyHook | None
    _sqs_routes: list[tuple[str, SQSHandler]]
    _kinesis_routes: list[tuple[str, KinesisHandler]]
    _sns_routes: list[tuple[str, SNSHandler]]
    _eventbridge_routes: list[tuple[EventBridgeSelector, EventBridgeHandler]]
    _dynamodb_routes: list[tuple[str, DynamoDBStreamHandler]]
    _ws_routes: dict[str, WebSocketHandler]
    _websocket_client_factory: WebSocketClientFactory | None
    _middlewares: list[Middleware]
    _event_middlewares: list[EventMiddleware]

    def __init__(
        self,
        *,
        clock: Clock | None = None,
        id_generator: IdGenerator | None = None,
        tier: str = "p2",
        http_error_format: str = HTTP_ERROR_FORMAT_NESTED,
        limits: Limits | None = None,
        cors: CORSConfig | None = None,
        auth_hook: AuthHook | None = None,
        observability: ObservabilityHooks | None = None,
        policy_hook: PolicyHook | None = None,
        websocket_client_factory: WebSocketClientFactory | None = None,
    ) -> None:
        self._router = Router()
        self._clock = clock or RealClock()
        self._id_generator = id_generator or RealIdGenerator()
        tier_value = str(tier or "").strip().lower()
        if tier_value not in {"p0", "p1", "p2"}:
            tier_value = "p2"
        self._tier = tier_value
        self._http_error_format = normalize_http_error_format(http_error_format)
        self._limits = limits or Limits()
        self._cors = _normalize_cors_config(cors)
        self._auth_hook = auth_hook
        self._observability = observability or ObservabilityHooks()
        self._policy_hook = policy_hook
        self._sqs_routes = []
        self._kinesis_routes = []
        self._sns_routes = []
        self._eventbridge_routes = []
        self._dynamodb_routes = []
        self._ws_routes = {}
        self._websocket_client_factory = websocket_client_factory or _default_websocket_client_factory
        self._middlewares = []
        self._event_middlewares = []

    def handle(self, method: str, pattern: str, handler: Handler, *, auth_required: bool = False) -> App:
        self._router.add(method, pattern, handler, auth_required=auth_required)
        return self

    def handle_strict(self, method: str, pattern: str, handler: Handler, *, auth_required: bool = False) -> App:
        self._router.add_strict(method, pattern, handler, auth_required=auth_required)
        return self

    def get(self, pattern: str, handler: Handler) -> App:
        return self.handle("GET", pattern, handler)

    def post(self, pattern: str, handler: Handler) -> App:
        return self.handle("POST", pattern, handler)

    def put(self, pattern: str, handler: Handler) -> App:
        return self.handle("PUT", pattern, handler)

    def patch(self, pattern: str, handler: Handler) -> App:
        return self.handle("PATCH", pattern, handler)

    def options(self, pattern: str, handler: Handler) -> App:
        return self.handle("OPTIONS", pattern, handler)

    def delete(self, pattern: str, handler: Handler) -> App:
        return self.handle("DELETE", pattern, handler)

    def sqs(self, queue_name: str, handler: SQSHandler) -> App:
        name = str(queue_name or "").strip()
        if not name:
            return self
        self._sqs_routes.append((name, handler))
        return self

    def kinesis(self, stream_name: str, handler: KinesisHandler) -> App:
        name = str(stream_name or "").strip()
        if not name:
            return self
        self._kinesis_routes.append((name, handler))
        return self

    def sns(self, topic_name: str, handler: SNSHandler) -> App:
        name = str(topic_name or "").strip()
        if not name:
            return self
        self._sns_routes.append((name, handler))
        return self

    def event_bridge(self, selector: EventBridgeSelector, handler: EventBridgeHandler) -> App:
        if selector is None:
            return self
        sel = EventBridgeSelector(
            rule_name=str(selector.rule_name or "").strip(),
            source=str(selector.source or "").strip(),
            detail_type=str(selector.detail_type or "").strip(),
        )
        if not sel.rule_name and not sel.source and not sel.detail_type:
            return self
        self._eventbridge_routes.append((sel, handler))
        return self

    def dynamodb(self, table_name: str, handler: DynamoDBStreamHandler) -> App:
        name = str(table_name or "").strip()
        if not name:
            return self
        self._dynamodb_routes.append((name, handler))
        return self

    def websocket(self, route_key: str, handler: WebSocketHandler) -> App:
        key = str(route_key or "").strip()
        if not key:
            return self
        self._ws_routes[key] = handler
        return self

    def use(self, middleware: Middleware) -> App:
        if middleware is None:
            return self
        self._middlewares.append(middleware)
        return self

    def use_events(self, middleware: EventMiddleware) -> App:
        if middleware is None:
            return self
        self._event_middlewares.append(middleware)
        return self

    def _apply_middlewares(self, handler: Handler) -> Handler:
        wrapped = handler
        for middleware in reversed(self._middlewares):
            if middleware is None:
                continue

            def apply_one(next_handler: Handler, mw: Middleware = middleware) -> Handler:
                def _wrapped(ctx: Context) -> Response | Awaitable[Response]:
                    def next_sync(inner_ctx: Context) -> Response:
                        return _resolve(next_handler(inner_ctx))

                    return mw(ctx, next_sync)

                return _wrapped

            wrapped = apply_one(wrapped)
        return wrapped

    def _apply_event_middlewares(self, handler: EventHandler) -> EventHandler:
        wrapped = handler
        for middleware in reversed(self._event_middlewares):
            if middleware is None:
                continue

            def apply_one(next_handler: EventHandler, mw: EventMiddleware = middleware) -> EventHandler:
                def _wrapped(ctx: EventContext, event: dict[str, Any]) -> Any:
                    return mw(ctx, event, lambda: _resolve(next_handler(ctx, event)))

                return _wrapped

            wrapped = apply_one(wrapped)
        return wrapped

    def get_http_error_format(self) -> str:
        return self._http_error_format

    def _http_error_response(
        self,
        code: str,
        message: str,
        *,
        headers: dict[str, Any] | None = None,
    ) -> Response:
        return error_response_with_format(self._http_error_format, code, message, headers=headers)

    def _http_error_response_with_request_id(
        self,
        code: str,
        message: str,
        *,
        headers: dict[str, Any] | None = None,
        request_id: str = "",
    ) -> Response:
        return error_response_with_request_id_and_format(
            self._http_error_format,
            code,
            message,
            headers=headers,
            request_id=request_id,
        )

    def _response_for_http_error(self, exc: Exception) -> Response:
        return response_for_error_with_format(self._http_error_format, exc)

    def _response_for_http_error_with_request_id(self, exc: Exception, request_id: str) -> Response:
        return response_for_error_with_request_id_and_format(self._http_error_format, exc, request_id)

    def serve(self, request: Request, ctx: Any | None = None) -> Response:
        return self._serve(request, ctx)

    def _serve(
        self,
        request: Request,
        ctx: Any | None = None,
        context_configurer: Callable[[Context], None] | None = None,
        appsync: AppSyncContext | None = None,
        error_responder: Callable[[Exception, Request, str], Response] | None = None,
        fallback_request_id: str = "",
    ) -> Response:
        def respond_to_error(exc: Exception, error_request: Request, request_id: str) -> Response:
            if error_responder is not None:
                return error_responder(exc, error_request, request_id)
            if request_id:
                return self._response_for_http_error_with_request_id(exc, request_id)
            return self._response_for_http_error(exc)

        if self._tier == "p1":
            return self._serve_portable(
                request,
                ctx,
                enable_p2=False,
                context_configurer=context_configurer,
                appsync=appsync,
                error_responder=error_responder,
                fallback_request_id=fallback_request_id,
            )
        if self._tier == "p2":
            return self._serve_portable(
                request,
                ctx,
                enable_p2=True,
                context_configurer=context_configurer,
                appsync=appsync,
                error_responder=error_responder,
                fallback_request_id=fallback_request_id,
            )

        try:
            normalized = normalize_request(request)
        except Exception as exc:  # noqa: BLE001
            return respond_to_error(exc, request, fallback_request_id)

        match, allowed = self._router.match(normalized.method, normalized.path)
        if match is None:
            if error_responder is not None:
                if allowed:
                    return respond_to_error(
                        AppError("app.method_not_allowed", "method not allowed"),
                        normalized,
                        fallback_request_id,
                    )
                return respond_to_error(
                    AppError("app.not_found", "not found"),
                    normalized,
                    fallback_request_id,
                )
            if allowed:
                return self._http_error_response(
                    "app.method_not_allowed",
                    "method not allowed",
                    headers={"allow": [self._router.format_allow_header(allowed)]},
                )
            return self._http_error_response("app.not_found", "not found")

        request_ctx = Context(
            request=normalized,
            params=match.params,
            clock=self._clock,
            id_generator=self._id_generator,
            ctx=ctx,
            appsync=appsync,
        )
        if context_configurer is not None:
            context_configurer(request_ctx)

        handler = self._apply_middlewares(match.handler)
        try:
            resp = _resolve(handler(request_ctx))
        except Exception as exc:  # noqa: BLE001
            return respond_to_error(exc, normalized, fallback_request_id)

        if resp is None:
            return respond_to_error(
                AppError("app.internal", "internal error"),
                normalized,
                fallback_request_id,
            )

        return normalize_response(resp)

    def _policy_check(
        self,
        request_ctx: Context,
        request_id: str,
        *,
        enable_p2: bool,
        error_responder: Callable[[Exception, Request, str], Response] | None = None,
    ) -> tuple[Response, str] | None:
        if not enable_p2 or self._policy_hook is None:
            return None

        try:
            decision = _resolve(self._policy_hook(request_ctx))
        except Exception as exc:  # noqa: BLE001
            error_code = exc.code if isinstance(exc, (AppError, AppTheoryError)) else "app.internal"
            if error_responder is not None:
                return error_responder(exc, request_ctx.request, request_id), error_code
            return self._response_for_http_error_with_request_id(exc, request_id), error_code

        if decision is None or not str(getattr(decision, "code", "")).strip():
            return None

        code = str(decision.code).strip()
        message = str(getattr(decision, "message", "")).strip() or _default_policy_message(code)
        if error_responder is not None:
            return error_responder(AppError(code, message), request_ctx.request, request_id), code
        resp = self._http_error_response_with_request_id(
            code,
            message,
            headers=decision.headers,
            request_id=request_id,
        )
        return resp, code

    def _auth_check(
        self,
        request_ctx: Context,
        *,
        auth_required: bool,
        request_id: str,
        trace: list[str],
        error_responder: Callable[[Exception, Request, str], Response] | None = None,
    ) -> tuple[Response, str] | None:
        if not auth_required:
            return None

        trace.append("auth")
        if self._auth_hook is None:
            if error_responder is not None:
                return (
                    error_responder(AppError("app.unauthorized", "unauthorized"), request_ctx.request, request_id),
                    "app.unauthorized",
                )
            resp = self._http_error_response_with_request_id(
                "app.unauthorized",
                "unauthorized",
                request_id=request_id,
            )
            return resp, "app.unauthorized"

        try:
            identity = _resolve(self._auth_hook(request_ctx))
        except Exception as exc:  # noqa: BLE001
            error_code = exc.code if isinstance(exc, (AppError, AppTheoryError)) else "app.internal"
            if error_responder is not None:
                return error_responder(exc, request_ctx.request, request_id), error_code
            return self._response_for_http_error_with_request_id(exc, request_id), error_code

        if not str(identity or "").strip():
            if error_responder is not None:
                return (
                    error_responder(AppError("app.unauthorized", "unauthorized"), request_ctx.request, request_id),
                    "app.unauthorized",
                )
            resp = self._http_error_response_with_request_id(
                "app.unauthorized",
                "unauthorized",
                request_id=request_id,
            )
            return resp, "app.unauthorized"

        request_ctx.auth_identity = str(identity)
        return None

    def _serve_portable(  # noqa: C901
        self,
        request: Request,
        ctx: Any | None,
        *,
        enable_p2: bool,
        context_configurer: Callable[[Context], None] | None = None,
        appsync: AppSyncContext | None = None,
        error_responder: Callable[[Exception, Request, str], Response] | None = None,
        fallback_request_id: str = "",
    ) -> Response:
        def respond_to_error(exc: Exception, error_request: Request, request_id: str) -> Response:
            if error_responder is not None:
                return error_responder(exc, error_request, request_id)
            return self._response_for_http_error_with_request_id(exc, request_id)

        pre_headers = canonicalize_headers(request.headers)
        pre_query = clone_query(request.query)

        method = str(request.method or "").strip().upper()
        path = str(request.path or "").strip() or "/"

        request_id = (
            _first_header_value(pre_headers, "x-request-id")
            or str(fallback_request_id or "").strip()
            or self._id_generator.new_id()
        )
        origin = _first_header_value(pre_headers, "origin")
        tenant_id = _extract_tenant_id(pre_headers, pre_query)
        remaining_ms = _remaining_ms(ctx)

        trace = ["request_id", "recovery", "logging"]
        if origin:
            trace.append("cors")

        def finish(resp: Response, error_code: str = "") -> Response:
            out = _finalize_p1_response(resp, request_id, origin, self._cors)
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
            error_code = exc.code if isinstance(exc, (AppError, AppTheoryError)) else "app.internal"
            return finish(respond_to_error(exc, request, request_id), error_code)

        method = normalized.method
        path = normalized.path
        tenant_id = _extract_tenant_id(normalized.headers, normalized.query)

        if self._limits.max_request_bytes > 0 and len(normalized.body) > self._limits.max_request_bytes:
            if error_responder is not None:
                return finish(
                    respond_to_error(AppError("app.too_large", "request too large"), normalized, request_id),
                    "app.too_large",
                )
            return finish(
                self._http_error_response_with_request_id(
                    "app.too_large",
                    "request too large",
                    request_id=request_id,
                ),
                "app.too_large",
            )

        match, allowed = self._router.match(normalized.method, normalized.path)
        if match is None:
            if error_responder is not None:
                if allowed:
                    return finish(
                        respond_to_error(
                            AppError("app.method_not_allowed", "method not allowed"),
                            normalized,
                            request_id,
                        ),
                        "app.method_not_allowed",
                    )
                return finish(
                    respond_to_error(AppError("app.not_found", "not found"), normalized, request_id),
                    "app.not_found",
                )
            if allowed:
                return finish(
                    self._http_error_response_with_request_id(
                        "app.method_not_allowed",
                        "method not allowed",
                        headers={"allow": [self._router.format_allow_header(allowed)]},
                        request_id=request_id,
                    ),
                    "app.method_not_allowed",
                )
            return finish(
                self._http_error_response_with_request_id(
                    "app.not_found",
                    "not found",
                    request_id=request_id,
                ),
                "app.not_found",
            )

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
            appsync=appsync,
        )
        if context_configurer is not None:
            context_configurer(request_ctx)

        policy_outcome = self._policy_check(
            request_ctx,
            request_id,
            enable_p2=enable_p2,
            error_responder=error_responder,
        )
        if policy_outcome is not None:
            resp, error_code = policy_outcome
            return finish(resp, error_code)

        auth_outcome = self._auth_check(
            request_ctx,
            auth_required=match.auth_required,
            request_id=request_id,
            trace=trace,
            error_responder=error_responder,
        )
        if auth_outcome is not None:
            resp, error_code = auth_outcome
            return finish(resp, error_code)

        trace.append("handler")

        handler = self._apply_middlewares(match.handler)
        try:
            resp = _resolve(handler(request_ctx))
        except Exception as exc:  # noqa: BLE001
            error_code = exc.code if isinstance(exc, (AppError, AppTheoryError)) else "app.internal"
            return finish(respond_to_error(exc, normalized, request_id), error_code)

        if resp is None:
            return finish(
                respond_to_error(AppError("app.internal", "internal error"), normalized, request_id),
                "app.internal",
            )

        resp = normalize_response(resp)
        if (
            self._limits.max_response_bytes > 0
            and resp.body_stream is None
            and len(resp.body) > self._limits.max_response_bytes
        ):
            if error_responder is not None:
                return finish(
                    respond_to_error(AppError("app.too_large", "response too large"), normalized, request_id),
                    "app.too_large",
                )
            return finish(
                self._http_error_response_with_request_id(
                    "app.too_large",
                    "response too large",
                    request_id=request_id,
                ),
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
            return apigw_v2_response_from_response(self._response_for_http_error(exc))

        resp = self.serve(request, ctx)
        return apigw_v2_response_from_response(resp)

    def serve_lambda_function_url(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        try:
            request = request_from_lambda_function_url(event)
        except Exception as exc:  # noqa: BLE001
            return lambda_function_url_response_from_response(self._response_for_http_error(exc))

        resp = self.serve(request, ctx)
        return lambda_function_url_response_from_response(resp)

    def serve_apigw_proxy(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        try:
            request = request_from_apigw_proxy(event)
        except Exception as exc:  # noqa: BLE001
            return apigw_proxy_response_from_response(self._response_for_http_error(exc))

        resp = self.serve(request, ctx)
        return apigw_proxy_response_from_response(resp)

    def serve_alb(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        try:
            request = request_from_alb_target_group(event)
        except Exception as exc:  # noqa: BLE001
            return alb_target_group_response_from_response(self._response_for_http_error(exc))

        resp = self.serve(request, ctx)
        return alb_target_group_response_from_response(resp)

    def serve_appsync(self, event: AppSyncResolverEvent, ctx: Any | None = None) -> Any:
        fallback_request_id = _appsync_request_id_from_ctx(ctx)
        request_metadata = _appsync_request_from_event(event)
        try:
            request = _request_from_appsync_event(event)
        except Exception as exc:  # noqa: BLE001
            return _appsync_payload_from_response(_appsync_error_response(exc, request_metadata, fallback_request_id))

        resp: Response | None = None
        try:
            resp = self._serve(
                request,
                ctx,
                lambda request_ctx: _apply_appsync_context_values(request_ctx, event),
                _appsync_context_from_event(event),
                lambda exc, error_request, request_id: _appsync_error_response(exc, error_request, request_id),
                fallback_request_id,
            )
            return _appsync_payload_from_response(resp)
        except Exception as exc:  # noqa: BLE001
            return _appsync_payload_from_response(
                _appsync_error_response(
                    exc,
                    request_metadata,
                    _appsync_request_id_from_response(resp, fallback_request_id),
                )
            )

    def serve_websocket(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        try:
            request = _request_from_websocket_event(event)
        except Exception as exc:  # noqa: BLE001
            return apigw_proxy_response_from_response(response_for_error(exc))

        try:
            normalized = normalize_request(request)
        except Exception as exc:  # noqa: BLE001
            return apigw_proxy_response_from_response(response_for_error(exc))

        request_context = event.get("requestContext") or {}
        if not isinstance(request_context, dict):
            request_context = {}

        route_key = str(request_context.get("routeKey") or "").strip()
        handler = self._ws_routes.get(route_key)
        if handler is None:
            return apigw_proxy_response_from_response(error_response("app.not_found", "not found"))

        handler = self._apply_middlewares(handler)

        request_id = str(request_context.get("requestId") or "").strip()
        if not request_id:
            request_id = self._id_generator.new_id()

        tenant_id = _extract_tenant_id(normalized.headers, normalized.query)
        remaining_ms = _remaining_ms(ctx)

        domain_name = str(request_context.get("domainName") or "").strip()
        stage = str(request_context.get("stage") or "").strip()
        management_endpoint = _websocket_management_endpoint(domain_name, stage, str(event.get("path") or ""))

        ws_ctx = WebSocketContext(
            clock=self._clock,
            id_generator=self._id_generator,
            ctx=ctx,
            request_id=request_id,
            remaining_ms=remaining_ms,
            connection_id=str(request_context.get("connectionId") or "").strip(),
            route_key=route_key,
            domain_name=domain_name,
            stage=stage,
            event_type=str(request_context.get("eventType") or "").strip(),
            management_endpoint=management_endpoint,
            body=normalized.body,
            client_factory=self._websocket_client_factory,
        )

        request_ctx = Context(
            request=normalized,
            params={},
            clock=self._clock,
            id_generator=self._id_generator,
            ctx=ctx,
            request_id=request_id,
            tenant_id=tenant_id,
            auth_identity="",
            remaining_ms=remaining_ms,
            middleware_trace=[],
            websocket=ws_ctx,
        )

        try:
            resp = _resolve(handler(request_ctx))
        except Exception as exc:  # noqa: BLE001
            return apigw_proxy_response_from_response(response_for_error(exc))

        return apigw_proxy_response_from_response(normalize_response(resp))

    def _event_context(self, ctx: Any | None) -> EventContext:
        request_id = ""
        if ctx is not None:
            request_id = str(getattr(ctx, "aws_request_id", "") or getattr(ctx, "awsRequestId", "") or "").strip()
        if not request_id:
            request_id = self._id_generator.new_id()
        return EventContext(
            clock=self._clock,
            id_generator=self._id_generator,
            ctx=ctx,
            request_id=request_id,
            remaining_ms=_remaining_ms(ctx),
        )

    def _sqs_handler_for_event(self, event: dict[str, Any]) -> SQSHandler | None:
        records = event.get("Records") or []
        if not isinstance(records, list) or not records:
            return None
        first = records[0] if isinstance(records[0], dict) else {}
        queue_name = _sqs_queue_name_from_arn(str(first.get("eventSourceARN") or ""))
        if not queue_name:
            return None
        for name, handler in self._sqs_routes:
            if name == queue_name:
                return handler
        return None

    def serve_sqs(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        records = event.get("Records") or []
        if not isinstance(records, list):
            records = []

        handler = self._sqs_handler_for_event(event)
        if handler is None:
            failures = []
            for record in records:
                if not isinstance(record, dict):
                    continue
                msg_id = str(record.get("messageId") or "").strip()
                if msg_id:
                    failures.append({"itemIdentifier": msg_id})
            return {"batchItemFailures": failures}

        evt_ctx = self._event_context(ctx)
        wrapped = self._apply_event_middlewares(handler)
        failures = []
        for record in records:
            if not isinstance(record, dict):
                continue
            try:
                _resolve(wrapped(evt_ctx, record))
            except Exception:  # noqa: BLE001
                msg_id = str(record.get("messageId") or "").strip()
                if msg_id:
                    failures.append({"itemIdentifier": msg_id})

        return {"batchItemFailures": failures}

    def _eventbridge_handler_for_event(self, event: dict[str, Any]) -> EventBridgeHandler | None:
        source = str(event.get("source") or "").strip()
        detail_type = str(event.get("detail-type") or event.get("detailType") or "").strip()
        resources = event.get("resources") or []

        for selector, handler in self._eventbridge_routes:
            if selector.rule_name:
                if isinstance(resources, list):
                    for resource in resources:
                        if _eventbridge_rule_name_from_arn(str(resource or "")) == selector.rule_name:
                            return handler
                continue

            if selector.source and selector.source != source:
                continue
            if selector.detail_type and selector.detail_type != detail_type:
                continue
            return handler

        return None

    def serve_eventbridge(self, event: dict[str, Any], ctx: Any | None = None) -> Any:
        handler = self._eventbridge_handler_for_event(event)
        if handler is None:
            return None
        wrapped = self._apply_event_middlewares(handler)
        return _resolve(wrapped(self._event_context(ctx), event))

    def _dynamodb_handler_for_event(self, event: dict[str, Any]) -> DynamoDBStreamHandler | None:
        records = event.get("Records") or []
        if not isinstance(records, list) or not records:
            return None
        first = records[0] if isinstance(records[0], dict) else {}
        table_name = _dynamodb_table_name_from_stream_arn(str(first.get("eventSourceARN") or ""))
        if not table_name:
            return None
        for name, handler in self._dynamodb_routes:
            if name == table_name:
                return handler
        return None

    def serve_dynamodb_stream(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        records = event.get("Records") or []
        if not isinstance(records, list):
            records = []

        handler = self._dynamodb_handler_for_event(event)
        if handler is None:
            failures = []
            for record in records:
                if not isinstance(record, dict):
                    continue
                event_id = str(record.get("eventID") or "").strip()
                if event_id:
                    failures.append({"itemIdentifier": event_id})
            return {"batchItemFailures": failures}

        evt_ctx = self._event_context(ctx)
        wrapped = self._apply_event_middlewares(handler)
        failures = []
        for record in records:
            if not isinstance(record, dict):
                continue
            try:
                _resolve(wrapped(evt_ctx, record))
            except Exception:  # noqa: BLE001
                event_id = str(record.get("eventID") or "").strip()
                if event_id:
                    failures.append({"itemIdentifier": event_id})

        return {"batchItemFailures": failures}

    def _kinesis_handler_for_event(self, event: dict[str, Any]) -> KinesisHandler | None:
        records = event.get("Records") or []
        if not isinstance(records, list) or not records:
            return None
        first = records[0] if isinstance(records[0], dict) else {}
        stream_name = _kinesis_stream_name_from_arn(str(first.get("eventSourceARN") or ""))
        if not stream_name:
            return None
        for name, handler in self._kinesis_routes:
            if name == stream_name:
                return handler
        return None

    def serve_kinesis(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        records = event.get("Records") or []
        if not isinstance(records, list):
            records = []

        handler = self._kinesis_handler_for_event(event)
        if handler is None:
            failures = []
            for record in records:
                if not isinstance(record, dict):
                    continue
                event_id = str(record.get("eventID") or "").strip()
                if event_id:
                    failures.append({"itemIdentifier": event_id})
            return {"batchItemFailures": failures}

        evt_ctx = self._event_context(ctx)
        wrapped = self._apply_event_middlewares(handler)
        failures = []
        for record in records:
            if not isinstance(record, dict):
                continue
            try:
                _resolve(wrapped(evt_ctx, record))
            except Exception:  # noqa: BLE001
                event_id = str(record.get("eventID") or "").strip()
                if event_id:
                    failures.append({"itemIdentifier": event_id})

        return {"batchItemFailures": failures}

    def _sns_handler_for_event(self, event: dict[str, Any]) -> SNSHandler | None:
        records = event.get("Records") or []
        if not isinstance(records, list) or not records:
            return None
        first = records[0] if isinstance(records[0], dict) else {}
        sns = first.get("Sns") if isinstance(first.get("Sns"), dict) else {}
        topic_name = _sns_topic_name_from_arn(str(sns.get("TopicArn") or ""))
        if not topic_name:
            return None
        for name, handler in self._sns_routes:
            if name == topic_name:
                return handler
        return None

    def serve_sns(self, event: dict[str, Any], ctx: Any | None = None) -> Any:
        records = event.get("Records") or []
        if not isinstance(records, list):
            records = []

        handler = self._sns_handler_for_event(event)
        if handler is None:
            raise RuntimeError("apptheory: unrecognized sns topic")

        evt_ctx = self._event_context(ctx)
        wrapped = self._apply_event_middlewares(handler)
        outputs: list[Any] = []
        for record in records:
            if not isinstance(record, dict):
                continue
            outputs.append(_resolve(wrapped(evt_ctx, record)))

        return outputs

    def handle_lambda(self, event: Any, ctx: Any | None = None) -> Any:
        if not isinstance(event, dict):
            raise RuntimeError("apptheory: unknown event type")

        records = event.get("Records") or []
        if isinstance(records, list) and records:
            first = records[0] if isinstance(records[0], dict) else {}
            source = str(first.get("eventSource") or first.get("EventSource") or "").strip()
            if source == "aws:sqs":
                return self.serve_sqs(event, ctx=ctx)
            if source == "aws:dynamodb":
                return self.serve_dynamodb_stream(event, ctx=ctx)
            if source == "aws:kinesis":
                return self.serve_kinesis(event, ctx=ctx)
            if source == "aws:sns":
                return self.serve_sns(event, ctx=ctx)

        if "detail-type" in event or "detailType" in event:
            return self.serve_eventbridge(event, ctx=ctx)
        if _is_appsync_event(event):
            return self.serve_appsync(event, ctx=ctx)

        if "requestContext" in event:
            request_context = event.get("requestContext") or {}
            if isinstance(request_context, dict) and request_context.get("connectionId"):
                return self.serve_websocket(event, ctx=ctx)
            if isinstance(request_context, dict) and "http" in request_context:
                if "routeKey" in event:
                    return self.serve_apigw_v2(event, ctx=ctx)
                return self.serve_lambda_function_url(event, ctx=ctx)
            if (
                isinstance(request_context, dict)
                and isinstance(request_context.get("elb"), dict)
                and str((request_context.get("elb") or {}).get("targetGroupArn") or "").strip()
            ):
                return self.serve_alb(event, ctx=ctx)
            if "httpMethod" in event:
                return self.serve_apigw_proxy(event, ctx=ctx)

        raise RuntimeError("apptheory: unknown event type")


def create_app(
    *,
    clock: Clock | None = None,
    id_generator: IdGenerator | None = None,
    tier: str = "p2",
    http_error_format: str = HTTP_ERROR_FORMAT_NESTED,
    limits: Limits | None = None,
    cors: CORSConfig | None = None,
    auth_hook: AuthHook | None = None,
    observability: ObservabilityHooks | None = None,
    policy_hook: PolicyHook | None = None,
    websocket_client_factory: WebSocketClientFactory | None = None,
) -> App:
    return App(
        clock=clock,
        id_generator=id_generator,
        tier=tier,
        http_error_format=http_error_format,
        limits=limits,
        cors=cors,
        auth_hook=auth_hook,
        observability=observability,
        policy_hook=policy_hook,
        websocket_client_factory=websocket_client_factory,
    )


def _default_websocket_client_factory(endpoint: str, _ctx: Any | None):
    from apptheory.streamer import Client

    return Client(endpoint)


def _request_from_websocket_event(event: dict[str, Any]) -> Request:
    headers = event.get("headers") or {}
    if not isinstance(headers, dict):
        headers = {}

    multi = event.get("multiValueQueryStringParameters")
    single = event.get("queryStringParameters")
    query: dict[str, list[str]] = {}
    if isinstance(multi, dict):
        for key, values in multi.items():
            if values is None:
                continue
            if isinstance(values, list):
                query[str(key)] = [str(v) for v in values]
            else:
                query[str(key)] = [str(values)]
    elif isinstance(single, dict):
        for key, value in single.items():
            query[str(key)] = [str(value)]

    return Request(
        method=str(event.get("httpMethod") or "").strip().upper(),
        path=str(event.get("path") or "/"),
        query=query,
        headers=headers,
        body=str(event.get("body") or ""),
        is_base64=bool(event.get("isBase64Encoded")),
    )


def _request_from_appsync_event(event: AppSyncResolverEvent | dict[str, Any]) -> Request:
    if not isinstance(event, dict):
        raise AppError("app.bad_request", "invalid appsync event")

    info = event.get("info") or {}
    if not isinstance(info, dict):
        info = {}

    field_name = str(info.get("fieldName") or "").strip()
    parent_type_name = str(info.get("parentTypeName") or "").strip()
    if not field_name or not parent_type_name:
        raise AppError("app.bad_request", "invalid appsync event")

    request_info = event.get("request") or {}
    if not isinstance(request_info, dict):
        request_info = {}
    headers = request_info.get("headers") or {}
    if not isinstance(headers, dict):
        headers = {}
    normalized_headers = {str(key): str(value) for key, value in headers.items() if str(key).strip()}
    if "content-type" not in {str(key).strip().lower() for key in normalized_headers}:
        normalized_headers["content-type"] = "application/json; charset=utf-8"

    arguments = event.get("arguments")
    if arguments is None:
        body = b""
    elif isinstance(arguments, dict):
        body = json.dumps(arguments, ensure_ascii=False, sort_keys=True).encode("utf-8") if arguments else b""
    else:
        raise AppError("app.bad_request", "invalid appsync event")

    return Request(
        method=_appsync_method(parent_type_name),
        path=f"/{field_name}",
        headers=normalized_headers,
        body=body,
        is_base64=False,
    )


def _is_appsync_event(event: Any) -> bool:
    if not isinstance(event, dict):
        return False
    if "arguments" not in event:
        return False

    info = event.get("info") or {}
    if not isinstance(info, dict):
        return False

    field_name = str(info.get("fieldName") or "").strip()
    parent_type_name = str(info.get("parentTypeName") or "").strip()
    return bool(field_name and parent_type_name)


def _apply_appsync_context_values(request_ctx: Context, event: AppSyncResolverEvent | dict[str, Any]) -> None:
    if not isinstance(event, dict):
        return

    request_ctx.appsync = _appsync_context_from_event(event)

    info = event.get("info") or {}
    if not isinstance(info, dict):
        info = {}

    request_info = event.get("request") or {}
    if not isinstance(request_info, dict):
        request_info = {}
    request_headers = request_info.get("headers") or {}
    if not isinstance(request_headers, dict):
        request_headers = {}

    request_ctx.set("apptheory.trigger_type", "appsync")
    request_ctx.set("apptheory.appsync.field_name", str(info.get("fieldName") or "").strip())
    request_ctx.set("apptheory.appsync.parent_type_name", str(info.get("parentTypeName") or "").strip())
    request_ctx.set("apptheory.appsync.arguments", event.get("arguments") or {})
    request_ctx.set("apptheory.appsync.identity", event.get("identity") or {})
    request_ctx.set("apptheory.appsync.source", event.get("source") or {})
    request_ctx.set("apptheory.appsync.variables", info.get("variables") or {})
    request_ctx.set("apptheory.appsync.prev", event.get("prev"))
    request_ctx.set("apptheory.appsync.stash", event.get("stash") or {})
    request_ctx.set(
        "apptheory.appsync.request_headers",
        {str(key): str(value) for key, value in request_headers.items() if str(key).strip()},
    )
    request_ctx.set("apptheory.appsync.raw_event", event)


def _appsync_context_from_event(event: AppSyncResolverEvent | dict[str, Any]) -> AppSyncContext:
    if not isinstance(event, dict):
        return AppSyncContext()

    info = event.get("info") or {}
    if not isinstance(info, dict):
        info = {}

    request_info = event.get("request") or {}
    if not isinstance(request_info, dict):
        request_info = {}
    request_headers = request_info.get("headers") or {}
    if not isinstance(request_headers, dict):
        request_headers = {}

    return AppSyncContext(
        field_name=str(info.get("fieldName") or "").strip(),
        parent_type_name=str(info.get("parentTypeName") or "").strip(),
        arguments=dict(event.get("arguments") or {}),
        identity=dict(event.get("identity") or {}),
        source=dict(event.get("source") or {}),
        variables=dict(info.get("variables") or {}),
        stash=dict(event.get("stash") or {}),
        prev=event.get("prev"),
        request_headers={str(key): str(value) for key, value in request_headers.items() if str(key).strip()},
        raw_event=dict(event),
    )


def _appsync_method(parent_type_name: str) -> str:
    parent = str(parent_type_name or "").strip()
    if parent in {"Query", "Subscription"}:
        return "GET"
    return "POST"


_APPSYNC_PROJECTION_MESSAGE = "unsupported appsync response"
_APPSYNC_PROJECTION_BINARY_REASON = "binary_body_unsupported"
_APPSYNC_PROJECTION_STREAM_REASON = "streaming_body_unsupported"
_APPSYNC_ERROR_TYPE_CLIENT = "CLIENT_ERROR"
_APPSYNC_ERROR_TYPE_SYSTEM = "SYSTEM_ERROR"


def _appsync_request_from_event(event: AppSyncResolverEvent) -> Request:
    info = event.get("info") or {}
    if not isinstance(info, dict):
        info = {}
    field_name = str(info.get("fieldName") or "").strip()
    parent_type_name = str(info.get("parentTypeName") or "").strip()
    if not field_name or not parent_type_name:
        return Request(method="", path="/", headers={}, body=b"", is_base64=False)
    return Request(
        method=_appsync_method(parent_type_name),
        path="/" + field_name,
        headers={},
        body=b"",
        is_base64=False,
    )


def _appsync_request_id_from_ctx(ctx: Any | None) -> str:
    return str(getattr(ctx, "aws_request_id", "") or getattr(ctx, "awsRequestId", "") or "").strip()


def _appsync_request_id_from_response(resp: Response | None, fallback_request_id: str) -> str:
    if resp is None:
        return str(fallback_request_id or "").strip()
    normalized = normalize_response(resp)
    return _first_header_value(normalized.headers, "x-request-id") or str(fallback_request_id or "").strip()


def _appsync_error_type_for_status(status: int) -> str:
    return _APPSYNC_ERROR_TYPE_CLIENT if 400 <= int(status) < 500 else _APPSYNC_ERROR_TYPE_SYSTEM


def _appsync_status_for_error(exc: Exception) -> int:
    if isinstance(exc, AppTheoryError):
        if exc.status_code and exc.status_code > 0:
            return int(exc.status_code)
        return status_for_error_code(exc.code)
    if isinstance(exc, AppError):
        return status_for_error_code(exc.code)
    return 500


def _appsync_portable_error_payload(
    *,
    code: str,
    message: str,
    status: int,
    details: dict[str, Any] | None,
    request_id: str,
    trace_id: str,
    timestamp: str,
    request: Request,
) -> dict[str, Any]:
    resolved_code = str(code or "").strip() or "app.internal"
    resolved_status = int(status) if int(status) > 0 else status_for_error_code(resolved_code)

    error_data: dict[str, Any] = {"status_code": resolved_status}
    resolved_request_id = str(request_id or "").strip()
    if resolved_request_id:
        error_data["request_id"] = resolved_request_id
    resolved_trace_id = str(trace_id or "").strip()
    if resolved_trace_id:
        error_data["trace_id"] = resolved_trace_id
    resolved_timestamp = str(timestamp or "").strip()
    if resolved_timestamp:
        error_data["timestamp"] = resolved_timestamp

    error_info: dict[str, Any] = {
        "code": resolved_code,
        "trigger_type": "appsync",
    }
    method = str(request.method or "").strip()
    if method:
        error_info["method"] = method
    path = str(request.path or "").strip()
    if path:
        error_info["path"] = path
    if details:
        error_info["details"] = dict(details)

    return {
        "pay_theory_error": True,
        "error_message": str(message or ""),
        "error_type": _appsync_error_type_for_status(resolved_status),
        "error_data": error_data,
        "error_info": error_info,
    }


def _appsync_error_payload(exc: Exception, request: Request, request_id: str) -> dict[str, Any]:
    if isinstance(exc, AppTheoryError):
        return _appsync_portable_error_payload(
            code=exc.code,
            message=exc.message,
            status=exc.status_code or status_for_error_code(exc.code),
            details=exc.details,
            request_id=str(exc.request_id or "").strip() or str(request_id or "").strip(),
            trace_id=str(exc.trace_id or "").strip(),
            timestamp=str(exc.timestamp or "").strip(),
            request=request,
        )
    if isinstance(exc, AppError):
        return _appsync_portable_error_payload(
            code=exc.code,
            message=exc.message,
            status=status_for_error_code(exc.code),
            details=None,
            request_id=str(request_id or "").strip(),
            trace_id="",
            timestamp="",
            request=request,
        )

    return {
        "pay_theory_error": True,
        "error_message": str(exc or "internal error"),
        "error_type": _APPSYNC_ERROR_TYPE_SYSTEM,
        "error_data": {},
        "error_info": {},
    }


def _appsync_error_response(exc: Exception, request: Request, request_id: str) -> Response:
    body = json.dumps(
        _appsync_error_payload(exc, request, request_id),
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")
    return normalize_response(
        Response(
            status=_appsync_status_for_error(exc),
            headers={"content-type": ["application/json; charset=utf-8"]},
            cookies=[],
            body=body,
            is_base64=False,
        )
    )


def _appsync_payload_from_response(resp: Response) -> Any:
    normalized = normalize_response(resp)
    if normalized.is_base64:
        raise AppTheoryError(
            code="app.internal",
            message=_APPSYNC_PROJECTION_MESSAGE,
            status_code=500,
            details={"reason": _APPSYNC_PROJECTION_BINARY_REASON},
        )
    if normalized.body_stream is not None:
        raise AppTheoryError(
            code="app.internal",
            message=_APPSYNC_PROJECTION_MESSAGE,
            status_code=500,
            details={"reason": _APPSYNC_PROJECTION_STREAM_REASON},
        )
    if not normalized.body:
        return None

    content_type_values = normalized.headers.get("content-type", [])
    for value in content_type_values:
        if str(value).strip().lower().startswith("application/json"):
            try:
                return json.loads(normalized.body.decode("utf-8"))
            except Exception as exc:
                raise AppError("app.internal", "internal error") from exc

    first_content_type = str(content_type_values[0]).strip().lower() if content_type_values else ""
    if first_content_type.startswith("text/"):
        return normalized.body.decode("utf-8", errors="replace")
    return normalized.body.decode("utf-8", errors="replace")


def _websocket_management_endpoint(domain_name: str, stage: str, path: str = "") -> str:
    domain = str(domain_name or "").strip().strip("/")
    if not domain:
        return ""
    domain = domain.removeprefix("https://").removeprefix("http://").rstrip("/")
    if not domain:
        return ""

    host_lower = domain.lower()
    if ".execute-api." in host_lower:
        stage_value = str(stage or "").strip().strip("/")
        if not stage_value:
            return ""
        return "https://" + domain + "/" + stage_value

    base_path = str(path or "").strip().strip("/")
    if not base_path:
        return "https://" + domain
    return "https://" + domain + "/" + base_path


def _sqs_queue_name_from_arn(arn: str) -> str:
    value = str(arn or "").strip()
    if not value:
        return ""
    parts = value.split(":")
    return parts[-1] if parts else ""


def _kinesis_stream_name_from_arn(arn: str) -> str:
    value = str(arn or "").strip()
    if not value:
        return ""
    parts = value.split(":")
    last = parts[-1] if parts else ""
    if not last:
        return ""
    if "/" in last:
        return last.split("/", 1)[1].strip()
    return last.strip()


def _sns_topic_name_from_arn(arn: str) -> str:
    value = str(arn or "").strip()
    if not value:
        return ""
    parts = value.split(":")
    return parts[-1].strip() if parts else ""


def _eventbridge_rule_name_from_arn(arn: str) -> str:
    value = str(arn or "").strip()
    if not value:
        return ""

    marker = ":rule/"
    idx = value.find(marker)
    if idx >= 0:
        after = value[idx + len(marker) :].lstrip("/")
    else:
        marker = "rule/"
        idx = value.find(marker)
        if idx < 0:
            return ""
        after = value[idx + len(marker) :].lstrip("/")

    if not after:
        return ""
    return after.split("/", 1)[0]


def _dynamodb_table_name_from_stream_arn(arn: str) -> str:
    value = str(arn or "").strip()
    if not value:
        return ""
    marker = ":table/"
    idx = value.find(marker)
    if idx < 0:
        return ""
    after = value[idx + len(marker) :]
    stream_idx = after.find("/stream/")
    if stream_idx >= 0:
        return after[:stream_idx]
    return after.split("/", 1)[0]


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


def _normalize_cors_config(cors: CORSConfig | None) -> CORSConfig:
    if cors is None:
        return CORSConfig()

    allowed_origins: list[str] | None
    if cors.allowed_origins is None:
        allowed_origins = None
    else:
        allowed_origins = []
        for origin in cors.allowed_origins:
            trimmed = str(origin or "").strip()
            if not trimmed:
                continue
            if trimmed == "*":
                allowed_origins = ["*"]
                break
            allowed_origins.append(trimmed)

    allow_headers: list[str] | None
    if cors.allow_headers is None:
        allow_headers = None
    else:
        allow_headers = []
        for header in cors.allow_headers:
            trimmed = str(header or "").strip()
            if not trimmed:
                continue
            allow_headers.append(trimmed)

    return CORSConfig(
        allowed_origins=allowed_origins,
        allow_credentials=bool(cors.allow_credentials),
        allow_headers=allow_headers,
    )


def _cors_origin_allowed(origin: str, cors: CORSConfig) -> bool:
    origin_value = str(origin or "").strip()
    if not origin_value:
        return False

    if cors.allowed_origins is None:
        return True
    if not cors.allowed_origins:
        return False

    return any(allowed == "*" or allowed == origin_value for allowed in cors.allowed_origins)


def _cors_allow_headers_value(cors: CORSConfig) -> str:
    if cors.allow_headers:
        return ", ".join([str(h) for h in cors.allow_headers if str(h).strip()])
    if cors.allow_credentials:
        return "Content-Type, Authorization"
    return ""


def _finalize_p1_response(resp: Response, request_id: str, origin: str, cors: CORSConfig) -> Response:
    headers = canonicalize_headers(resp.headers)
    if request_id:
        headers["x-request-id"] = [str(request_id)]
    if origin and _cors_origin_allowed(origin, cors):
        headers["access-control-allow-origin"] = [str(origin)]
        headers["vary"] = vary(headers.get("vary"), "origin")
        if cors.allow_credentials:
            headers["access-control-allow-credentials"] = ["true"]
        allow_headers = _cors_allow_headers_value(cors)
        if allow_headers:
            headers["access-control-allow-headers"] = [allow_headers]
    return normalize_response(
        Response(
            status=resp.status,
            headers=headers,
            cookies=resp.cookies,
            body=resp.body,
            is_base64=resp.is_base64,
            body_stream=resp.body_stream,
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
