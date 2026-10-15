package apptheorycdk

// Owning-API stage throttling decision.
type AppTheoryMcpOwningApiThrottlingOptions struct {
	// Stage burst limit.
	BurstLimit *float64 `field:"required" json:"burstLimit" yaml:"burstLimit"`
	// Stage rate limit in requests per second.
	RateLimit *float64 `field:"required" json:"rateLimit" yaml:"rateLimit"`
}
