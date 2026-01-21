package apptheory

import "testing"

func TestParseRouteSegment(t *testing.T) {
	seg, canon, ok := parseRouteSegment("foo")
	if !ok || seg.Kind != routeSegmentStatic || seg.Value != "foo" || canon != "foo" {
		t.Fatalf("unexpected static parse: %#v canon=%q ok=%v", seg, canon, ok)
	}

	seg, canon, ok = parseRouteSegment("{id}")
	if !ok || seg.Kind != routeSegmentParam || seg.Value != "id" || canon != "{id}" {
		t.Fatalf("unexpected param parse: %#v canon=%q ok=%v", seg, canon, ok)
	}

	seg, canon, ok = parseRouteSegment(":name")
	if !ok || seg.Kind != routeSegmentParam || seg.Value != "name" || canon != "{name}" {
		t.Fatalf("unexpected colon param parse: %#v canon=%q ok=%v", seg, canon, ok)
	}

	seg, canon, ok = parseRouteSegment("{proxy+}")
	if !ok || seg.Kind != routeSegmentProxy || seg.Value != "proxy" || canon != "{proxy+}" {
		t.Fatalf("unexpected proxy parse: %#v canon=%q ok=%v", seg, canon, ok)
	}

	if _, _, ok := parseRouteSegment(""); ok {
		t.Fatal("expected empty segment to be invalid")
	}
	if _, _, ok := parseRouteSegment("{ }"); ok {
		t.Fatal("expected blank param name to be invalid")
	}
	if _, _, ok := parseRouteSegment("{+}"); ok {
		t.Fatal("expected blank proxy name to be invalid")
	}
}

func TestParseRouteSegments_RejectsProxyNotLast(t *testing.T) {
	if _, _, ok := parseRouteSegments([]string{"{proxy+}", "x"}); ok {
		t.Fatal("expected proxy segment not last to be rejected")
	}
}

func TestRouterMatch_MostSpecificRouteWins(t *testing.T) {
	r := newRouter()
	r.add("GET", "/users/{id}", func(*Context) (*Response, error) { return Text(200, "param"), nil }, routeOptions{})
	r.add("GET", "/users/me", func(*Context) (*Response, error) { return Text(200, "static"), nil }, routeOptions{})

	match, allowed := r.match("GET", "/users/me")
	if match == nil {
		t.Fatal("expected route match")
	}
	if match.Route.Pattern != "/users/me" {
		t.Fatalf("expected /users/me route, got %q", match.Route.Pattern)
	}
	if len(allowed) != 2 {
		t.Fatalf("expected 2 allowed methods, got %v", allowed)
	}
}

func TestRouterMatch_ProxyParams(t *testing.T) {
	r := newRouter()
	r.add("GET", "/files/{path+}", func(*Context) (*Response, error) { return Text(200, "ok"), nil }, routeOptions{})

	match, _ := r.match("GET", "/files/a/b/c")
	if match == nil {
		t.Fatal("expected route match")
	}
	if match.Params["path"] != "a/b/c" {
		t.Fatalf("expected proxy param 'a/b/c', got %q", match.Params["path"])
	}
}

func TestFormatAllowHeader_DedupAndSort(t *testing.T) {
	got := formatAllowHeader([]string{"post", "GET", "  ", "get"})
	if got != "GET, POST" {
		t.Fatalf("unexpected allow header: %q", got)
	}
}
