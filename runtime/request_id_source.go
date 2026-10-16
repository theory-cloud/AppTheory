package apptheory

// RequestIDSource controls where an HTTP request's ID comes from.
type RequestIDSource string

const (
	// RequestIDSourceDefault honors a client-supplied x-request-id header, as
	// the runtime has always done.
	RequestIDSourceDefault RequestIDSource = "default"
	// RequestIDSourceServer ignores any client-supplied x-request-id header and
	// issues the request ID from the fallback request ID, else a generated ID.
	RequestIDSourceServer RequestIDSource = "server"
)

func normalizeRequestIDSource(source RequestIDSource) RequestIDSource {
	switch source {
	case RequestIDSourceServer:
		return RequestIDSourceServer
	default:
		return RequestIDSourceDefault
	}
}
