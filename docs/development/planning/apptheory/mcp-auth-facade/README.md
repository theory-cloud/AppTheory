# AppTheory MCP auth facade — planning

This folder is the planning and design record for the **AppTheory MCP auth facade**: the framework capability
that lets any implementing system front an upstream auth provider on **one domain**, in Go, TypeScript, and
Python with jsii CDK bindings, proven by shared fixtures.

It answers operator rulings of 2026-10-12 (Factory docs/110):

1. AppTheory must **fully support** applications like theory-mcp-server (TMS). App-side workarounds for
   framework gaps are framework needs, fixed upstream.
2. AppTheory provides the **full needs of an MCP auth facade**, provider-neutral, with Autheory as the first
   provider and the sole authorization server / token authority.
3. TMS **proxies** Autheory so MCP clients see a single domain; TMS is not its own authorization server.
4. v6.0.0 has **no consumers**: corrections are not breaking; no shims and no opt-in flags; design the right
   default directly; the fix ships as the next 6.x release (the 6.0.0 tag/assets are immutable).
5. **Parity is never deferred**: Go, TypeScript, and Python plus CDK bindings ship atomically, proven by shared
   fixtures.
6. **No releases and no lab/integration testing** until AppTheory is fixed; in-CI unit/contract testing
   continues.
7. The fix is **proven in lab** against Autheory and TMS (deploy order Autheory → TMS → TCA), using each app's
   own deploy script in a lab-only mode that builds AppTheory at a pinned commit declared in **encoded stage
   config** (never an operator environment variable).

## Status

**M0 (design, contract and fixtures) is complete in this folder.** No runtime, CDK, or version change is in
M0. M1–M4 implement the design; M5 migrates TMS/Autheory; M6 is the operator-run lab proof.

**Implemented:** M1, M2 and M3 (delivered as M3b-i, M3b-ii, M3c-1a, M3c-1b and M3c-2) and M4 are implemented for
Go, TypeScript, Python and CDK on the `staging` line. M4 covers the framework CDK edge `WWW-Authenticate`
restoration construct for REST v1 origins (G9), the release-note correction mechanism (G11) and the deterministic
`streamjoin` close test (G12), and it ships the lab candidate-build builder that §4 of
`CANDIDATE_BUILD_INTERFACE.md` specifies. M5 (TMS/Autheory adoption) and M6 (the operator-run lab proof) are not
started, and every lab item in `UNVERIFIED.md` stays open.

## Default-semantics recommendation (read this first)

**Facade-scoped default flip.** An `AppTheoryMcpServer` that attaches the OAuth facade defaults to
runtime-validated bearer (`runtime-bearer`); a plain transport server keeps the IAM default; `unauthenticatedMcp`
is replaced by an explicit `transportPosture` selection whose `none-public` value is never a default. Full
reasoning, options, consequences, and the fail-closed behavior table are in `DEFAULT_SEMANTICS.md`. The
operator reviews this at the M0 PR.

## Documents

| Document | Contents |
| --- | --- |
| `M0.md` | Work order, deliverables index (items 1–10), acceptance record, and open decisions. |
| `DESIGN.md` | Item 1 — component model, provider SPI, store SPI, route model, validator/challenge model, CDK model. |
| `FRAMEWORK_VS_POLICY.md` | Item 2 — verdict per TMS mechanic and the derived minimal proxy. |
| `DEFAULT_SEMANTICS.md` | Item 3 — the transport-auth default decision (**operator review**). |
| `DEFENSE_IN_DEPTH.md` | Item 4 — mandatory floor for runtime-validated bearer. |
| `THREAT_MODEL.md` | Item 5 — named threat model with controls and pins. |
| `CONFORMANCE_KIT.md` | Item 6 — the conformance-kit spec (synth posture pin, credential-free 401 + challenge, fail-closed). |
| `MINIMAL_CONSUMER.md` | Item 6 — the worked minimal non-TMS consumer (scenario (a) by construction). |
| `PARITY_AND_DELIVERY.md` | Item 7 — parity matrix, M1–M4, CI gates, deterministic `streamjoin`. |
| `RELEASE_NOTE_CORRECTION.md` | Item 8 — correcting the 6.0.0 release notes under Release Please ownership (executed in M4; the durable record is `docs/release-notes-corrections.md`). |
| `CANDIDATE_BUILD_INTERFACE.md` | Item 9 — lab candidate build interface (one commit, per-surface hashes, refuse-live); **implemented in M4** (`scripts/lab/candidate-build.sh` + self-test), with §4.1 the interface as built and §4.2 the integration note for TMS/Autheory. |
| `UNVERIFIED.md` | Item 10 — honest unknown/unverified list. |
| `fixtures/` | Planning-tree contract tables (`m17.mcp-auth-facade/v1`) and the runnable example candidate stage config; the `m17.mcp-route-algebra/v2` and `m17.mcp-transport-posture/v1` tables now live in the corpus at `contract-tests/fixtures/routing/mcp-auth-facade/` (moved in M1). |

## Contracts

- `m17.mcp-route-algebra/v2` — superset of v1: adds the derived `/register` route, one stage-global upstream
  callback route, and per-route issuer/resource derivation (`IssuerMode: route`).
- `m17.mcp-transport-posture/v1` — transport posture vocabulary, CDK↔runtime pairing, fail-closed defaults.
- `m17.mcp-auth-facade/v1` — facade behavior, provider SPI, store SPI, validator/challenge model.

## Milestones (detail in `PARITY_AND_DELIVERY.md`)

- **M1** Transport posture + conformance kit (G1, G10).
- **M2** Route model + validator + challenge (G2, G4, G5, G6, G8).
- **M3** Facade module + provider/store SPIs (G7, G3).
- **M4** Hygiene: edge header restoration, release-note correction, deterministic `streamjoin` (G9, G11, G12).
- **M5** Adoption (TMS migrates onto the facade; Autheory/TCA/FaceTheory repin) + lab-only candidate mode.
- **M6** Operator-run lab proof.

## Non-goals in M0

No releases or prereleases, no version bumps, no CHANGELOG edits, no runtime/CDK implementation, no lab or
deploy actions, no AWS calls or credentials, no sibling/parent repo edits.
