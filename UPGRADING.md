# Upgrading AppTheory

AppTheory is released only through immutable GitHub Releases. Pin the version you consume, verify the downloaded asset,
and move one minor line at a time when possible.

This file is hand-maintained upgrade policy. It is not generated from Conventional Commits and it is not a replacement
for `CHANGELOG.md`:

- `CHANGELOG.md` is generated release history. It tells you what commits shipped.
- `UPGRADING.md` tells operators and framework consumers what action may be required, what deprecations exist, and what
  replacement path preserves AppTheory's single runtime contract.

Every minor release line that changes runtime behavior, deployment constructs, generated artifacts, dependency floors,
or deprecation posture must add or update a section here before the release is promoted.

## v3.x line

### Toolchain and CDK dependency floors

The v3.x runtime requires Go 1.26.6 or newer, as declared by the root `go.mod`. Upgrade local toolchains and CI images
before moving a Go application onto this line.

The v3.x CDK package pins its `aws-cdk-lib` peer dependency exactly to 2.265.0 rather than accepting a version range.
Align the consuming CDK application's `aws-cdk-lib` dependency to 2.265.0 before installing the matching AppTheory CDK
GitHub Release asset; mixing CDK versions is outside the supported jsii surface.

### Go module paths

AppTheory v3 uses Go semantic import versioning. Replace the `/v2` suffix on every AppTheory runtime import with the
canonical `github.com/theory-cloud/apptheory/v3` path, update the root module requirement to the pinned v3 release tag,
and run `go mod tidy`. Do not retain both AppTheory major paths in one
application: packages from `/v2` and `/v3` have distinct Go type identities even where their APIs are otherwise
unchanged.

The generated CDK Go bindings move in the same release transaction. Replace the bindings' `/v2` suffix with
`github.com/theory-cloud/apptheory/cdk-go/apptheorycdk/v3`, pin the matching `v3.x` tag, and run `go mod tidy` in the
CDK application's module. Runtime and CDK module tags continue to target the same immutable release commit; do not mix
major lines or substitute registry-published artifacts.

### Function log group removal policies

Starting in v3.1.0, function log groups created by `AppTheoryFunction` and `AppTheoryApp` default to
`RemovalPolicy.DESTROY` instead of the inherited CDK `RemovalPolicy.RETAIN` default. The first `cdk deploy` after
upgrading changes those AppTheory-managed resources to delete on stack deletion or replacement. Applications that must
retain their function logs must set `logRemovalPolicy: RemovalPolicy.RETAIN` explicitly.

AppTheory also fails synthesis when `logGroup` and `logRemovalPolicy` are passed together. Earlier releases silently
ignored `logRemovalPolicy` in that configuration. Existing callers that pass both must choose one ownership path:
either omit `logGroup` and configure the AppTheory-managed group with `logRemovalPolicy`, or pass a caller-managed
`logGroup`, omit `logRemovalPolicy`, and configure the removal policy where that group is created.

The CDK TypeScript library, jsii metadata, and generated Go bindings must come from the same pinned AppTheory GitHub
Release so this validation and default stay aligned; do not mix `cdk/lib`, `.jsii`, or `cdk-go` artifacts across
versions.

### Namespace MCP server construct and static discovery deprecation

Starting in v3.1.0, `AppTheoryMcpServer` owns the namespace MCP route bundle. Existing callers that omit
`authorizationServerIssuer` and `jwksUri` keep the previous POST-only AgentCore template. Namespace applications
should supply both props and register their Go handler through `oauth.RegisterMCPServer`; this produces an
authenticated MCP route and public runtime-served RFC 9728 discovery routes. `mcpPath` is a literal synthesis-time
path and defaults to `/mcp`.

The namespace surface does not accept a protected-resource URL or origin. Discovery derives the resource host from
each normalized request, while issuer and JWKS values are forwarded to the Lambda as runtime install config. Do not
recreate a resource origin from API Gateway tokens at synthesis.

The URL-valued `resource` and `authorizationServers` props on `AppTheoryMcpProtectedResource` are deprecated. The
construct remains supported for existing synth-time-static REST API documents, and its optional `metadataPath` prop
can select a literal static route without deriving that route from `resource`. This is a compatibility escape hatch,
not the namespace deployment path. Migrate namespace applications to `AppTheoryMcpServer` plus
`oauth.RegisterMCPServer`; no removal version is scheduled for the compatibility construct in the v3 line.

Regenerate or consume matching jsii and `cdk-go` bindings when adopting this surface. `AppTheoryMcpPaths` exports the
canonical CDK path set, and `runtime/oauth` exports the matching Go constants.

### Governed namespace install parameters

Starting in v3.1.0, namespace stacks should instantiate `AppTheoryInstallParameters` and pass its typed tokens to
consuming constructs. The construct emits the ten required governed CloudFormation parameters and the
`TargetAccountMatchesCaller` rule without embedding account-, tenant-, stage-, or DNS-specific identity in the
template. Deployment runners must inject every parameter because none has a default.

Parameter patterns and allowed values are evaluated by CloudFormation, not at synthesis. The governed install-profile
validator must continue enforcing `DnsHost == cloud-keeper.<NamespaceSlug>.theorycloud.app`: CloudFormation Rules
cannot express that relationship with `Fn::Join`, although the parameter pattern still enforces the
`theorycloud.app` suffix. Consume matching TypeScript/jsii and `cdk-go` artifacts from one immutable AppTheory GitHub
Release so the parameter and accessor surfaces stay aligned.

### Versioned namespace artifact ingress

Starting in v3.1.0, operator-owned platform stacks can use `AppTheoryS3VersionedIngress` for the namespace release
bucket. The construct fixes versioning, all four public-access-block settings, S3-managed encryption, TLS-only access,
bucket-owner-enforced ownership, retain semantics, and an enabled lifecycle rule that aborts incomplete multipart
uploads after 7 days. It intentionally defines no object expiration or noncurrent-version deletion because the
namespace artifact contract does not authorize deletion of pinned versions.

Use `grantUpload` for exact-key `s3:PutObject` and `grantVersionedRead` for exact-key `s3:GetObjectVersion`. Both helpers
address `ns/<namespaceSlug>/<bundleId>` and reject invalid literals at synthesis. Token-valued slug and bundle inputs
remain supported for account-agnostic templates. CloudFormation resolves them at deployment, and AppTheory cannot
guarantee exactness for token-valued inputs; required-input checks and CloudFormation-safe key composition remain
enforced. Consumers should replace copied `ns/` literals with
`AppTheoryS3VersionedIngress.KEY_ROOT` or the instance `keyRoot` accessor when adopting the v3.1.0 release. AppTheory
does not issue STS credentials or presigned requests and does not transfer platform provisioning authority to
application stacks.

### Versioned artifact attestation member modes

Starting in v3.1.0, the aggregate digest for a verified versioned artifact includes each regular tar member's mode.
Every sorted digest entry now has the fixed wire format
`path<two spaces>four-digit-octal-mode<two spaces>content-sha256`, with the mode rendered using `%04o`. Attestations
produced by the earlier path-and-content-only scheme do not verify under this scheme. Before upgrading, regenerate
every stored artifact digest with the current derivation and re-pin the resulting digest anywhere the operator stores
or supplies `ExpectedDigest`.

`ArtifactEntry.Mode` exposes the normalized value used by attestation, not the raw tar header value. AppTheory masks
the header with `header.Mode & 0o7777`, so only the permission and special-mode bits (execute, setuid, setgid, and
sticky) enter the digest; bits outside that mask are neither returned in `ArtifactEntry.Mode` nor attested.

### TableTheory v3 dependency floor

The next AppTheory major line adopts TableTheory v3.0.2 in all three runtimes. This changes the Go type identity exposed
by AppTheory constructors and adapters that accept TableTheory interfaces: Go consumers must replace the previous
TableTheory `/v2` import path with `github.com/theory-cloud/tabletheory/v3` and require v3.0.2 or later before upgrading
AppTheory. Do not keep both TableTheory major paths in one application; their otherwise similar interfaces are distinct
Go types.

TableTheory v3 also adopts DMS v0.2 explicit-empty update semantics. An explicitly selected empty field marked
`omitempty` / `omit_empty` is removed instead of stored, while an unselected empty field remains unchanged. Audit
conditions, sparse indexes, projections, streams, and tests that depend on the presence of empty attributes. Follow the
canonical [TableTheory v3 migration guide](https://github.com/theory-cloud/TableTheory/blob/v3.0.2/docs/migration/v3.md)
for the complete persisted-shape and transaction changes.

TableTheory v3.0.1 established the legacy Go `Transaction.Update(model)` lifecycle contract: implicit selection excludes
`version` / `created_at` / `updated_at`, preserves stored `created_at`, and replaces caller-set `updated_at` with the
library timestamp. TableTheory v3.0.2 additionally treats zero as valid persisted optimistic-lock state on this surface:
it locks and increments version 0, so a missing or mismatched item fails its condition and aborts the whole transaction
group instead of being upserted. Call `Rollback`, then issue an explicit create when the item is absent. The legacy
transactional `Transaction.Delete(model)` surface and the explicit query `Delete()` surface add a lock condition only
for non-zero versions. `TransactionBuilder.Delete` attaches no automatic version lock; callers who need one must supply
the condition themselves.

Handle every legacy `Create`, `Update`, or `Delete` construction error. An ignored error now poisons the transaction;
`Commit` returns the stored first error and submits nothing, and `Rollback` is required before reuse. Unsigned Go
version fields from `uint` through `uint64` now work across every version path instead of panicking.

TableTheory v3.0.2 also rejects duplicate database attribute mappings at model parse or registration time, including Go
embedding shadowing shapes. Models accepted by v3.0.1 may now fail registration. Rename the Go field, assign a distinct
attribute tag, or exclude one mapping with `theorydb:"-"`; for same-name embedding collisions, changing only the
attribute tag is insufficient, so rename the Go field or exclude the embedded mapping.

AppTheory's TypeScript and Python release metadata continues to install TableTheory only from immutable GitHub Release
assets. The v3 dependency assets pinned by this line are:

- TypeScript: `theory-cloud-tabletheory-ts-3.0.2.tgz`, verified with SHA-512
  `K+jT8P2m+8QHvM+Y1hZxThnQfumcMVVwb8BltkEI8vs7bOg8PbUFR5w92ihBQbiA1pCvxG3kz7vwFhqNT0VUtw==`.
- Python: `tabletheory_py-3.0.2-py3-none-any.whl`, verified with SHA-256
  `f6a7d6876a6e7bb71c342023e002b2e5a92a2dc3d704ae233d9fb58354cbe8db`.

Use those pinned assets through AppTheory's package metadata; do not substitute registry-published packages or mutable
URLs.

## v1.15.x line

The v1.15 line contains the Strengthening Program work that made AppTheory stricter without creating a v1 breaking
release. The intended upgrade posture is additive: existing code keeps working, while deprecated compatibility helpers
point at the single future path.

### Canonical framework errors

New code should raise/return `AppTheoryError` for framework-emitted errors. `AppError` remains supported for legacy
code/message compatibility, but it is deprecated as the primary framework error type.

| Runtime | Legacy surface | Replacement | Horizon |
| --- | --- | --- | --- |
| Go | `AppError` | `AppTheoryError` | Supported for v1.x; earliest removal is v2.0. |
| TypeScript | `AppError` | `AppTheoryError` | Supported for v1.x; earliest removal is v2.0. |
| Python | `AppError` | `AppTheoryError` | Supported for v1.x; earliest removal is v2.0. |

Default nested HTTP error envelopes remap any error whose code string is `EMPTY_BODY` or `INVALID_JSON` to the
canonical `app.bad_request` code and message. The remap is keyed by the error code string so that legacy
JSONHandler-originated errors and callers that still return those Lift-era codes converge to the same nested envelope.
If you temporarily need the old flat shape during a Lift migration, opt into the legacy HTTP error format explicitly:

- Go: `apptheory.WithHTTPErrorFormat(apptheory.HTTPErrorFormatFlatLegacy)` or `apptheory.WithLegacyHTTPErrorShape()`
- TypeScript: `createApp({ httpErrorFormat: HTTP_ERROR_FORMAT_FLAT_LEGACY })`
- Python: `create_app(http_error_format=HTTP_ERROR_FORMAT_FLAT_LEGACY)`

Treat that flat legacy format as a migration bridge, not the target state for new applications. Flat legacy preserves
the Lift-era `EMPTY_BODY` / `INVALID_JSON` codes and messages; the nested AppTheory envelope remains the v1 default
and the future-major path.

### Legacy JSON helpers

Go `JSONHandler` remains available for compatibility with Lift-era handlers, but new code should return AppTheory
`Response` values through normal route handlers and use the canonical response helpers (`JSON`, `Text`, `Binary`, SSE,
and stream helpers as appropriate).

| Runtime | Legacy surface | Replacement | Horizon |
| --- | --- | --- | --- |
| Go | `JSONHandler` | AppTheory route handlers returning `Response` / `JSON` / `Text` / `Binary` | Supported for v1.x; earliest removal is v2.0. |

### Fail-closed route registration

The fluent registration path is now fail-closed across runtimes. Invalid route patterns, duplicate canonical
method/pattern pairs, and nil/undefined/None handlers fail during registration instead of producing a dead route at
runtime. This is an intentional behavior change for misconfigured applications that older v1 lines could silently
ignore; treat it as action-required upgrade guidance before promoting a service that constructs routes dynamically.

Use the normal registration path for new code:

| Runtime | Preferred path |
| --- | --- |
| Go | `app.Get(...)`, `app.Post(...)`, `app.Handle(...)`, and other fluent methods |
| TypeScript | `app.get(...)`, `app.post(...)`, `app.handle(...)`, and other fluent methods |
| Python | `app.get(...)`, `app.post(...)`, `app.handle(...)`, and other fluent methods |

Strict helpers are deprecated compatibility wrappers for callers that already depend on their error-returning/throwing shape.
Their failure details now share the canonical AppTheory error path: Python `add_strict` / `handle_strict` raise
`AppTheoryError` instead of `ValueError`, and Go `GetStrict` / `HandleStrict` / related helpers return canonical
`AppTheoryError` messages where applicable rather than older segment-specific strings. Update tests that asserted the
legacy exception class or exact message text:

| Runtime | Deprecated compatibility helper | Replacement | Horizon |
| --- | --- | --- | --- |
| Go | `GetStrict`, `HandleStrict`, and related `*Strict` helpers | Normal fluent registration; catch startup panics in tests if you need setup-error assertions | Supported for v1.x; earliest removal is v2.0. |
| TypeScript | `handleStrict` | `handle` / `get` / `post` / normal fluent registration | Supported for v1.x; earliest removal is v2.0. |
| Python | `handle_strict` | `handle` / `get` / `post` / normal fluent registration | Supported for v1.x; earliest removal is v2.0. |

When upgrading, run application startup tests that construct every route and include duplicate-route, invalid-pattern,
and nil/undefined/None-handler cases if your service builds route tables programmatically. A route typo that was
previously ignored may now fail fast during app initialization. That is expected fail-closed behavior; fix the route
pattern rather than wrapping it in a fallback router.

## v1.14.x and older v1 lines

Before the v1.15 strengthening work, some documentation and examples used strict helpers as the recommended way to
catch bad route patterns. When moving from older v1 lines to v1.15 or later:

1. Replace strict helper usage in ordinary app setup with normal fluent registration.
2. Keep strict helpers only where a test deliberately asserts the compatibility shape.
3. Replace new framework-emitted `AppError` usage with `AppTheoryError`.
4. Plan migration away from Go `JSONHandler` if you still have Lift-era handler adapters.
5. Keep any temporary flat legacy HTTP error format opt-in isolated to migration boundaries.

## Maintainer checklist for future lines

For every minor line, update this file when any of the following change:

- public API deprecation posture;
- default runtime behavior, even when the change is fail-closed and additive;
- dependency floors or installation asset names;
- CDK construct defaults that affect deployed infrastructure;
- migration-only compatibility formats;
- generated artifact expectations such as `ts/dist`, `cdk/lib`, `cdk-go`, or API snapshots.

Do not rely on the generated changelog for action-required guidance. If a consumer must do something, document it here
and link to the exact canonical guide or release note.
