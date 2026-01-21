from __future__ import annotations

import base64
from typing import Any

from apptheory.util import to_bytes


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


def build_kinesis_event(stream_arn: str, records: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    arn = str(stream_arn or "").strip()
    out_records: list[dict[str, Any]] = []
    for idx, record in enumerate(records or []):
        event_id = str(record.get("eventID") or f"evt-{idx + 1}")

        kinesis = record.get("kinesis") if isinstance(record.get("kinesis"), dict) else {}

        data_b64 = str(record.get("data_b64") or record.get("dataBase64") or "").strip()
        if not data_b64:
            raw = record.get("data") if "data" in record else kinesis.get("data") or b""
            data_b64 = base64.b64encode(to_bytes(raw)).decode("ascii")

        partition_key = str(kinesis.get("partitionKey") or record.get("partitionKey") or f"pk-{idx + 1}")
        sequence_number = str(kinesis.get("sequenceNumber") or record.get("sequenceNumber") or str(idx + 1))

        out_records.append(
            {
                "eventID": event_id,
                "eventName": str(record.get("eventName") or "aws:kinesis:record"),
                "eventVersion": str(record.get("eventVersion") or "1.0"),
                "eventSource": "aws:kinesis",
                "awsRegion": str(record.get("awsRegion") or "us-east-1"),
                "invokeIdentityArn": str(record.get("invokeIdentityArn") or ""),
                "eventSourceARN": str(record.get("eventSourceARN") or arn),
                "kinesis": {
                    "data": data_b64,
                    "partitionKey": partition_key,
                    "sequenceNumber": sequence_number,
                    "kinesisSchemaVersion": str(kinesis.get("kinesisSchemaVersion") or "1.0"),
                },
            }
        )
    return {"Records": out_records}


def build_sns_event(topic_arn: str, records: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    arn = str(topic_arn or "").strip()
    out_records: list[dict[str, Any]] = []
    for idx, record in enumerate(records or []):
        sns = record.get("Sns") if isinstance(record.get("Sns"), dict) else {}
        subscription_arn = str(record.get("EventSubscriptionArn") or record.get("eventSubscriptionArn") or "")

        out_records.append(
            {
                "EventSource": "aws:sns",
                "EventVersion": str(record.get("EventVersion") or record.get("eventVersion") or "1.0"),
                "EventSubscriptionArn": subscription_arn,
                "Sns": {
                    "MessageId": str(sns.get("MessageId") or record.get("messageId") or f"sns-{idx + 1}"),
                    "TopicArn": str(sns.get("TopicArn") or record.get("topicArn") or arn),
                    "Subject": str(sns.get("Subject") or record.get("subject") or ""),
                    "Message": str(sns.get("Message") or record.get("message") or ""),
                    "Timestamp": str(sns.get("Timestamp") or record.get("timestamp") or "1970-01-01T00:00:00Z"),
                },
            }
        )
    return {"Records": out_records}
