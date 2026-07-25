# AppTheory MicroVM Consumer Conformance Harness

This harness is the AppTheory-owned validation surface for an external consumer, such as EqualToAI/Host, to run against a **consumer-provided lab deployment** of the canonical AppTheory MicroVM controller.

It proves the AppTheory framework contract that can be observed from outside the deployment:

- canonical control-plane and token routes: `run`, `get`, `list`, `suspend`, `resume`, `terminate`, `auth-token`, and `shell-auth-token`;
- fail-closed missing/invalid auth and safe tenant/namespace negative checks;
- tenant/namespace-bound list and get behavior, without treating AppTheory as product business truth;
- controller-run behavior that remains deployment-owned; an HTTP request does not select a MicroVM image logging
  destination;
- sanitized token metadata only for `auth-token` and `shell-auth-token` responses;
- cleanup by exercising `terminate` and requiring post-terminate terminal-or-denied behavior;
- token/secret no-leak scanning across responses plus supplied registry-record and log artifacts.

The canonical M16 controller vocabulary also includes workload `invoke`. This harness has not yet grown a consumer
workload probe for `invoke`; AppTheory covers that route with shared contract fixtures and the
`examples/cdk/microvm-controller` live example. Do not cite this conformance harness alone as EqualToAI/Host workload
invoke proof until it adds an external workload assertion.

`shell-auth-token` is canonical. `shell-token` is not used as a canonical route or command by this harness.

## Proof boundary

A local dry-run proves only that the harness, assertions, fixture transport, and leak scanner are ready. It does **not**
prove live AWS Lambda MicroVM operation, mutate AWS, validate EqualToAI/Host infrastructure, prove CloudWatch runtime-log
delivery, or certify customer workload/platform readiness.

Live proof exists only when EqualToAI/Host runs this harness against its deployed lab controller with real lab configuration and supplies any registry/log artifacts it wants included in the no-leak boundary.

The registry checks are intentionally bounded: AppTheory verifies observable tenant/namespace binding in controller responses and supplied registry-record-like JSON artifacts. Product-owned reconstruction truth remains outside AppTheory.

Factory EqualToAI separately completed a controlled lesser-host A/B that held the image version, execution role,
connector, duration, and destination constant: omitted per-run AWS logging produced no stream/events, while explicit
CloudWatch logging delivered guest output. That established the cause of the AppTheory 2.0 contract change. It is not a
post-change conformance result. Factory owns the external acceptance rerun after the AppTheory milestone is ready.

## Configuration

Copy `equaltoai-host.config.example.json` outside the repo and replace placeholders with lab values. Keep the auth token in an environment variable; do not put live tokens in the JSON file.

Required fields:

- `endpoint`: base URL for the lab AppTheory MicroVM controller.
- `auth_token_env`: environment variable that contains the lab bearer token.
- `tenant_id` and `namespace`: the tenant/namespace the lab token should be bound to.
- `run.image_ref` and `run.network_connector_ref`: lab MicroVM image and connector references.

There is no logging field in the harness run request. AppTheory 2.0 pins CloudWatch-or-disabled logging in the
deployment, and the controller must reject any attempt to make it caller-controlled.

Optional scanner fields:

- `scanner.registry_artifact_paths`: JSON registry-record-like files to scan and tenant-check.
- `scanner.log_artifact_paths`: text or JSON logs to scan.
- `scanner.sensitive_value_env`: additional environment variables whose values must never appear in scanned artifacts.

All example values are obvious placeholders. Do not replace them with fake-but-real-looking AWS keys or credentials.

## Local dry-run

From the AppTheory repo root:

```bash
./scripts/verify-microvm-conformance-harness.sh
```

That verifier is part of the full release/rubric gate path as repo-local dry-run and scanner proof only. It does not
replace the consumer-run live EqualToAI/Host lab run.

Equivalent direct commands:

```bash
python3 scripts/test_microvm_conformance.py
python3 scripts/microvm_conformance.py run \
  --config examples/microvm-conformance/equaltoai-host.config.example.json \
  --dry-run \
  --fixture examples/microvm-conformance/fixtures/no-leak-artifacts.json
python3 scripts/microvm_conformance.py scan \
  --artifact no-leak=examples/microvm-conformance/fixtures/scanner-no-leak-artifacts.json \
  --sensitive-value auth-token-DO-NOT-LOG-123456 \
  --sensitive-value provider-token-DO-NOT-LOG-123456
```

## Live lab run

After exporting the lab token, run:

```bash
export APPTHEORY_MICROVM_CONFORMANCE_AUTH_TOKEN='<lab-token-from-EqualToAI-Host-secret-store>'
python3 scripts/microvm_conformance.py run --config /path/to/equaltoai-host.lab.json
```

The harness does not print the token or response bodies. On a leak, it reports the artifact and finding type with the value suppressed.

A passing live run means the supplied lab deployment satisfied the externally observable AppTheory conformance boundary
at the time of the run. Runtime-log delivery remains a separate Factory acceptance observation unless the run includes
and verifies those artifacts. It is not a general AWS account audit and not a customer readiness claim.

## Token leak scanner only

To scan collected response, registry, and log artifacts without running controller operations:

```bash
python3 scripts/microvm_conformance.py scan \
  --artifact responses=/path/to/responses.json \
  --artifact registry=/path/to/registry-records.json \
  --artifact logs=/path/to/controller.log \
  --sensitive-env APPTHEORY_MICROVM_CONFORMANCE_AUTH_TOKEN
```

The scanner fails closed on plaintext supplied sensitive values, bearer credentials, private keys, AWS-looking credentials, forbidden credential fields such as `token_value`, `provider_token`, or `session_token_plaintext`, and secret-looking field names that are not AppTheory's sanitized token metadata.
