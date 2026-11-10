package apptheorycdk

// Direct-origin reachability decision required under `runtime-bearer` and `none-public`.
type AppTheoryMcpOriginReachability string

const (
	// Disable the execute-api default endpoint and advertise an owned ordinary custom domain as the only MCP authority.
	AppTheoryMcpOriginReachability_DISABLED AppTheoryMcpOriginReachability = "DISABLED"
	// Disable the execute-api default endpoint and require mutual TLS on every custom domain mapped to the construct-owned API.
	//
	// The owned domain's
	// `mutualTlsAuthentication` is the concrete lock; an enum alone or an
	// external/attached front door never satisfies it.
	AppTheoryMcpOriginReachability_LOCKED AppTheoryMcpOriginReachability = "LOCKED"
	// The origin stays directly reachable at its execute-api endpoint and is served only through an application-owned front door that injects `frontDoorVerification` on every origin request.
	//
	// This is the posture for an app-owned distribution whose origin is the
	// execute-api hostname: the construct sees neither the distribution nor the
	// API's endpoint configuration, so it cannot produce in-stack evidence the
	// way `DISABLED` and `LOCKED` do. Valid only in attach mode, accepted with
	// `RUNTIME_BEARER` and `NONE_PUBLIC` like the other decisions, and it
	// requires the mandatory `frontDoorVerification` declaration.
	//
	// `FRONTED` is a defense-in-depth declaration with runtime enforcement, not
	// mutual-TLS assurance and not origin unreachability. The enforcement is the
	// runtime's front-door header check (`mcpfacade.FacadeConfig`
	// `FrontDoorVerification` in Go, `frontDoorVerification` in TypeScript,
	// `front_door_verification` in Python): it refuses every derived route when
	// the declared header is absent or wrong, and fails registration when
	// `FRONTED` is declared without it. An unwired runtime enforces nothing.
	AppTheoryMcpOriginReachability_FRONTED AppTheoryMcpOriginReachability = "FRONTED"
)
