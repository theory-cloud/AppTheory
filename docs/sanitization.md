# Sanitization (safe logging + redaction)

AppTheory includes a **portable sanitization toolkit** (Go/TypeScript/Python) intended for **safe-by-default logging** in
PCI/PII-heavy services (including import pipelines).

Sanitization is a **last line of defense**. Prefer not to log secrets at all, and treat any logged payload as user data.

## What to sanitize

- **Log strings**: strip control characters (`\r`, `\n`) to prevent log forging.
- **Fields/maps**: redact or mask values based on key name (case-insensitive).
- **JSON**: recursively sanitize JSON structures (with a special case for `"body"` being a JSON-encoded string).
- **XML**: apply regex-based masking for common payment XML tags (card numbers, CVV, etc).

## Cross-language surfaces

- Go: `pkg/sanitization`
  - `SanitizeLogString`, `SanitizeFieldValue`, `SanitizeJSON`, `SanitizeJSONValue`, `SanitizeXML`
  - `RawJSON` (marker type for structured JSON logging)
  - `PaymentXMLPatterns` (and alias `RapidConnectXMLPatterns`)
  - `MaskFirstLast`, `MaskFirstLast4`
- TypeScript: `ts/src/sanitization.ts` (exported from `@theory-cloud/apptheory`)
  - `sanitizeLogString`, `sanitizeFieldValue`, `sanitizeJSON`, `sanitizeJSONValue`, `sanitizeXML`
  - `paymentXMLPatterns` (and alias `rapidConnectXMLPatterns`)
  - `maskFirstLast`, `maskFirstLast4`
- Python: `py/src/apptheory/sanitization.py` (exported from `apptheory`)
  - `sanitize_log_string`, `sanitize_field_value`, `sanitize_json`, `sanitize_json_value`, `sanitize_xml`
  - XML patterns: `payment_xml_patterns` (and alias `rapid_connect_xml_patterns`)
  - `mask_first_last`, `mask_first_last4`

## Sensitive field policy (high level)

Sanitization is key-name driven:

- Some keys are **fully redacted** (e.g. `cvv`, `password`, `authorization`).
- Some keys are **partially masked** (e.g. `card_number`, `account_number`, `ssn`).
- Common PAN aliases used in import/migration datasets are treated as card numbers and **masked accordingly**:
  `pan_value`, `pan`, `primary_account_number`.

Unknown keys fall back to safe string sanitization (strip `\r`/`\n`) and recursive sanitization for nested objects.
AppTheory intentionally avoids substring-based redaction rules because they can over-redact non-secret business fields
(for example GraphQL response fields that contain `"authorization"` in the name).

### Context-aware `accountNumber`

Some upstream payloads use the key `accountNumber` for both card PANs and bank accounts. AppTheory masks this key
based on immediate parent context:

- Card PAN contexts (e.g. `cardWithPanDetails`, `panDetails`): **PAN mask** (`BIN + **** + last4` when available).
- ACH/bank contexts (e.g. `achDetails`, `bankDetails`) or snake_case `account_number`: **restricted mask** (`****last4`).

## Usage guidance

- Prefer sanitizing **structured fields** (`sanitize_field_value` / `SanitizeFieldValue`) over dumping raw payloads.
- If you must log JSON payloads (e.g. event envelopes):
  - Console/text logs: log `sanitize_json(...)` / `SanitizeJSON(...)` output.
  - Structured JSON logs:
    - Go: wrap payload bytes with `sanitization.RawJSON(...)` (recommended) or call `SanitizeJSONValue(...)`.
    - TypeScript/Python: prefer `sanitizeJSONValue(...)` / `sanitize_json_value(...)`.
    This keeps JSON nested/typed in the logger output instead of logging an escaped JSON string.
- For XML payloads, use `sanitize_xml(xml, payment_xml_patterns)` / `SanitizeXML(xml, PaymentXMLPatterns)`.

### AWS event `"body"` parsing

AWS HTTP-style events commonly store the request body as a JSON-encoded **string** under the key `"body"`.
AppTheory treats `"body"` specially when it contains valid JSON:

- `SanitizeJSON(...)` / `sanitize_json(...)` keeps `"body"` as a string (rewritten to sanitized JSON).
- `SanitizeJSONValue(...)` / `sanitizeJSONValue(...)` / `sanitize_json_value(...)` parses `"body"` into a nested object for structured logging.

## Policy overrides (Go)

If you need to tune sanitization without writing a custom sanitizer function, set
`observability.LoggerConfig.SanitizationPolicy`.

Rules are evaluated **before** the built-in defaults, so policies can override both allowlisted IDs and default
redactions/masks.

## Stability

Sanitization behavior is intentionally deterministic. Expanding redaction rules can be a **breaking operational change**
(it affects logs, debugging workflows, and any downstream log processing). When changing policy, add tests before
expanding the rules.
