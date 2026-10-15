package apptheorycdk

// The DD-2 direct-origin reachability decision for a REST v1 origin.
//
// DD-2 (`DEFENSE_IN_DEPTH.md`) requires the deployment to **record** whether the
// `execute-api` default endpoint is directly reachable and, when it is, to make
// that posture explicit. A directly reachable origin (`direct`) is **not**
// allowed: it is not a member of this enum and the construct refuses it at
// synthesis.
type AppTheoryRestV1OriginReachability string

const (
	// The REST API's `execute-api` default endpoint is disabled (`disableExecuteApiEndpoint`), so the API is not reachable at its default endpoint.
	//
	// Because the construct fronts an external `IRestApi` it cannot mutate, the
	// caller must assert the disablement with
	// `disableExecuteApiEndpointAsserted: true`.
	//
	// Note the platform shape: the disabled hostname is exactly the
	// `<restApiId>.execute-api.<region>.<urlSuffix>` hostname this construct uses
	// as its origin, so an app that disables the default endpoint must front its
	// REST API through a custom domain (AWS requires a custom domain once the
	// default endpoint is disabled). `LOCKED` is the posture for a REST v1 origin
	// this construct is expected to serve.
	AppTheoryRestV1OriginReachability_DISABLED AppTheoryRestV1OriginReachability = "DISABLED"
	// The origin is reachable only through this construct's CloudFront front door.
	//
	// Requires `originLock` carrying the origin-lock secret the construct injects
	// as a custom origin header, plus the caller's assertion that the REST API
	// verifies that header (the construct cannot attach an origin-side
	// verification to an external `IRestApi`).
	AppTheoryRestV1OriginReachability_LOCKED AppTheoryRestV1OriginReachability = "LOCKED"
)
