---
title: Migrate to SecureApp
---

# Migrate to SecureApp

`SecureApp` is opt-in. Legacy `App` construction and open-by-omission routing remain frozen, so migration can proceed
application by application without changing unrelated services.

## 1. Inventory effective runtime policy

Inventory what the running application enforces, not only what its OpenAPI document claims. Include:

- every HTTP method/path;
- every AppSync parent type and field;
- every WebSocket route key;
- default-deny middleware and allowlists;
- service-only or instance-key checks;
- optional-principal behavior and route scopes.

Treat legacy Go `RequireScope` / `RequireAnyScope` calls whose inputs all normalize empty as open. The legacy runtime
returns before setting `authRequired` in that case; migration must preserve effective behavior before deliberately
tightening it.

## 2. Replace construction and registrations

Replace `New`, `new App`, or `create_app` with the closed secure constructor. Add one posture to every HTTP,
`AppSyncField`, and WebSocket registration.

Map existing behavior as follows:

| Legacy effective behavior | Secure posture |
| --- | --- |
| Explicit anonymous route | `Public()` / `public()` |
| Optional verified principal | `Optional()` / `optional()` |
| Required identity | `Authenticated()` / `authenticated()` |
| Required all-of scopes | `Authenticated(scopes...)` / `authenticated(*scopes)` |
| Verified service or instance credential | `InternalOnly()` / `internal_only()` |

Do not infer `InternalOnly` from a claim or powerful scope. The resolver may return `internal` only after the
application verifies the service credential.

## 3. Convert the resolver

Wrap legacy string/principal hooks in one `SecurePrincipalResolver`. A migrated legacy identity is external unless a
separate trusted service credential was verified. Return normalized source values; AppTheory trims identity/scopes,
deduplicates scopes, defaults empty kind to external, and rejects unknown kinds.

For AppSync, resolve from the typed AppSync identity map. For WebSockets, validate the handshake at `$connect`, then
load and revalidate application-owned connection state by connection ID for later keys. Never authenticate a frame
from body fields.

## 4. Verify the route inventory

Compare `Routes()` / `routes()` to the inventory from step 1. Confirm:

- all HTTP/AppSync/WebSocket entries are present exactly once;
- methods and paths are canonical;
- scopes retain normalized first-occurrence order;
- AppSync and WebSocket metadata identifies the intended surface;
- no non-router event registration appears.

Mutation tests should prove returned records and principal values are defensive copies.

## 5. Bind secure OpenAPI

Move generation to the app-bound secure method. Configure document-level authenticated and internal scheme names and
describe exactly the registered HTTP projection. Require these assertions in the adopter's contract test:

- top-level `x-apptheory-contract-mode` equals `secure-v1`;
- every HTTP operation has `x-apptheory-auth-posture`;
- scoped operations have the exact normalized `x-apptheory-required-scopes`;
- the description set exactly equals the HTTP route set.

Do not add route-level overrides or ignore lists to force the join to pass. A mismatch is migration evidence.

## 6. Prove behavior-neutral rollout

Exercise anonymous, external, internal, unknown-kind, missing-principal, missing-scope, and resolver-error cases on each
surface. Confirm 401 versus 403 behavior and that denied requests never enter user middleware or handlers. Verify P1/P2
preflight remains a uniform 204 and secure P0 adds only the fixed posture gate.

For WebSockets, run an ordered connect/message/revocation/disconnect test against the trusted connection store. Ensure
each key's posture is enforced independently.

## 7. Retire the old guard

Remove the application-owned default-deny middleware or allowlist only after runtime tests, route inventory, and
secure OpenAPI exact-join tests all pass. Policy tightening is a later explicit change; it is not part of a
behavior-neutral migration.

Install the migration target from one pinned immutable
[AppTheory GitHub Release](https://github.com/theory-cloud/AppTheory/releases). Do not substitute registry packages.
