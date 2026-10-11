package apptheorycdk

// Authenticated authorizer configuration for the MCP transport routes.
type AppTheoryMcpTransportAuthorizerOptions struct {
	// Accepted JWT audiences.
	//
	// Required when kind is JWT.
	// Default: undefined.
	//
	Audience *[]*string `field:"optional" json:"audience" yaml:"audience"`
	// JWT authorizer resource name.
	//
	// JWT only.
	// Default: the authorizer construct id.
	//
	AuthorizerName *string `field:"optional" json:"authorizerName" yaml:"authorizerName"`
	// Identity sources for the JWT authorizer.
	//
	// JWT only.
	// Default: ["$request.header.Authorization"]
	//
	IdentitySource *[]*string `field:"optional" json:"identitySource" yaml:"identitySource"`
	// Absolute HTTPS JWT issuer URL.
	//
	// Required when kind is JWT.
	// Default: undefined.
	//
	Issuer *string `field:"optional" json:"issuer" yaml:"issuer"`
	// Default: AppTheoryMcpTransportAuthorizerKind.IAM
	//
	Kind AppTheoryMcpTransportAuthorizerKind `field:"optional" json:"kind" yaml:"kind"`
}
