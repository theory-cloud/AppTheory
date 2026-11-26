package apptheorycdk

// The endpoint a Web Function serves requests on.
//
// Every field here is deployment configuration, not a runtime knob: the endpoint is part of the
// stack, so its shape is decided at synthesis time and never by an environment variable.
type AppTheoryWebFunctionEndpointProps struct {
	// A description of the endpoint.
	// Default: undefined - no description.
	//
	Description *string `field:"optional" json:"description" yaml:"description"`
	// The name of the endpoint.
	//
	// Must be 2 to 64 characters of letters, numbers, hyphens or underscores, starting and ending
	// with a letter or number.
	// Default: undefined - the endpoint is named `prod` in the home Region.
	//
	EndpointName *string `field:"optional" json:"endpointName" yaml:"endpointName"`
	// The maximum number of concurrent execution environments the endpoint may use.
	//
	// A cap on top of the account's vCPU quota, not a reservation. Must be 2 or greater.
	// Default: undefined - scaling is limited only by the account's vCPU quota.
	//
	MaxEnvironments *float64 `field:"optional" json:"maxEnvironments" yaml:"maxEnvironments"`
	// The maximum request rate per second the endpoint accepts.
	//
	// The service accepts 0, 100 through 1000 in increments of 100, and 2000 through 10000 in
	// increments of 1000. Which of those a Region accepts varies, and an unsupported value is
	// rejected at deploy time with the values that Region does accept.
	// Default: undefined - the request rate is limited only by the account's rate limit quota.
	//
	RateLimit *float64 `field:"optional" json:"rateLimit" yaml:"rateLimit"`
}
