package apptheorycdk

// Dimensions for AppTheory EMF request metrics.
//
// The runtime emits metrics in namespace `AppTheory` with metric names
// `RequestCount`, `RequestDuration`, and `RequestErrors`. EMF dimensions are:
// `service`, `method`, `path`, `status`, `tenant_id`, and `error_code`.
type AppTheoryRequestMetricDimensions struct {
	// Error code dimension.
	// Default: undefined.
	//
	ErrorCode *string `field:"optional" json:"errorCode" yaml:"errorCode"`
	// HTTP method dimension.
	// Default: undefined.
	//
	Method *string `field:"optional" json:"method" yaml:"method"`
	// HTTP route/path dimension.
	// Default: undefined.
	//
	Path *string `field:"optional" json:"path" yaml:"path"`
	// AppTheory service dimension.
	// Default: "apptheory".
	//
	Service *string `field:"optional" json:"service" yaml:"service"`
	// HTTP status dimension.
	// Default: undefined.
	//
	Status *string `field:"optional" json:"status" yaml:"status"`
	// Tenant id dimension.
	// Default: undefined.
	//
	TenantId *string `field:"optional" json:"tenantId" yaml:"tenantId"`
}
