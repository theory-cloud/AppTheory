# Runtime concurrency audit: multi-request isolation in one execution environment

Status: complete. Audited at `staging` `397ebd591b70aa333820a544f3acbade426dce13`; fixes and tests land with the
`feat/runtime-multiconcurrency` branch. Scope: the TypeScript and Python runtimes. Go is recorded as **N/A** (AWS has
no Go Web Function runtime, and the Go runtime is unchanged).

This is the evidence behind [Concurrency and request isolation](../../../features/concurrency.md). Line numbers below
are the audited (pre-fix) tree, so every citation resolves against `397ebd59`.

## 1. Method

Every module-level and package-level binding, singleton, cache, request-scoped context holder, logger/correlation
binding, middleware state, and lazy client in `ts/src/**` (77 files) and `py/src/apptheory/**` (61 files) was read and
classified. The two runtimes are classified against **their own** concurrency model, because the same shape of code is
safe in one and unsafe in the other:

| Runtime | Overlap in one environment | When a shared read-modify-write can interleave |
|---|---|---|
| TypeScript | One event loop; N suspended `async` bodies | Only if an `await` sits **inside** the window. CPython has no analogue: Node never pre-empts a synchronous stretch. |
| Python | Threads, one per request | At **any** call boundary, and inside any Python-level loop or comprehension. |

That distinction is not cosmetic — it decides several classifications below, and it is why the Python fix list is six
items long while the TypeScript list is empty.

Two consequences worth stating explicitly, because they bound what the tests can claim:

- In CPython 3.14 a read-modify-write with **no call inside it** (for example `session.next_seq += 1`) is not
  pre-empted by the GIL, so it is not reproducible as a fault. Those items are classified by contract, not by an
  observed crash, and are pinned by an overlap test instead of a failing-first test.
- A check-then-act that **spans a call**, or a **structure mutated while another thread iterates it**, is reproducible
  on demand. Every `UNSAFE_SHARED` item below is in one of those two shapes, and each has a test that fails on
  `397ebd59`.

## 2. Classification

### 2.1 PER_REQUEST — owned by exactly one request

| # | Location | Item | Why it is request-scoped |
|---|---|---|---|
| P1 | `ts/src/context.ts:125` | `Context` (request, params, `requestId`, `traceId`, `tenantId`, `authIdentity`, `_values`, `_securePrincipal`, `middlewareTrace`) | Constructed per request at `ts/src/app.ts:1149`, `:1354`, `:1757`; nothing caches it. |
| P2 | `ts/src/context.ts:337`, `:400` | `EventContext`, `WebSocketContext` (including the lazily created WS management client at `:466`) | Fresh per event / per socket request. |
| P3 | `ts/src/app.ts:790` | `_applyMiddlewares` wrapper closures | Rebuilt per request; the closure captures only the registration-time middleware and next handler, never request data. |
| P4 | `ts/src/app.ts:1078`, `:1225` | `respondToServeError`, `finish` | Per-call closures capturing this request's ids. |
| P5 | `ts/src/app.ts:2603`, `:2724` | `cloneContextWithTimeoutCarrier`, `timeoutMiddleware` (`AbortController` + timer) | Timer armed and cleared inside the request; the parent abort listener is removed in `finally`. |
| P6 | `ts/src/internal/aws-lambda-streaming.ts:216` | `CapturedHttpResponseStream` | Instantiated per invocation; `globalThis.awslambda` is only read (`:58`). |
| P7 | `py/src/apptheory/context.py:63` | `Context` (`_values`, `params`, `middleware_trace`, `_secure_principal`) | Built per request at `py/src/apptheory/app.py:797`, `:1160`, `:1548`. |
| P8 | `py/src/apptheory/app.py:575` | `_apply_middlewares` closures | Rebuilt per request; `next_handler` is bound per call. |
| P9 | `py/src/apptheory/middleware.py:94` | Deadline cancellation token + `Context` clone | New token and clone per request; the handler runs inline on the invoking thread and no timer thread is started. |
| P10 | `py/src/apptheory/aws_http.py:214`, `:305` | Per-drain `box` dict and worker thread | The worker touches only its own request's stream (see §3.1 for the residual). |

Pinned by `test_http_pipeline_isolates_overlapping_requests`, `test_overlapping_failures_keep_their_own_identity` and
`test_overlapping_early_returns_keep_their_own_response_state` (Python) and their two TypeScript counterparts.

### 2.2 UNSAFE_SHARED — repaired in this change

| # | Location (pre-fix) | Item | Failure observed | Fix |
|---|---|---|---|---|
| U1 | `py/src/apptheory/mcp/__init__.py:854` (`_sessions` at `:863`) | `MemoryMcpStreamStore` — `next_seq`, `event_to_stream`, `event_count`, `total_bytes`, `streams`, and the retained event lists | `IndexError: pop from empty list` escaping `append()` (`_evict_oldest_event`, `:955`), and subscriptions losing events in the middle: observed gaps at 42–85 per run over 8 workers × 120 appends, plus 22–32 other exceptions. A subscriber silently missed events another request had appended. | `threading.RLock` (`_lock`) guarding `create`, `append`, `close`, `subscribe`, `stream_for_event`, `delete_session`, mirroring the sibling session store. The subscription snapshot is built under the lock. |
| U2 | `py/src/apptheory/mcp/__init__.py:960` (`_sessions` at `:966`) | `MemoryMcpTaskStore` — per-session task maps, `_record` handing back the **live** stored record | Concurrent `create` lost tasks (1 of 8 survived with the window held open; 4 of 8 in the first observed run). `cancel` mutated a live record after an unlocked terminal check, so a cancel could race a completion. | `threading.RLock`; `create` now uses `setdefault` under the lock, and `get`/`update`/`list`/`cancel`/`delete_session` each perform their check-then-act under one acquisition. |
| U3 | `py/src/apptheory/oauth/jwks.py:284` (`_keys`, `_windows`, `_fetch_window_start`, `_fetch_budget_used`) | `_JWKSValidator` shared cache, per-kid resolution windows, unknown-kid fetch budget | `RuntimeError: dictionary changed size during iteration` and `KeyError` escaping `validate()` on the **bearer-token auth path** — 694 RuntimeErrors over five 32-thread trials — i.e. 500s for valid tokens. The budget read-modify-write could also spend one unit from several threads. | `threading.RLock` guarding `_key_for`, the single mutation entry point. Network refresh happens under the lock, serialising tag-along validators (the same trade-off `_FrontDoorSecretCache` already accepts). |
| U4 | `py/src/apptheory/oauth/autheory.py:177`, `:178` | `AutheoryProvider._metadata` and `._validators` (`OrderedDict`) | Discovery fetched once **per concurrent caller** — 8 upstream fetches for 8 first requests — and the ordered cache mutated while another caller read it. | `threading.Lock`; `discovery()` is single-flight under the lock, and the get-or-build-or-remember sequence is atomic. |
| U5 | `py/src/apptheory/mcpfacade.py:1538` (`global` at `:1542`, assign `:1548`) | `_front_door_ssm_client_instance` lazy boto3 SSM client | 8 clients created for 8 overlapping first reads. botocore documents client creation as not thread-safe. | Module lock with double-check inside `_front_door_ssm_client()`. |
| U6 | `py/src/apptheory/mcp/__init__.py:1166` (`_store` at `:1167`) | `_S3McpStreamSpillStore._store` lazy object store | 8 object stores created for 8 overlapping first writes. | Instance `threading.Lock` with double-check. |

Failing-first evidence: `py/.venv/bin/python -m unittest py.tests.test_concurrency_isolation` on `397ebd59` reports
`Ran 16 tests — FAILED (failures=6)`, one failure per item above (U2 carries two tests; the create test is the
failing-first one, the cancel test pins the terminal outcome). After the fixes: `Ran 16 tests — OK`.

### 2.3 SAFE_SHARED — intentionally process-wide, correct under overlap

| # | Location | Item | Why it is safe under concurrency | Pinned by |
|---|---|---|---|---|
| S1 | `ts/src/logger.ts:77`, `:79`, `:83`; `py/src/apptheory/logger.py:96`, `:103` | The process logger singleton and its setter | Configuration, installed at initialization. Nothing in either runtime binds request identity onto it, and both `with*` implementations (`ts/src/logging-profile.ts:340-400`, `py/src/apptheory/logging_profile.py:302-321`) return a **new** logger. The audit found no request-path caller of `setLogger` / `set_logger`. | `the process logger keeps one instance while every request binds its own copy`; `test_process_logger_binding_is_request_scoped` |
| S2 | `ts/src/logging-profile.ts:309-312`; `py/src/apptheory/logging_profile.py:285-288` | `ProfileLogger` root `profileEntries`/`_entries` ring, `entriesLogged`, `lastError`, `closed` | Process-scoped diagnostic (last 1024 encoded lines). Binding derives a copy, so it never carries one request's identity into another's line. In TypeScript the ring's operations are atomic (no `await`); in Python `entries_logged += 1` is a single store and the bounded ring self-corrects, so no fault is reproducible — recorded as a documented process-scoped surface rather than "fixed", and `entries()`/`getStats()` are explicitly not per-request views (see the feature page). | `the retained-log ring stays bounded and attributed under overlap`; `test_profile_logger_retains_every_entry_under_overlap` |
| S3 | `ts/src/mcpfacade.ts:1413` | `frontDoorSsmClient` lazy SSM client | Assigned with `??=` in synchronous code; SDK clients hold no request state. | Covered by U5's Python test and by the interleaved store tests. |
| S4 | `ts/src/mcpfacade.ts:1251`, `:1356-1401`; `py/src/apptheory/mcpfacade.py:1499` | `FrontDoorSecretCache` (value, fetch times, single-flight `inflight`/lock) | Keyed by the parameter name fixed at construction; concurrent readers coalesce onto one read. Python holds `_lock` across the read by design. | `test_front_door_secret_cache_reads_once_under_overlap` |
| S5 | `ts/src/app.ts:481` | `secureConstructionOptions` `WeakMap` | Written while constructing a `SecureApp`, read and **deleted** in the `App` constructor; keyed by object identity and never touched on a request path. | Construction-time only; no request path. |
| S6 | `ts/src/oauth/provider.ts:341`, `:345`; `ts/src/oauth/jwks.ts:306-310` | Validator cache, cached discovery, `keys`/`windows`/fetch budget/single-flight refresh | Keys are immutable inputs (`validatorCacheKey`); single-flight via the stored promise; bounded by `maxKeyEntries`/`maxWindowEntries`; values carry no request identity. In TypeScript each mutation is atomic and the refresh coalesces. | `interleaved stream appends never skip or reorder an event id` (same invariant shape) and the Python counterparts. |
| S7 | `ts/src/oauth/store.ts:444`, `:495`, `:561`, `:638`, `:1075`; `py/src/apptheory/oauth/store.py:448`, `:534`, `:570`, `:843` | In-memory OAuth reference stores (transactions, codes, clients, broker, rate limits) | Keyed by hashed/opaque IDs; Python guards every mutating method with its own `threading.Lock` (read-modify-write inside the lock); TypeScript performs each read-modify-write without an interleaved `await`. | Existing store conformance rows plus the interleaved-store tests. |
| S8 | `ts/src/mcp/index.ts:881`, `:1140`; `py/src/apptheory/mcp/__init__.py:783` | `MemoryMcpSessionStore`, and the TypeScript `MemoryMcpStreamStore`/`MemoryMcpTaskStore` | Process-wide by MCP protocol, keyed by session/stream/task ID. Python's session store already held an `RLock` and clones on the way in and out; the TypeScript stores are synchronous throughout, so each operation is atomic. | `interleaved task creates never lose a record`; `interleaved session reads never cross sessions`; `test_memory_session_store_keeps_sessions_apart_under_overlap` |
| S9 | `ts/src/internal/router.ts:69`; `ts/src/app.ts:546-573`; `py/src/apptheory/router.py:47`; `py/src/apptheory/app.py:335-363` | Route tables, middleware lists, app configuration | Written only during registration, read-only while serving; matching allocates fresh `params` per call. | Isolation tests exercise registration-time state under overlap. |
| S10 | `ts/src/app.ts:562`, `:707` | `App._webSocketEnabled` | The only non-`readonly` `App` field; written once during secure web-socket registration. | Registration-time only. |
| S11 | `ts/src/emf.ts:25`; `py/src/apptheory/emf.py:19` | `EMFMetricSink` | No buffer: one complete line per record is written per call, so nothing accumulates across requests. | No shared mutable surface. |
| S12 | `py/src/apptheory/aws_http.py:49`, `:50` | `_drain_workers_lock` + `_drain_workers` `WeakSet` | Every read/write is under the lock and only `Thread` objects are retained. | `test_drain_worker_registry_is_readable_during_overlap` |
| S13 | `py/src/apptheory/oauth/fake_provider.py:54`, `:55` | `_KEY_CACHE` / `_KEY_LOCK` | Whole check-then-generate inside the lock, keyed by immutable bit size. | `test_shared_rsa_key_returns_one_keypair_under_overlap` |
| S14 | `py/src/apptheory/oauth/autheory.py:130`; `ts/src/oauth/provider.ts:302` | `_VALIDATION_CONTEXT` / `VALIDATOR_CONTEXT` shared inert `Context` | Verified inert: the adapter pins issuer/audience/scopes per call, so the validator's route-aware resolvers are never consulted and nothing writes to the context (the only mutating seam, `ctx.set`, is not reached). Recorded as a latent hazard: a future adapter that supplied *dynamic* audience/scope resolvers would need a per-call context. | Covered by the provider conformance rows. |
| S15 | `py/src/apptheory/oauth/jwks.py:336-337` | Lazily discovered `_jwks_uri` | Idempotent last-write-wins; every writer assigns the same discovery-verified value. Covered by U3's lock. | U3 test. |
| S16 | `py/src/apptheory/microvm/aws_provider.py:44-51`, `:57` | `_default_provider_invoke_opener`, `AWSLambdaMicroVMProvider._opener` | Idempotent lazy init with equivalent results; the class attribute is a read-only test seam. | No request-path mutation. |
| S17 | `py/src/apptheory/jobs.py:246-250`, `limited/limiter.py:154` | `ModelDefinition` singletons shared by every `Table(...)` | Read at construction only; rate-limit counts live in DynamoDB, not in process memory. | Dependency-note in §4. |
| S18 | Both runtimes: import-time constant tables (`sanitization.ts:9`,  `:26`; `py/src/apptheory/sanitization.py:13`, `:28`; `naming.ts:192`; `py/src/apptheory/naming.py:77`; and the `*_PATTERNS`/`*_FIELDS` sets) | Lookup tables | Built at import (the one alias-adding pass runs at import time), never mutated afterwards. | Static analysis: no writer after import. |

### 2.4 OUT OF CONTRACT — named, not shared with the request path

| # | Location | Item | Classification |
|---|---|---|---|
| X1 | `ts/src/testkit/oauthprovider.ts:158`, `:162`, `:163` | `lastToken`, `refreshCalls`, `lastRefreshForm` on the fake OAuth server | `UNSAFE_SHARED`, **test-double only**. Two overlapping token calls in one test can overwrite each other's last-request record. Never constructed by the runtime; not on a request path. Left as-is; a fake that records "the last request" is single-threaded instrumentation by definition, and changing it to a per-call record would add public testkit surface (which the size check forbids). |
| X2 | `py/src/apptheory/objectstore.py:293-294`, `vectorstore.py:151`, `microvm/fake.py:24`, `testkit.py:590`, `ids.py:39-43`, `clock.py` | In-memory fakes, `ManualIdGenerator`, manual clocks | `UNSAFE_SHARED if shared`, **test-double only**. Deterministic test instrumentation; the runtime never constructs them for a request. Documented in the feature page as "not for production concurrency". |
| X3 | `py/src/apptheory/app.py:77-89`; `bind_handler.py:158-168`; `mcp/__init__.py:3936-3949` | `_resolve` and its siblings bridging an awaitable with `asyncio.run` | Not shared state: a **capability** limit. `asyncio.run` raises inside a live event loop, so the Python runtime supports thread concurrency only, and fails closed with a named message otherwise. Changing this would alter runtime semantics, which is a size-check trigger; recorded for the AT-W1 composition instead. |

## 3. Flagged to the owner, deliberately not changed

### 3.1 The buffered adapters' abandoned drain worker

`py/src/apptheory/aws_http.py:305-322` starts one thread per streamed-body drain, joins it for up to 5 s, then releases
and joins for another `_STREAMING_BODY_UNWIND_GRACE = 0.1` s and **gives up**, logging that the worker was abandoned
and returning a 500. The worker touches only its own request's `box` and stream, so it cannot corrupt another request
— but it outlives its invocation, and
`docs/development/planning/apptheory/supporting/apptheory-runtime-contract-v0.md:127-129` states normatively that
"there is no grace window that ends in abandoning work, and a residual that outlives the invocation is not an
acceptable documented behavior".

That is a pre-existing contradiction between the code and the published contract, not a per-request isolation defect,
and every remediation option changes observable behaviour (read on the invoking thread; wait unboundedly and let the
function timeout bound it; or amend the contract). It is reported here for a ruling rather than changed inside a
bounded isolation fix.

### 3.2 Two older, unrelated observations

- `py/src/apptheory/fake_provider.py`'s test HTTP server mutates its request counters from `ThreadingHTTPServer` handler
  threads without a lock (`:154`, `:169`, `:176-183`). Test-double only; see X1/X2.
- `ts/src/mcp/index.ts:1446` memoises a *rejected* `createS3ObjectStore()` promise for the lifetime of the process, so
  one transient failure sticks. That is a failure-mode defect, not a concurrency one.

## 4. Dependency note (outside this repository)

`py/src/apptheory/jobs.py:246-250` and `limited/limiter.py:154` share a module-level `ModelDefinition` across every
`Table(...)`. That is safe **provided** `tabletheory_py.Table(model, table_name=...)` does not write the table name back
onto the shared model. It is a dependency outside this repository, so it is recorded here rather than asserted. If it
does write back, two differently configured instances in one process would share a table name — a cross-tenant leak,
not just a race.

## 5. Size check

Every fix is a private lock plus a guarded critical section: no exported signature, type, constructor option, error
code, fixture or CDK/jsii construct changed. `api-snapshots/*.txt` are unchanged. The audit found nothing requiring a
public API redesign, so this change stays inside the bounded fix and does not stop for approval.

## 6. What the tests establish

| Claim | Test |
|---|---|
| Overlapping requests never share context, identity, correlation ID, headers, middleware values or response state — including on error and on early return | `test_http_pipeline_isolates_overlapping_requests`, `test_overlapping_failures_keep_their_own_identity`, `test_overlapping_early_returns_keep_their_own_response_state`; `overlapping requests keep their own request context`, `overlapping failures and early returns keep their own identity` |
| Logger binding is per request and never mutates the process logger | `test_process_logger_binding_is_request_scoped`; `the process logger keeps one instance while every request binds its own copy` |
| The MCP stream store keeps event IDs unique, ordered and gapless under overlap (U1) | `test_memory_stream_store_never_loses_or_reorders_events_under_overlap`; `interleaved stream appends never skip or reorder an event id` |
| The MCP task store loses no create and cancels are terminal (U2) | `test_memory_task_store_records_every_concurrent_create`, `test_memory_task_store_cancel_stays_terminal_under_overlap`; `interleaved task creates never lose a record` |
| Concurrent bearer validation fails closed instead of corrupting the shared JWKS cache (U3) | `test_jwks_validator_survives_concurrent_validation` |
| One discovery fetch and one validator per key under overlap (U4) | `test_autheory_discovery_is_fetched_once_under_overlap` |
| One SSM client and one spill object store per environment (U5, U6) | `test_front_door_ssm_client_is_created_once_under_overlap`, `test_stream_spill_store_creates_one_object_store_under_overlap` |
| The session store, front-door cache, drain registry and shared key cache stay correct under overlap (S1, S4, S12, S13) | `test_memory_session_store_keeps_sessions_apart_under_overlap`, `test_front_door_secret_cache_reads_once_under_overlap`, `test_drain_worker_registry_is_readable_during_overlap`, `test_shared_rsa_key_returns_one_keypair_under_overlap` |

The TypeScript suite passes on the **unmodified** runtime (7/7 at `397ebd59`): the TypeScript runtime was already
isolation-correct under the strongest interleaving Node can produce, and its tests exist to keep it that way. The
Python suite fails 6 of 16 at `397ebd59` and passes 16/16 after the fixes.
