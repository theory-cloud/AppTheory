package apptheorycdk

// Transport-route authorization posture for AppTheoryMcpServer.
type AppTheoryMcpTransportPosture string

const (
	// AWS IAM (SigV4) on the transport routes.
	//
	// The default for a server with no facade attachment.
	AppTheoryMcpTransportPosture_IAM AppTheoryMcpTransportPosture = "IAM"
	// A static JWT authorizer (issuer + audience) on the transport routes.
	AppTheoryMcpTransportPosture_JWT AppTheoryMcpTransportPosture = "JWT"
	// The gateway authorizer is NONE and the runtime validates RFC 9728 bearer tokens.
	//
	// The default for a facade-configured server.
	AppTheoryMcpTransportPosture_RUNTIME_BEARER AppTheoryMcpTransportPosture = "RUNTIME_BEARER"
	// Deliberately public MCP server: every transport route is public.
	//
	// Never a default.
	AppTheoryMcpTransportPosture_NONE_PUBLIC AppTheoryMcpTransportPosture = "NONE_PUBLIC"
)
