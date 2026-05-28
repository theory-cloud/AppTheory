---
title: Source Provenance
description: Safe HTTP source-IP access derived from AWS provider request context — never from client-controlled forwarding headers.
---

# Source Provenance

`SourceProvenance` is AppTheory's portable, structured source-IP contract for HTTP requests. It is available at **every tier including P0**, and it is derived exclusively from AWS provider request-context fields. AppTheory **never** trusts `Forwarded` or `X-Forwarded-For` for this contract.

## Why this exists

`X-Forwarded-For` and `Forwarded` are viewer-controlled headers unless your product has its own separate trusted-proxy model. A handler that reads them for security decisions — rate limiting by IP, geo gating, fraud scoring — is reading attacker-controlled input. AppTheory closes that door by surfacing only the provider-observed source IP, in canonical form, through a single accessor.

## The accessor surface

| Concern | Go | TypeScript | Python |
| --- | --- | --- | --- |
| Structured type | `SourceProvenance` | `SourceProvenance` | `SourceProvenance` |
| Request field | `Request.SourceProvenance` | `Request.sourceProvenance` | `Request.source_provenance` |
| Context accessor | `ctx.SourceProvenance()` | `ctx.sourceProvenance()` | `ctx.source_provenance()` |
| Convenience IP | `ctx.SourceIP()` | `ctx.sourceIP()` | `ctx.source_ip()` |
| APIGW v2 test option | `HTTPEventOptions.SourceIP` | `sourceIp` | `source_ip` |
| Lambda URL test option | `HTTPEventOptions.SourceIP` | `sourceIp` | `source_ip` |

## The shape

The structured value has four fields:

| Field | Meaning |
| --- | --- |
| `source_ip` | Canonical parsed source IP string, or `""` when invalid/unknown. |
| `provider` | `apigw-v2`, `lambda-url`, `apigw-v1`, or `unknown`. |
| `source` | `provider_request_context` or `unknown`. |
| `valid` | `true` only when the provider supplied a parseable source IP. |

## Provider mapping

| AWS event source | Field read | `provider` value |
| --- | --- | --- |
| API Gateway v2 HTTP API | `requestContext.http.sourceIp` | `apigw-v2` |
| Lambda Function URL | `requestContext.http.sourceIp` | `lambda-url` |
| API Gateway v1 REST proxy | `requestContext.identity.sourceIp` | `apigw-v1` |
| ALB target group | (none) | `unknown` |
| Anything else | (none) | `unknown` |

ALB source values are intentionally not supported in this contract because ALB does not surface a reliable, untrusted-header-free source IP in the same way API Gateway and Lambda URLs do.

## Examples

### Go

```go
app.Get("/source", func(ctx *apptheory.Context) (*apptheory.Response, error) {
    return apptheory.JSON(200, map[string]string{"source_ip": ctx.SourceIP()})
})

event := testkit.APIGatewayV2Request("GET", "/source", testkit.HTTPEventOptions{
    SourceIP: "2001:DB8::1",
})
```

### TypeScript

```ts
app.get("/source", (ctx) => json(200, { source_ip: ctx.sourceIP() }));

const event = buildAPIGatewayV2Request("GET", "/source", {
  sourceIp: "2001:DB8::1",
});
```

### Python

```python
app.get("/source", lambda ctx: json(200, {"source_ip": ctx.source_ip()}))

event = build_apigw_v2_request("GET", "/source", source_ip="2001:DB8::1")
```

## Canonical IP form

Valid IPs are parsed and re-emitted in canonical form before they become public response or handler strings. The fixture pins this explicitly:

```
input:    "2001:DB8::1"
emitted:  "2001:db8::1"
```

All three runtimes canonicalize identically. If you see Go and TypeScript disagreeing on `source_ip`, it is a runtime bug, not a fixture interpretation issue — the canonical form is the contract.

## Fail-closed behavior

When the provider does not supply a source IP, or supplies one that does not parse:

```
provider: "unknown"
source:   "unknown"
source_ip: ""
valid:    false
```

The runtime does **not** fall back to `X-Forwarded-For`. There is no flag to enable fallback. If you have a trusted-proxy model in front of AppTheory, derive the trusted source in your own middleware and stash it on the context — but do not extend `SourceProvenance` to read forwarding headers.

## What's not in scope

- **Trust models for `Forwarded` / `X-Forwarded-For`** — not handled. Build your own middleware if needed.
- **GeoIP** — not handled. The contract surface is the IP only.
- **Rate-limiting by IP** — handled separately by `RateLimitMiddleware`, which can use `SourceIP` as the bucket key.

## Related

- [HTTP Runtime tiers](http-runtime.md) — `SourceProvenance` is available at P0
- [Sanitization](sanitization.md) — safe logging of source IPs
- [v1 Security Migration](../migration/v1-security.md) — older code paths and how to update them
