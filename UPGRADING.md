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
