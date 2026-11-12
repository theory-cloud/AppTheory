# Vendored contract: `theorycloud_refresh_rotation_recovery.v0.1`

Source: Factory `contracts/refresh-rotation-recovery/v0.1` (plan gate
docs/133/134/135, paired CLEAR/CLEAR at round 3 on 2026-11-11). Vendored
verbatim, with the source `README.md`, `schema.json`, and every conformance
fixture, so AppTheory CI pins the facade against the contract rather than against
a local paraphrase.

- Do not edit the vendored documents to make AppTheory pass. If the contract is
  wrong, stop and report to Factory (docs/133 D3 instruction) instead of forking
  the semantics here.
- Re-vendor by copying the whole directory from the Factory contract again, so a
  revision cannot land half-applied.
- Consumers, one validator port per runtime:
  - Go: `runtime/mcpfacade/refresh_rotation_recovery_conformance_test.go`
  - TypeScript: `ts/test/mcpfacade-refresh-recovery.test.mjs`
  - Python: `py/tests/test_mcpfacade_refresh_recovery.py`

Each port implements the contract's rule checks (`R1`–`R8` plus fixture-shape
`FX` consistency) and additionally asserts the facade-side rule (`R7`): the
runtime's terminal token-verdict taxonomy must classify exactly the contract's
terminal code as terminal and every per-request client code as not terminal, so
the invalid `per-request-error-family-kill` case is impossible by construction.
