package apptheorycdk

// The origin custom header the application wires into its front door.
//
// `headerValue` is the literal for the literal form and a CloudFormation
// `ssm` dynamic reference for the parameter form, so the parameter value never
// enters the application source.
type AppTheoryMcpFrontDoorHeader struct {
	// The origin request header name to send to the origin.
	HeaderName *string `field:"required" json:"headerName" yaml:"headerName"`
	// The header value: a literal, or a `{{resolve:ssm:...}}` dynamic reference.
	HeaderValue *string `field:"required" json:"headerValue" yaml:"headerValue"`
}
