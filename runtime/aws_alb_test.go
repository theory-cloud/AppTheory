package apptheory

import (
	"encoding/base64"
	"testing"

	"github.com/aws/aws-lambda-go/events"
)

func TestALBStatusDescription(t *testing.T) {
	if got := albStatusDescription(200); got != "200 OK" {
		t.Fatalf("unexpected status description: %q", got)
	}
	if got := albStatusDescription(0); got != "0" {
		t.Fatalf("unexpected status description for unknown: %q", got)
	}
}

func TestALBTargetGroupResponseFromResponse(t *testing.T) {
	resp := Response{
		Status:   200,
		Headers:  map[string][]string{"x-test": {"a", "b"}},
		Cookies:  []string{"a=b", "c=d"},
		Body:     []byte{0x01, 0x02},
		IsBase64: true,
	}
	out := albTargetGroupResponseFromResponse(resp)
	if out.StatusCode != 200 || out.StatusDescription != "200 OK" {
		t.Fatalf("unexpected alb response: %#v", out)
	}
	if out.Headers["x-test"] != "a" || len(out.MultiValueHeaders["x-test"]) != 2 {
		t.Fatalf("unexpected headers: %#v", out)
	}
	if out.Headers["set-cookie"] != "a=b" || len(out.MultiValueHeaders["set-cookie"]) != 2 {
		t.Fatalf("unexpected cookies: %#v", out)
	}
	if out.Body != base64.StdEncoding.EncodeToString(resp.Body) || !out.IsBase64Encoded {
		t.Fatalf("unexpected body encoding: %#v", out)
	}
}

func TestRequestFromALB(t *testing.T) {
	req, err := requestFromALB(events.ALBTargetGroupRequest{
		HTTPMethod: "GET",
		Path:       "/",
		Headers:    map[string]string{"x-test": "v"},
		Body:       "ok",
	})
	if err != nil {
		t.Fatalf("requestFromALB returned error: %v", err)
	}
	if req.Method != "GET" || req.Path != "/" || string(req.Body) != "ok" {
		t.Fatalf("unexpected request: %#v", req)
	}
}
