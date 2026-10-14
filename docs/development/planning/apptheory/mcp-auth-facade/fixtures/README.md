# MCP auth facade fixtures (contract of record)

These files are the M0 **contract of record** for the AppTheory MCP auth facade, authored in the repository's
contract-table shape so they can be registered in the contract-test corpus in M1 without translation.

The remaining files live under `docs/development/planning/` (the planning tree) rather than `contract-tests/fixtures/`
for one reason: their runtime consumers (the provider/store SPI and the facade mechanics) have not landed yet, so
registering them in the live corpus now would create inert vectors and inflate the public fixture count without an
executable pin. `CONFORMANCE_KIT.md` §4 records the M1 registration of the two tables that did land.

| File | Contract | Consumed by (target) |
| --- | --- | --- |
| `facade-provider-spi.v1.json` | `m17.mcp-auth-facade/v1` | provider SPI tests + the Autheory adapter contract test |
| `facade-store-spi.v1.json` | `m17.mcp-auth-facade/v1` | store SPI tests (consume-once / CAS / TTL semantics) |
| `facade-threat-controls.v1.json` | `m17.mcp-auth-facade/v1` | threat-control pinning (review aid + future fixtures) |

`facade-route-model.v1.json`, `facade-transport-posture.v1.json`, and `facade-journey.v1.json` were authored here in
M0 and have **moved into the corpus**; they now live at `contract-tests/fixtures/routing/mcp-auth-facade/` and are
consumed directly by the Go, TypeScript, Python, and CDK-TS loader tests (the journey table as one `journey` row set
executed by all three runtimes). Do not re-add them under this directory.

Shape notes: these are versioned contract tables, matching
`contract-tests/fixtures/routing/mcp-route-algebra/expectations.json` (a nested table loaded directly by tests),
not the three-language single-envelope fixture format used by `tier: oauth` / `tier: mcp` vectors.
The journey table keeps the same HTTP-shaped rows it was authored with, now carrying the closed row vocabulary each
runtime's journey dispatcher executes.
