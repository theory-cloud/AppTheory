package apptheorycdk

// Denial-telemetry declaration required under `runtime-bearer`.
type AppTheoryMcpDenialSignalOptions struct {
	// Bounded metric dimensions.
	//
	// Must be exactly `outcome` and `route_family`.
	// Default: ["outcome", "route_family"].
	//
	Dimensions *[]*string `field:"optional" json:"dimensions" yaml:"dimensions"`
	// Denial metric name.
	//
	// Must be `apptheory.mcp.auth_denied`.
	// Default: apptheory.mcp.auth_denied
	//
	MetricName *string `field:"optional" json:"metricName" yaml:"metricName"`
}
