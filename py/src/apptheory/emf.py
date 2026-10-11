from __future__ import annotations

import datetime as dt
import json
import sys
from collections.abc import Callable
from typing import Any, TextIO

from apptheory.app import MetricRecord, ObservabilityHooks

_DEFAULT_EMF_NAMESPACE = "AppTheory"
_DEFAULT_EMF_SERVICE = "apptheory"

# _EMF_UNMATCHED_ROUTE is the bounded route dimension value used when a metric
# carries no matched route template.
_EMF_UNMATCHED_ROUTE = "unmatched"


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
        # The CloudWatch dimension tuple is bounded to service, method, route
        # template, status class, and error code. The concrete request path, raw
        # status code, and any client-supplied tenant hint are deliberately
        # excluded: they are attacker-influenced and would let unauthenticated
        # requests mint unbounded custom metric series (and billing) for every
        # unique value. Those concrete values remain on the framework's request
        # log and span records, which carry no metric-cardinality cost; an
        # authenticated, bounded tenant identity could be added as a dimension
        # later, but no such binding is invented here.
        envelope = {
            "_aws": {
                "Timestamp": _unix_millis(self.clock()),
                "CloudWatchMetrics": [
                    {
                        "Namespace": self.namespace,
                        "Dimensions": [["service", "method", "route", "status_class", "error_code"]],
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
            "route": _emf_route_template(tags.get("route")),
            "status_class": _emf_status_class(status, tags.get("status_class")),
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


def _emf_route_template(value: Any) -> str:
    route = str(value or "").strip()
    return route or _EMF_UNMATCHED_ROUTE


def _emf_status_class(status_value: Any, class_value: Any) -> str:
    explicit = str(class_value or "").strip()
    if explicit:
        return explicit
    try:
        code = int(str(status_value or "").strip())
    except ValueError:
        return "unknown"
    if 100 <= code < 200:
        return "1xx"
    if 200 <= code < 300:
        return "2xx"
    if 300 <= code < 400:
        return "3xx"
    if 400 <= code < 500:
        return "4xx"
    if 500 <= code < 600:
        return "5xx"
    return "unknown"


def _request_error_metric_value(status: str, error_code: str) -> int:
    if error_code.strip():
        return 1
    try:
        return 1 if int(status.strip()) >= 400 else 0
    except ValueError:
        return 0
