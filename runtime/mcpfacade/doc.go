// Package mcpfacade composes AppTheory's Go runtime MCP OAuth facade.
//
// The package registers the route families defined by
// runtime/mcproutes.ContractVersion. It serves RFC 9728 protected-resource metadata
// and RFC 8414 authorization-server discovery while leaving authorization and
// token behavior in application-owned handlers.
package mcpfacade
