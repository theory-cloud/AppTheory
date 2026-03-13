# AppTheory Development Guidelines

This page is contract-only. It exists at this fixed root path to mark the maintainer-only boundary of the docs contract,
and it is not part of the ingestible user-facing docs set.

Detailed maintainer workflow belongs outside the ingestible surface under `docs/development/**`. Keep this root file
short so contract-only guidance is layout-resistant and does not accumulate user-facing process material.

## Root boundary rules

- keep this file short
- keep substantive maintainer process docs under `docs/development/**`
- do not add user-facing product guidance here
- do not treat this file as part of the KT ingestible publish set
- keep public capability docs under `docs/features/**`, `docs/integrations/**`, `docs/cdk/**`, or `docs/migration/**`

## Contract boundary

- Canonical external root: `docs/`
- Fixed contract-only files: `docs/_contract.yaml`, `docs/development-guidelines.md`
- Sanctioned optional ingestible surfaces: `docs/migration/**`, `docs/cdk/**`, `docs/llm-faq/**`
- Verification: `./scripts/verify-docs-standard.sh`, `make rubric`

## Maintainer detail

For the detailed docs maintainer workflow, version alignment rules, generated-output checklist, and local verification
sequence, use [docs/development/docs-maintainer-guide.md](./development/docs-maintainer-guide.md).

This indirection is intentional: the fixed root contract-only file remains minimal, while the maintainer procedure lives
under the non-canonical `docs/development/**` tree.
