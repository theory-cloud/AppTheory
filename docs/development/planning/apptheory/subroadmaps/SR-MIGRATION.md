# SR-MIGRATION — Lift → AppTheory (Easy Migration, Not Drop-in)

Goal: enable Pay Theory (and any other Lift users) to migrate to AppTheory with minimal friction, even if the migration is
not drop-in identical.

This workstream is about **reducing migration time** while preserving **Lift-equivalent capabilities** for Pay Theory.
AppTheory is not required to be API-identical to Lift, but it must keep **100% of Lift’s current functionality** available
to Go users (portable subset + documented Go-only extensions) so migrations don’t require feature cuts.

## Scope

- A complete migration guide with mapping tables and examples
- Optional automation helpers:
  - import rewrite scripts
  - compatibility shims/adapters (targeted, not permanent)
  - codemods for common patterns
- A migration playbook tested on at least one representative service

Non-goals:

- 100% API compatibility with Lift.
- Supporting external Lift users’ edge cases beyond what Pay Theory uses (unless chosen later).

## Milestones

### G0 — Inventory real Lift usage (Pay Theory baseline)

**Acceptance criteria**
- A list exists of which Lift packages/features are used in:
  - the Pay Theory stack, and
  - other known Lift apps we care about (notably: `equaltoai/lesser`)
- Each usage is mapped to:
  - “direct replacement in AppTheory”
  - “replacement with behavior change”
  - “Go-only, keep using Lift” (temporary) or “drop”

Inventory doc (baseline):

- `docs/development/planning/apptheory/supporting/apptheory-lift-usage-inventory.md`
- Gap analysis derived from Lesser: `docs/development/planning/apptheory/apptheory-gap-analysis-lesser.md`

---

### G1 — Migration guide skeleton + mapping table

**Acceptance criteria**
- A doc exists that answers:
  - what changes (imports, handler signatures, middleware stack, config)
  - why changes exist (contract parity, language portability)
  - what is automated vs manual
- Includes a mapping table from Lift symbols/patterns → AppTheory equivalents.

Guide (skeleton):

- `docs/migration/from-lift.md`

---

### G2 — Compatibility shims (only where high-leverage)

**Acceptance criteria**
- If shims are created, they are:
  - small and explicit
  - clearly deprecated
  - covered by tests
- Shims exist only for the highest-leverage migration pain points.

High-leverage port (rate limiting):

- `pkg/limited` (TableTheory-backed port of `pay-theory/limited`)
- `pkg/limited/middleware` (net/http middleware)

---

### G3 — Automated helpers (codemods/scripts)

**Acceptance criteria**
- At least one automation helper exists and is documented (example: rewrite import paths and a small set of renamed APIs).
- The helper is safe by default (dry-run mode; clear diff output).

Automation helper (Go):

- `scripts/migrate-from-lift-go.sh` (rewrites `pay-theory/limited` imports to AppTheory)

---

### G4 — Migrate one representative service end-to-end

**Acceptance criteria**
- A representative service is migrated using the playbook and helpers.
- The migration produces a short “lessons learned” and updates the guide.

Representative migration (rate limiting):

- Example: `examples/migration/rate-limited-http/README.md`
- Lessons learned: `docs/migration/g4-representative-migration.md`

---

### G5 — Deprecation and communication plan

**Acceptance criteria**
- `pay-theory/lift` deprecation posture is documented (what stays supported and for how long internally).
- AppTheory release notes link to the migration guide and highlight breaking differences.

Artifacts:

- Deprecation posture: `docs/migration/lift-deprecation.md`
- Release notes template: `scripts/render-release-notes.sh`

## Risks and mitigation

- **Hidden Lift coupling:** start with the Pay Theory inventory to avoid surprises.
- **Shim creep:** make shims time-bound and minimal; prefer teaching the new model.
