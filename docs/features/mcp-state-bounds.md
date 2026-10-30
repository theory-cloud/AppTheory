# MCP state bounds and MicroVM list ownership

This page records the M3 state and ownership contract. Every bound is a fixed framework constant:
there are no environment variables, CDK properties, or deployment knobs for the session or aggregate
budgets. Tests may select small bounds through language-local seams; production wiring does not.

## Built-in session capacity

A built-in `MemorySessionStore` / `MemoryMcpSessionStore` instance keeps at most **1,000 live
sessions**. Every `Put` runs one atomic critical section (Go mutex, TypeScript synchronous section,
Python `RLock`) that:

1. reads the store clock once and removes every session whose `ExpiresAt` has passed;
2. refuses an incoming record that is already expired, so expired state cannot be revived;
3. allows a live same-ID refresh/overwrite without consuming new capacity;
4. refuses a new live session at capacity with the typed `Session capacity exceeded` error; and
5. otherwise stores the record.

No live session is evicted to admit another. The bound is **per store instance / warm process**. It is
not a distributed quota across Lambda contexts or multiple server instances; deployments that need a
cross-process quota must use a durable store and their own capacity controls.

### Typed capacity mapping

The capacity refusal is the only session-store failure that is publicly typed. It maps identically in
single-request initialize in Go, TypeScript, and Python:

- JSON-RPC error code `-32000` (`CodeServerError`);
- message exactly `Session capacity exceeded`;
- HTTP status `200`;
- no `Mcp-Session-Id` response header.

Go also relays the refusal through JSON-RPC batch initialize. TypeScript and Python do not implement
JSON-RPC batch bodies; a batch body remains a parse error there. Every other session-store error keeps
the generic `session error` / internal-error mapping.

### Associated cleanup

The server cleans all state owned by a session with one helper used by explicit `DELETE`, Get-observed
expiry, and the expired-first sweep during initialize. Cleanup removes session, stream, event/replay,
task, and cancellation state.

Get-observed expiry means the session store itself proved the record expired: the built-in stores return
a distinct observed-expiry error, and the server also cleans when a store hands back an expired record
that it must reject. A `Mcp-Session-Id` that is merely absent from one process-local session store is not
an expiry: it may belong to a different warm instance that still owns the live session, or it may be
forged. Such an unknown ID returns the ordinary 404 **without** creating a tombstone, deleting durable
stream/task/spill state, or waiting on deletion quiet passes. This protects live cross-instance state and
avoids write amplification from unknown IDs.

The built-in in-memory session store exposes an optional `PutAndCollectExpired` capability so the server
learns which expired IDs the atomic Put removed; custom `SessionStore` implementations keep the base SPI
and must report observed expiry distinctly to request request-path cleanup. Custom external cleanup
failures are never converted into a successful initialization.

## Durable stream aggregate

Durable streams bound each session at **10,000 logical events** and **64 MiB of logical payload bytes**
across inline and spilled records. The existing per-event maximum and inline-spill threshold remain.

Each append uses one backend transaction that:

- proves the session is active and its aggregate schema is current;
- checks `count + 1 <= 10,000` and `bytes + logicalPayloadBytes <= 64 MiB`;
- allocates the session sequence and updates aggregate count/bytes;
- updates stream metadata; and
- creates the event record.

A backend without transactional conditional writes refuses append **before** any event write. There is
no save-then-create fallback. Aggregate overflow returns `stream aggregate capacity exceeded`; an
oversize single event keeps the existing too-large error. In-memory streams retain their existing
oldest-event eviction semantics; durable streams never delete live replay history to admit a new event.

### Aggregate schema, backfill, and recreate

New sessions initialize a versioned aggregate record. A record that is missing entirely cannot prove the
session is active, so append returns the typed stream-not-found error identically in Go, TypeScript, and
Python. A present record with missing or older counters is the **pre-aggregate** case: missing counters
are never interpreted as zero, because that would let retained data bypass the bound. Appends to a
pre-aggregate session fail with `stream aggregate backfill required` until an operator/product-owned
backfill atomically counts every retained inline and spilled record and writes the current schema. M3
does not run an automatic runtime migration.

The supported alternatives are:

- backfill the aggregate from all retained records under the store's transactional proof, then resume;
- delete and recreate the session (losing its retained replay history); or
- leave the session read-only/quarantined.

`DeleteSession` tombstones first so late appends fail, then pages through every retained record (more
than 1,000 included), deletes stream/event metadata and spilled objects, and retries quiet passes to
close the append race. The tombstone is retained so a deleted session cannot be recreated by a late
append. DynamoDB TTL and S3 lifecycle are cleanup backstops, not authorization or precise
counter-decrement mechanisms.

### Spill lifecycle

When `MCP_STREAM_SPILL_BUCKET` is configured, payloads above
`MCP_STREAM_SPILL_INLINE_MAX_BYTES` (default 32 KiB, clamped to the DynamoDB-safe inline ceiling) and at
or below `MCP_STREAM_MAX_EVENT_BYTES` are written through AppTheory's object store. DynamoDB retains the
logical event ID, stream ID, object pointer, byte count, and SHA-256 hash; replay validates size and
hash before emitting the payload. A refused append deletes its spilled object, and a cleanup failure is
joined with the refusal rather than hidden. S3 lifecycle expiration is only a cleanup backstop; replay
enforces record expiry before reading either inline or spilled data.

The CDK Remote MCP construct already grants the handler table/bucket access and supplies the existing
bucket, prefix, inline-threshold, and max-event environment variables. M3 adds no aggregate
configuration or IAM/table/bucket shape.

## MicroVM list and keyed ownership

Every registry (memory and TableTheory) and every real controller list path applies the same rule:

1. union the canonical and legacy partitions with **canonical precedence by session ID** before owner
   filtering, so a caller-owned legacy duplicate cannot bypass an ownerless or cross-subject canonical
   record;
2. require both the caller subject and the stored `AuthSubject` to be non-empty and exactly equal;
3. exclude expired records; and
4. validate only the surviving same-owner records before constructing provider bindings.

Excluded records cause no provider list binding, metadata disclosure, provider output, refresh, or
mutation. Controller list paths re-apply the filter as defense in depth, so a custom registry that
ignores `AuthSubject` still cannot disclose another subject's records.

An **empty-subject identity-only caller receives an empty list** after owner filtering. This is the M3
list behavior; F17 caller-selected-tenant compatibility is unchanged.

Ownerless records are quarantined:

- they are never anonymously listable and never adopted from the current caller;
- a keyed legacy read does not rekey/persist an ownerless item before rejecting it;
- an owned legacy rekey preserves the stored owner;
- only a genuinely new record may initialize `AuthSubject` from the authenticated request; an existing
  record with an empty owner fails before `Put`.

Keyed denial shapes are preserved: owner mismatch keeps
`m15.microvm.session_owner_mismatch`/403, and ownerless or invalid records keep the
session-registry-incomplete failure. Any ownerless backfill is a separate operator/product-owned
migration based on independent historical evidence; M3 implements no runtime inference.

## Proof limits

These contracts are proven with deterministic source, fixture, and CI checks. They do not claim live
AWS behavior, deployed capacity, or a completed data migration. The session bound is per process; the
aggregate bound is per session, not a global cross-session quota; and custom/durable store conformance
proves the adapter at its test seam.
