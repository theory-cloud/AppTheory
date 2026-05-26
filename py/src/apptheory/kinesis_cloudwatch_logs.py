"""CloudWatch Logs subscription decoding for Lambda Kinesis records."""

from __future__ import annotations

import base64
import binascii
import gzip
import io
import json
import math
from typing import Any

CloudWatchLogsSubscription = dict[str, Any]
CloudWatchLogsSubscriptionLogEvent = dict[str, Any]
CloudWatchLogsSubscriptionSummary = dict[str, Any]

_CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES = 6 * 1024 * 1024
_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE = "apptheory: decode cloudwatch logs subscription"


def decode_cloudwatch_logs_subscription(record: dict[str, Any]) -> CloudWatchLogsSubscription:
    """Decode a CloudWatch Logs subscription envelope from a Lambda Kinesis record.

    AWS delivers CloudWatch Logs subscription payloads to Kinesis as gzip-compressed JSON bytes encoded in the
    Lambda Kinesis record's ``kinesis.data`` field. The returned ``safe_summary`` intentionally excludes raw log event
    messages so callers can use it in logs, metrics, spans, and fixture summaries without copying customer log material.
    """

    record_obj = record if isinstance(record, dict) else {}
    record_id = _object_string(record_obj, "eventID")
    if not record_id:
        raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: missing kinesis eventID")

    payload_bytes = _gunzip_cloudwatch_logs_subscription_data(record_obj)
    payload = _parse_cloudwatch_logs_subscription_payload(payload_bytes)
    decoded = {
        "record_id": record_id,
        "message_type": _object_string(payload, "messageType"),
        "owner": _object_string(payload, "owner"),
        "log_group": _object_string(payload, "logGroup"),
        "log_stream": _object_string(payload, "logStream"),
        "subscription_filters": _payload_string_array(payload, "subscriptionFilters"),
        "log_events": _payload_log_events(payload, "logEvents"),
    }
    _validate_cloudwatch_logs_subscription(decoded)
    decoded["safe_summary"] = _cloudwatch_logs_subscription_safe_summary(decoded)
    return decoded


def _gunzip_cloudwatch_logs_subscription_data(record: dict[str, Any]) -> bytes:
    kinesis = _object_from_value(record.get("kinesis"))
    data = kinesis.get("data")
    if isinstance(data, str):
        data_b64 = data.strip()
        if not data_b64:
            raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty kinesis data")
        try:
            compressed = base64.b64decode(data_b64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} gzip: invalid payload") from exc
    elif isinstance(data, bytes | bytearray | memoryview):
        compressed = bytes(data)
        if not compressed:
            raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty kinesis data")
    else:
        raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty kinesis data")

    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as reader:
            payload = reader.read(_CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES + 1)
    except (EOFError, OSError, ValueError) as exc:
        raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} gzip: invalid payload") from exc

    if len(payload) > _CLOUDWATCH_LOGS_SUBSCRIPTION_MAX_DECODED_BYTES:
        raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: payload too large")
    return payload


def _parse_cloudwatch_logs_subscription_payload(payload_bytes: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(payload_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} json: invalid payload") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE} json: expected object")
    return parsed


def _validate_cloudwatch_logs_subscription(decoded: dict[str, Any]) -> None:
    missing: list[str] = []
    if not str(decoded.get("message_type") or "").strip():
        missing.append("messageType")
    if not str(decoded.get("owner") or "").strip():
        missing.append("owner")
    if not str(decoded.get("log_group") or "").strip():
        missing.append("logGroup")
    if not str(decoded.get("log_stream") or "").strip():
        missing.append("logStream")
    if not decoded.get("subscription_filters"):
        missing.append("subscriptionFilters")
    if missing:
        raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: missing {', '.join(missing)}")

    for index, value in enumerate(decoded.get("subscription_filters") or []):
        if not str(value or "").strip():
            raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty subscriptionFilters[{index}]")
    for index, event in enumerate(decoded.get("log_events") or []):
        if not str((event or {}).get("id") or "").strip():
            raise RuntimeError(f"{_CLOUDWATCH_LOGS_SUBSCRIPTION_DECODE_MESSAGE}: empty logEvents[{index}].id")


def _cloudwatch_logs_subscription_safe_summary(decoded: dict[str, Any]) -> CloudWatchLogsSubscriptionSummary:
    subscription_filter_count = len(decoded.get("subscription_filters") or [])
    log_event_count = len(decoded.get("log_events") or [])
    safe_log = (
        f"record_id={decoded.get('record_id')} owner={decoded.get('owner')} "
        f"log_group={decoded.get('log_group')} log_stream={decoded.get('log_stream')} "
        f"message_type={decoded.get('message_type')} log_events={log_event_count} "
        f"subscription_filters={subscription_filter_count}"
    )
    return {
        "record_id": str(decoded.get("record_id") or ""),
        "message_type": str(decoded.get("message_type") or ""),
        "owner": str(decoded.get("owner") or ""),
        "log_group": str(decoded.get("log_group") or ""),
        "log_stream": str(decoded.get("log_stream") or ""),
        "subscription_filter_count": subscription_filter_count,
        "log_event_count": log_event_count,
        "safe_log": safe_log,
    }


def _payload_string_array(payload: dict[str, Any], key: str) -> list[str]:
    value = payload.get(key)
    if not isinstance(value, list) or not value:
        return []
    return [item.strip() if isinstance(item, str) else "" for item in value]


def _payload_log_events(payload: dict[str, Any], key: str) -> list[CloudWatchLogsSubscriptionLogEvent]:
    value = payload.get(key)
    if not isinstance(value, list) or not value:
        return []
    out: list[CloudWatchLogsSubscriptionLogEvent] = []
    for item in value:
        event = _object_from_value(item)
        out.append(
            {
                "id": _object_string(event, "id"),
                "timestamp": _object_int(event, "timestamp"),
                "message": _object_raw_string(event, "message"),
            }
        )
    return out


def _object_from_value(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _object_string(obj: dict[str, Any], key: str) -> str:
    value = obj.get(key) if isinstance(obj, dict) else ""
    return value.strip() if isinstance(value, str) else ""


def _object_raw_string(obj: dict[str, Any], key: str) -> str:
    value = obj.get(key) if isinstance(obj, dict) else ""
    return value if isinstance(value, str) else ""


def _object_int(obj: dict[str, Any], key: str) -> int:
    if not isinstance(obj, dict):
        return 0
    value = obj.get(key)
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return int(value)
    return 0
