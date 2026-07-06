from __future__ import annotations

import datetime as dt
import json
import sys
from collections.abc import Callable
from typing import TextIO

from apptheory.app import MetricRecord, ObservabilityHooks

_DEFAULT_EMF_NAMESPACE = "AppTheory"
_DEFAULT_EMF_SERVICE = "apptheory"


class EMFMetricSink:
    """First-party CloudWatch Embedded Metric Format sink for AppTheory request metrics."""

    def __init__(
        self,
        *,
        namespace: str = _DEFAULT_EMF_NAMESPACE,
        service: str = _DEFAULT_EMF_SERVICE,
        writer: TextIO | None = None,
        clock: Callable[[], dt.datetime] | None = None,
    ) -> None:
        self.namespace = str(namespace or "").strip() or _DEFAULT_EMF_NAMESPACE
        self.service = str(service or "").strip() or _DEFAULT_EMF_SERVICE
        self.writer = writer if writer is not None else sys.stdout
        self.clock = clock or (lambda: dt.datetime.now(tz=dt.UTC))

    def record_metric(self, record: MetricRecord) -> None:
        if str(record.name or "").strip() != "apptheory.request":
            return
        self.writer.write(self.encode_metric(record) + "\n")

    def encode_metric(self, record: MetricRecord) -> str:
        tags = dict(record.tags or {})
        status = str(tags.get("status") or "").strip()
        error_code = str(tags.get("error_code") or "").strip()
        envelope = {
            "_aws": {
                "Timestamp": _unix_millis(self.clock()),
                "CloudWatchMetrics": [
                    {
                        "Namespace": self.namespace,
                        "Dimensions": [["service", "method", "path", "status", "tenant_id", "error_code"]],
                        "Metrics": [
                            {"Name": "RequestCount", "Unit": "Count"},
                            {"Name": "RequestDuration", "Unit": "Milliseconds"},
                            {"Name": "RequestErrors", "Unit": "Count"},
                        ],
                    }
                ],
            },
            "service": self.service,
            "method": str(tags.get("method") or "").strip(),
            "path": str(tags.get("path") or "").strip(),
            "status": status,
            "tenant_id": str(tags.get("tenant_id") or "").strip(),
            "error_code": error_code,
            "RequestCount": int(record.value or 0),
            "RequestDuration": max(0, int(record.duration_ms)),
            "RequestErrors": _request_error_metric_value(status, error_code),
        }
        return json.dumps(envelope, separators=(",", ":"), ensure_ascii=False)


def create_emf_metric_sink(
    *,
    namespace: str = _DEFAULT_EMF_NAMESPACE,
    service: str = _DEFAULT_EMF_SERVICE,
    writer: TextIO | None = None,
    clock: Callable[[], dt.datetime] | None = None,
) -> EMFMetricSink:
    return EMFMetricSink(namespace=namespace, service=service, writer=writer, clock=clock)


def hooks_from_emf_metric_sink(sink: EMFMetricSink | None) -> ObservabilityHooks:
    if sink is None:
        return ObservabilityHooks()
    return ObservabilityHooks(metric=sink.record_metric)


def _unix_millis(value: dt.datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=dt.UTC)
    return int(value.timestamp() * 1000)


def _request_error_metric_value(status: str, error_code: str) -> int:
    if error_code.strip():
        return 1
    try:
        return 1 if int(status.strip()) >= 400 else 0
    except ValueError:
        return 0
