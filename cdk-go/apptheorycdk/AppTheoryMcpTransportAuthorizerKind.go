package apptheorycdk

// Authorizer applied to the AppTheoryMcpServer MCP transport routes.
type AppTheoryMcpTransportAuthorizerKind string

const (
	// AWS IAM (SigV4) authorization.
	//
	// The zero-configuration default.
	AppTheoryMcpTransportAuthorizerKind_IAM AppTheoryMcpTransportAuthorizerKind = "IAM"
	// JSON Web Token authorization against an OIDC/Cognito issuer.
	AppTheoryMcpTransportAuthorizerKind_JWT AppTheoryMcpTransportAuthorizerKind = "JWT"
)
