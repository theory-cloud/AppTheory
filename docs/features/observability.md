---
title: Observability Hooks
---

# Observability hooks

AppTheory's shipped observability surface is the P2 hook contract: one structured request log record, one metric record,
and one span-shaped record per completed HTTP request. The hooks are deliberately small and portable across Go,
TypeScript, and Python; they are not a full OpenTelemetry SDK, exporter, dashboard, or alerting system.

## What P2 records today

When an HTTP request completes in P2, AppTheory records the same fields in each runtime:

- **Log record** — `level`, `event="request.completed"`, `request_id`, `tenant_id`, `method`, `path`, `status`,
  `error_code`, and `duration_ms`.
- **Metric record** — `name="apptheory.request"`, `value=1`, `duration_ms`, and tags for method, path, status,
  error code, and tenant ID.
- **Span record** — `name="http METHOD /path"` and attributes for HTTP method, route, status code, request ID,
  tenant ID, error code, and trace ID when one was extracted.

`duration_ms` is measured by the runtime clock around request handling. Tests may use a manual clock to make the value
stable; production uses the runtime clock supplied to the app.

## Trace propagation boundary

Trace propagation is extraction and recording only:

1. If a valid W3C `traceparent` header is present, AppTheory records its trace ID.
2. Otherwise, if a valid AWS X-Ray `X-Amzn-Trace-Id` header is present, AppTheory records its `Root` value.
3. If neither header is valid, AppTheory does not synthesize a trace ID.

The extracted value is available on the request/context (`TraceID` / `traceId` / `trace_id`) and via the trace-context
helper (`TraceContextID()` / `traceContextId()` / `trace_context_id()`). P2 log records include `trace_id`, P2 span
attributes include `trace.id`, and nested AppTheory HTTP error envelopes include `trace_id` when an inbound trace ID was
available.

AppTheory does not start spans, sample traces, inject downstream headers, run an OpenTelemetry provider, or send data to
OTLP/X-Ray. Bring your own OpenTelemetry SDK or AWS instrumentation at the application edge if a service needs full
trace lifecycle management; keep the AppTheory contract as the extraction/recording layer.

## EMF metric sink

The EMF sink is a helper that turns P2 metric records into CloudWatch Embedded Metric Format JSON lines. It preserves the
portable metric name, value, tags, and duration semantics from the hook contract. It does not create dashboards, alarms,
log subscriptions, or incident routing.

Use the EMF sink when CloudWatch metrics are the desired output:

- Go: create the EMF metric sink and pass its metric hook into `WithObservability`.
- TypeScript: create the EMF metric sink and call `recordMetric` from the P2 metric hook.
- Python: create the EMF metric sink and call `record_metric` from the P2 metric hook.

If a service needs different metric dimensions or alert destinations, add contract-visible fields or wire downstream AWS
resources outside AppTheory. Do not bypass the P2 hook path with per-route raw SDK calls.

## Relationship to logging profiles

[Logging Profiles](./logging-profiles.md) build on this surface. Profiles validate and encode structured JSON log output,
including request fields such as request ID, tenant ID, trace ID, route, status, and error code when the runtime has them.
Profiles do not replace P2 hooks and do not send alerts; they are the profile-backed encoding path for records produced
by the runtime or service logger.
