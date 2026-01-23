package apptheory

import "testing"

func TestCacheControlISR_NormalizesNegativeValues(t *testing.T) {
	got := CacheControlISR(-1, -2)
	if got != "public, max-age=0, s-maxage=0" {
		t.Fatalf("unexpected CacheControlISR: %q", got)
	}

	got = CacheControlISR(60, 30)
	if got != "public, max-age=0, s-maxage=60, stale-while-revalidate=30" {
		t.Fatalf("unexpected CacheControlISR: %q", got)
	}
}

func TestETag_IsQuotedSHA256Hex(t *testing.T) {
	etag := ETag([]byte("hello"))
	if len(etag) != 66 {
		t.Fatalf("unexpected etag length: %d", len(etag))
	}
	if etag[0] != '"' || etag[len(etag)-1] != '"' {
		t.Fatalf("expected quoted etag, got %q", etag)
	}
}

func TestMatchesIfNoneMatch(t *testing.T) {
	etag := `"abc"`
	if MatchesIfNoneMatch(nil, etag) {
		t.Fatal("expected empty headers to not match")
	}
	if !MatchesIfNoneMatch(map[string][]string{"If-None-Match": {etag}}, etag) {
		t.Fatal("expected strong etag match")
	}
	if !MatchesIfNoneMatch(map[string][]string{"If-None-Match": {`W/` + etag}}, etag) {
		t.Fatal("expected weak etag match")
	}
	if !MatchesIfNoneMatch(map[string][]string{"If-None-Match": {`"nope", *`}}, etag) {
		t.Fatal("expected wildcard match")
	}
	if MatchesIfNoneMatch(map[string][]string{"If-None-Match": {`"nope"`}}, etag) {
		t.Fatal("expected non-match")
	}
}

func TestVary_NormalizesAndSorts(t *testing.T) {
	got := Vary([]string{"Origin, Accept-Encoding"}, "accept-encoding", "X-Test", "origin")
	want := []string{"accept-encoding", "origin", "x-test"}
	if len(got) != len(want) {
		t.Fatalf("unexpected vary length: got=%v want=%v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unexpected vary: got=%v want=%v", got, want)
		}
	}
}

func TestSplitCommaValues(t *testing.T) {
	got := splitCommaValues(" a, ,b , c ")
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("unexpected split: got=%v want=%v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unexpected split: got=%v want=%v", got, want)
		}
	}
}
