# Roadmap: AppTheory MCP runtime prerequisites for theory-mcp-server issue #144

## Goal

Deliver the AppTheory-owned MCP runtime and deployment prerequisites needed by theory-mcp-server's issue #144 remediation without creating product-specific bypasses. AppTheory will own protocol-visible behavior, transport correctness, panic/session/stream-store hardening, optional utility hooks, and task primitives. theory-mcp-server remains responsible for product policy, audit, rate-limit keying, selected tool enablement, and its dependency bump.

## Phases

### Phase 1: Runtime hardening

**Milestone candidates:**
- **mcp-runtime-hardening** — Make existing MCP tool execution, session persistence, and stream-spill replay safer without adding new advertised capabilities.
  - Items: 1, 2, 3, 4
  - Dependencies: none
  - Risks:
    - Session upsert semantics depend on TableTheory `CreateOrUpdate` behavior.
    - Bounded S3 reads must preserve hash/size verification and existing spill cleanup behavior.

### Phase 2: Protocol and transport correctness

**Milestone candidates:**
- **mcp-capability-transport** — Make AppTheory's initialize capability surface and Streamable HTTP behavior explicit, protocol-aware, and canary-ready.
  - Items: 5, 6, 7, 8, 9
  - Dependencies: `mcp-runtime-hardening` should land first so stricter clients do not expose known runtime gaps.
  - Risks:
    - Stricter Accept/Content-Type handling may reject currently tolerated clients.
    - SSE priming/replay changes can alter reconnect timing for active steward MCP sessions.
    - Protocol capability changes must not overclaim optional features before hooks land.

### Phase 3: Optional utility hooks

**Milestone candidates:**
- **mcp-utility-hooks** — Add capability-gated resource subscription, logging, completion, and cancellation hooks while preserving fail-closed omitted-capability behavior.
  - Items: 10, 11, 12, 13, 14
  - Dependencies: `mcp-capability-transport`
  - Risks:
    - Cancellation requires careful request tracking so completed or unknown request IDs are ignored safely.
    - Products must continue omitting unsupported capabilities until product policy is wired.

### Phase 4: Task runtime primitives

**Milestone candidates:**
- **mcp-task-runtime** — Add task capability, task-backed tool execution, durable task storage, and deployment/docs support as a separate opt-in MCP feature.
  - Items: 15, 16, 17, 18
  - Dependencies: `mcp-capability-transport`; `mcp-utility-hooks` is a soft dependency because cancellation semantics inform task behavior.
  - Risks:
    - Tasks are experimental in MCP 2025-11-25 and may change in a later protocol revision.
    - Durable task state must bind to session/principal/route to avoid cross-principal result reads.
    - CDK/jsii generation and cdk-go regeneration must be committed with construct changes.

### Phase 5: Product integration guidance

**Milestone candidates:**
- **mcp-product-guidance** — Clarify that MCP route/principal/tool-aware rate limiting is product wiring over existing AppTheory primitives.
  - Items: 19
  - Dependencies: none; can land after or alongside earlier phases
  - Risks:
    - Documentation must not imply API Gateway stage throttling replaces product-aware rate limiting.

## Cross-phase risks

- Active steward sessions can be affected by transport strictness, SSE replay changes, and later product rate-limit adoption; lab canaries should include `memory_recent`, `list_knowledge_bases`, tool-list, and a streaming tool call before promotion.
- Any exported Go MCP API change requires `./scripts/update-api-snapshots.sh` in the same commit.
- Any CDK construct change requires jsii and `cdk-go/` regeneration in the same commit.
- AppTheory releases are immutable and must follow staging → premain → main with version alignment intact.

## Cross-repo dependencies

- theory-mcp-server must bump AppTheory after the relevant AppTheory release and wire only capabilities it is ready to support.
- KnowledgeTheory task/related-unit work remains separate and is not an AppTheory prerequisite unless task result retrieval later depends on KnowledgeTheory-owned state.
- No TableTheory code change is currently planned, but Phase 1 should verify `CreateOrUpdate` semantics are sufficient for Dynamo session upsert.

## Deprecation and migration plan

No deprecation is planned. Stricter transport behavior should be release-noted as compatibility-sensitive and canaried before theory-mcp-server promotes the dependency. Products should continue omitting optional capabilities until they wire product policy.

## Open questions

- Should AppTheory expose task principal/route binding as required callback hooks or as fields on a task context object? This must be answered before Phase 4 implementation.
- Should strict transport enforcement apply to all supported protocol versions immediately, or should legacy `2025-03-26` retain batch-specific tolerance while still enforcing required HTTP headers?
