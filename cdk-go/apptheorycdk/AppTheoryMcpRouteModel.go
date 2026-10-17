package apptheorycdk

// Route-emission model for AppTheoryMcpServer.
type AppTheoryMcpRouteModel string

const (
	// One API Gateway HTTP API v2 route per derived route key.
	//
	// This is the
	// construct's historical inventory and stays byte-identical for deployed
	// stacks, so a `routeModel: explicit` upgrade deploys in place. The default.
	AppTheoryMcpRouteModel_EXPLICIT AppTheoryMcpRouteModel = "EXPLICIT"
	// Two greedy routes, `ANY /` and `ANY /{proxy+}`, backed by one shared integration.
	//
	// The AppTheory runtime router performs method and path
	// dispatch, path-parameter capture, and denial. Consolidation never changes
	// gateway admission, so it is valid only when every gateway route is `NONE`:
	// the `runtime-bearer` and `none-public` transport postures. `iam` and `jwt`
	// are refused at synthesis time.
	AppTheoryMcpRouteModel_CONSOLIDATED AppTheoryMcpRouteModel = "CONSOLIDATED"
)
