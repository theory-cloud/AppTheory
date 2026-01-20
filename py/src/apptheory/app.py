from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from apptheory.aws_http import (
    apigw_proxy_response_from_response,
    apigw_v2_response_from_response,
    lambda_function_url_response_from_response,
    request_from_apigw_proxy,
    request_from_apigw_v2,
    request_from_lambda_function_url,
)
from apptheory.cache import vary
from apptheory.clock import Clock, RealClock
from apptheory.context import Context, EventContext, WebSocketClientFactory, WebSocketContext
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
Middleware = Callable[[Context, Handler], Response]
AuthHook = Callable[[Context], str]
PolicyHook = Callable[[Context], "PolicyDecision | None"]
EventHandler = Callable[[EventContext, dict[str, Any]], Any]
EventMiddleware = Callable[[EventContext, dict[str, Any], Callable[[], Any]], Any]
SQSHandler = Callable[[EventContext, dict[str, Any]], None]
DynamoDBStreamHandler = Callable[[EventContext, dict[str, Any]], None]
EventBridgeHandler = Callable[[EventContext, dict[str, Any]], Any]
WebSocketHandler = Callable[[Context], Response]


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
    _limits: Limits
    _cors: CORSConfig
    _auth_hook: AuthHook | None
    _observability: ObservabilityHooks
    _policy_hook: PolicyHook | None
    _sqs_routes: list[tuple[str, SQSHandler]]
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
        self._limits = limits or Limits()
        self._cors = _normalize_cors_config(cors)
        self._auth_hook = auth_hook
        self._observability = observability or ObservabilityHooks()
        self._policy_hook = policy_hook
        self._sqs_routes = []
        self._eventbridge_routes = []
        self._dynamodb_routes = []
        self._ws_routes = {}
        self._websocket_client_factory = websocket_client_factory or _default_websocket_client_factory
        self._middlewares = []
        self._event_middlewares = []

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

    def sqs(self, queue_name: str, handler: SQSHandler) -> App:
        name = str(queue_name or "").strip()
        if not name:
            return self
        self._sqs_routes.append((name, handler))
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
                def _wrapped(ctx: Context) -> Response:
                    return mw(ctx, next_handler)

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
                    return mw(ctx, event, lambda: next_handler(ctx, event))

                return _wrapped

            wrapped = apply_one(wrapped)
        return wrapped

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

        handler = self._apply_middlewares(match.handler)
        try:
            resp = handler(request_ctx)
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
            return finish(
                error_response_with_request_id("app.not_found", "not found", request_id=request_id),
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

        handler = self._apply_middlewares(match.handler)
        try:
            resp = handler(request_ctx)
        except AppError as exc:
            return finish(error_response_with_request_id(exc.code, exc.message, request_id=request_id), exc.code)
        except Exception as exc:  # noqa: BLE001
            return finish(response_for_error_with_request_id(exc, request_id), "app.internal")

        resp = normalize_response(resp)
        if self._limits.max_response_bytes > 0 and resp.body_stream is None and len(resp.body) > self._limits.max_response_bytes:
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

    def serve_apigw_proxy(self, event: dict[str, Any], ctx: Any | None = None) -> dict[str, Any]:
        try:
            request = request_from_apigw_proxy(event)
        except Exception as exc:  # noqa: BLE001
            return apigw_proxy_response_from_response(response_for_error(exc))

        resp = self.serve(request, ctx)
        return apigw_proxy_response_from_response(resp)

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
        management_endpoint = _websocket_management_endpoint(domain_name, stage)

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
            resp = handler(request_ctx)
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
                wrapped(evt_ctx, record)
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
        return wrapped(self._event_context(ctx), event)

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
                wrapped(evt_ctx, record)
            except Exception:  # noqa: BLE001
                event_id = str(record.get("eventID") or "").strip()
                if event_id:
                    failures.append({"itemIdentifier": event_id})

        return {"batchItemFailures": failures}

    def handle_lambda(self, event: Any, ctx: Any | None = None) -> Any:
        if not isinstance(event, dict):
            raise RuntimeError("apptheory: unknown event type")

        records = event.get("Records") or []
        if isinstance(records, list) and records:
            first = records[0] if isinstance(records[0], dict) else {}
            source = str(first.get("eventSource") or "").strip()
            if source == "aws:sqs":
                return self.serve_sqs(event, ctx=ctx)
            if source == "aws:dynamodb":
                return self.serve_dynamodb_stream(event, ctx=ctx)

        if "detail-type" in event or "detailType" in event:
            return self.serve_eventbridge(event, ctx=ctx)

        if "requestContext" in event:
            request_context = event.get("requestContext") or {}
            if isinstance(request_context, dict) and request_context.get("connectionId"):
                return self.serve_websocket(event, ctx=ctx)
            if isinstance(request_context, dict) and "http" in request_context:
                if "routeKey" in event:
                    return self.serve_apigw_v2(event, ctx=ctx)
                return self.serve_lambda_function_url(event, ctx=ctx)
            if "httpMethod" in event:
                return self.serve_apigw_proxy(event, ctx=ctx)

        raise RuntimeError("apptheory: unknown event type")


def create_app(
    *,
    clock: Clock | None = None,
    id_generator: IdGenerator | None = None,
    tier: str = "p2",
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


def _websocket_management_endpoint(domain_name: str, stage: str) -> str:
    domain = str(domain_name or "").strip().strip("/")
    if not domain:
        return ""
    if domain.startswith("https://") or domain.startswith("http://"):
        base = domain
    else:
        base = "https://" + domain

    stage_value = str(stage or "").strip().strip("/")
    if not stage_value:
        return base
    return base + "/" + stage_value


def _sqs_queue_name_from_arn(arn: str) -> str:
    value = str(arn or "").strip()
    if not value:
        return ""
    parts = value.split(":")
    return parts[-1] if parts else ""


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

    for allowed in cors.allowed_origins:
        if allowed == "*" or allowed == origin_value:
            return True
    return False


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
