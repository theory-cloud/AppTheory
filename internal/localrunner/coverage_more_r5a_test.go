package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

func TestHTTPAuthorizerEventV1CarriesTheRequestShape(t *testing.T) {
	event, err := buildHTTPAuthorizerEventV1(InvokeRequest{
		API:      APISpec{Class: APIHTTPV2, LogicalID: "Api", Stage: "$default"},
		Route:    Route{Method: "GET", Path: "/hello/{id}"},
		Params:   map[string]string{"id": "7"},
		Method:   "GET",
		Path:     "/hello/7",
		RawQuery: "scope=read",
		Header:   http.Header{"Authorization": []string{"Bearer token"}},
		Body:     []byte(`{"hello":"world"}`),
	}, []string{"Bearer token"})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(event, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded["type"] != "REQUEST" || decoded["resource"] != "/hello/{id}" || decoded["httpMethod"] != "GET" {
		t.Fatalf("event = %+v", decoded)
	}
	pathParameters, ok := decoded["pathParameters"].(map[string]any)
	if !ok || pathParameters["id"] != "7" {
		t.Fatalf("pathParameters = %+v", decoded["pathParameters"])
	}
	if decoded["body"] != `{"hello":"world"}` {
		t.Fatalf("body = %v", decoded["body"])
	}
	identitySource, ok := decoded["identitySource"].([]any)
	if !ok || len(identitySource) == 0 || identitySource[0] != "Bearer token" {
		t.Fatalf("identitySource = %+v", decoded["identitySource"])
	}
}

func TestAuthorizerContextValuesHandlesJSONNumbers(t *testing.T) {
	values, err := authorizerContextValues(map[string]any{"number": json.Number("42"), "nothing": nil})
	if err != nil {
		t.Fatalf("context: %v", err)
	}
	if values["number"] != "42" || values["nothing"] != "" {
		t.Fatalf("values = %+v", values)
	}
}

func TestMethodARNUsesTheStageAndPath(t *testing.T) {
	arn := methodARN(APISpec{LogicalID: "RestApi", Stage: "prod"}, "get", "/items/7")
	if !strings.Contains(arn, "/prod/GET/items/7") {
		t.Fatalf("method ARN = %q", arn)
	}
}

func TestLayerReferenceProblems(t *testing.T) {
	stack := assemblyStack{Name: "Stack", Template: template{Resources: map[string]templateResource{
		"NotALayer":    {Type: typeLambdaFunction},
		"LayerNoAsset": {Type: typeLambdaLayer},
	}}}
	cases := map[string]string{
		"missing resource": `{"Ref":"Missing"}`,
		"not a layer":      `{"Ref":"NotALayer"}`,
		"no asset":         `{"Ref":"LayerNoAsset"}`,
	}
	for name, raw := range cases {
		if _, problem := parseLayerReference(t.TempDir(), stack, json.RawMessage(raw)); problem == "" {
			t.Fatalf("%s must be refused", name)
		}
	}
}

func TestApplyOriginOverridesKeepsAnAlreadyRefusedDistribution(t *testing.T) {
	distribution := servableTestDistribution()
	distribution.Refusals = []string{"distribution: WebACLId"}
	spec := &Spec{CloudFront: []*localcloudfront.Distribution{distribution}}
	runner := &Runner{options: Options{Origins: map[string]string{"origin.example": "http://127.0.0.1:9000"}}}
	if err := runner.applyOriginOverrides(spec); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if distribution.Origins[0].LocalURL != "http://127.0.0.1:9000" {
		t.Fatalf("local URL = %q", distribution.Origins[0].LocalURL)
	}
	if len(spec.Skipped) != 0 {
		t.Fatalf("an already-refused distribution must not be added twice: %+v", spec.Skipped)
	}
}

func TestHTTPOriginReportsAnUnreachableMapping(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := server.URL
	server.Close()
	origin, err := newHTTPOrigin(&localcloudfront.DistributionOrigin{
		ID: "api", DomainName: "api.example.com", LocalURL: url, Kind: localcloudfront.OriginCustom,
	}, nil)
	if err != nil {
		t.Fatalf("new origin: %v", err)
	}
	if _, err := origin.Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/x"}); err == nil {
		t.Fatal("an unreachable mapped origin must fail")
	}
}

func TestParseDockerImageAssetRequiresADirectory(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "not-a-dir")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	metadata := map[string]json.RawMessage{assetPathMetadataKey: json.RawMessage(`"not-a-dir"`)}
	if _, problem, err := parseDockerImageAsset(dir, "Fn", templateResource{Metadata: metadata}); err != nil || problem == "" {
		t.Fatalf("a file asset = %q %v", problem, err)
	}
}
