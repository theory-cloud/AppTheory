"""Portable helpers for non-HTTP event workloads."""

from __future__ import annotations

import json
from typing import Any

EventBridgeWorkloadEnvelope = dict[str, Any]

_EVENTBRIDGE_ENVELOPE_INVALID = "apptheory: eventbridge workload envelope invalid"
_CORRELATION_SOURCE_METADATA = "metadata.correlation_id"
_CORRELATION_SOURCE_HEADER = "headers.x-correlation-id"
_CORRELATION_SOURCE_DETAIL = "detail.correlation_id"
_CORRELATION_SOURCE_EVENT_ID = "event.id"
_CORRELATION_SOURCE_AWS_REQUEST_ID = "lambda.aws_request_id"


class _SafeEventError(RuntimeError):
    safe_event_error = True


def normalize_eventbridge_workload_envelope(ctx: Any, event: dict[str, Any]) -> EventBridgeWorkloadEnvelope:
    """Return the canonical EventBridge workload envelope.

    Correlation IDs are selected in contract order: metadata.correlation_id,
    headers["x-correlation-id"], detail.correlation_id, event.id, and finally
    the Lambda awsRequestId.
    """

    event_obj = event if isinstance(event, dict) else {}
    detail = _object_from_value(event_obj.get("detail"))
    correlation_id, correlation_source = _eventbridge_correlation_id(ctx, event_obj, detail)
    resources = event_obj.get("resources") or []
    return {
        "account": _object_string(event_obj, "account"),
        "correlation_id": correlation_id,
        "correlation_source": correlation_source,
        "detail_type": _as_trimmed_string(event_obj.get("detail-type") or event_obj.get("detailType")),
        "event_id": _object_string(event_obj, "id"),
        "region": _object_string(event_obj, "region"),
        "request_id": _event_context_request_id(ctx),
        "resources": [str(value) for value in resources] if isinstance(resources, list) else [],
        "source": _object_string(event_obj, "source"),
        "time": _event_time(event_obj),
    }


def require_eventbridge_workload_envelope(ctx: Any, event: dict[str, Any]) -> EventBridgeWorkloadEnvelope:
    """Return the EventBridge workload envelope and fail closed if required fields are missing."""

    envelope = normalize_eventbridge_workload_envelope(ctx, event)
    if not envelope["source"] or not envelope["detail_type"] or not envelope["correlation_id"]:
        raise _SafeEventError(_EVENTBRIDGE_ENVELOPE_INVALID)
    return envelope


def _eventbridge_correlation_id(
    ctx: Any,
    event: dict[str, Any],
    detail: dict[str, Any],
) -> tuple[str, str]:
    metadata_correlation = _object_string(_object_from_value(event.get("metadata")), "correlation_id")
    if metadata_correlation:
        return metadata_correlation, _CORRELATION_SOURCE_METADATA

    header_correlation = _header_string(_object_from_value(event.get("headers")), "x-correlation-id")
    if header_correlation:
        return header_correlation, _CORRELATION_SOURCE_HEADER

    detail_correlation = _object_string(detail, "correlation_id")
    if detail_correlation:
        return detail_correlation, _CORRELATION_SOURCE_DETAIL

    event_id = _object_string(event, "id")
    if event_id:
        return event_id, _CORRELATION_SOURCE_EVENT_ID

    request_id = _lambda_aws_request_id(ctx)
    if request_id:
        return request_id, _CORRELATION_SOURCE_AWS_REQUEST_ID

    return "", ""


def _event_time(event: dict[str, Any]) -> str:
    value = event.get("time")
    if isinstance(value, str):
        return value.strip()
    if hasattr(value, "isoformat"):
        return str(value.isoformat()).strip()
    return ""


def _event_context_request_id(ctx: Any) -> str:
    return str(getattr(ctx, "request_id", "") or "").strip()


def _lambda_aws_request_id(ctx: Any) -> str:
    lambda_ctx = getattr(ctx, "ctx", None)
    if lambda_ctx is None:
        return ""
    return str(getattr(lambda_ctx, "aws_request_id", "") or getattr(lambda_ctx, "awsRequestId", "") or "").strip()


def _object_from_value(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    try:
        parsed = json.loads(value)
    except Exception:  # noqa: BLE001
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _object_string(obj: dict[str, Any], key: str) -> str:
    if not isinstance(obj, dict):
        return ""
    return _as_trimmed_string(obj.get(key))


def _header_string(headers: dict[str, Any], key: str) -> str:
    if not isinstance(headers, dict):
        return ""
    wanted = str(key or "").strip().lower()
    if not wanted:
        return ""
    for name, value in headers.items():
        if str(name).strip().lower() != wanted:
            continue
        if isinstance(value, list):
            for entry in value:
                candidate = _as_trimmed_string(entry)
                if candidate:
                    return candidate
            return ""
        return _as_trimmed_string(value)
    return ""


def _as_trimmed_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""
