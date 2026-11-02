package localcloudfront

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"strings"
	"time"
)

// maxGatewayBody is the request body bound. API Gateway and CloudFront both
// bound viewer bodies; a larger body is refused instead of buffered.
const maxGatewayBody = 10 << 20

// Gateway serves one CloudFront distribution's edge path locally. It selects
// the cache behavior, runs the viewer-request and viewer-response functions,
// applies the origin request and response headers policies, and hands origin
// requests to the Origin implementations.
type Gateway struct {
	Distribution *Distribution
	Topology     *Topology
	Origins      map[string]Origin
	Executor     *Executor
	Now          func() time.Time
	RequestID    func() string
	Logf         func(format string, args ...any)
	MaxBody      int64
}

// NewGateway builds a gateway. A nil executor uses the default Node executor;
// a nil origin map makes every origin an OriginNotWiredError until A5b.
func NewGateway(
	distribution *Distribution,
	topology *Topology,
	origins map[string]Origin,
	executor *Executor,
	logf func(string, ...any),
) *Gateway {
	if executor == nil {
		executor = NewExecutor()
	}
	if origins == nil {
		origins = map[string]Origin{}
	}
	return &Gateway{
		Distribution: distribution,
		Topology:     topology,
		Origins:      origins,
		Executor:     executor,
		Now:          time.Now,
		RequestID:    newGatewayRequestID,
		Logf:         logf,
		MaxBody:      maxGatewayBody,
	}
}

// ServeHTTP runs one viewer request through the distribution's edge path.
//
//nolint:gocognit,gocyclo // the phase order is documented and pinned by the docs-order test
func (g *Gateway) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if g.Distribution == nil {
		writeErrorResponse(writer, request, http.StatusInternalServerError, "the gateway has no distribution")
		return
	}
	if !g.Distribution.Servable() {
		writeErrorResponse(writer, request, http.StatusServiceUnavailable,
			"distribution "+g.Distribution.LogicalID+" is refused: "+strings.Join(g.Distribution.Refusals, "; "))
		return
	}
	requestID := g.newRequestID()
	body, err := readGatewayBody(request, g.MaxBody)
	if err != nil {
		writeErrorResponse(writer, request, http.StatusRequestEntityTooLarge, err.Error())
		return
	}
	state := newRequestState(request, body)
	originalURI := state.URI
	behavior := g.Distribution.BehaviorForURI(originalURI)
	if behavior == nil {
		g.respondError(writer, request, nil, state.Header, http.StatusServiceUnavailable,
			"the distribution has no cache behavior for "+originalURI)
		return
	}
	domainName := request.Host
	if domainName == "" {
		domainName = strings.ToLower(g.Distribution.LogicalID) + ".cloudfront.local"
	}

	// AWS documents the viewer-request trigger and the 403 (Invalid method)
	// response separately, but not their relative order. The local gateway runs
	// the function first by choice, so a function can answer a request whose
	// method the behavior does not allow; see docs/examples/local-runner.md.
	if behavior.ViewerRequestFunction != "" {
		function, ok := g.function(behavior.ViewerRequestFunction)
		if !ok {
			g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable,
				fmt.Sprintf("CloudFront Function %q is referenced but cannot run locally", behavior.ViewerRequestFunction))
			return
		}
		event := buildViewerRequestEvent(state, g.Distribution, requestID, domainName)
		result, executeErr := g.Executor.Execute(request.Context(), function, event)
		if executeErr != nil {
			g.functionFailure(writer, request, behavior, state.Header, "viewer-request", function, executeErr)
			return
		}
		if result.Kind == ResultResponse {
			response, responseErr := responseFromEventResponse(result.Response, nil)
			if responseErr != nil {
				g.functionFailure(writer, request, behavior, state.Header, "viewer-request", function, responseErr)
				return
			}
			applyResponseHeadersPolicy(behavior.ResponseHeadersPolicy, request.Method, state.Header, &response)
			g.log(request, behavior, response.StatusCode, "viewer-request short-circuit")
			g.write(writer, request, response)
			return
		}
		applyFunctionRequest(state, result.Request)
	}

	if !methodAllowed(behavior.AllowedMethods, state.Method) {
		g.respondError(writer, request, behavior, state.Header, http.StatusForbidden,
			fmt.Sprintf("method %s is not allowed by cache behavior %q (AllowedMethods: %s)",
				state.Method, behavior.PathPattern, strings.Join(behavior.AllowedMethods, ", ")))
		return
	}
	if state.URI == "/" && g.Distribution.DefaultRootObject != "" {
		state.URI = "/" + g.Distribution.DefaultRootObject
	}

	targetID := behavior.TargetOriginID
	originImplementation, origin, _ := g.originForTarget(targetID)
	if originImplementation == nil {
		g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable,
			(&OriginNotWiredError{OriginID: targetID}).Error())
		return
	}
	originRequest := g.originRequest(state, behavior, origin, targetID, requestID)
	originResponse, originErr := originImplementation.Fetch(request.Context(), originRequest)
	if originErr != nil {
		var notWired *OriginNotWiredError
		if errors.As(originErr, &notWired) || errors.Is(originErr, ErrOriginNotWired) {
			g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable, originErr.Error())
			return
		}
		g.respondError(writer, request, behavior, state.Header, http.StatusBadGateway,
			fmt.Sprintf("origin %q failed: %v", targetID, originErr))
		return
	}

	final := originResponse
	if behavior.ViewerResponseFunction != "" {
		function, ok := g.function(behavior.ViewerResponseFunction)
		if !ok {
			g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable,
				fmt.Sprintf("CloudFront Function %q is referenced but cannot run locally", behavior.ViewerResponseFunction))
			return
		}
		responseEvent := eventResponseFromOrigin(originResponse)
		event := buildViewerResponseEvent(state, g.Distribution, requestID, domainName, responseEvent)
		result, executeErr := g.Executor.Execute(request.Context(), function, event)
		if executeErr != nil {
			g.functionFailure(writer, request, behavior, state.Header, "viewer-response", function, executeErr)
			return
		}
		final, err = responseFromEventResponse(result.Response, originResponse.Body)
		if err != nil {
			g.functionFailure(writer, request, behavior, state.Header, "viewer-response", function, err)
			return
		}
	}
	if final.Header == nil {
		final.Header = http.Header{}
	} else {
		final.Header = final.Header.Clone()
	}
	applyResponseHeadersPolicy(behavior.ResponseHeadersPolicy, request.Method, state.Header, &final)
	g.log(request, behavior, final.StatusCode, "")
	g.write(writer, request, final)
}

func (g *Gateway) function(logicalID string) (*Function, bool) {
	if g.Topology == nil {
		return nil, false
	}
	return g.Topology.Function(logicalID)
}

func (g *Gateway) logf(format string, args ...any) {
	if g.Logf != nil {
		g.Logf(format, args...)
	}
}

func (g *Gateway) functionFailure(
	writer http.ResponseWriter,
	request *http.Request,
	behavior *Behavior,
	requestHeader http.Header,
	eventType string,
	function *Function,
	err error,
) {
	var functionErr *FunctionError
	if errors.As(err, &functionErr) {
		for _, line := range functionErr.Logs {
			g.logf("cloudfront function %s: %s", function.LogicalID, line)
		}
	}
	detail := fmt.Sprintf("CloudFront Function %q (%s) failed: %v. The request was not passed through.",
		function.LogicalID, eventType, err)
	g.respondError(writer, request, behavior, requestHeader, http.StatusServiceUnavailable, detail)
}

func (g *Gateway) respondError(
	writer http.ResponseWriter,
	request *http.Request,
	behavior *Behavior,
	requestHeader http.Header,
	status int,
	detail string,
) {
	response := errorResponse(status, detail)
	if behavior != nil {
		applyResponseHeadersPolicy(behavior.ResponseHeadersPolicy, request.Method, requestHeader, &response)
	}
	g.log(request, behavior, status, detail)
	g.write(writer, request, response)
}

func (g *Gateway) log(request *http.Request, _ *Behavior, status int, note string) {
	if g.Logf == nil {
		return
	}
	suffix := ""
	if note != "" {
		suffix = " (" + note + ")"
	}
	g.logf("cloudfront %s %s %s -> %d%s", g.Distribution.LogicalID, request.Method, request.URL.EscapedPath(), status, suffix)
}

func (g *Gateway) write(writer http.ResponseWriter, request *http.Request, response OriginResponse) {
	if response.StatusCode == 0 {
		response.StatusCode = http.StatusBadGateway
	}
	header := writer.Header()
	for name, values := range response.Header {
		if isHopByHopHeader(name) {
			continue
		}
		for _, value := range values {
			header.Add(name, value)
		}
	}
	writer.WriteHeader(response.StatusCode)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(response.Body) //nolint:errcheck // response already committed
}

func (g *Gateway) newRequestID() string {
	if g.RequestID != nil {
		return g.RequestID()
	}
	return newGatewayRequestID()
}

func newGatewayRequestID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return fmt.Sprintf("local-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(bytes[:])
}

func readGatewayBody(request *http.Request, limit int64) ([]byte, error) {
	if limit <= 0 {
		limit = maxGatewayBody
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("request body exceeds the %d byte local limit", limit)
	}
	return body, nil
}

func methodAllowed(methods []string, method string) bool {
	if len(methods) == 0 {
		return method == http.MethodGet || method == http.MethodHead
	}
	for _, allowed := range methods {
		if allowed == method {
			return true
		}
		if method == http.MethodHead && allowed == http.MethodGet {
			return true
		}
	}
	return false
}

func eventResponseFromOrigin(response OriginResponse) *EventResponse {
	headers, cookies := splitResponseHeaders(response.Header)
	return &EventResponse{
		StatusCode:        response.StatusCode,
		StatusDescription: response.StatusDescription,
		Headers:           headers,
		Cookies:           cookies,
	}
}

func splitResponseHeaders(header http.Header) (map[string]HeaderValue, map[string]CookieValue) {
	headers := map[string]HeaderValue{}
	cookies := map[string]CookieValue{}
	for name, values := range header {
		lower := strings.ToLower(name)
		if lower == "set-cookie" {
			for _, value := range values {
				name, cookieValue, attributes, ok := parseSetCookie(value)
				if !ok {
					continue
				}
				addResponseCookie(cookies, name, cookieValue, attributes)
			}
			continue
		}
		headers[lower] = headerValue(values)
	}
	return headers, cookies
}

func parseSetCookie(value string) (name, cookieValue, attributes string, ok bool) {
	parts := strings.SplitN(value, ";", 2)
	name, cookieValue, found := strings.Cut(parts[0], "=")
	if !found || strings.TrimSpace(name) == "" {
		return "", "", "", false
	}
	if len(parts) == 2 {
		attributes = strings.TrimSpace(parts[1])
	}
	return strings.TrimSpace(name), cookieValue, attributes, true
}

func addResponseCookie(cookies map[string]CookieValue, name, value, attributes string) {
	entry := CookieValue{Value: value, Attributes: attributes}
	current, exists := cookies[name]
	if !exists {
		cookies[name] = entry
		return
	}
	if len(current.MultiValue) == 0 {
		current.MultiValue = []CookieValue{{Value: current.Value, Attributes: current.Attributes}}
	}
	current.MultiValue = append(current.MultiValue, entry)
	cookies[name] = current
}

func responseFromEventResponse(response *EventResponse, originBody []byte) (OriginResponse, error) {
	if response == nil {
		return OriginResponse{}, errors.New("viewer-response returned no response object")
	}
	if response.StatusCode < 100 || response.StatusCode > 599 {
		return OriginResponse{}, fmt.Errorf("viewer-response statusCode %d is outside 100..599", response.StatusCode)
	}
	header := http.Header{}
	for name, value := range response.Headers {
		for _, entry := range valuesOf(value) {
			header.Add(name, entry)
		}
	}
	for name, cookie := range response.Cookies {
		entries := []CookieValue{cookie}
		if len(cookie.MultiValue) > 0 {
			entries = cookie.MultiValue
		}
		for _, entry := range entries {
			setCookie := name + "=" + entry.Value
			if entry.Attributes != "" {
				setCookie += "; " + entry.Attributes
			}
			header.Add("Set-Cookie", setCookie)
		}
	}
	body, _, err := decodeResponseBody(response.Body, originBody)
	if err != nil {
		return OriginResponse{}, err
	}
	return OriginResponse{
		StatusCode:        response.StatusCode,
		StatusDescription: response.StatusDescription,
		Header:            header,
		Body:              body,
	}, nil
}

func errorResponse(status int, detail string) OriginResponse {
	title := fmt.Sprintf("%d %s", status, http.StatusText(status))
	body := fmt.Sprintf("<!DOCTYPE html><html><head><title>%s</title></head><body><h1>%s</h1><p>%s</p></body></html>",
		html.EscapeString(title), html.EscapeString(title), html.EscapeString(detail))
	return OriginResponse{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
		Body:       []byte(body),
	}
}

func writeErrorResponse(writer http.ResponseWriter, request *http.Request, status int, detail string) {
	response := errorResponse(status, detail)
	header := writer.Header()
	for name, values := range response.Header {
		for _, value := range values {
			header.Add(name, value)
		}
	}
	writer.WriteHeader(status)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(response.Body) //nolint:errcheck // response already committed
}
