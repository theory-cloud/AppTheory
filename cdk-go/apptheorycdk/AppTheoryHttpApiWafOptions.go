package apptheorycdk

type AppTheoryHttpApiWafOptions struct {
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
	// Existing regional WAFv2 WebACL ARN to associate with the HTTP API stage.
	//
	// When omitted, AppTheory creates a regional WebACL with AWS managed baseline rules.
	// Default: undefined.
	//
	WebAclArn *string `field:"optional" json:"webAclArn" yaml:"webAclArn"`
}
