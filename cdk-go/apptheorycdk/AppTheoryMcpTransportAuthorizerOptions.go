package apptheorycdk

// Static JWT configuration for `transportPosture: JWT`.
type AppTheoryMcpTransportAuthorizerOptions struct {
	// Accepted JWT audiences.
	//
	// Required under `transportPosture: JWT`.
	// Default: undefined.
	//
	Audience *[]*string `field:"optional" json:"audience" yaml:"audience"`
	// JWT authorizer resource name.
	// Default: the authorizer construct id.
	//
	AuthorizerName *string `field:"optional" json:"authorizerName" yaml:"authorizerName"`
	// Identity sources for the JWT authorizer.
	// Default: ["$request.header.Authorization"]
	//
	IdentitySource *[]*string `field:"optional" json:"identitySource" yaml:"identitySource"`
	// Absolute HTTPS JWT issuer URL.
	//
	// Required under `transportPosture: JWT`.
	// Default: undefined.
	//
	Issuer *string `field:"optional" json:"issuer" yaml:"issuer"`
}
