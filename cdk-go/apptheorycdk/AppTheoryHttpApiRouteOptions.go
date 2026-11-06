package apptheorycdk

// One explicit, semantically identified route added alongside the construct's greedy `ANY /` and `ANY /{proxy+}` routes.
//
// API Gateway precedence gives a full method+path match priority over the
// greedy routes, so a more specific route with a stricter authorizer (for
// example `AWS_IAM`) wins for its own path. A wrong-method request on such a
// path falls through to the runtime's fail-closed 404/405 when the runtime does
// not declare it.
type AppTheoryHttpApiRouteOptions struct {
	// HTTP methods wired for the route, for example `["GET"]` or `["ANY"]`.
	Methods *[]*string `field:"required" json:"methods" yaml:"methods"`
	// Absolute route path.
	//
	// Segments are literals, `{parameter}`, or `{proxy+}` segments.
	Path *string `field:"required" json:"path" yaml:"path"`
	// Gateway authorization posture for the route.
	//
	// Omit for `NONE`. Every explicit value other than `IAM` or `NONE` — an
	// uppercase spelling, a misspelling, `null`, a number, an object, or any
	// unchecked configuration value — fails synthesis before this route is
	// emitted instead of silently falling back to `NONE`.
	// Default: AppTheoryHttpApiRouteAuthorizer.NONE
	//
	Authorizer AppTheoryHttpApiRouteAuthorizer `field:"optional" json:"authorizer" yaml:"authorizer"`
}
