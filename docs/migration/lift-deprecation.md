# Lift Deprecation & Communication Plan (Pay Theory)

This document is the **internal posture** for transitioning Pay Theory services from `pay-theory/lift` to AppTheory.

AppTheory is not required to be API-identical to Lift, but Pay Theory’s migrations must preserve **100% of Lift’s current
functionality** (portable subset + documented Go-only extensions) so services don’t lose capabilities during the move.

## Principles

- **No cliff migrations:** services move when the needed capabilities exist (or have explicit Go-only equivalents).
- **No feature cuts:** Pay Theory migrations do not drop Lift functionality.
- **Predictable support:** Lift stays supported long enough to migrate safely.

## Support posture (recommended)

### Lift

- **New features:** stop adding net-new features to Lift once AppTheory has an equivalent roadmap item.
- **Allowed changes:** security fixes, critical bug fixes, dependency updates, and narrowly scoped internal needs.
- **Release posture:** maintain releases only as needed for the above; avoid large refactors.

### AppTheory

- **New features:** all net-new platform/runtime work lands in AppTheory.
- **Migration focus:** prioritize functionality that unblocks Pay Theory services (baseline inventory in:
  `docs/development/planning/apptheory/supporting/apptheory-lift-usage-inventory.md`).

## Timeline (fill in when ready)

- **T0:** AppTheory `v0.x` begins (contract + fixtures; migration helpers available).
- **T1:** AppTheory reaches “Lift-equivalent for Pay Theory” (documented parity across required features).
- **T2:** Lift marked “maintenance mode” internally (no new features; fixes only).
- **T3:** Lift end-of-support date (after all services migrate).

This document intentionally avoids hard dates until the inventory-to-parity plan is validated.

## Comms checklist

- AppTheory release notes always include:
  - a link to the migration guide (`docs/migration/from-lift.md`)
  - a link to this deprecation plan (`docs/migration/lift-deprecation.md`)
  - a short “what changed” note for migrations (imports, config, middleware ordering, etc)

