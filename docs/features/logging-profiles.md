---
title: Logging Profiles
---

# Logging profiles

AppTheory logging profiles are the single contract path for profile-backed structured JSON logs across Go,
TypeScript, and Python. A profile is not an alternate logger framework and it is not alert delivery. It is a portable
`apptheory.logging/v1` configuration that tells the AppTheory logger and observability hooks how to validate, enrich,
sanitize, and encode log records so downstream systems can consume them consistently.

Use logging profiles when a service needs stable CloudWatch JSON output, deterministic alert fingerprints, or
cross-language parity for request, job, and error log fields. Do not add per-service middleware bypasses or raw SDK log
emitters for those concerns; grow the profile contract and fixtures instead.

## Built-in profiles

The built-in catalog is fixture-backed and sorted canonically:

- `paytheory-alert-v1` — JSON profile for operational alerting and investigation fields used by Pay Theory services.
- `cloudwatch-json` — minimal JSON profile with `timestamp`, `level`, and `message` required.
- `legacy` — JSON profile that keeps legacy `timestamp` / `level` / `message` field names.
- `local-dev` — JSON profile with uppercase local levels for developer output.

The catalog is exposed in each runtime:

- Go: `observability.BuiltInLoggingProfileNames()` and `observability.LoggingProfileCatalog()`
- TypeScript: `builtInLoggingProfileNames()` and `loggingProfileCatalog()`
- Python: `built_in_logging_profile_names()` and `logging_profile_catalog()`

Unknown profiles, unsupported encodings, unsupported output fields, and unknown JSON configuration options fail closed
with validation errors. AppTheory does not silently fall back to a different profile.

## Schema fields

Logging profile configs use `schema_version: "apptheory.logging/v1"` and these top-level fields:

| Field | Purpose |
|---|---|
| `profile` | Built-in profile name. |
| `encoding` | Output format and canonical timestamp / level / message field names. Only JSON is supported. |
| `levels` | Optional mapping from AppTheory levels (`debug`, `info`, `warn`, `error`) to emitted values. |
| `required_fields` | Fields that must be present after encoding and enrichment; missing fields make emission fail closed. |
| `recommended_fields` | Portable fields downstream tooling should expect when the caller can provide them. |
| `field_map` | Mapping from canonical AppTheory fields to profile-specific output fields. |
| `enrichment.static` | Literal values or `${ENV_NAME}` substitutions owned by the service configuration. |
| `enrichment.context` | Runtime context sources such as `request.request_id`, `request.tenant_id`, `request.route`, and `job.name`. |
| `error_capture` | Error type/code capture plus optional stack trace and `sha256:` stack hash fields. |
| `sanitization` | Contract metadata that records the profile's sanitized logging expectation. |
| `alerting_hints` | Fingerprint and Keeper lookup field hints for downstream systems. AppTheory does not send alerts. |

Supported context sources are intentionally finite: request ID, tenant ID, user ID, trace ID, span ID, correlation ID,
route, method, path, status, and job name. If a service needs another portable context source, add it to the contract
and fixtures before relying on it.

## Ownership boundary

AppTheory owns:

- the `apptheory.logging/v1` schema and validation rules;
- built-in profile defaults;
- JSON encoding, level mapping, field mapping, and required-field checks;
- request/job/error context projection from observability hooks;
- sanitization of log messages and structured fields;
- cross-language contract fixtures.

The application owns:

- choosing one profile/config for the service;
- setting static environment values such as `SERVICE_NAME`, `STAGE`, `PARTNER`, `AWS_REGION`, and account metadata;
- adding service-safe fields with `WithField` / `withField` / `with_field`;
- deciding whether stack traces are appropriate for its data boundary;
- routing CloudWatch logs to alarms, Slack, incident tooling, or Keeper outside AppTheory.

This boundary is important: `paytheory-alert-v1` emits JSON fields and alerting hints, but AppTheory does not contain
Slack routing, alert destinations, or incident escalation policy.

## Go: select `paytheory-alert-v1`

Select the profile once during application construction and pass the generated hooks to the normal P2 observability
slot:

```go
package main

import (
	"log"

	"github.com/theory-cloud/apptheory/pkg/observability"
	apptheory "github.com/theory-cloud/apptheory/runtime"
)

func buildApp() *apptheory.App {
	profile, err := observability.DefaultLoggingProfile(observability.LoggingProfilePayTheoryAlertV1)
	if err != nil {
		log.Fatalf("logging profile: %v", err)
	}

	hooks, logger, err := observability.HooksFromProfileLogger(
		profile,
		observability.WithProfileEnvironment(map[string]string{
			"SERVICE_NAME":             "payments-api",
			"STAGE":                    "prod",
			"PARTNER":                  "pay-theory",
			"AWS_LAMBDA_FUNCTION_NAME": "payments-api-handler",
			"AWS_REGION":               "us-east-1",
			"SOURCE_ACCOUNT_ID":        "123456789012",
			"ACCOUNT_FAMILY":           "prod",
		}),
	)
	if err != nil {
		log.Fatalf("profile logger: %v", err)
	}

	logger.WithField("safe_component", "startup").Info("logger configured")
	return apptheory.New(apptheory.WithObservability(hooks))
}
```

The emitted record contains profile-owned fields such as `ts`, `level`, `message`, `service`, `stage`, `partner`,
`function`, and `aws_region`. Request fields such as `request_id`, `trace_id`, `correlation_id`, `route`, and `job_name`
are populated when the runtime has that context. If any required `paytheory-alert-v1` field remains empty after static
and context enrichment, the profile logger records an error instead of emitting a partial profile record.

## TypeScript and Python parity

The same profile contract is available in the TypeScript and Python runtimes:

```ts
import {
  LOGGING_PROFILE_PAYTHEORY_ALERT_V1,
  createApp,
  defaultLoggingProfile,
  hooksFromProfileLogger,
} from "@theory-cloud/apptheory";

const profile = defaultLoggingProfile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1);
const { hooks, logger } = hooksFromProfileLogger(profile, {
  environment: {
    SERVICE_NAME: "payments-api",
    STAGE: "prod",
    PARTNER: "pay-theory",
    AWS_LAMBDA_FUNCTION_NAME: "payments-api-handler",
    AWS_REGION: "us-east-1",
    SOURCE_ACCOUNT_ID: "123456789012",
    ACCOUNT_FAMILY: "prod",
  },
});

logger.withField("safe_component", "startup").info("logger configured");
const app = createApp({ observability: hooks });
```

```py
from apptheory import (
    LOGGING_PROFILE_PAYTHEORY_ALERT_V1,
    create_app,
    default_logging_profile,
    hooks_from_profile_logger,
)

profile = default_logging_profile(LOGGING_PROFILE_PAYTHEORY_ALERT_V1)
hooks, logger = hooks_from_profile_logger(
    profile,
    environment={
        "SERVICE_NAME": "payments-api",
        "STAGE": "prod",
        "PARTNER": "pay-theory",
        "AWS_LAMBDA_FUNCTION_NAME": "payments-api-handler",
        "AWS_REGION": "us-east-1",
        "SOURCE_ACCOUNT_ID": "123456789012",
        "ACCOUNT_FAMILY": "prod",
    },
)

logger.with_field("safe_component", "startup").info("logger configured")
app = create_app(observability=hooks)
```

Keep runtime-specific examples mechanically equivalent. If one runtime needs a new profile field, context source, or
encoding behavior, add the fixture first and implement all three runtimes to match.

## Sanitized logging expectations

Logging profiles build on AppTheory's sanitization surface. Messages are normalized with log-string sanitization, and
structured fields are passed through the runtime sanitizer before they are written. Profile-owned fields win over caller
fields, so a caller cannot override `level`, `message`, `request_id`, or other fields already set by encoding and
enrichment.

Guidelines:

1. Prefer structured safe fields over raw payload dumps.
2. Prefix service-only diagnostic fields with `safe_` when they are not part of the portable field list.
3. Sanitize JSON or XML payloads before logging them; see [Sanitization](./sanitization.md).
4. Treat stack traces as operational diagnostics. Do not put request bodies, tokens, PANs, or other sensitive values in
   error messages or stack frames.
5. Do not bypass the profile logger with direct `fmt.Println`, `console.log`, or `print` calls for production events.

## Migration guidance

When migrating a service to logging profiles:

1. Choose the built-in profile instead of copying a service-local JSON encoder.
2. Set required static enrichment from deployment configuration. For `paytheory-alert-v1`, provide service, stage,
   partner, function, region, source account ID, and account family values.
3. Move per-request data into AppTheory request context or structured logger fields instead of building log maps by hand.
4. Keep alert destinations outside AppTheory. Wire CloudWatch subscriptions, alarms, Slack notifications, or Keeper
   lookups in the operations layer that consumes the JSON logs.
5. Run `make test` and, before merging a milestone PR, `make rubric`. If the emitted shape is contract-visible, update
   the logging profile fixtures and prove parity across Go, TypeScript, and Python.

For Lift migrations, replace ad hoc logger construction with `DefaultLoggingProfile(...)` /
`defaultLoggingProfile(...)` / `default_logging_profile(...)` and the profile observability hooks. Preserve any existing
sanitization policy until the service has verified that the profile output contains the operational fields it needs.
