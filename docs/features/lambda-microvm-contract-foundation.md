---
title: Lambda MicroVM Contract Foundation
description: M15 fixture-backed vocabulary for future first-class AWS Lambda MicroVM support.
---

# Lambda MicroVM Contract Foundation

M15 introduces the **contract foundation** for first-class AWS Lambda MicroVM support in AppTheory. This is not a
runtime implementation, CDK deployment surface, or deployment proof. It is the fixture-backed vocabulary that later
milestones must implement consistently across Go, TypeScript, and Python before MicroVM deployments are considered
shippable.

The contract name is `apptheory.lambda_microvm`; the fixture version is `m15.microvm/v1`. Fixtures live under
`contract-tests/fixtures/m15/` and are validated by the Go, TypeScript, and Python contract runners.

## What M15 pins

The M15 fixtures define:

- lifecycle hook vocabulary for `prepare_image`, `start`, `readiness`, `stop`, `teardown`, and `failure`;
- lifecycle states from `requested` through image preparation, start, readiness, stop, teardown, `terminated`, and
  `failed`;
- controller command vocabulary for `create`, `start`, `stop`, `status`, and `session` interactions;
- controller envelope requirements for `command`, `request_id`, `tenant_id`, and `auth_context`;
- safe error-envelope fields for controller responses;
- durable session registry guidance using a TableTheory-patterned, tenant-and-namespace-bound record shape;
- explicit denial fixtures for raw AWS SDK escape hatches, raw lifecycle hook bypasses, and unauthenticated controller
  defaults.

## Security posture

The contract grows AppTheory's single path rather than adding a bypass. Later runtime and CDK work must preserve these
M15 invariants:

- no raw AWS SDK escape hatch for callers;
- no raw lifecycle hook bypass outside the AppTheory lifecycle contract;
- no unauthenticated controller default;
- session records remain tenant and namespace scoped;
- session registries must not persist raw AWS credentials, bearer tokens, or raw lifecycle hook payloads.

## What this does not ship yet

This milestone intentionally does **not** provide:

- Go lifecycle adapters or control-plane runtime APIs;
- TypeScript or Python runtime parity implementation;
- a durable TableTheory-backed session registry implementation;
- `AppTheoryMicrovm*` CDK constructs;
- example applications;
- any cloud deployment, live AWS receipt, account mutation, DNS mutation, or IAM mutation.

Those items belong to follow-up milestones. Until they land with fixture-backed parity, AppTheory documentation should
describe MicroVM support as contract foundation only.

## Validating the foundation

Run the shared contract runners:

```bash
./scripts/verify-contract-tests.sh
```

For focused debugging of only the fixture validators, run the three language runners directly:

```bash
go run ./contract-tests/runners/go
node contract-tests/runners/ts/run.cjs
python3 contract-tests/runners/py/run.py
```
