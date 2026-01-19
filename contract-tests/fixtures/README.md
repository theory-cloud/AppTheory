# Contract test fixtures

Fixtures are shared, machine-readable test vectors used to prevent cross-language runtime drift.

File layout:

- `contract-tests/fixtures/p0/` — runtime core
- `contract-tests/fixtures/p1/` — context + middleware
- `contract-tests/fixtures/p2/` — portable production features

Each fixture is a single JSON object.

## Common shape

- `id` (string): stable identifier (use `p0.*`, `p1.*`, `p2.*` prefixes).
- `tier` (string): `p0` / `p1` / `p2`.
- `name` (string): short human-friendly name.
- `setup.routes` (array): route table for the fixture runner.
  - `method` (string): HTTP method (e.g. `GET`).
  - `path` (string): route pattern (supports `{param}` segments).
  - `handler` (string): built-in handler name provided by each language runner.
- `input.request` (object): request presented to the runtime under test.
- `expect.response` (object): expected canonical response.

## Bytes in JSON

Because JSON cannot carry raw bytes, fixtures encode request/response bodies as:

- `body.encoding`: `utf8` or `base64`
- `body.value`: the encoded value

For convenience, expected responses may specify `body_json` (object). When present, runners compare JSON semantics
(ignoring key order) and do not require a specific JSON byte formatting.

