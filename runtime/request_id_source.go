package apptheory

import "strings"

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

// MaxClientRequestIDLength is the longest client-supplied x-request-id header
// value the framework treats as well-formed.
const MaxClientRequestIDLength = 128

// clientRequestIDWhitespace lists the leading and trailing bytes trimmed from a
// client x-request-id before its shape is judged. It is ASCII-only so that Go,
// TypeScript, and Python trim exactly the same bytes.
const clientRequestIDWhitespace = " \t\n\v\f\r"

// IsWellFormedClientRequestID reports whether a client-supplied x-request-id
// header value is well-formed.
//
// A value is well-formed when, after trimming leading and trailing whitespace,
// it is 1 to MaxClientRequestIDLength characters long and every character is
// visible ASCII (0x21 through 0x7E). Spaces, tabs, carriage returns, line feeds,
// other control characters, and non-ASCII characters all make a value
// malformed.
//
// The runtime never uses a malformed value as the request ID. Consumer
// applications read well-formed client values through Context.ClientRequestID.
func IsWellFormedClientRequestID(value string) bool {
	return wellFormedClientRequestID(value) != ""
}

// wellFormedClientRequestID returns the trimmed client value when it is
// well-formed, and an empty string otherwise.
func wellFormedClientRequestID(value string) string {
	trimmed := strings.Trim(value, clientRequestIDWhitespace)
	if len(trimmed) == 0 || len(trimmed) > MaxClientRequestIDLength {
		return ""
	}
	for index := 0; index < len(trimmed); index++ {
		if trimmed[index] < 0x21 || trimmed[index] > 0x7e {
			return ""
		}
	}
	return trimmed
}
