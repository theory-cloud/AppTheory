"""AppTheory Python SDK/runtime entrypoint."""

from __future__ import annotations

from apptheory.app import (
    App,
    CORSConfig,
    EventBridgeSelector,
    Limits,
    ObservabilityHooks,
    PolicyDecision,
    create_app,
    event_bridge_pattern,
    event_bridge_rule,
)
from apptheory.aws_events import (
    build_dynamodb_stream_event,
    build_eventbridge_event,
    build_kinesis_event,
    build_sns_event,
    build_sqs_event,
    build_stepfunctions_task_token_event,
    stepfunctions_task_token,
)
from apptheory.aws_http import build_alb_target_group_request, build_apigw_v2_request, build_lambda_function_url_request
from apptheory.cache import cache_control_isr, cache_control_ssg, cache_control_ssr, etag, matches_if_none_match, vary
from apptheory.clock import Clock, ManualClock, RealClock
from apptheory.cloudfront import client_ip, origin_url
from apptheory.context import Context, EventContext, WebSocketContext
from apptheory.errors import AppError, AppTheoryError
from apptheory.ids import IDGenerator, IdGenerator, ManualIdGenerator, RealIdGenerator
from apptheory.logger import NoOpLogger, StructuredLogger, get_logger, set_logger
from apptheory.middleware import TimeoutConfig, timeout_middleware
from apptheory.naming import base_name, normalize_stage, resource_name
from apptheory.request import Request
from apptheory.response import Response, binary, html, html_stream, json, safe_json_for_html, text
from apptheory.sanitization import (
    mask_first_last,
    mask_first_last4,
    payment_xml_patterns,
    rapid_connect_xml_patterns,
    sanitize_field_value,
    sanitize_json,
    sanitize_log_string,
    sanitize_xml,
)
from apptheory.sse import SSEEvent, sse, sse_event_stream
from apptheory.testkit import (
    FakeWebSocketClientFactory,
    FakeWebSocketManagementClient,
    StreamResult,
    TestEnv,
    WebSocketCall,
    build_websocket_event,
    create_fake_websocket_client_factory,
    create_test_env,
)

__all__ = [
    "App",
    "AppError",
    "AppTheoryError",
    "CORSConfig",
    "Clock",
    "Context",
    "EventBridgeSelector",
    "EventContext",
    "FakeWebSocketClientFactory",
    "FakeWebSocketManagementClient",
    "IDGenerator",
    "IdGenerator",
    "Limits",
    "ManualClock",
    "ManualIdGenerator",
    "NoOpLogger",
    "ObservabilityHooks",
    "PolicyDecision",
    "RealClock",
    "RealIdGenerator",
    "Request",
    "Response",
    "SSEEvent",
    "StreamResult",
    "StructuredLogger",
    "TestEnv",
    "TimeoutConfig",
    "WebSocketCall",
    "WebSocketContext",
    "base_name",
    "binary",
    "build_alb_target_group_request",
    "build_apigw_v2_request",
    "build_dynamodb_stream_event",
    "build_eventbridge_event",
    "build_kinesis_event",
    "build_lambda_function_url_request",
    "build_sns_event",
    "build_sqs_event",
    "build_stepfunctions_task_token_event",
    "build_websocket_event",
    "cache_control_isr",
    "cache_control_ssg",
    "cache_control_ssr",
    "client_ip",
    "create_app",
    "create_fake_websocket_client_factory",
    "create_test_env",
    "etag",
    "event_bridge_pattern",
    "event_bridge_rule",
    "get_logger",
    "html",
    "html_stream",
    "json",
    "matches_if_none_match",
    "mask_first_last",
    "mask_first_last4",
    "normalize_stage",
    "origin_url",
    "payment_xml_patterns",
    "rapid_connect_xml_patterns",
    "resource_name",
    "safe_json_for_html",
    "sanitize_field_value",
    "sanitize_json",
    "sanitize_log_string",
    "sanitize_xml",
    "set_logger",
    "sse",
    "sse_event_stream",
    "stepfunctions_task_token",
    "text",
    "timeout_middleware",
    "vary",
]
