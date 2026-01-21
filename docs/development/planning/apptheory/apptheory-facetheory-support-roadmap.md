# AppTheory: FaceTheory Enablement Roadmap (SSR on Lambda URL)

This roadmap captures what AppTheory must provide to make **FaceTheory** (SSR + SSG/ISR on AWS) production-ready, while
preserving AppTheory’s core constraints:

- **First-class Go/TS/Py** (no “official” language plus ports).
- **GitHub Releases only** (no npm/PyPI publishing).
- **Contract-first** behavior with fixture-backed verification.

Source documents:

- `FaceTheory/docs/WISHLIST.md` (dependency wishlist for AppTheory/TableTheory)
- `FaceTheory/docs/ARCHITECTURE.md` (Lambda Function URL + response streaming design)
- `FaceTheory/docs/ROADMAP.md` (FaceTheory milestones; used for sequencing)

## Baseline (current)

As of AppTheory `v0.2.0-rc.2` (M13 complete):

- Lambda Function URL **buffered** request/response normalization exists (Go/TS/Py).
- Router supports `{param}` and `:param` normalization, but **no catch-all** (`{proxy+}`).
- SSE for API Gateway REST v1 exists (separate from Lambda URL response streaming).

## Scope (what AppTheory must own)

### Must-haves (FaceTheory P0/P1)

- Lambda Function URL **response streaming** (TS first), with a portable stream contract.
- Router **catch-all** pattern support (`/{proxy+}`) with explicit precedence rules.
- A **streaming-aware testkit** capable of asserting streamed chunks + finalized headers/cookies.
- HTML ergonomics: `html(...)`, `htmlStream(...)`, and safe hydration payload serialization helpers.
- Explicit header/cookie semantics for **multi-value headers**, `set-cookie`, and streaming “headers finalize” rules.
- Cache-header + CloudFront-aware request normalization helpers (origin reconstruction, client IP).

### Nice-to-haves (FaceTheory P2 / broader parity)

- Additional HTTP event shapes (ALB) and event helpers (Kinesis/SNS, Step Functions task-token), if they reduce glue code.

## Sequencing to FaceTheory milestones

- FaceTheory **M1 (buffered SSR)**: can ship once `html(...)` exists and Lambda URL normalization is stable.
- FaceTheory **M2 (streaming SSR core)**: requires AppTheory streaming responses + streaming testkit + catch-all routing.
- FaceTheory **M3+ (React adapter, build pipeline)**: benefits from hydration serialization + cache helpers.
- FaceTheory **M6 (ISR)**: depends primarily on TableTheory (locks/metadata), but AppTheory must provide cache header helpers
  and CloudFront normalization to make correctness practical.

## Milestones

### FT-A0 — Streaming contract + primitives (portable, TS-first implementation)

**Goal:** define a stable, fixture-testable “response body can be a stream” contract that all languages can represent,
even if only TS integrates to Lambda’s streaming runtime first.

**Complex enough for a sub-roadmap:** yes. See `subroadmaps/SR-STREAMING.md`.

**Acceptance criteria**
- A new contract version (or an extension to the current contract) specifies:
  - streaming body representation (chunk type, encoding rules, and concatenation semantics)
  - streaming header/cookie finalize rules
  - deterministic late-error behavior (what can still change after first chunk)
- Contract fixtures exist that validate streaming semantics in a deterministic harness (no timing/TTFB assertions).
- Go/TS/Py runners all execute the fixtures:
  - TS must support true streaming execution in the testkit
  - Go/Py may satisfy fixtures by emitting a single chunk (buffered fallback) until true streaming is implemented

---

### FT-A1 — Lambda Function URL streaming handler (TypeScript)

**Goal:** make Lambda Function URL response streaming a first-class AppTheory integration for SSR (`text/html`) and SSE
(`text/event-stream`).

**Complex enough for a sub-roadmap:** yes. See `subroadmaps/SR-STREAMING.md`.

**Acceptance criteria**
- TS exports a supported streaming handler entrypoint that works with Lambda Function URLs.
- Streaming responses can set status + headers before writing chunks.
- Streaming responses support:
  - `text/html; charset=utf-8`
  - `text/event-stream; charset=utf-8`
- Testkit can execute the streaming handler path deterministically and assert:
  - chunk sequence
  - final status/headers/cookies
  - header immutability after streaming starts

---

### FT-A2 — Catch-all routes (`/{proxy+}`) with precedence rules

**Goal:** allow SPA/SSR “app shell” routing patterns without shadowing specific routes.

**Acceptance criteria**
- Router supports terminal catch-all patterns:
  - Go/TS/Py accept `/{proxy+}` in route registration
  - `{proxy+}` must be **last segment**; invalid patterns fail closed
- Precedence rules are defined and fixture-backed:
  1) static segments
  2) `{param}` segments
  3) `{proxy+}` (terminal only)
- Route params include a stable capture key (e.g. `proxy`) with a predictable value format (string with `/` separators).

---

### FT-A3 — Streaming-aware TestEnv (all languages)

**Goal:** enable deterministic unit tests for streamed responses without depending on AWS.

**Complex enough for a sub-roadmap:** yes. See `subroadmaps/SR-STREAMING.md`.

**Acceptance criteria**
- Each language testkit can invoke a handler and return:
  - status
  - normalized headers (including multi-value)
  - cookies (`set-cookie` semantics)
  - streamed chunks (0..N) + concatenated body
- Testkit exposes “first-chunk boundary” as a structural notion (not a timing assertion) so tests can assert header
  finalization before chunks.

---

### FT-A4 — HTML helpers + hydration-safe serialization (all languages)

**Goal:** reduce SSR boilerplate and prevent common XSS footguns when embedding hydration payloads.

**Acceptance criteria**
- Each language exposes:
  - `html(body: string|bytes, opts?)` helper that sets content-type + reasonable defaults
  - `htmlStream(chunks, opts?)` helper that streams bytes with `text/html`
- Each language exposes a supported, deterministic “safe JSON for HTML embedding” helper:
  - escapes `<`, `>`, `&`, U+2028/U+2029, and any other required sequences
  - has fixtures proving identical output across languages

---

### FT-A5 — Response header + cookie merge semantics (streaming-aware)

**Goal:** remove ambiguity and drift around multi-value headers and `set-cookie`, especially under streaming.

**Complex enough for a sub-roadmap:** likely. See `subroadmaps/SR-STREAMING.md` (or split if it grows).

**Acceptance criteria**
- The contract defines:
  - multi-value header representation and merge rules (middleware + handler + error envelope)
  - canonical `set-cookie` behavior (append vs replace, duplicates, ordering guarantees if any)
  - behavior differences per AWS adapter where the platform constrains output (e.g. Lambda URL single-value headers)
- Streaming mode enforces “headers finalized before first chunk”; violations fail closed in tests.

---

### FT-A6 — Cache + CloudFront helpers (SSG/ISR ergonomics)

**Goal:** make SSR/SSG/ISR caching correctness easy to implement consistently.

**Acceptance criteria**
- Cache header helpers exist (portable):
  - `cacheControlSSR()` / `cacheControlSSG()` / `cacheControlISR()` style helpers (names TBD)
  - `etag()` helper + conditional request helpers (`if-none-match`)
  - `vary()` helper
- CloudFront-aware request helpers exist (portable):
  - canonical origin URL reconstruction (host + forwarded headers)
  - stable client IP extraction (CloudFront + generic `x-forwarded-for`)
- Fixtures prove consistent behavior for header parsing/normalization.

---

### FT-A7 — “SSR site” AWS resource support (CDK/templates; Lambda URL-first)

**Goal:** keep FaceTheory apps from re-implementing a CloudFront+S3+Lambda URL deployment pattern ad hoc.

**Complex enough for a sub-roadmap:** yes. See `subroadmaps/SR-SSR-INFRA.md` (also integrates with `subroadmaps/SR-CDK.md`).

**Acceptance criteria**
- A supported deployment pattern exists (constructs or templates) that provisions:
  - S3 bucket for immutable assets (`/assets/*`)
  - Lambda Function URL for SSR origin
  - CloudFront distribution with two origins + routing rules
  - OAC, logs, custom domain option (Route53 + ACM), optional WAF hooks
- A build/deploy helper convention exists for:
  - uploading assets + manifest
  - wiring runtime env vars (bucket, manifest location, cache table name)
- `cdk synth` is deterministic and part of `make rubric` gates.

---

Implementation (AppTheory `m14`):

- Reusable construct: `cdk/lib/ssr-site.ts` (`AppTheorySsrSite`)
- Deployable example: `examples/cdk/ssr-site`
- Build/deploy helpers: `examples/cdk/ssr-site/scripts/`
- Deterministic synth gate: `scripts/verify-cdk-synth.sh`

### FT-A8 — Optional: broader AWS event ergonomics (ALB, Kinesis/SNS, Step Functions)

**Goal:** reduce app glue code where these event types are used alongside FaceTheory stacks.

**Acceptance criteria**
- If implemented, each new event type ships with:
  - normalization helpers
  - testkit event builders
  - fixtures that lock semantics

---

Implementation (AppTheory `m14`):

- ALB adapter support (Go/TS/Py) + contract fixtures
- Kinesis/SNS routing + partial batch failure + fixtures (Go/TS/Py)
- Step Functions task token helpers + fixtures (Go/TS/Py)
