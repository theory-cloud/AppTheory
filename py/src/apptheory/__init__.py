"""AppTheory Python SDK/runtime entrypoint."""

from __future__ import annotations

from apptheory.app import (
    App,
    EventBridgeSelector,
    Limits,
    ObservabilityHooks,
    PolicyDecision,
    create_app,
    event_bridge_pattern,
    event_bridge_rule,
)
from apptheory.aws_events import build_dynamodb_stream_event, build_eventbridge_event, build_sqs_event
from apptheory.aws_http import build_apigw_v2_request, build_lambda_function_url_request
from apptheory.clock import Clock, ManualClock, RealClock
from apptheory.context import Context, EventContext, WebSocketContext
from apptheory.errors import AppError
from apptheory.ids import IdGenerator, ManualIdGenerator, RealIdGenerator
from apptheory.request import Request
from apptheory.response import Response, binary, json, text
from apptheory.sse import SSEEvent, sse, sse_event_stream
from apptheory.testkit import (
    FakeWebSocketClientFactory,
    FakeWebSocketManagementClient,
    TestEnv,
    WebSocketCall,
    build_websocket_event,
    create_fake_websocket_client_factory,
    create_test_env,
)

__all__ = [
    "App",
    "AppError",
    "Clock",
    "Context",
    "EventBridgeSelector",
    "EventContext",
    "Limits",
    "ObservabilityHooks",
    "PolicyDecision",
    "WebSocketContext",
    "IdGenerator",
    "ManualClock",
    "ManualIdGenerator",
    "RealClock",
    "RealIdGenerator",
    "Request",
    "Response",
    "SSEEvent",
    "FakeWebSocketClientFactory",
    "FakeWebSocketManagementClient",
    "TestEnv",
    "WebSocketCall",
    "build_apigw_v2_request",
    "build_dynamodb_stream_event",
    "build_eventbridge_event",
    "build_lambda_function_url_request",
    "build_sqs_event",
    "build_websocket_event",
    "binary",
    "create_app",
    "create_fake_websocket_client_factory",
    "create_test_env",
    "event_bridge_pattern",
    "event_bridge_rule",
    "json",
    "sse",
    "sse_event_stream",
    "text",
]
