# MCP auth facade fixtures (contract of record)

These files are the M0 **contract of record** for the AppTheory MCP auth facade, authored in the repository's
contract-table shape so they can be registered in the contract-test corpus in M1 without translation.

They live under `docs/development/planning/` (the planning tree) rather than `contract-tests/fixtures/` for one
reason: M0 has no facade runtime to load them against, and this milestone's write scope forbids adding loader
tests under `runtime/**`/`cdk/**`. Registering them in the live corpus now would create inert vectors and
inflate the public fixture count without an executable pin. `CONFORMANCE_KIT.md` §4 records the exact M1
registration (nested directory + Go/CDK-TS loaders + count/prose update).

| File | Contract | Consumed by (target) |
| --- | --- | --- |
| `facade-route-model.v1.json` | `m17.mcp-route-algebra/v2` | route model tests (Go + CDK-TS); conformance kit Layer A |
| `facade-transport-posture.v1.json` | `m17.mcp-transport-posture/v1` | conformance kit Layers A/C (CDK-TS + runtime) |
| `facade-provider-spi.v1.json` | `m17.mcp-auth-facade/v1` | provider SPI tests + the Autheory adapter contract test |
| `facade-store-spi.v1.json` | `m17.mcp-auth-facade/v1` | store SPI tests (consume-once / CAS / TTL semantics) |
| `facade-journey.v1.json` | `m17.mcp-auth-facade/v1` | end-to-end facade fixtures (Go/TS/Py) |
| `facade-threat-controls.v1.json` | `m17.mcp-auth-facade/v1` | threat-control pinning (review aid + future fixtures) |

Shape notes: these are versioned contract tables, matching
`contract-tests/fixtures/routing/mcp-route-algebra/expectations.json` (a nested table loaded directly by tests),
not the three-language single-envelope fixture format used by `tier: oauth` / `tier: mcp` vectors.
`facade-journey.v1.json` is deliberately HTTP-shaped so it can become a `tier: facade` single-envelope fixture
set when the runtime exists.
