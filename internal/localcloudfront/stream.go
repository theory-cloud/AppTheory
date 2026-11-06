package localcloudfront

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// DefaultOriginResponseTimeout is the default CloudFront origin response
// timeout. It applies "after receiving a packet of a response from the origin
// and before receiving the next packet".
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html
const DefaultOriginResponseTimeout = 30 * time.Second

// StreamOrigin is an origin that can return a response before its body is
// complete. The gateway forwards each chunk to the viewer as it arrives and
// caches the object only when the response completes.
type StreamOrigin interface {
	Origin
	// FetchStream returns the response status and headers as soon as the origin
	// produces them, with a body that yields each payload chunk.
	FetchStream(ctx context.Context, request OriginRequest) (StreamResponse, error)
}

// StreamResponse is an origin response whose body is still arriving.
type StreamResponse struct {
	StatusCode        int
	StatusDescription string
	Header            http.Header
	Body              io.ReadCloser
	// Chunked reports that the origin used HTTP/1.1 chunked transfer encoding.
	// CloudFront forwards such an object to the viewer as it receives it and
	// caches it in chunked format.
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html
	Chunked bool
}

// streamOutcome says what the gateway did with a streamed origin response.
type streamOutcome struct {
	// Handled reports that the response was written to the viewer.
	Handled bool
	// Buffered is the complete response when the gateway had to buffer it
	// (a custom error page, or a viewer function that replaces the body).
	Buffered OriginResponse
	// OriginResponseRan reports that the streaming path already ran the
	// origin-response Lambda@Edge association. A complete, non-chunked
	// response takes the unchanged buffered finish path instead.
	OriginResponseRan bool
}

// serveStreamingOrigin handles a response-streaming origin. It returns
// Handled=true when it wrote the response, or a buffered response the caller
// must continue with through the normal cache and finish path.
//
//nolint:gocognit,gocyclo // the streaming pipeline mirrors the documented CloudFront order
func (g *Gateway) serveStreamingOrigin(
	writer http.ResponseWriter,
	request *http.Request,
	behavior *Behavior,
	state *requestState,
	requestID, domainName string,
	originRequest OriginRequest,
	origin *DistributionOrigin,
	streamOrigin StreamOrigin,
	cacheable bool,
	cacheKey string,
	now time.Time,
) (streamOutcome, error) {
	fetched, err := streamOrigin.FetchStream(request.Context(), originRequest)
	if err != nil {
		return streamOutcome{}, err
	}
	if fetched.Body == nil {
		fetched.Body = io.NopCloser(bytes.NewReader(nil))
	}
	response := OriginResponse{
		StatusCode:        fetched.StatusCode,
		StatusDescription: fetched.StatusDescription,
		Header:            fetched.Header.Clone(),
	}
	if response.StatusCode == 0 {
		response.StatusCode = http.StatusBadGateway
	}
	if response.Header == nil {
		response.Header = http.Header{}
	}

	if !fetched.Chunked {
		// A complete response (a BUFFERED Function URL origin, or any origin
		// that returns the whole body without chunked encoding) takes the
		// unchanged buffered finish path: the origin-response and
		// viewer-response functions, custom error pages, error caching, the
		// response headers policy and the cache TTLs all run exactly as they do
		// for a buffered origin.
		buffered, readErr := bufferStream(fetched.Body, false)
		if readErr != nil {
			return streamOutcome{}, readErr
		}
		buffered.StatusCode = response.StatusCode
		buffered.StatusDescription = response.StatusDescription
		buffered.Header = response.Header
		return streamOutcome{Buffered: buffered}, nil
	}

	// Lambda@Edge origin-response runs once CloudFront has the status and
	// headers. It does not receive the origin body.
	if association := behavior.EdgeLambdas[edgeOriginResponse]; association != nil {
		event := g.edgeOriginEvent(association, originRequest, origin, requestID, domainName, &response)
		outcome, edgeErr := g.invokeEdge(request.Context(), association, event)
		if edgeErr != nil {
			_ = fetched.Body.Close() //nolint:errcheck // the origin is done with
			g.edgeFailure(writer, request, behavior, state.Header, "origin-response", edgeErr)
			return streamOutcome{Handled: true}, nil
		}
		if outcome.Response != nil {
			replaced, responseErr := g.edgeGeneratedResponse(association, outcome.Response, nil)
			if responseErr != nil {
				_ = fetched.Body.Close() //nolint:errcheck // the origin is done with
				g.edgeFailure(writer, request, behavior, state.Header, "origin-response", responseErr)
				return streamOutcome{Handled: true}, nil
			}
			if replaced.Body != nil {
				// A body replacement is complete; the origin body is not part of
				// the response, so the stream is closed rather than buffered.
				_ = fetched.Body.Close() //nolint:errcheck // the replacement owns the response
				return streamOutcome{Buffered: replaced, OriginResponseRan: true}, nil
			}
			response = replaced
		}
	}

	// A custom error response needs the complete origin object; buffer and let
	// the normal path apply the page.
	if _, custom := g.Distribution.CustomErrorResponseFor(response.StatusCode); custom {
		buffered, readErr := bufferStream(fetched.Body, fetched.Chunked)
		if readErr != nil {
			return streamOutcome{}, readErr
		}
		buffered.StatusCode = response.StatusCode
		buffered.Header = response.Header
		return streamOutcome{Buffered: buffered, OriginResponseRan: true}, nil
	}

	// The viewer-response function runs on the status and headers; the body is
	// not available before the stream ends. A function that replaces the body
	// forces the gateway to buffer the origin object first.
	if behavior.ViewerResponseFunction != "" {
		function, ok := g.function(behavior.ViewerResponseFunction)
		if !ok {
			_ = fetched.Body.Close() //nolint:errcheck // the origin is done with
			g.respondError(writer, request, behavior, state.Header, http.StatusServiceUnavailable,
				fmt.Sprintf("CloudFront Function %q is referenced but cannot run locally", behavior.ViewerResponseFunction))
			return streamOutcome{Handled: true}, nil
		}
		event := buildViewerResponseEvent(state, g.Distribution, requestID, domainName, eventResponseFromOrigin(response))
		result, executeErr := g.Executor.Execute(request.Context(), function, event)
		if executeErr != nil {
			_ = fetched.Body.Close() //nolint:errcheck // the origin is done with
			g.functionFailure(writer, request, behavior, state.Header, "viewer-response", function, executeErr)
			return streamOutcome{Handled: true}, nil
		}
		updated, updateErr := responseFromEventResponse(result.Response, nil)
		if updateErr != nil {
			_ = fetched.Body.Close() //nolint:errcheck // the origin is done with
			g.functionFailure(writer, request, behavior, state.Header, "viewer-response", function, updateErr)
			return streamOutcome{Handled: true}, nil
		}
		if updated.Body != nil {
			_ = fetched.Body.Close() //nolint:errcheck // the replacement owns the response
			return streamOutcome{Buffered: updated, OriginResponseRan: true}, nil
		}
		response = updated
	}

	// Lambda@Edge viewer-response runs before the response is returned to the
	// viewer. Its event carries the status and headers, not the body, so for a
	// streamed response it runs at the prelude, once both are known.
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html
	if association := behavior.EdgeLambdas[edgeViewerResponse]; association != nil && response.StatusCode < 400 {
		event := g.edgeEvent(association, state, requestID, domainName, &response)
		outcome, edgeErr := g.invokeEdge(request.Context(), association, event)
		if edgeErr != nil {
			_ = fetched.Body.Close() //nolint:errcheck // the origin is done with
			g.edgeFailure(writer, request, behavior, state.Header, "viewer-response", edgeErr)
			return streamOutcome{Handled: true}, nil
		}
		if outcome.Response != nil {
			updated, responseErr := g.edgeGeneratedResponse(association, outcome.Response, nil)
			if responseErr != nil {
				_ = fetched.Body.Close() //nolint:errcheck // the origin is done with
				g.edgeFailure(writer, request, behavior, state.Header, "viewer-response", responseErr)
				return streamOutcome{Handled: true}, nil
			}
			if updated.StatusCode != response.StatusCode {
				_ = fetched.Body.Close() //nolint:errcheck // the origin is done with
				g.edgeFailure(writer, request, behavior, state.Header, "viewer-response", &EdgeValidationError{
					Function: association.Version,
					Reason: fmt.Sprintf("a viewer-response function cannot modify the HTTP status code (%d to %d)",
						response.StatusCode, updated.StatusCode),
				})
				return streamOutcome{Handled: true}, nil
			}
			response.Header = updated.Header
			if updated.StatusDescription != "" {
				response.StatusDescription = updated.StatusDescription
			}
		}
	}

	applyResponseHeadersPolicy(behavior.ResponseHeadersPolicy, request.Method, state.Header, &response)
	response.Header.Del("Content-Length")
	response.Header.Del("Transfer-Encoding")
	response.Header.Del("Trailer")
	setCacheHeaders(&response, cacheMissHeader, 0)

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
	flusher, canFlush := writer.(http.Flusher)
	if canFlush && flusher != nil {
		flusher.Flush()
	}
	g.log(request, behavior, response.StatusCode, "streamed")
	if request.Method == http.MethodHead {
		_ = fetched.Body.Close() //nolint:errcheck // no body for HEAD
		return streamOutcome{Handled: true}, nil
	}

	// CloudFront returns a chunked object to the viewer as it arrives and caches
	// it in full only after the stream completes.
	// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html
	collect := cacheable && request.Header.Get("Range") == ""
	var cached bytes.Buffer
	timeout := originResponseTimeout(behavior, origin)
	buffer := make([]byte, 32*1024)
	for {
		n, readErr := readWithOriginTimeout(fetched.Body, buffer, timeout)
		if n > 0 {
			if collect {
				cached.Write(buffer[:n])
			}
			if _, writeErr := writer.Write(buffer[:n]); writeErr != nil {
				_ = fetched.Body.Close() //nolint:errcheck // the viewer is gone
				return streamOutcome{Handled: true}, nil
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			// An incomplete chunked response is not cached; the viewer keeps
			// what it received.
			g.logf("origin %s stream ended early: %v", originRequest.OriginID, readErr)
			return streamOutcome{Handled: true}, nil
		}
	}
	if collect {
		stored := OriginResponse{StatusCode: response.StatusCode, Header: response.Header.Clone(), Body: cached.Bytes()}
		ttl, control := g.responseTTL(stored, behavior, errorCachingDecision{})
		if ttl > 0 {
			g.Cache.Set(cacheKey, CacheEntry{
				Response:             cloneOriginResponse(stored),
				Path:                 state.URI,
				Query:                CacheKeyQuery(state.RawQuery, policyCache(behavior)),
				StoredAt:             now,
				ExpiresAt:            now.Add(ttl),
				StaleWhileRevalidate: control.StaleWhileRevalidate,
				StaleIfError:         control.StaleIfError,
			})
		}
	}
	return streamOutcome{Handled: true}, nil
}

// originResponseTimeout is the between-packet timeout the streaming branch
// applies. The behavior's explicit value wins; otherwise the origin's
// CustomOriginConfig.OriginReadTimeout is used, and its default is 30 seconds:
// the origin response timeout is "the amount of time, in seconds, that
// CloudFront waits after receiving a packet of a response from the origin and
// before receiving the next packet".
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html
func originResponseTimeout(behavior *Behavior, origin *DistributionOrigin) time.Duration {
	if behavior != nil && behavior.OriginResponseTimeout > 0 {
		return behavior.OriginResponseTimeout
	}
	if origin != nil && origin.Custom != nil && origin.Custom.ReadTimeout != nil && *origin.Custom.ReadTimeout > 0 {
		return time.Duration(*origin.Custom.ReadTimeout) * time.Second
	}
	return DefaultOriginResponseTimeout
}

// bufferStream reads the rest of a streamed origin response into memory, for
// the cases that cannot be streamed (a body replacement or a custom error
// page).
func bufferStream(body io.ReadCloser, chunked bool) (OriginResponse, error) {
	defer func() { _ = body.Close() }() //nolint:errcheck // fully read before close
	raw, err := io.ReadAll(body)
	if err != nil {
		return OriginResponse{}, fmt.Errorf("buffer the streamed origin response: %w", err)
	}
	response := OriginResponse{Body: raw}
	if chunked && len(raw) == 0 {
		response.Body = nil
	}
	return response, nil
}

// readWithOriginTimeout reads one packet, or reports the origin response
// timeout when the next packet does not arrive in time. The timeout applies
// between packets, not to the whole response.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html
func readWithOriginTimeout(body io.ReadCloser, buffer []byte, timeout time.Duration) (int, error) {
	type result struct {
		n   int
		err error
	}
	done := make(chan result, 1)
	go func() {
		n, err := body.Read(buffer)
		done <- result{n: n, err: err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case res := <-done:
		return res.n, res.err
	case <-timer.C:
		_ = body.Close() //nolint:errcheck // closing unblocks the read
		res := <-done
		if res.err != nil {
			return res.n, fmt.Errorf("origin response timeout after %s: %w", timeout, res.err)
		}
		return res.n, fmt.Errorf("origin response timeout after %s", timeout)
	}
}

// ErrStreamUnavailable marks an origin that cannot stream a response.
var ErrStreamUnavailable = errors.New("origin cannot stream a response")
