package apptheorycdk

// Front-door verification for `originReachability: FRONTED`.
//
// Attach mode means the front door is application-owned, so the construct
// cannot inject the header itself and cannot observe the distribution. The
// declaration therefore carries three independently wired copies that must come
// from one application-owned constant: this prop, the distribution's origin
// custom-header configuration, and the runtime's front-door verification
// config. The construct proves only its own copy, and the literal secret is
// consumed at synthesis for validation and the SHA-256 digest only.
type AppTheoryMcpFrontDoorVerificationOptions struct {
	// The assertion that the runtime verifies the front-door header on every derived route.
	//
	// The construct cannot attach that verification to an application-owned front
	// door or a runtime it does not own, so it refuses to synthesize until the
	// caller records that the verification exists. Must be `true`.
	Asserted *bool `field:"required" json:"asserted" yaml:"asserted"`
	// The origin request header the front door injects on every request it sends to the origin.
	//
	// 1 to 64 characters of `[A-Za-z0-9-]`, and never a request header that
	// rewrites the origin contract (`Host`, `Authorization`, `Cookie`,
	// `Content-Length`, `Transfer-Encoding`, `Connection`, `WWW-Authenticate`,
	// `X-Forwarded-For`), any `x-amz-*`/`x-amzn-*`/`cloudfront-*` name, or a
	// hop-by-hop name.
	HeaderName *string `field:"required" json:"headerName" yaml:"headerName"`
	// The literal secret injected as the front-door header value.
	//
	// 32 to 128 characters of `[A-Za-z0-9._~-]`: a header-value-safe alphabet
	// with no whitespace and no control characters. The value is consumed at
	// synthesis for validation and the recorded SHA-256 digest only — the literal
	// never lands in the synthesized template or in CloudFormation. It is not a
	// credential store; rotation means changing the value and redeploying, and it
	// must not be (or contain) a secret that protects anything else.
	SecretValue *string `field:"required" json:"secretValue" yaml:"secretValue"`
}
