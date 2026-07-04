package apptheorycdk

// Deprecated: API Gateway v2 HTTP API stages are not supported WAFv2 regional
// association targets. Use AppTheoryRestApi or AppTheoryRestApiRouter with
// AppTheoryRegionalWafOptions for WAF-protected REST API stages.
type AppTheoryHttpApiWafOptions struct {
	// CloudWatch metric name for the WebACL.
	// Default: derived from apiName.
	//
	// Deprecated: API Gateway v2 HTTP API stages are not supported WAFv2 regional
	// association targets. Use AppTheoryRestApi or AppTheoryRestApiRouter with
	// AppTheoryRegionalWafOptions for WAF-protected REST API stages.
	MetricName *string `field:"optional" json:"metricName" yaml:"metricName"`
	// WebACL name when AppTheory creates one.
	// Default: derived from apiName.
	//
	// Deprecated: API Gateway v2 HTTP API stages are not supported WAFv2 regional
	// association targets. Use AppTheoryRestApi or AppTheoryRestApiRouter with
	// AppTheoryRegionalWafOptions for WAF-protected REST API stages.
	Name *string `field:"optional" json:"name" yaml:"name"`
	// Optional request rate limit rule threshold per five-minute window.
	// Default: undefined.
	//
	// Deprecated: API Gateway v2 HTTP API stages are not supported WAFv2 regional
	// association targets. Use AppTheoryRestApi or AppTheoryRestApiRouter with
	// AppTheoryRegionalWafOptions for WAF-protected REST API stages.
	RateLimit *float64 `field:"optional" json:"rateLimit" yaml:"rateLimit"`
	// Existing regional WAFv2 WebACL ARN to associate with the REST API stage.
	//
	// When omitted, AppTheory creates a regional WebACL with AWS managed
	// baseline rules.
	// Default: undefined.
	//
	// Deprecated: API Gateway v2 HTTP API stages are not supported WAFv2 regional
	// association targets. Use AppTheoryRestApi or AppTheoryRestApiRouter with
	// AppTheoryRegionalWafOptions for WAF-protected REST API stages.
	WebAclArn *string `field:"optional" json:"webAclArn" yaml:"webAclArn"`
}
