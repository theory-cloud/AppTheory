package localcloudfront

import (
	"context"
	"net/http"
	"testing"
)

// Round-1 rework tests for the LOCAL-W2-R3b delta.

// fetchOnlyStreamOrigin is a StreamOrigin that cannot stream this request, the
// shape a Function URL origin has under --rie.
type fetchOnlyStreamOrigin struct {
	fetches int
}

func (o *fetchOnlyStreamOrigin) Fetch(context.Context, OriginRequest) (OriginResponse, error) {
	o.fetches++
	return OriginResponse{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/plain"}},
		Body:       []byte("buffered"),
	}, nil
}

func (o *fetchOnlyStreamOrigin) FetchStream(context.Context, OriginRequest) (StreamResponse, error) {
	return StreamResponse{}, ErrStreamUnavailable
}

func TestGatewayFallsBackToFetchWhenTheOriginCannotStream(t *testing.T) {
	origin := &fetchOnlyStreamOrigin{}
	gateway := NewGateway(
		testDistribution(streamingBehavior(), nil, testOrigin("origin", "origin.example")),
		&Topology{}, map[string]Origin{"origin": origin}, nil, t.Logf)
	recorder := serveGateway(gateway, http.MethodGet, "http://viewer.example/x", "", nil)
	if recorder.Code != http.StatusOK || recorder.Body.String() != "buffered" {
		t.Fatalf("an origin that cannot stream must be served through Fetch: %d %q", recorder.Code, recorder.Body.String())
	}
	if origin.fetches != 1 {
		t.Fatalf("the buffered path must run once: %d", origin.fetches)
	}
}
