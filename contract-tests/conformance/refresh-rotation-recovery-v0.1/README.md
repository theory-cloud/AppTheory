# `theorycloud_refresh_rotation_recovery` v0.1: durable MCP sessions through rotation

Status: **draft, 2026-11-11** (plan-gate passed paired CLEAR/CLEAR at round 3:
sanity `PLAN135-DURABLE-MCP-SANITY-PLAN-R3-20261111`, adversary
`ADVERSARY-PLAN133-R3-20261111`; three rework rounds recorded in
`docs/135-durable-mcp-sessions-roadmap-2026-11-11.md`). This is a contract
definition only — no implementation exists yet and no lab or live proof is
claimed. Governing scope and operator decisions: `docs/133`; enumeration:
`docs/134` items 1, 3, 4, 5, 7.

## Why this exists

Operator ruling, 2026-11-11: MCP connections are delegated stewards running for
many hours, in parallel and in sequence, across harness platforms whose client
behavior we do not control. **A credential family must die only from a real
security signal or explicit revocation — never from latency, timeouts, client
naivety, or intra-identity concurrency.** Availability-first: "if the system
does not work, no other security matters."

The 2026-11-11 16:00Z incident (theory-mcp-server#1153, comment 6801552583)
showed the kill shape: an upstream timeout mid-rotation lost the successor
response, the retry presented the consumed token, and the family was revoked as
`invalid_grant` — a credential family killed by latency. Three plan-gate rounds
then established, against the shipped code, what the recovery rules may rest on:

- there is **no holder-identity substrate** (ADV-133-1): the grant parses only
  client_id/refresh_token/resource/scope;
- the chain is **linear by CAS construction** (ADV-133-R1-2): "two concurrently
  live generations" is unreachable from presenter behavior;
- fine-grained reason codes are **log-only** (ADV-133-R1-3): the wire carries
  `error`/`error_description` only;
- the shipped artifact writer was **flag-gated, error-swallowed, and
  post-transaction** (ADV-133-R2-2): "write before ack" with those semantics
  still strands the lost-response holder;
- a generation **count bound can mis-pin below the real worst case**
  (ADV-133-R2-1) and revoke legitimate in-window presenters if it is a
  revocation predicate.

Every rule below is therefore stated on server-observable facts only.

## Producers and consumers

| Role | Party | Responsibility |
|---|---|---|
| Producer | Autheory (identity plane, sole token-minting authority) | R1–R6, R8, R9: rotation/rescue machinery, replay-artifact chain, recovery walk, verdict transport, revocation + receipts, retention |
| Producer | AppTheory framework `mcpfacade` (agent plane) | R7: verdict consumption, terminal-only family kill, exported sweep entrypoint, refresh budget configuration |
| Consumer | theory-mcp-server | Drives the scheduled sweep through the framework entrypoint (R7); surfaces the route-refresh event stream |
| Consumer | MCP host clients (kimi-code, Codex, others) | Unchanged. This contract exists so the platform stops depending on client behavior |
| Coordinator | Factory | This contract, the fixtures, validation, and the soak gate (docs/134 item 7) |

## Constants and derived pins

All values are **encoded stage configuration**, never operator-set environment
variables. The contract pins the derivation; the D4 assignment reconciles the
concrete numbers against the stage configs and records them here in a revision.

| Quantity | Derivation | Live (pinned target) | Lab soak (pinned target) |
|---|---|---|---|
| access-token TTL | stage config | 900 s | 120 s (short, to force refreshes during injection) |
| `g_min` (minimum legitimate generation interval) | refresh-due fraction × TTL; sweep lag additive | 0.5 × 900 = 450 s | 0.5 × 120 = 60 s |
| `W` (serve window) | measured recovery-attempt latency, minutes; `min(retention, concurrency grace)` — **both knobs move together** | 600 s | 600 s |
| `N` (generation bound) | `ceil(W / g_min) × margin`, margin 2 | `ceil(600/450)×2 = 4` | `ceil(600/60)×2 = 20` |
| artifact TTL | `W + margin` (time-based) | 1800 s | 1800 s |
| walk budget | sized for concurrent-presenter bursts; loader guarantee `≥ max(default, 4×G)` stated in the D4 packet | per D4 packet | per D4 packet |

**Steward sleep never enters N or W.** Multi-hour-sleep stewards are recovered
at the facade plane (stale-predecessor rotation, serve-never-revoke past
grace). No later revision may reintroduce sleep into these derivations
(ADV-133-R2-1).

## Rules

Rules are evaluated in order; the first violation is the case's verdict.

| Id | Rule |
|---|---|
| **R1 chain continuity** | Every rotation or rescue that consumes a generation mints exactly one successor, revokes the predecessor, and writes the consumed→successor replay artifact **in the same atomic transaction**, on **all** consuming branches. There are two transaction sites: `updateOAuthRefresh` (direct rotate + portal rescue) and `RedeemRetryAndRotateReplacement`'s own transaction (public-client branch — test-double-only today and out of production scope for that reason, ADV-133-R3-1). A consuming path that cannot guarantee the artifact write **fails closed 503 before minting** — it never mints an unlinkable successor. The artifact-write flag may gate walk **serve** only; it can never disable the invariant on consuming paths. |
| **R2 rescue mint and serve-many** | At most one rescue **mint** per generation (one-shot marker, CAS'd; the loser's race resolves transient 503, never a verdict). Artifact-backed **serve** repeats without limit within the window: a replaced token presenting in-window is walked along the artifact chain and served the current successor. |
| **R3 serve window W** | The online serve window is `min(replay retention, refresh concurrency grace)`, both from stage config, and **both move together** — moving only retention silently leaves the window at its old value. W derives from measured recovery-attempt latency (minutes), never from steward sleep duration. |
| **R4 generation bound N** | `N = ceil(W / g_min(stage)) × margin` with `g_min` from the **same** stage config. N is a **walk hop budget only — it is never a revocation predicate** (retention is time-based per R9): a count mis-pin degrades to a transient `replay_budget_exhausted` 503, never a kill. |
| **R5 revocation triggers (exhaustive)** | A family is revoked **only** by: (a) replay of a consumed token **beyond the time window W** (out-of-window replay); (b) logout/revoke-all generation containment; (c) explicit revocation. Nothing else revokes: not latency, timeouts, 503s, sweeps, client naivety, intra-identity concurrency, count-bound excess, or chain anomalies. A chain anomaly is corruption: 503 + alert, **never** a revocation and never `invalid_grant`. |
| **R6 verdict transport** | Every **recovery-available** staleness is answered `503 temporarily_unavailable` (with `Retry-After`, per the shipped M1.5 decision table `docs/auth/token-endpoint-error-decision-table.md`, which this contract's verdict rows extend) or served via the walk. Only **genuinely terminal** `invalid_grant` reaches the wire for consumed-token cases (post-revocation replay, containment). Per-code enumeration: per-request client errors (`invalid_scope`, `invalid_request`, `access_denied`, `expired_token`, `invalid_token`) are per-request/transient and are **never** family-killers. The portal rescue projection-refusal (`oauth_refresh_retry.go`) is reclassified per the M1.5 table or explicitly scoped out with a stated reason (ADV-133-R2-6a). |
| **R7 facade consumption** | The framework's terminal classifier family-kills only on contract-terminal verdicts; `failedRefreshGrant`/`revokeFamilyForRecord` fires only on those. The exported sweep entrypoint has a stated concurrency contract: a sweep-driven rotation racing a request-path rotation on the same family resolves transient (CAS/lock loser retries or defers), never family-affecting. The refresh budget is encoded configuration, not a fixed constant. |
| **R8 receipts** | Every revocation emits a receipt: structured log + audit event carrying the family reference, the trigger (one of R5's three), and the observable evidence. No silent revocations. |
| **R9 retention** | Replay artifacts live on a **time** TTL of `W + margin`; raw successor material is not served beyond the window. No count-based strip — deleting artifacts by count races in-window walkers by creating artificial gaps (ADV-133-R2-3). The plaintext-at-rest amplification of the walk is named in the D4 security-scan flag (ADV-133-6). |
| **R10 recorded residuals** | The D4 PR body carries this residual set for operator sign-off: (i) a thief holding the **current** live token is protocol-indistinguishable from the owner; (ii) in-window consumed-token theft upgrades the thief to a live co-holder via walk-serve (recovery-oracle); (iii) out-of-window replay revocation is a family-kill DoS primitive for a thief holding any single old token — the availability price of keeping replay-revocation; (iv) a lone legitimate holder presenting past W is revoked (finite-window false positive). Plus two horizon notes: the **replay-detection horizon** (SAN-135-R3-1: out-of-window replay revocation is implementable only within artifact retention; beyond it, old tokens are inert `invalid_grant` with no family event) and the **serve-off client-plane note** (ADV-133-R3-2: with the write ON but serve OFF, an in-window rescue-marked presenter gets a 400 `invalid_grant` and a purging harness kills its own session client-side — the family survives, but the write-ON/serve-OFF soak state and any serve kill-switch re-arm the incident class at the client plane; stated in the D4 rollout note and the advisory harness doc), and the **rolling-deploy note** (ADV-133-R2-6b: rescue mints under pre-D4 code during a rollout produce unlinkable successors no invariant repairs retroactively; bounded by in-window 503-never-revoke and residual (iv)). |

## Valid fixtures

`fixtures/valid/` (each is a conformant scenario trace; see schema):

- `rotation-loss-rescue-walk-serve.json` — the 2026-11-11 16:00Z sequence:
  rescue mints the successor with the artifact atomically, the response is
  lost, the retry presents the consumed token and is **walk-served** the
  successor. No revocation, no `invalid_grant`.
- `diverged-store-parallel-recovery.json` — two sessions of one identity with
  diverged stores: A's rescue is walked by B, which is recovery-served.
  Parallel sessions are never fork evidence.
- `multi-generation-gap-resume.json` — a steward holding g0 while the family
  advanced to g12 within W is walked to the head: recovery, not revocation.
- `out-of-window-replay-revokes.json` — control: replay beyond W revokes, with
  receipt and terminal `invalid_grant`.
- `artifact-write-outage-fail-closed.json` — artifact write unavailable during
  a rotation: fail-closed 503 **before** minting, family intact, retry
  recovers.
- `burst-budget-exhaustion-transient.json` — a concurrent-presenter burst
  exceeding the walk budget gets `replay_budget_exhausted` 503s; transient,
  family intact, retries recover.

## Invalid fixtures

`fixtures/invalid/` (banned behaviors; each declares `expected_violation`):

- `rescue-mint-without-artifact.json` — R1: rescue mints without the artifact
  in the same transaction (today's 16:00Z strand).
- `second-rescue-mint-within-window.json` — R2: a second in-window rescue
  **mint** for one generation instead of a serve.
- `in-window-staleness-invalid-grant.json` — R6: recovery-available staleness
  answered 400 `invalid_grant`.
- `family-revoked-on-upstream-timeout.json` — R5: revocation after a timeout.
- `count-bound-revocation.json` — R4: revocation because presentations exceeded
  N while inside W.
- `chain-anomaly-revoke.json` — R5: chain inconsistency treated as theft.
- `per-request-error-family-kill.json` — R7: `invalid_scope` kills a family.
- `sleep-derived-window.json` — R3: W or N derived from steward sleep duration.

## Validation

- `python3 scripts/validate-refresh-rotation-recovery-fixtures.py` — schema +
  rule checks: fixture shape, stage-config arithmetic (`g_min`, `N ≥ ceil(W /
  g_min)`), revocation triggers restricted to R5's set, wire-code discipline
  (no terminal `invalid_grant` for recovery-available staleness), and
  invalid-fixture verdicts against declared violations.
- Consuming repos (Autheory D4, AppTheory D3) consume these fixtures in their
  own CI per docs/135; the D7 soak replays the valid scenarios against lab.

## Unproven / planned surfaces

- Everything here is **planned** until D3/D4 merge and the D7 lab soak runs;
  evidence remains lab-class until the operator runs live.
- kimi-code / other harness behavior is observed-upstream only; the advisory
  harness-behavior doc (docs/134 item 8, folded into D6) carries the mapping.
- Provisioned concurrency for the token path is a soak-driven operator
  decision, not part of this contract.

## Unsafe interpretations blocked

- "The count bound revokes." Demoted: N is a walk hop budget only (retention is time-based, R9).
- "A second rescue means an attacker." One identity runs parallel sessions
  with diverged stores; rescue-serve is the required behavior.
- "Chain inconsistency is theft evidence." Corruption → 503 + alert, never
  revocation.
- "invalid_grant is safe to emit for stale tokens." Recovery-available
  staleness is 503; harnesses purge on `invalid_grant`.
- "Steward sleep belongs in the window derivation." Sleep is facade-plane;
  barred from N and W.
- "The artifact write flag can disable chain continuity." The flag gates walk
  serve only; consuming paths always write atomically or fail closed.
- "Recovery weakens revocation for real attacks." Revocation still fires on
  out-of-window replay, containment, and explicit operator action — with
  receipts. The accepted residuals are the four in R10, recorded, not hidden.
