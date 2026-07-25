---
title: Operations Guide
---

# Operations Guide

This guide is for people operating an already deployed AppTheory application. It assumes the app was deployed through
the AppTheory CDK constructs or the `theory app up` path, and that the Lambda handler delegates to the single
AppTheory runtime entrypoint for the trigger type. It is not a contributor debugging checklist and it is not live deploy
proof.

## Operator first triage

Start every incident with the framework-owned signals before changing app code or infrastructure:

1. Identify the trigger: Lambda Function URL, HTTP API v2, REST API v1, ALB, AppSync, WebSocket, SQS, EventBridge,
   DynamoDB Streams, Kinesis, or SNS.
2. Confirm the handler still calls the AppTheory entrypoint for that trigger (`HandleLambda`, `handleLambda`, or
   `handle_lambda` for mixed-trigger Lambdas; the direct `Serve*`/`serve*` entrypoint only when the Lambda has one
   trigger shape).
3. Read the response envelope and request identifiers. Nested HTTP errors include `error.code`, `error.message`, and,
   when available, `request_id` and `trace_id`.
4. Check the P2 observability output before adding ad-hoc logging. AppTheory records method, path, status, tenant ID,
   error code, duration, request ID, and trace ID when configured through the runtime hooks.
5. Classify the failure with the sections below, then make the smallest contract-preserving change.

## Cold starts and latency spikes

Symptoms:

- first request after a quiet period is slow;
- p95/p99 duration alarms fire while error counts stay flat;
- logs show normal responses after a long initialization gap.

Checks:

- Confirm whether the route is behind an alias with provisioned concurrency or a CodeDeploy traffic-shift alias. If the
  app uses `AppTheoryFunction` deployment options, alarms must be attached to the alias that serves traffic.
- Separate initialization time from handler time. AppTheory P2 request duration measures request handling; Lambda
  platform reports show init duration separately.
- Check bundle size and runtime initialization. Large dependency graphs, framework initialization in global scope, and
  cold imports all increase the first-hit path.
- For periodic event workloads, verify the schedule rate does not unintentionally keep many separate functions cold at
  the same time.

Safe fixes:

- move expensive connection/client construction to lazy paths owned by the handler;
- use the AppTheory CDK alias/provisioned-concurrency surface when the service has a hard latency SLO;
- keep middleware on the configured tier path rather than adding a route-specific bypass.

## IAM and permission failures

Symptoms:

- Lambda logs contain `AccessDenied`, `AccessDeniedException`, `UnauthorizedOperation`, or `iam:PassRole` failures;
- event-source mappings retry while the handler never reaches route code;
- AppTheory returns an internal error envelope because a downstream call failed.

Checks:

- Identify whether the failure is before AppTheory receives the event (for example, event-source mapping or API
  integration permissions) or inside the handler after dispatch.
- Prefer the AppTheory CDK construct that owns the resource relationship. For example, use the queue, stream, jobs
  table, object-store, and MicroVM constructs instead of hand-writing parallel IAM paths.
- For Lambda MicroVM controllers, confirm the execution role and connector permissions were supplied through the
  AppTheory MicroVM constructs; do not add broad wildcard policies as a workaround.
- For object-store and TableTheory-backed data paths, confirm encryption and table access are configured explicitly.
  Missing keys or records should fail closed rather than broadening access.

Safe fixes:

- add the missing permission to the construct prop or helper that owns that relationship;
- redeploy through the normal AppTheory deployment path;
- avoid raw AWS SDK escape hatches that bypass the runtime or deployment contract.

## Lambda MicroVM runtime logs are dark

Symptoms:

- a MicroVM reaches `running`, but guest stdout/stderr never appears in CloudWatch Logs;
- the expected log stream is absent or remains empty;
- controller logs exist, but workload runtime output does not.

Checks:

1. Confirm the deployed `AppTheoryMicrovmImage.logging` posture is CloudWatch, not `disabled: true`.
2. Confirm the controller received the reserved `APPTHEORY_MICROVM_LOGGING` value from
   `AppTheoryMicrovmController`. Do not add that key manually to `controller.environment`.
3. Confirm CloudWatch mode has an `AppTheoryMicrovmController.executionRole`. The image build role and controller Lambda
   role are different roles and do not satisfy this requirement.
4. Confirm the MicroVM execution-role trust allows Lambda `sts:AssumeRole` and `sts:TagSession`.
5. Confirm the execution role allows `logs:CreateLogGroup`, `logs:CreateLogStream`, and `logs:PutLogEvents`.
6. Check the configured log group/stream names and region. Do not assume a missing per-run union inherits an image-level
   default.

AppTheory validates that CloudWatch mode has an execution role, but it does not inspect or mutate policies on arbitrary
caller-owned roles. Synthesis can therefore succeed while live delivery fails because a required Logs action is absent.

Safe fixes:

- update the logging posture on `AppTheoryMicrovmImage`;
- update the role passed through `AppTheoryMicrovmController.executionRole`;
- re-synthesize and redeploy through the AppTheory CDK path;
- keep logging deployment-owned rather than accepting it in `POST /microvms`;
- use explicit `logging: { disabled: true }` only when the intended outcome is no runtime log delivery.

Factory EqualToAI's controlled lesser-host A/B showed that otherwise identical runs can differ solely because the AWS
per-run `Logging` union was omitted versus explicitly set. AppTheory repository tests pin the corrected request shape,
but they do not replace Factory's external post-change acceptance run. See
[AppTheory 2.0 MicroVM Runtime Logging](../migration/microvm-runtime-logging-v2.md).

## Event-shape mismatches

Symptoms:

- a Lambda that should process one trigger returns `app.bad_request`, `app.not_found`, or a partial-batch response that
  marks every record failed;
- an HTTP Lambda handles local test events but fails behind API Gateway or Function URLs;
- AppSync resolvers return an error payload before the handler body runs.

Checks:

- Confirm the event source matches the configured entrypoint. Mixed-trigger handlers should call the universal
  `HandleLambda`/`handleLambda`/`handle_lambda` dispatcher so AppTheory can detect the shape.
- Compare the received event to the documented shapes in [Event Shape Dispatch](../reference/event-shapes.md).
- For HTTP APIs, distinguish API Gateway v2, Lambda Function URL, REST proxy, and ALB. They share an AppTheory request
  model, but their AWS envelope fields differ.
- For SQS, Kinesis, and DynamoDB Streams, unregistered queues/streams/tables fail closed by returning per-record
  failures. Check the resource name derived from the ARN matches the app registration.
- For AppSync, verify `info.fieldName`, `info.parentTypeName`, `arguments`, and `request.headers` are present.

Safe fixes:

- change the Lambda handler to the correct AppTheory entrypoint;
- register the exact queue, stream, table, topic, rule, or route name through the app;
- add or update contract fixtures for new trigger behavior before changing runtime dispatch.

## CORS failures

Symptoms:

- browser requests fail before the handler sees them;
- OPTIONS preflight succeeds locally but not through the deployed API;
- responses are missing `access-control-allow-origin` or credentials headers.

Checks:

- Determine whether CORS is owned by the API stage/construct or by AppTheory P1/P2 runtime response finalization.
  Do not configure competing CORS layers with conflicting origins.
- For `AppTheoryHttpApi` and top-level `AppTheoryApp`, verify the CDK `cors` configuration is the intended public
  policy.
- Confirm `allowCredentials` is not paired with wildcard origins.
- Confirm preflight requests include `Origin` and `Access-Control-Request-Method`; AppTheory only treats that shape as a
  CORS preflight.

Safe fixes:

- make one CORS policy change in the AppTheory construct or runtime tier config;
- prefer explicit origin lists for credentials;
- re-run the deterministic synth/docs gates before publishing the change.

## Reading 500 envelopes

AppTheory HTTP errors are framework envelopes, not plain text stack traces. In the default nested format, inspect:

- `error.code` — stable machine classification, such as `app.internal`, `app.bad_request`, `app.not_found`, or
  `app.too_large`;
- `error.message` — safe operator-facing summary;
- `request_id` — correlate with Lambda logs and AppTheory P2 logs;
- `trace_id` — correlate with upstream W3C `traceparent` or AWS X-Ray root IDs when supplied.

Triage rules:

- `app.bad_request` usually means event/request normalization or JSON parsing failed.
- `app.not_found` or `app.method_not_allowed` means routing did not match after normalization.
- `app.too_large` means request or response guardrails rejected the payload.
- `app.internal` means the handler or a framework-owned adapter raised an unexpected error. Use the request ID to find
  the corresponding log line; do not expose stack traces in the response.

If a service opted into the flat legacy error format for migration compatibility, use that only as a temporary migration
surface and plan to return to the nested AppTheory envelope.

## Cost review

Most AppTheory cost incidents come from unbounded traffic, retries, logs, or high-cardinality metrics rather than the
runtime layer itself.

Check:

- Lambda duration and concurrency, including provisioned concurrency;
- API Gateway or Function URL request volume;
- CloudWatch log volume and retention; AppTheory CDK functions should use explicit finite retention;
- event-source retry loops that repeatedly fail the same SQS/Kinesis/DynamoDB records;
- dashboard and alarm metric queries, especially high-cardinality dimensions like raw paths or tenant IDs;
- object-store reads that exceed bounded-get limits or retry unnecessarily.

Safe fixes:

- use P2 policy hooks for rate limiting/load shedding rather than adding a second router path;
- keep partial-batch handlers idempotent and report only failed records;
- cap response sizes with AppTheory limits and use object-store references for large payloads;
- tune log retention and metric dimensions through the owning construct.

## Alarming with `AppTheoryObservability`

For AppTheory runtime metrics emitted through the EMF sink, the CDK `AppTheoryObservability` construct creates a
CloudWatch dashboard plus two default alarms:

- `requestErrorsAlarm` over `RequestErrors` using `SUM`;
- `requestDurationAlarm` over `RequestDuration` using `MAX`.

The construct queries the AppTheory EMF schema with Metrics Insights. The expected dimensions are `service`, `method`,
`path`, `status`, `tenant_id`, and `error_code`, and the default filter is the service dimension. Use `alarmDimensions`
when an operator needs a narrower method/path/status/tenant/error-code slice.

Minimal pattern:

```ts
new AppTheoryObservability(stack, "ApiObservability", {
  serviceName: "orders-api",
  requestErrorThreshold: 1,
  requestDurationThresholdMs: 1000,
});
```

Operational notes:

- Treat missing data as not breaching unless the service has a separate uptime check.
- Attach alarm actions outside AppTheory; incident routing is deployment policy.
- If the runtime does not emit EMF metrics yet, first wire the P2 metric hook to the EMF sink. Do not add a one-off
  CloudWatch metric emitter in a route handler.
- Use Lambda/platform alarms such as `AppTheoryFunctionAlarms` for Lambda `Errors` and `Throttles`; use
  `AppTheoryObservability` for AppTheory request/error/duration semantics.

## Escalation checklist

Before declaring a framework bug, capture local, non-secret evidence:

- trigger type and AppTheory entrypoint used;
- response envelope with request ID and trace ID, with secrets redacted;
- matching Lambda log excerpt for that request ID;
- resource name derived from the event ARN when the trigger is batch/event based;
- deployed construct surface and any relevant props;
- the smallest deterministic fixture or test event that reproduces the behavior.

If the behavior is contract-visible, grow the shared fixtures first. AppTheory does not accept per-runtime fixes that
only make one deployed app pass.
