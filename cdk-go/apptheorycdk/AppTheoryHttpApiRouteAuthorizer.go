package apptheorycdk

// Gateway authorization posture for an explicit AppTheoryHttpApi route.
type AppTheoryHttpApiRouteAuthorizer string

const (
	// AWS IAM (SigV4) on the route.
	AppTheoryHttpApiRouteAuthorizer_IAM AppTheoryHttpApiRouteAuthorizer = "IAM"
	// No gateway authorizer;
	//
	// the runtime owns admission.
	AppTheoryHttpApiRouteAuthorizer_NONE AppTheoryHttpApiRouteAuthorizer = "NONE"
)
