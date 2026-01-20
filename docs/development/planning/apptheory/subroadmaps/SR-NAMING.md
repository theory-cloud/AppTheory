# SR-NAMING — Deterministic Resource Naming Helpers (Lift Parity, Go/TS/Py)

Goal: AppTheory must provide deterministic naming helpers (Lift parity for `lift/pkg/naming`) that work in Go/TS/Py and
support consistent infrastructure naming across environments.

## Scope

- Stage normalization helpers (canonicalize aliases like `prod` → `live`, etc)
- Resource name builders based on env inputs (`APP_NAME`, `STAGE`, optional tenant/partner)
- Unit tests in each language (deterministic)

## Current status (AppTheory `v0.2.0-rc.1`)

- Go: `pkg/naming` (`NormalizeStage`, `BaseName`, `ResourceName`)
- TS: `normalizeStage`, `baseName`, `resourceName` exports
- Py: `apptheory.naming` (`normalize_stage`, `base_name`, `resource_name`)
- Contract fixture coverage exists: `contract-tests/fixtures/m12/naming-helpers.json`.

Non-goals:

- Replacing CDK naming conventions; this is a small utility package to keep names consistent across services, scripts,
  and CDK templates.

## Milestones

### N0 — API design + compatibility target

**Acceptance criteria**
- Define the AppTheory naming API surface and how it maps to Lift naming concepts.
- Decide env var conventions:
  - app name key (`APP_NAME`)
  - stage key (`STAGE`)
  - tenant key (`PARTNER` vs `TENANT`)

---

### N1 — Stage normalization (portable)

**Acceptance criteria**
- Go/TS/Py can normalize stage aliases to canonical values.
- Unit tests cover known aliases used in real repos.

---

### N2 — Name builders (portable)

**Acceptance criteria**
- Go/TS/Py expose helpers to build:
  - base name (`<app>-<tenant>-<stage>` or `<app>-<stage>`)
  - resource name (`<app>-<tenant>-<resource>-<stage>` or `<app>-<resource>-<stage>`)
- Unit tests prove deterministic output.

---

### N3 — Migration guidance (Lesser)

**Acceptance criteria**
- Docs map `lift/pkg/naming` usage to AppTheory naming helpers for Lesser.

## Risks and mitigation

- **Naming drift:** keep the rules small, explicit, and tested; avoid adding “magic” heuristics without tests.
