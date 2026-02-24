# Compatibility contract — Claude Remote MCP (Streamable HTTP + OAuth/DCR)

This document defines the **wire-level contract** AppTheory must enable so that servers built on it are compatible with **Claude Custom Connectors** using **Remote MCP**.

It is intentionally explicit (status codes, headers, message framing) so implementation can be delegated without “interpretation”.

---

## 1) Protocol versions

### Transport

- Implement **MCP Streamable HTTP**.
- Support protocol revision `2025-06-18`.
- If the request does not include `MCP-Protocol-Version`, default to `2025-03-26`.

### Auth

- Implement MCP authorization spec `2025-06-18` (protected resource metadata + RFC9728 challenge).
- Maintain compatibility with `2025-03-26` clients by exposing OAuth endpoints at root paths (`/authorize`, `/token`, `/register`) and metadata at `/.well-known/oauth-authorization-server`.

---

## 2) Single MCP endpoint

The MCP server exposes exactly one MCP endpoint path:

- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp` (recommended; server MAY return 405)

Do not implement the deprecated “HTTP+SSE transport” endpoints.

---

## 3) Required request headers

### Common

- `Accept`:
  - POST: must include both `application/json` and `text/event-stream`
  - GET: must include `text/event-stream`
- `MCP-Protocol-Version: 2025-06-18` (required after initialization; validate and reject unknown/unsupported values with `400`)
- `Mcp-Session-Id: <opaque>` (required after initialization if the server issues one)
- `Origin: <origin>` (must be validated; fail closed)
- `Authorization: Bearer <token>` (when the server is protected)

### Resumability

- `Last-Event-ID: <id>` (optional; used on GET to resume an interrupted stream)

Notes:
- HTTP header field names are case-insensitive. Consumers must accept different casing.
- For protected servers, clients must include `Authorization: Bearer ...` on **every** HTTP request (POST/GET/DELETE), even within the same logical session.

---

## 4) JSON-RPC message handling

### POST /mcp request body

Body MUST be exactly one JSON value:
- a JSON-RPC **request**, **notification**, or **response** (2025-06-18), OR
- a JSON-RPC batch array (2025-03-26 compatibility)

### POST /mcp responses

If the input is a JSON-RPC **notification** or **response**:
- If accepted: return `202 Accepted` with **no body**
- If rejected: return an HTTP error status (e.g. `400`) and MAY include a JSON-RPC error response **without an `id`**

If the input contains a JSON-RPC **request**:
- Return either:
  - `Content-Type: application/json` with the JSON-RPC response body, OR
  - `Content-Type: text/event-stream` and stream server messages, eventually including the JSON-RPC response

### GET /mcp

If supported:
- return `Content-Type: text/event-stream`
If not supported:
- return `405 Method Not Allowed`

GET stream rules:
- The server MAY send JSON-RPC requests/notifications.
- The server MUST NOT send JSON-RPC responses on the GET stream unless it is resuming/replaying a previously interrupted request stream.

---

## 5) SSE framing rules (Streamable HTTP)

### Message delivery

- Every server->client JSON-RPC message is sent as an SSE event whose `data:` payload is a single JSON-RPC message value:
  - a JSON object (request/notification/response), or
  - a JSON array (batch) when operating in a version/mode that permits batching.
- Prefer either:
  - no explicit event name (default “message”), OR
  - `event: message`

### Multiple connections

- Clients MAY keep multiple SSE streams open.
- The server MUST deliver each JSON-RPC message on only one stream (no broadcast).

### Event IDs (required for resumability)

- Each SSE event MAY include `id: <id>`.
- If present, IDs MUST be unique per-stream and can be used as a cursor for replay via `Last-Event-ID`.

### Keepalives

- The server SHOULD periodically send SSE comment keepalives (e.g. `: keepalive`) to avoid idle timeouts.

### Disconnects are not cancellation

- SSE disconnects MUST NOT be interpreted as client cancellation.
- If the client wants to cancel work, it should send an MCP cancellation notification (per MCP spec) explicitly.

---

## 6) MCP lifecycle requirements

### notifications/initialized MUST work

Clients will send `notifications/initialized` as a JSON-RPC notification (no `id`).

Server behavior:
- Accept it.
- Return `202 Accepted` with no body.

---

## 7) Progress streaming requirements

To stream tool progress:

- Send JSON-RPC notifications `notifications/progress` (not custom SSE event types).
- Use `_meta.progressToken` to correlate progress to a request/tool call.

---

## 8) Session rules

### Issuing a session id

If the server uses sessions:
- On the HTTP response that contains the `initialize` result, set header:
  - `Mcp-Session-Id: <new id>`

### Subsequent requests

If a session id was issued:
- Clients MUST send `Mcp-Session-Id` on all subsequent requests (POST/GET/DELETE).
- If missing (non-initialize): server SHOULD return `400 Bad Request`.

### Termination

- Server MAY terminate sessions at any time.
- Once terminated, any request with that session id MUST return `404 Not Found`.
- Clients may request termination via `DELETE /mcp` with `Mcp-Session-Id` header.

---

## 9) OAuth/DCR contract (Claude-first)

### Protected resource challenge (MCP auth 2025-06-18)

When auth is required and missing/invalid:
- Return `401 Unauthorized`
- Include `WWW-Authenticate` header with a `resource_metadata` parameter pointing to the resource metadata URL.

Example shape (exact formatting may vary):
- `WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"`

### Protected resource metadata endpoint

Resource server (MCP server) must host:
- `GET /.well-known/oauth-protected-resource`

It must include:
- `authorization_servers`: list containing the Autheory issuer/base URL
- `resource`: canonical resource identifier (used by clients as `resource=` parameter)

### Authorization Server metadata + endpoints (Autheory)

Autheory must host:
- `GET /.well-known/oauth-authorization-server` (RFC8414 metadata)
- `POST /register` (DCR)
- `GET /authorize`
- `POST /token`

### DCR policy requirements (day‑1)

Autheory must enforce:
- redirect URI allowlist:
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`
- public clients only (`token_endpoint_auth_method=none`)
- PKCE required
- refresh tokens enabled

---

## 10) AWS deployment constraints (document as first-class)

When deployed behind API Gateway REST + Lambda response streaming:

- Streaming connections have a max duration (documented as 15 minutes in AWS guidance).
- Idle timeouts exist; keepalives are required.
- Therefore, long-running tasks MUST be modeled as:
  - async work + durable event log + resumable SSE replay
