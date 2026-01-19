# SR-PROD-FEATURES — Production Features Parity (P1/P2)

Goal: deliver the “production-ready” value proposition (multi-tenancy, auth hooks, observability, rate limiting) without
breaking cross-language parity.

Rule: if a feature is P1/P2, it must be contract-specified and fixture-tested across Go/TypeScript/Python.

## Scope

P1/P2 features that are expected to be portable:

- Context model: request-id, tenant, auth identity (as a hookable interface), correlation fields
- Middleware ordering semantics and “safe defaults” behavior
- CORS, size/time guardrails, input validation surfaces
- Observability envelope: minimum structured log schema; optional metrics/tracing hooks
- Rate limiting / load shedding semantics (portable subset only)

Non-goals:

- Porting every Lift enterprise feature immediately. Prioritize what Pay Theory actually uses and what is portable.

## Milestones

### P0 — Freeze portable boundaries (what must match)

**Acceptance criteria**
- A list exists of P1/P2 features that must be portable.
- A separate list exists for Go-only features (explicitly documented as non-portable).
- Parity matrix is updated accordingly.

---

### P1 — Multi-tenant semantics (portable core)

**Acceptance criteria**
- Tenant extraction rules are specified (where tenant comes from; precedence; failure behavior).
- Tenant is present in context in all three languages.
- Contract fixtures validate tenant behavior and tagging.

---

### P2 — Auth hooks + identity model (portable core)

**Acceptance criteria**
- Auth is expressed as a hook/interface that can be implemented per app (not hard-coded to one provider).
- Failure behavior is standardized (401/403 mapping; error codes).
- Contract fixtures validate ordering and error behavior.

---

### P3 — Observability surfaces (logs/metrics/tracing)

**Acceptance criteria**
- Minimum structured log fields are defined and consistent across languages.
- Metrics/tracing hooks exist with stable naming rules (if included).
- Deterministic tests exist for log field presence and trace span naming rules (where feasible).

---

### P4 — Rate limiting / load shedding semantics (portable subset)

**Acceptance criteria**
- Contract defines portable behavior (what triggers shedding; response/status; retry hints).
- Implementations match behavior across languages.
- Anything too platform-specific is explicitly excluded (Go-only or user-space).

---

### P5 — “Safe by default” controls (guardrails)

**Acceptance criteria**
- Default middleware stack is documented and consistent.
- Dangerous defaults are avoided (no silent permissive behavior).
- CI gates exist to prevent regressions (lint rules, size budgets, or contract fixtures as appropriate).

## Risks and mitigation

- **Portability pressure:** if a feature cannot be made portable, explicitly make it Go-only and do not pretend otherwise.
- **Overreach:** prioritize features actually required for Pay Theory migrations and multi-language parity.

