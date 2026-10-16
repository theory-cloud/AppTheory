package apptheorycdk

// Route-level throttling applied to one API Gateway route key.
type AppTheoryHttpApiRouteThrottling struct {
	// Burst limit for the route key.
	// Default: the stage default.
	//
	BurstLimit *float64 `field:"optional" json:"burstLimit" yaml:"burstLimit"`
	// Requests per second for the route key.
	// Default: the stage default.
	//
	RateLimit *float64 `field:"optional" json:"rateLimit" yaml:"rateLimit"`
}
