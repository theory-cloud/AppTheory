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
    AppSyncResolverEvent,
    AppSyncResolverInfo,
    AppSyncResolverRequest,
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
from apptheory.cloudfront import client_ip, origin_url, original_host, original_uri
from apptheory.context import AppSyncContext, Context, EventContext, WebSocketContext
from apptheory.errors import (
    HTTP_ERROR_FORMAT_FLAT_LEGACY,
    HTTP_ERROR_FORMAT_NESTED,
    AppError,
    AppTheoryError,
)
from apptheory.event_workloads import (
    DynamoDBStreamRecordSummary,
    EventBridgeScheduledWorkloadResultSummary,
    EventBridgeScheduledWorkloadSummary,
    EventBridgeWorkloadEnvelope,
    normalize_dynamodb_stream_record,
    normalize_eventbridge_scheduled_workload,
    normalize_eventbridge_workload_envelope,
    require_eventbridge_workload_envelope,
)
from apptheory.ids import IDGenerator, IdGenerator, ManualIdGenerator, RealIdGenerator

try:
    from apptheory.jobs import (  # type: ignore
        DEFAULT_JOBS_TABLE_NAME,
        DynamoJobLedger,
        EnvJobsTableName,
        JobLedgerError,
        JobsConfig,
        format_rfc3339_nano,
        job_lock_sort_key,
        job_meta_sort_key,
        job_partition_key,
        job_record_sort_key,
        job_request_sort_key,
        jobs_table_name,
        sanitize_error_envelope,
        sanitize_fields,
        unix_seconds,
    )
    from apptheory.jobs import (
        default_config as default_jobs_config,
    )
    from apptheory.jobs import (
        new_error as new_job_ledger_error,
    )
    from apptheory.jobs import (
        wrap_error as wrap_job_ledger_error,
    )
except ModuleNotFoundError as exc:  # pragma: no cover
    if exc.name != "theorydb_py":
        raise

    DEFAULT_JOBS_TABLE_NAME = "apptheory-jobs"
    EnvJobsTableName = "APPTHEORY_JOBS_TABLE_NAME"
    missing_exc = exc

    def _raise_jobs_dependency_error() -> None:
        raise ModuleNotFoundError(
            "theorydb_py is required for apptheory.jobs; install `tabletheory-py` (see py/pyproject.toml)."
        ) from missing_exc

    class JobsConfig:  # type: ignore
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            _raise_jobs_dependency_error()

    class JobLedgerError(Exception):
        pass

    class DynamoJobLedger:  # type: ignore
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            _raise_jobs_dependency_error()

    def default_jobs_config() -> JobsConfig:
        _raise_jobs_dependency_error()

    def new_job_ledger_error(*_args: object, **_kwargs: object) -> JobLedgerError:
        _raise_jobs_dependency_error()

    def wrap_job_ledger_error(*_args: object, **_kwargs: object) -> JobLedgerError:
        _raise_jobs_dependency_error()

    def jobs_table_name() -> str:
        _raise_jobs_dependency_error()

    def job_partition_key(_job_id: str) -> str:
        _raise_jobs_dependency_error()

    def job_meta_sort_key() -> str:
        _raise_jobs_dependency_error()

    def job_record_sort_key(_record_id: str) -> str:
        _raise_jobs_dependency_error()

    def job_lock_sort_key() -> str:
        _raise_jobs_dependency_error()

    def job_request_sort_key(_idempotency_key: str) -> str:
        _raise_jobs_dependency_error()

    def unix_seconds(_value: object) -> int:
        _raise_jobs_dependency_error()

    def format_rfc3339_nano(_value: object) -> str:
        _raise_jobs_dependency_error()

    def sanitize_fields(_fields: object) -> object:
        _raise_jobs_dependency_error()

    def sanitize_error_envelope(_envelope: object) -> object:
        _raise_jobs_dependency_error()


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
    sanitize_json_value,
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
    build_appsync_event,
    build_websocket_event,
    create_fake_websocket_client_factory,
    create_test_env,
)

__all__ = [
    "DEFAULT_JOBS_TABLE_NAME",
    "HTTP_ERROR_FORMAT_FLAT_LEGACY",
    "HTTP_ERROR_FORMAT_NESTED",
    "App",
    "AppError",
    "AppSyncContext",
    "AppSyncResolverEvent",
    "AppSyncResolverInfo",
    "AppSyncResolverRequest",
    "AppTheoryError",
    "CORSConfig",
    "Clock",
    "Context",
    "DynamoDBStreamRecordSummary",
    "DynamoJobLedger",
    "EnvJobsTableName",
    "EventBridgeScheduledWorkloadResultSummary",
    "EventBridgeScheduledWorkloadSummary",
    "EventBridgeSelector",
    "EventBridgeWorkloadEnvelope",
    "EventContext",
    "FakeWebSocketClientFactory",
    "FakeWebSocketManagementClient",
    "IDGenerator",
    "IdGenerator",
    "JobLedgerError",
    "JobsConfig",
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
    "build_appsync_event",
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
    "default_jobs_config",
    "etag",
    "event_bridge_pattern",
    "event_bridge_rule",
    "format_rfc3339_nano",
    "get_logger",
    "html",
    "html_stream",
    "job_lock_sort_key",
    "job_meta_sort_key",
    "job_partition_key",
    "job_record_sort_key",
    "job_request_sort_key",
    "jobs_table_name",
    "json",
    "mask_first_last",
    "mask_first_last4",
    "matches_if_none_match",
    "new_job_ledger_error",
    "normalize_dynamodb_stream_record",
    "normalize_eventbridge_scheduled_workload",
    "normalize_eventbridge_workload_envelope",
    "normalize_stage",
    "origin_url",
    "original_host",
    "original_uri",
    "payment_xml_patterns",
    "rapid_connect_xml_patterns",
    "require_eventbridge_workload_envelope",
    "resource_name",
    "safe_json_for_html",
    "sanitize_error_envelope",
    "sanitize_field_value",
    "sanitize_fields",
    "sanitize_json",
    "sanitize_json_value",
    "sanitize_log_string",
    "sanitize_xml",
    "set_logger",
    "sse",
    "sse_event_stream",
    "stepfunctions_task_token",
    "text",
    "timeout_middleware",
    "unix_seconds",
    "vary",
    "wrap_job_ledger_error",
]
