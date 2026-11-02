package localrunner

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestParseIdentitySource(t *testing.T) {
	cases := []struct {
		name    string
		source  string
		wantErr string
		kind    identitySourceKind
		value   string
	}{
		{name: "header", source: " $request.header.X-Tenant ", kind: identitySourceHeader, value: "X-Tenant"},
		{name: "query string", source: "$request.querystring.namespace", kind: identitySourceQueryString, value: "namespace"},
		{name: "empty header name", source: "$request.header.", wantErr: "has no header name"},
		{name: "empty query name", source: "$request.querystring.", wantErr: "has no query string name"},
		{name: "context variable", source: "$context.accountId", wantErr: "not supported locally"},
		{name: "stage variable", source: "$stageVariables.tenant", wantErr: "not supported locally"},
		{name: "empty", source: "  ", wantErr: "not supported locally"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := parseIdentitySource(test.source)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("parseIdentitySource(%q) error = %v, want %q", test.source, err, test.wantErr)
				}
				trimmed := strings.TrimSpace(test.source)
				if trimmed != "" && !strings.Contains(err.Error(), trimmed) {
					t.Fatalf("error does not name the identity source %q: %v", test.source, err)
				}
				if validateIdentitySource(test.source) == nil {
					t.Fatalf("validateIdentitySource(%q) must fail closed", test.source)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseIdentitySource(%q): %v", test.source, err)
			}
			if parsed.kind != test.kind || parsed.name != test.value || parsed.raw != strings.TrimSpace(test.source) {
				t.Fatalf("parseIdentitySource(%q) = %+v", test.source, parsed)
			}
			if err := validateIdentitySource(test.source); err != nil {
				t.Fatalf("validateIdentitySource(%q): %v", test.source, err)
			}
		})
	}
}

func TestIdentitySourceValue(t *testing.T) {
	header := http.Header{}
	header.Set("X-Tenant", " tenant-a ")
	header.Set("Authorization", "Bearer good")

	if got := (identitySource{kind: identitySourceHeader, name: "x-tenant"}).value(header, ""); got != "tenant-a" {
		t.Fatalf("header names are case-insensitive, got %q", got)
	}
	if got := (identitySource{kind: identitySourceHeader, name: "Missing"}).value(header, ""); got != "" {
		t.Fatalf("a missing header must resolve to empty, got %q", got)
	}
	if got := (identitySource{kind: identitySourceQueryString, name: "namespace"}).value(header, "namespace=ns-a&Namespace=ns-b"); got != "ns-a" {
		t.Fatalf("query string names are case-sensitive, got %q", got)
	}
	if got := (identitySource{kind: identitySourceQueryString, name: "Namespace"}).value(header, "namespace=ns-a&Namespace=ns-b"); got != "ns-b" {
		t.Fatalf("query string name did not resolve, got %q", got)
	}
	if got := (identitySource{kind: identitySourceQueryString, name: "namespace"}).value(header, "%zz"); got != "" {
		t.Fatalf("a malformed query string must resolve to empty, got %q", got)
	}
	if got := (identitySource{kind: identitySourceKind(99), name: "namespace"}).value(header, "namespace=ns-a"); got != "" {
		t.Fatalf("an unknown identity source kind must resolve to empty, got %q", got)
	}
}

func TestIdentitySourceValuesAndMissing(t *testing.T) {
	header := http.Header{}
	header.Set("X-Tenant", "tenant-a")
	sources := []string{"$request.header.X-Tenant", "$request.querystring.namespace"}

	values, err := identitySourceValues(header, "namespace=ns-a", sources)
	if err != nil {
		t.Fatalf("identity sources: %v", err)
	}
	if len(values) != 2 || values[0] != "tenant-a" || values[1] != "ns-a" {
		t.Fatalf("unexpected identity source values: %+v", values)
	}
	missing, err := missingIdentitySource(header, "namespace=ns-a", sources)
	if err != nil || missing != "" {
		t.Fatalf("missing = %q, err = %v; want none", missing, err)
	}
	missing, err = missingIdentitySource(header, "", sources)
	if err != nil || missing != "$request.querystring.namespace" {
		t.Fatalf("missing = %q, err = %v; want the query string source", missing, err)
	}
	if _, err := identitySourceValues(header, "", []string{"$context.accountId"}); err == nil {
		t.Fatal("an unsupported identity source must fail closed")
	}
	if _, err := missingIdentitySource(header, "", []string{"$stageVariables.tenant"}); err == nil {
		t.Fatal("an unsupported identity source must fail closed")
	}
}

func TestBuildAuthorizerEventCarriesAnIdentitySourceArray(t *testing.T) {
	request := InvokeRequest{
		API:    APISpec{Class: APIHTTPV2, LogicalID: "Api", Stage: "$default"},
		Route:  Route{Class: APIHTTPV2, Method: "GET", Path: "/hello", RouteKey: "GET /hello", Function: "Fn"},
		Method: "GET",
		Path:   "/hello",
		Header: http.Header{},
	}
	raw, err := BuildAuthorizerEvent(request)
	if err != nil {
		t.Fatalf("build authorizer event: %v", err)
	}
	var event map[string]any
	if err := json.Unmarshal(raw, &event); err != nil {
		t.Fatalf("authorizer event is not JSON: %v", err)
	}
	values, ok := event["identitySource"].([]any)
	if !ok {
		t.Fatalf("identitySource is not an array: %+v", event["identitySource"])
	}
	if len(values) != 0 {
		t.Fatalf("an authorizer without identity sources must carry an empty array, got %+v", values)
	}

	request.Route.AuthorizerIdentitySources = []string{"$context.accountId"}
	if _, err := BuildAuthorizerEvent(request); err == nil || !strings.Contains(err.Error(), "$context.accountId") {
		t.Fatalf("an unsupported identity source must fail closed with its name, got %v", err)
	}
}
