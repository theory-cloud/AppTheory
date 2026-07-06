package apptheorycdk

// Regional WAFv2 options for API Gateway REST API stages.
//
// AppTheory intentionally scopes this surface to API Gateway REST API v1
// stages, whose supported WAF resource ARN shape is:
// `arn:${partition}:apigateway:${region}::/restapis/${apiId}/stages/${stageName}`.
//
// API Gateway v2 HTTP API stages are not exposed through this construct
// because their `/apis/.../stages/...` ARN shape is not a supported regional
// WAFv2 association target.
type AppTheoryRegionalWafOptions struct {
	// CloudWatch metric name for the WebACL.
	// Default: derived from apiName.
	//
	MetricName *string `field:"optional" json:"metricName" yaml:"metricName"`
	// WebACL name when AppTheory creates one.
	// Default: derived from apiName.
	//
	Name *string `field:"optional" json:"name" yaml:"name"`
	// Optional request rate limit rule threshold per five-minute window.
	// Default: undefined.
	//
	RateLimit *float64 `field:"optional" json:"rateLimit" yaml:"rateLimit"`
	// Existing regional WAFv2 WebACL ARN to associate with the REST API stage.
	//
	// When omitted, AppTheory creates a regional WebACL with AWS managed
	// baseline rules.
	// Default: undefined.
	//
	WebAclArn *string `field:"optional" json:"webAclArn" yaml:"webAclArn"`
}
