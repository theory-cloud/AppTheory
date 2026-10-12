// Package mcpfacade composes AppTheory's Go runtime MCP OAuth facade.
//
// The package registers the route families defined by
// runtime/mcproutes.ContractVersion. It serves RFC 9728 protected-resource metadata
// and RFC 8414 authorization-server discovery while leaving authorization and
// token behavior in application-owned handlers.
//
// MCP transport routes (POST, GET, and DELETE on every MCP pattern) are
// registered with an authenticated posture by default: requests without a
// verified principal are rejected with HTTP 401 and the MCP handler never runs.
// Set FacadeConfig.UnauthenticatedMcp to opt out, or supply
// FacadeConfig.RequireBearerToken to validate an RFC 9728 bearer token on those
// routes.
package mcpfacade
