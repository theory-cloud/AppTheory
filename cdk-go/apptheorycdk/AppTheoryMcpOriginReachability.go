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
)
