// Package oauth provides small, composable OAuth 2.0/2.1 primitives used by
// AppTheory components (e.g. Remote MCP protected resources) and by Autheory
// (an OAuth Authorization Server built on AppTheory).
//
// The package intentionally focuses on wire-level helpers:
// - RFC9728 protected resource discovery (WWW-Authenticate + metadata)
// - RFC8414 authorization server metadata helpers
// - RFC7591 Dynamic Client Registration request/response types + validation
// - PKCE utilities
package oauth
