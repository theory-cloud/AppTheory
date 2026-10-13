package apptheorycdk

// Direct-origin reachability decision required under `runtime-bearer` and `none-public`.
type AppTheoryMcpOriginReachability string

const (
	// The execute-api default endpoint is disabled.
	AppTheoryMcpOriginReachability_DISABLED AppTheoryMcpOriginReachability = "DISABLED"
	// The origin is reachable only through a locked front door (CloudFront / VPC origin).
	AppTheoryMcpOriginReachability_LOCKED AppTheoryMcpOriginReachability = "LOCKED"
)
