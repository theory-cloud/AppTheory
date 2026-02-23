# Golden HTTP transcripts — Streamable HTTP MCP + OAuth/DCR (Claude-first)

This document contains **normative transcripts** (request/response examples) used as the source of truth for:

- AppTheory contract tests (`testkit/` + `contract-tests/`)
- Autheory DCR + PKCE + refresh behavior
- theory-mcp “protected resource” behavior

All tokens/IDs below are placeholders.

---

## A) Unauthenticated MCP call → 401 + resource metadata discovery

### A1. Client calls MCP without Bearer token (initialize)

Request:

```http
POST /mcp HTTP/1.1
Host: mcp.example.com
Accept: application/json, text/event-stream
Content-Type: application/json
Origin: https://claude.ai

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "Claude", "version": "unknown" }
  }
}
```

Response:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"
Content-Type: application/json; charset=utf-8

{ "error": "unauthorized" }
```

Notes:
- The `WWW-Authenticate` header is required for MCP auth (2025-06-18) protected resource discovery.

### A2. Client fetches protected resource metadata (RFC9728)

Request:

```http
GET /.well-known/oauth-protected-resource HTTP/1.1
Host: mcp.example.com
Accept: application/json
```

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "resource": "https://mcp.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"]
}
```

### A3. Client fetches authorization server metadata (RFC8414)

Request:

```http
GET /.well-known/oauth-authorization-server HTTP/1.1
Host: auth.example.com
Accept: application/json
```

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "issuer": "https://auth.example.com",
  "authorization_endpoint": "https://auth.example.com/authorize",
  "token_endpoint": "https://auth.example.com/token",
  "registration_endpoint": "https://auth.example.com/register",
  "jwks_uri": "https://auth.example.com/.well-known/jwks.json",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none"]
}
```

---

## B) Dynamic Client Registration (DCR) (RFC7591)

### B1. Client registers as a public client (token auth method: none)

Request:

```http
POST /register HTTP/1.1
Host: auth.example.com
Content-Type: application/json
Accept: application/json

{
  "client_name": "Claude",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

Response:

```http
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8

{
  "client_id": "claude-client-123",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "token_endpoint_auth_method": "none"
}
```

Policy requirements:
- Reject unknown/unsafe redirect URIs.
- Require `token_endpoint_auth_method=none`.
- Require PKCE at authorization time.

---

## C) Authorization Code + PKCE (public client) + resource indicators

### C1. Client initiates authorize request

Request (browser):

```http
GET /authorize?response_type=code&client_id=claude-client-123&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=...&code_challenge_method=S256&resource=https%3A%2F%2Fmcp.example.com%2Fmcp HTTP/1.1
Host: auth.example.com
```

Response (after login/consent):

```http
HTTP/1.1 302 Found
Location: https://claude.ai/api/mcp/auth_callback?code=authcode-abc&state=...
```

### C2. Client exchanges code for tokens

Request:

```http
POST /token HTTP/1.1
Host: auth.example.com
Content-Type: application/x-www-form-urlencoded
Accept: application/json

grant_type=authorization_code&
code=authcode-abc&
redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&
client_id=claude-client-123&
code_verifier=...&
resource=https%3A%2F%2Fmcp.example.com%2Fmcp
```

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "access_token": "eyJ...jwt...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "refresh-xyz",
  "scope": "mcp"
}
```

---

## D) MCP lifecycle (Streamable HTTP)

### D1. initialize request with Bearer token (JSON response)

Request:

```http
POST /mcp HTTP/1.1
Host: mcp.example.com
Accept: application/json, text/event-stream
Content-Type: application/json
Origin: https://claude.ai
Authorization: Bearer eyJ...jwt...

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": { "name": "Claude", "version": "unknown" }
  }
}
```

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Mcp-Session-Id: sess-1868a90c...

{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "ExampleServer", "version": "dev" }
  }
}
```

### D2. notifications/initialized (no id) → 202

Request:

```http
POST /mcp HTTP/1.1
Host: mcp.example.com
Accept: application/json, text/event-stream
Content-Type: application/json
Origin: https://claude.ai
Authorization: Bearer eyJ...jwt...
Mcp-Session-Id: sess-1868a90c...
MCP-Protocol-Version: 2025-06-18

{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

Response:

```http
HTTP/1.1 202 Accepted
```

---

## E) Tool call with SSE progress + final response (POST stream)

### E1. tools/call returns SSE stream and includes progress notifications

Request:

```http
POST /mcp HTTP/1.1
Host: mcp.example.com
Accept: application/json, text/event-stream
Content-Type: application/json
Origin: https://claude.ai
Authorization: Bearer eyJ...jwt...
Mcp-Session-Id: sess-1868a90c...
MCP-Protocol-Version: 2025-06-18

{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "long_task",
    "arguments": { "input": "..." },
    "_meta": { "progressToken": "pt-123" }
  }
}
```

Response (SSE):

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

id: 1
event: message
data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"pt-123","progress":1,"total":10,"message":"started"}}

id: 2
event: message
data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"pt-123","progress":5,"total":10,"message":"halfway"}}

id: 3
event: message
data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}]}}
```

After the final response message, the server closes the stream.

---

## F) Disconnect + resume (GET with Last-Event-ID)

If the client disconnects after receiving `id: 1`, it may resume:

Request:

```http
GET /mcp HTTP/1.1
Host: mcp.example.com
Accept: text/event-stream
Authorization: Bearer eyJ...jwt...
Mcp-Session-Id: sess-1868a90c...
MCP-Protocol-Version: 2025-06-18
Last-Event-ID: 1
```

Response:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream

id: 2
event: message
data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":"pt-123","progress":5,"total":10,"message":"halfway"}}

id: 3
event: message
data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}]}}
```

Important:
- Replays must only include events that were destined for the disconnected stream.
- GET streams must not emit JSON-RPC responses unless resuming/replaying a previously interrupted request stream.

---

## G) Refresh token

When access token expires:

Request:

```http
POST /token HTTP/1.1
Host: auth.example.com
Content-Type: application/x-www-form-urlencoded
Accept: application/json

grant_type=refresh_token&
refresh_token=refresh-xyz&
client_id=claude-client-123&
resource=https%3A%2F%2Fmcp.example.com%2Fmcp
```

Response:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{
  "access_token": "eyJ...newjwt...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "refresh-rotated-456"
}
```

The client continues MCP requests with the new access token; the session remains valid.

