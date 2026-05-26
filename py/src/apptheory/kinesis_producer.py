"""Bounded Kinesis producer helpers for JSON records and failure summaries."""

from __future__ import annotations

import json
import math
from typing import Any

KinesisJsonRecord = dict[str, Any]
KinesisJsonRecordSummary = dict[str, Any]
KinesisPutRecordsFailure = dict[str, Any]
KinesisPutRecordsFailureReport = dict[str, Any]
KinesisPutRecordsFailureReportSummary = dict[str, Any]
KinesisPutRecordsResultRecord = dict[str, Any]

_KINESIS_JSON_RECORD_INVALID_MESSAGE = "apptheory: kinesis json record invalid"
_KINESIS_PUT_RECORDS_INVALID_MESSAGE = "apptheory: kinesis put-records result invalid"
_KINESIS_MAX_PARTITION_KEY_BYTES = 256
_KINESIS_MAX_RECORD_DATA_BYTES = 1024 * 1024
_KINESIS_MAX_PUT_RECORDS_RECORDS = 500
_KINESIS_MAX_EXPLICIT_HASH_KEY = "340282366920938463463374607431768211455"
_KINESIS_MAX_ERROR_CODE_BYTES = 128
_KINESIS_MAX_ERROR_MESSAGE_BYTES = 4096


def create_kinesis_json_record(
    *,
    partition_key: str,
    payload: Any,
    explicit_hash_key: str | None = None,
) -> KinesisJsonRecord:
    """Return one deterministic JSON record for Kinesis producer calls.

    The helper validates the partition key, canonicalizes the optional explicit hash key, JSON-encodes the payload with
    sorted object keys, and enforces Kinesis record bounds. It does not send the record or wrap an AWS SDK client.
    """

    normalized_partition_key = _normalize_kinesis_partition_key(partition_key)
    normalized_explicit_hash_key = _normalize_kinesis_explicit_hash_key(explicit_hash_key)
    data = _encode_kinesis_json_payload(payload)
    record: KinesisJsonRecord = {
        "partition_key": normalized_partition_key,
        "data": data,
        "safe_summary": _kinesis_json_record_safe_summary(
            normalized_partition_key,
            len(data),
            normalized_explicit_hash_key,
        ),
    }
    if normalized_explicit_hash_key:
        record["explicit_hash_key"] = normalized_explicit_hash_key
    return record


def report_kinesis_put_records_failures(
    records: list[KinesisJsonRecord],
    results: list[KinesisPutRecordsResultRecord],
) -> KinesisPutRecordsFailureReport:
    """Return safe per-record failures aligned by input and result index.

    The records must come from ``create_kinesis_json_record`` or equivalent bounded data. The results are the minimal
    PutRecords-style per-record result shape, not raw SDK client instances or responses. Raw JSON payload bytes and raw
    error messages are intentionally excluded from the returned summaries.
    """

    if len(records) != len(results):
        raise RuntimeError(
            f"{_KINESIS_PUT_RECORDS_INVALID_MESSAGE}: records/results length mismatch "
            f"records={len(records)} results={len(results)}"
        )
    if len(records) > _KINESIS_MAX_PUT_RECORDS_RECORDS:
        raise RuntimeError(
            f"{_KINESIS_PUT_RECORDS_INVALID_MESSAGE}: record count {len(records)} "
            f"exceeds {_KINESIS_MAX_PUT_RECORDS_RECORDS}"
        )

    failures: list[KinesisPutRecordsFailure] = []
    for index, record in enumerate(records):
        normalized_record = _normalize_kinesis_report_record(record, index)
        result = _normalize_kinesis_put_records_result_record(results[index], index)
        if not result["error_code"]:
            continue
        failures.append(_kinesis_put_records_failure(index, normalized_record, result))

    return {
        "record_count": len(records),
        "failed_record_count": len(failures),
        "failures": failures,
        "safe_summary": _kinesis_put_records_failure_report_summary(len(records), len(failures)),
    }


def _encode_kinesis_json_payload(payload: Any) -> bytes:
    _validate_json_payload(payload, set())
    try:
        encoded = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: invalid payload") from exc
    if not encoded:
        raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: empty json payload")
    if len(encoded) > _KINESIS_MAX_RECORD_DATA_BYTES:
        raise RuntimeError(
            f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: json payload size {len(encoded)} "
            f"exceeds {_KINESIS_MAX_RECORD_DATA_BYTES}"
        )
    return bytes(encoded)


def _validate_json_payload(value: Any, seen: set[int]) -> None:
    if value is None or isinstance(value, str | bool | int):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: non-finite number")
        return
    if isinstance(value, bytes | bytearray | memoryview):
        raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: unsupported value")
    if isinstance(value, list | tuple):
        _validate_json_sequence(value, seen)
        return
    if isinstance(value, dict):
        _validate_json_object(value, seen)
        return
    raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: unsupported value")


def _validate_json_sequence(value: list[Any] | tuple[Any, ...], seen: set[int]) -> None:
    obj_id = id(value)
    if obj_id in seen:
        raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: circular value")
    seen.add(obj_id)
    try:
        for item in value:
            _validate_json_payload(item, seen)
    finally:
        seen.remove(obj_id)


def _validate_json_object(value: dict[Any, Any], seen: set[int]) -> None:
    obj_id = id(value)
    if obj_id in seen:
        raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: circular value")
    seen.add(obj_id)
    try:
        for key, item in value.items():
            if not isinstance(key, str):
                raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: json encode: object keys must be strings")
            _validate_json_payload(item, seen)
    finally:
        seen.remove(obj_id)


def _normalize_kinesis_partition_key(value: str) -> str:
    partition_key = str(value or "").strip()
    if not partition_key:
        raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: partition key is required")
    byte_length = len(partition_key.encode("utf-8"))
    if byte_length > _KINESIS_MAX_PARTITION_KEY_BYTES:
        raise RuntimeError(
            f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: partition key length {byte_length} "
            f"exceeds {_KINESIS_MAX_PARTITION_KEY_BYTES} bytes"
        )
    return partition_key


def _normalize_kinesis_explicit_hash_key(value: str | None) -> str:
    explicit_hash_key = str(value or "").strip()
    if not explicit_hash_key:
        return ""
    if not explicit_hash_key.isdecimal():
        raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: explicit hash key must be decimal digits")
    explicit_hash_key = explicit_hash_key.lstrip("0") or "0"
    if len(explicit_hash_key) > len(_KINESIS_MAX_EXPLICIT_HASH_KEY) or (
        len(explicit_hash_key) == len(_KINESIS_MAX_EXPLICIT_HASH_KEY)
        and explicit_hash_key > _KINESIS_MAX_EXPLICIT_HASH_KEY
    ):
        raise RuntimeError(f"{_KINESIS_JSON_RECORD_INVALID_MESSAGE}: explicit hash key exceeds Kinesis hash key range")
    return explicit_hash_key


def _kinesis_json_record_safe_summary(
    partition_key: str,
    data_byte_length: int,
    explicit_hash_key: str,
) -> KinesisJsonRecordSummary:
    summary: KinesisJsonRecordSummary = {
        "partition_key": partition_key,
        "data_byte_length": data_byte_length,
        "safe_log": f"partition_key={partition_key} data_bytes={data_byte_length}",
    }
    if explicit_hash_key:
        summary["explicit_hash_key"] = explicit_hash_key
        summary["safe_log"] = (
            f"partition_key={partition_key} explicit_hash_key={explicit_hash_key} data_bytes={data_byte_length}"
        )
    return summary


def _normalize_kinesis_report_record(record: KinesisJsonRecord, index: int) -> KinesisJsonRecord:
    try:
        partition_key = _normalize_kinesis_partition_key(str(record.get("partition_key") or ""))
        explicit_hash_key = _normalize_kinesis_explicit_hash_key(str(record.get("explicit_hash_key") or ""))
    except RuntimeError as exc:
        raise RuntimeError(f"{exc} at index {index}") from exc
    data = record.get("data")
    if not isinstance(data, bytes | bytearray | memoryview) or len(data) == 0:
        raise RuntimeError(f"{_KINESIS_PUT_RECORDS_INVALID_MESSAGE}: empty record data at index {index}")
    if len(data) > _KINESIS_MAX_RECORD_DATA_BYTES:
        raise RuntimeError(
            f"{_KINESIS_PUT_RECORDS_INVALID_MESSAGE}: record data size {len(data)} "
            f"exceeds {_KINESIS_MAX_RECORD_DATA_BYTES} at index {index}"
        )
    normalized: KinesisJsonRecord = {
        "partition_key": partition_key,
        "data": bytes(data),
        "safe_summary": _kinesis_json_record_safe_summary(partition_key, len(data), explicit_hash_key),
    }
    if explicit_hash_key:
        normalized["explicit_hash_key"] = explicit_hash_key
    return normalized


def _normalize_kinesis_put_records_result_record(
    result: KinesisPutRecordsResultRecord,
    index: int,
) -> KinesisPutRecordsResultRecord:
    normalized: KinesisPutRecordsResultRecord = {
        "sequence_number": str(result.get("sequence_number") or "").strip(),
        "shard_id": str(result.get("shard_id") or "").strip(),
        "error_code": str(result.get("error_code") or "").strip(),
        "error_message": str(result.get("error_message") or "").strip(),
    }
    if not normalized["error_code"] and normalized["error_message"]:
        raise RuntimeError(f"{_KINESIS_PUT_RECORDS_INVALID_MESSAGE}: error message without error code at index {index}")
    if len(str(normalized["error_code"]).encode("utf-8")) > _KINESIS_MAX_ERROR_CODE_BYTES:
        raise RuntimeError(f"{_KINESIS_PUT_RECORDS_INVALID_MESSAGE}: error code too long at index {index}")
    if _has_unsafe_error_code_rune(str(normalized["error_code"])):
        raise RuntimeError(f"{_KINESIS_PUT_RECORDS_INVALID_MESSAGE}: unsafe error code at index {index}")
    if len(str(normalized["error_message"]).encode("utf-8")) > _KINESIS_MAX_ERROR_MESSAGE_BYTES:
        raise RuntimeError(f"{_KINESIS_PUT_RECORDS_INVALID_MESSAGE}: error message too long at index {index}")
    return normalized


def _has_unsafe_error_code_rune(value: str) -> bool:
    return any(ord(char) <= 0x20 or ord(char) == 0x7F for char in value)


def _kinesis_put_records_failure(
    index: int,
    record: KinesisJsonRecord,
    result: KinesisPutRecordsResultRecord,
) -> KinesisPutRecordsFailure:
    failure: KinesisPutRecordsFailure = {
        "index": index,
        "partition_key": record["partition_key"],
        "data_byte_length": len(record["data"]),
        "error_code": result["error_code"],
        "error_message_present": bool(result["error_message"]),
        "error_message_byte_length": len(str(result["error_message"]).encode("utf-8")),
    }
    if record.get("explicit_hash_key"):
        failure["explicit_hash_key"] = record["explicit_hash_key"]
    failure["safe_log"] = _kinesis_put_records_failure_safe_log(failure)
    return failure


def _kinesis_put_records_failure_safe_log(failure: KinesisPutRecordsFailure) -> str:
    if failure.get("explicit_hash_key"):
        return (
            f"kinesis_put_records_failure index={failure['index']} partition_key={failure['partition_key']} "
            f"explicit_hash_key={failure['explicit_hash_key']} data_bytes={failure['data_byte_length']} "
            f"error_code={failure['error_code']} error_message_present={failure['error_message_present']} "
            f"error_message_bytes={failure['error_message_byte_length']}"
        )
    return (
        f"kinesis_put_records_failure index={failure['index']} partition_key={failure['partition_key']} "
        f"data_bytes={failure['data_byte_length']} error_code={failure['error_code']} "
        f"error_message_present={failure['error_message_present']} "
        f"error_message_bytes={failure['error_message_byte_length']}"
    )


def _kinesis_put_records_failure_report_summary(
    record_count: int,
    failed_record_count: int,
) -> KinesisPutRecordsFailureReportSummary:
    return {
        "record_count": record_count,
        "failed_record_count": failed_record_count,
        "safe_log": f"kinesis_put_records record_count={record_count} failed_record_count={failed_record_count}",
    }
