package localcloudfront

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// requestState is the mutable view of the viewer request between the
// viewer-request function and the origin.
type requestState struct {
	Method        string
	URI           string
	RawQuery      string
	Host          string
	Header        http.Header
	Body          []byte
	ViewerIP      string
	ViewerAddress string
	Proto         string
}

func newRequestState(request *http.Request, body []byte) *requestState {
	path := request.URL.EscapedPath()
	if path == "" {
		path = "/"
	}
	viewerIP, viewerAddress := viewerAddress(request.RemoteAddr)
	return &requestState{
		Method:        request.Method,
		URI:           path,
		RawQuery:      request.URL.RawQuery,
		Host:          request.Host,
		Header:        request.Header.Clone(),
		Body:          body,
		ViewerIP:      viewerIP,
		ViewerAddress: viewerAddress,
		Proto:         request.Proto,
	}
}

func viewerAddress(remoteAddr string) (string, string) {
	if remoteAddr == "" {
		return "127.0.0.1", "127.0.0.1"
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr, remoteAddr
	}
	return host, remoteAddr
}

// buildEventRequest turns the state into the documented version 1.0 request
// object. Cookie headers are split into the cookies object.
func buildEventRequest(state *requestState, context EventContext) *Event {
	headers := map[string]HeaderValue{}
	for name, values := range state.Header {
		lower := strings.ToLower(name)
		if lower == headerCookie {
			continue
		}
		headers[lower] = headerValue(values)
	}
	if state.Host != "" {
		headers["host"] = HeaderValue{Value: state.Host}
	}
	return &Event{
		Version: "1.0",
		Context: context,
		Viewer:  Viewer{IP: state.ViewerIP},
		Request: &EventRequest{
			Method:      state.Method,
			URI:         state.URI,
			Querystring: queryFromRaw(state.RawQuery),
			Headers:     headers,
			Cookies:     cookiesFromHeader(state.Header),
		},
	}
}

func buildViewerRequestEvent(state *requestState, distribution *Distribution, requestID, domainName string) *Event {
	return buildEventRequest(state, EventContext{
		DistributionDomainName: domainName,
		DistributionID:         localDistributionID(distribution),
		EventType:              "viewer-request",
		RequestID:              requestID,
	})
}

func buildViewerResponseEvent(
	state *requestState,
	distribution *Distribution,
	requestID, domainName string,
	response *EventResponse,
) *Event {
	event := buildEventRequest(state, EventContext{
		DistributionDomainName: domainName,
		DistributionID:         localDistributionID(distribution),
		EventType:              "viewer-response",
		RequestID:              requestID,
	})
	event.Response = response
	return event
}

// applyFunctionRequest replaces the state with the request a viewer-request
// function returned. Headers are lower-cased by the executor; Host and Cookie
// move back to their transport forms.
func applyFunctionRequest(state *requestState, returned *EventRequest) {
	state.Method = returned.Method
	state.URI = returned.URI
	state.RawQuery = serializeQuery(returned.Querystring)
	state.Header = http.Header{}
	state.Host = ""
	for name, value := range returned.Headers {
		lower := strings.ToLower(name)
		if lower == headerHost {
			state.Host = value.Value
			continue
		}
		state.Header[textprotoCanonical(lower)] = valuesOf(value)
	}
	cookieValues := cookieHeaderValues(returned.Cookies)
	if len(cookieValues) > 0 {
		state.Header["Cookie"] = cookieValues
	}
}

func textprotoCanonical(name string) string {
	// http.Header canonicalizes with textproto.CanonicalMIMEHeaderKey; this
	// helper keeps the dependency local and visible.
	return http.CanonicalHeaderKey(name)
}

func valuesOf(value HeaderValue) []string {
	if len(value.MultiValue) > 0 {
		out := make([]string, 0, len(value.MultiValue))
		for _, entry := range value.MultiValue {
			out = append(out, entry.Value)
		}
		return out
	}
	return []string{value.Value}
}

func headerValue(values []string) HeaderValue {
	if len(values) == 0 {
		return HeaderValue{}
	}
	value := HeaderValue{Value: values[0]}
	if len(values) > 1 {
		value.MultiValue = make([]HeaderValue, 0, len(values))
		for _, entry := range values {
			value.MultiValue = append(value.MultiValue, HeaderValue{Value: entry})
		}
	}
	return value
}

// queryFromRaw builds the event querystring object. CloudFront hands the
// function decoded values and a multiValue array when a name repeats.
func queryFromRaw(raw string) QueryString {
	if raw == "" {
		return QueryString{Values: map[string]HeaderValue{}}
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return QueryString{Raw: raw}
	}
	result := make(map[string]HeaderValue, len(values))
	for name, entries := range values {
		value := HeaderValue{Value: ""}
		if len(entries) > 0 {
			value.Value = entries[0]
		}
		if len(entries) > 1 {
			value.MultiValue = make([]HeaderValue, 0, len(entries))
			for _, entry := range entries {
				value.MultiValue = append(value.MultiValue, HeaderValue{Value: entry})
			}
		}
		result[name] = value
	}
	return QueryString{Values: result}
}

// serializeQuery turns a returned querystring into a raw query. A string return
// is kept verbatim; the object form is sorted because a JSON object has no
// order contract.
func serializeQuery(query QueryString) string {
	if query.Raw != "" {
		return query.Raw
	}
	if len(query.Values) == 0 {
		return ""
	}
	values := url.Values{}
	for name, value := range query.Values {
		if len(value.MultiValue) > 0 {
			for _, entry := range value.MultiValue {
				values.Add(name, entry.Value)
			}
			continue
		}
		values.Add(name, value.Value)
	}
	return values.Encode()
}

// cookiesFromHeader parses every Cookie header into the event cookies object.
func cookiesFromHeader(header http.Header) map[string]HeaderValue {
	pairs := parseCookiePairs(header.Values("Cookie"))
	result := map[string]HeaderValue{}
	for _, pair := range pairs {
		current, ok := result[pair.Name]
		if !ok {
			result[pair.Name] = HeaderValue{Value: pair.Value}
			continue
		}
		if len(current.MultiValue) == 0 {
			current.MultiValue = []HeaderValue{{Value: current.Value}}
		}
		current.MultiValue = append(current.MultiValue, HeaderValue{Value: pair.Value})
		result[pair.Name] = current
	}
	return result
}

func cookieHeaderValues(cookies map[string]HeaderValue) []string {
	if len(cookies) == 0 {
		return nil
	}
	names := make([]string, 0, len(cookies))
	for name := range cookies {
		names = append(names, name)
	}
	sort.Strings(names)
	values := make([]string, 0, len(cookies))
	for _, name := range names {
		value := cookies[name]
		if len(value.MultiValue) > 0 {
			for _, entry := range value.MultiValue {
				values = append(values, name+"="+entry.Value)
			}
			continue
		}
		values = append(values, name+"="+value.Value)
	}
	return values
}

type cookiePair struct {
	Name  string
	Value string
}

func parseCookiePairs(values []string) []cookiePair {
	var pairs []cookiePair
	for _, header := range values {
		for _, part := range strings.Split(header, ";") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			name, value, found := strings.Cut(part, "=")
			if !found || name == "" {
				continue
			}
			pairs = append(pairs, cookiePair{Name: strings.TrimSpace(name), Value: value})
		}
	}
	return pairs
}

func decodeResponseBody(body *ResponseBody, origin []byte) ([]byte, bool, error) {
	if body == nil {
		return origin, false, nil
	}
	switch strings.ToLower(body.Encoding) {
	case "", "text":
		return []byte(body.Data), true, nil
	case "base64":
		decoded, err := base64.StdEncoding.DecodeString(body.Data)
		if err != nil {
			decoded, err = base64.RawStdEncoding.DecodeString(body.Data)
		}
		if err != nil {
			return nil, true, fmt.Errorf("response body is not valid base64: %w", err)
		}
		return decoded, true, nil
	default:
		return nil, true, fmt.Errorf("unsupported response body encoding %q", body.Encoding)
	}
}

func localDistributionID(distribution *Distribution) string {
	if distribution == nil {
		return "LOCAL"
	}
	sum := sha256.Sum256([]byte(distribution.LogicalID))
	return "LOCAL" + strings.ToUpper(hex.EncodeToString(sum[:6]))
}
