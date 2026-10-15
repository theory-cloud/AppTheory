package apptheorycdk

// The origin lock for `originReachability: LOCKED`.
//
// The construct injects `secret` as the `headerName` custom origin header on
// **every** request it sends to the REST v1 origin, so an origin-side
// verification can refuse a request that did not come through this
// distribution. The construct fronts an external `IRestApi`, so it cannot attach
// that verification itself: the caller asserts it with `asserted: true`.
type AppTheoryRestV1OriginLockOptions struct {
	// The caller's assertion that the REST API verifies the origin lock.
	//
	// This construct cannot attach a resource policy, authorizer, or any other
	// origin-side verification to an external `IRestApi` it does not own, so it
	// refuses to synthesize until the caller records that the verification exists
	// and requires the injected header. Must be `true`.
	Asserted *bool `field:"required" json:"asserted" yaml:"asserted"`
	// The literal secret injected as the origin-lock header on every CloudFront request to the origin.
	//
	// 32 to 128 characters of `[A-Za-z0-9._~-]`. The value is a literal CloudFront
	// origin custom header value, so it appears verbatim in the synthesized
	// template and must not be (or contain) a credential you cannot rotate with the
	// REST API's verification.
	Secret *string `field:"required" json:"secret" yaml:"secret"`
	// The origin-lock header name.
	//
	// 1 to 64 characters of `[A-Za-z0-9-]`, and never a name CloudFront reserves or
	// that rewrites the origin request contract (`Host`, `Authorization`,
	// `Cookie`, `Content-Length`, `Transfer-Encoding`, `Connection`,
	// `WWW-Authenticate`, `X-Forwarded-For`, or any `x-amz-*`, `x-amzn-*`, or
	// `cloudfront-*` name).
	// Default: "x-apptheory-origin-lock".
	//
	HeaderName *string `field:"optional" json:"headerName" yaml:"headerName"`
}
