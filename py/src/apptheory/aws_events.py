from __future__ import annotations

from typing import Any


def build_sqs_event(queue_arn: str, records: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    arn = str(queue_arn or "").strip()
    out_records: list[dict[str, Any]] = []
    for idx, record in enumerate(records or []):
        msg_id = str(record.get("messageId") or f"msg-{idx + 1}")
        out_records.append(
            {
                "messageId": msg_id,
                "receiptHandle": str(record.get("receiptHandle") or ""),
                "body": str(record.get("body") or ""),
                "attributes": dict(record.get("attributes") or {}),
                "messageAttributes": dict(record.get("messageAttributes") or {}),
                "md5OfBody": str(record.get("md5OfBody") or ""),
                "eventSource": "aws:sqs",
                "eventSourceARN": str(record.get("eventSourceARN") or arn),
                "awsRegion": str(record.get("awsRegion") or "us-east-1"),
            }
        )
    return {"Records": out_records}


def build_eventbridge_event(
    *,
    rule_arn: str | None = None,
    resources: list[str] | None = None,
    version: str = "0",
    id: str = "evt-1",
    source: str = "aws.events",
    detail_type: str = "Scheduled Event",
    account: str = "000000000000",
    time: str = "1970-01-01T00:00:00Z",
    region: str = "us-east-1",
    detail: Any | None = None,
) -> dict[str, Any]:
    out_resources = list(resources or [])
    if rule_arn and str(rule_arn).strip():
        out_resources.append(str(rule_arn).strip())
    return {
        "version": str(version),
        "id": str(id),
        "detail-type": str(detail_type),
        "source": str(source),
        "account": str(account),
        "time": str(time),
        "region": str(region),
        "resources": out_resources,
        "detail": {} if detail is None else detail,
    }


def build_dynamodb_stream_event(stream_arn: str, records: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    arn = str(stream_arn or "").strip()
    out_records: list[dict[str, Any]] = []
    for idx, record in enumerate(records or []):
        event_id = str(record.get("eventID") or f"evt-{idx + 1}")
        out_records.append(
            {
                "eventID": event_id,
                "eventName": str(record.get("eventName") or "MODIFY"),
                "eventVersion": str(record.get("eventVersion") or "1.1"),
                "eventSource": "aws:dynamodb",
                "awsRegion": str(record.get("awsRegion") or "us-east-1"),
                "dynamodb": record.get("dynamodb")
                or {"SequenceNumber": str(idx + 1), "SizeBytes": 1, "StreamViewType": "NEW_AND_OLD_IMAGES"},
                "eventSourceARN": str(record.get("eventSourceARN") or arn),
            }
        )
    return {"Records": out_records}
