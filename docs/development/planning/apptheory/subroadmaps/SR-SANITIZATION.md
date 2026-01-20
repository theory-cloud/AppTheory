# SR-SANITIZATION — Safe Logging + Redaction Utilities (Lift Parity, Go/TS/Py)

Goal: AppTheory must provide a first-class, safe-by-default sanitization toolkit so services can log diagnostically
useful data without leaking secrets or enabling log forging.

This is Lift parity work (K3 uses `lift/pkg/utils/sanitization`), and it is also a security requirement for a “robust
improvement on Lift”.

## Scope

- Sanitization utilities for logging:
  - log-forging prevention (strip `\r`/`\n` from log strings)
  - JSON sanitization/redaction helpers (mask common sensitive fields)
  - masking helpers (card PAN-style, account numbers, tokens, etc)
- Clear guidance on when/how to use sanitizers in handlers/middleware
- Unit tests (deterministic, no AWS)

Non-goals:

- A full data classification system in the first pass (only add if real apps require it).

## Design requirements

- **Deterministic behavior:** given the same input, sanitization output must be stable (tests rely on this).
- **Safe by default:** unknown fields should not be aggressively redacted unless policy requires it, but known sensitive
  fields must be masked/redacted.
- **Portable behavior:** where sanitization output affects logged payloads used across languages, keep behavior aligned
  (or explicitly document differences).

## Current status (AppTheory `premain`)

- Go: `pkg/sanitization` provides:
  - `SanitizeLogString` (log forging prevention)
  - `SanitizeJSON` (recursive JSON sanitization with common sensitive-field redaction + `body`-JSON handling)
  - `SanitizeXML` + `PaymentXMLPatterns` (RapidConnect-friendly XML masking)
- TypeScript: `ts/dist/index.js` exports `sanitizeLogString`, `sanitizeJSON`, `sanitizeXML`, `paymentXMLPatterns`.
- Python: `py/src/apptheory/sanitization.py` exports `sanitize_log_string`, `sanitize_json`, `sanitize_xml`,
  `payment_xml_patterns`.

## Milestones

### Z0 — Inventory + policy decision (K3-focused)

**Acceptance criteria**
- Identify which Lift sanitization functions K3 uses (e.g. `SanitizeJSON`) and the expected behavior.
- Decide the minimum sanitization policy AppTheory will guarantee:
  - which fields are treated as sensitive by default
  - what masking strategy is used (partial vs full redaction)

---

### Z1 — Log-string sanitization (portable)

**Acceptance criteria**
- Go/TS/Py expose a helper to sanitize log strings (remove control characters that enable log forging).
- Unit tests cover common edge cases.

---

### Z2 — JSON sanitization (portable)

**Acceptance criteria**
- Go/TS/Py expose a helper that:
  - takes JSON bytes/string
  - returns a sanitized, valid JSON string (or a safe placeholder for malformed JSON)
  - redacts/masks known sensitive fields
- Unit tests cover:
  - nested objects/arrays
  - “body contains JSON string” patterns (common in AWS event payloads)
  - malformed JSON behavior

---

### Z3 — Documentation + examples

**Acceptance criteria**
- Docs include examples for:
  - sanitizing raw AWS events
  - sanitizing request payloads safely
  - avoiding accidental secret logging

## Risks and mitigation

- **False sense of safety:** document that sanitization is a last line of defense; avoid logging secrets in the first
  place.
- **Breaking changes:** treat sanitization behavior as stability-sensitive; add tests before expanding rules.
