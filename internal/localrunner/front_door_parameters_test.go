package localrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/theory-cloud/apptheory/v7/internal/localcloudfront"
)

func TestFrontDoorReferenceParameterName(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		want    string
		wantErr string
	}{
		{
			name:  "plain reference",
			value: "{{resolve:ssm:/theorycloud/tms/lab/fronted/origin-token}}",
			want:  "/theorycloud/tms/lab/fronted/origin-token",
		},
		{
			name:  "pinned version resolves the current local value",
			value: "{{resolve:ssm:/theorycloud/tms/lab/fronted/origin-token:3}}",
			want:  "/theorycloud/tms/lab/fronted/origin-token",
		},
		{
			name:    "ssm-secure is not a CloudFront property reference",
			value:   "{{resolve:ssm-secure:/theorycloud/tms/lab/fronted/origin-token}}",
			wantErr: "cannot carry an ssm-secure or Secrets Manager reference",
		},
		{
			name:    "Secrets Manager is not a CloudFront property reference",
			value:   "{{resolve:secretsmanager:fronted:SecretString:token}}",
			wantErr: "cannot carry an ssm-secure or Secrets Manager reference",
		},
		{
			name:    "missing closing braces",
			value:   "{{resolve:ssm:/theorycloud/tms/fronted",
			wantErr: "missing its closing",
		},
		{
			name:    "name outside the parameter alphabet",
			value:   "{{resolve:ssm:/theorycloud/tms/fronted token}}",
			wantErr: "must be a fully qualified SSM parameter name",
		},
		{
			name:    "reserved hierarchy",
			value:   "{{resolve:ssm:/aws/fronted-token}}",
			wantErr: "must not use the reserved aws or ssm hierarchy",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := frontDoorReferenceParameterName(testCase.value)
			if testCase.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), testCase.wantErr) {
					t.Fatalf("want error containing %q, got %v", testCase.wantErr, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != testCase.want {
				t.Fatalf("parameter name %q, want %q", got, testCase.want)
			}
		})
	}
}

// fakeFrontDoorSSM serves GetParameter/PutParameter for one run's parameter
// store. An absent name answers ParameterNotFound, matching the real API.
func fakeFrontDoorSSM(t *testing.T, values map[string]string) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var mu sync.Mutex
	puts := []map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // protocol fixture
		target := request.Header.Get("X-Amz-Target")
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)  //nolint:errcheck // protocol fixture
		name, _ := payload["Name"].(string) //nolint:errcheck // protocol fixture
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		switch {
		case strings.HasSuffix(target, "PutParameter"):
			mu.Lock()
			puts = append(puts, payload)
			mu.Unlock()
			if value, ok := payload["Value"].(string); ok {
				mu.Lock()
				values[name] = value
				mu.Unlock()
			}
			writeTestResponse(t, writer, `{"Version":1}`)
		case strings.HasSuffix(target, "GetParameter"):
			mu.Lock()
			value, ok := values[name]
			mu.Unlock()
			if !ok {
				writer.WriteHeader(http.StatusBadRequest)
				writeTestResponse(t, writer, `{"__type":"ParameterNotFound","message":"not found"}`)
				return
			}
			writeTestResponse(t, writer, `{"Parameter":{"Name":"`+name+`","Type":"String","Value":"`+value+`"}}`)
		default:
			t.Errorf("unexpected SSM target %q", target)
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	t.Cleanup(server.Close)
	return server, &puts
}

func frontDoorTestRunner(server *httptest.Server, parameters []string) *Runner {
	return &Runner{
		options: Options{Stdout: io.Discard, FrontDoorParameters: parameters},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSSM}}},
		},
	}
}

func TestProvisionFrontDoorParametersCreatesOnlyWhenAbsent(t *testing.T) {
	values := map[string]string{"/theorycloud/apptheory/test/existing": "existing-secret-0123456789-abcdefgh"}
	server, puts := fakeFrontDoorSSM(t, values)
	runner := frontDoorTestRunner(server, []string{
		"/theorycloud/apptheory/test/existing",
		"/theorycloud/apptheory/test/created",
	})

	if err := runner.provisionFrontDoorParameters(context.Background()); err != nil {
		t.Fatalf("provision front-door parameters: %v", err)
	}

	if len(*puts) != 1 {
		t.Fatalf("want one PutParameter for the absent parameter, got %d: %+v", len(*puts), *puts)
	}
	put := (*puts)[0]
	if put["Name"] != "/theorycloud/apptheory/test/created" {
		t.Fatalf("PutParameter name %v", put["Name"])
	}
	if put["Overwrite"] != false {
		t.Fatalf("PutParameter must never overwrite: %+v", put)
	}
	if put["Type"] != "String" {
		t.Fatalf("a CloudFront origin header can only reference a String parameter: %+v", put)
	}
	value, _ := put["Value"].(string) //nolint:errcheck // protocol fixture
	if !strings.HasPrefix(value, frontDoorLocalValuePrefix) {
		t.Fatalf("generated value %q does not carry the local prefix", value)
	}
	if len(value) < 32 || len(value) > 128 {
		t.Fatalf("generated value %q is outside the runtime's 32 to 128 characters", value)
	}

	runner.frontDoorMu.Lock()
	defer runner.frontDoorMu.Unlock()
	if runner.frontDoorSecrets["/theorycloud/apptheory/test/existing"] != values["/theorycloud/apptheory/test/existing"] {
		t.Fatalf("an existing parameter must keep its value: %+v", runner.frontDoorSecrets)
	}
	if runner.frontDoorSecrets["/theorycloud/apptheory/test/created"] != value {
		t.Fatalf("the created parameter must be remembered: %+v", runner.frontDoorSecrets)
	}
}

func TestProvisionFrontDoorParametersNeedsTheSSMBackend(t *testing.T) {
	runner := &Runner{
		options:  Options{Stdout: io.Discard, FrontDoorParameters: []string{"/theorycloud/app/test/fronted"}},
		backends: map[string]backendProcess{},
	}
	err := runner.provisionFrontDoorParameters(context.Background())
	if err == nil || !strings.Contains(err.Error(), "local SSM backend") {
		t.Fatalf("want a missing-backend error, got %v", err)
	}
}

func TestProvisionFrontDoorParametersValidatesNames(t *testing.T) {
	server, _ := fakeFrontDoorSSM(t, map[string]string{})
	for _, name := range []string{"theorycloud/app/fronted", "/aws/app/fronted", "/app//fronted", "/app/fronted token"} {
		runner := frontDoorTestRunner(server, []string{name})
		if err := runner.provisionFrontDoorParameters(context.Background()); err == nil {
			t.Fatalf("name %q must be refused", name)
		}
	}
}

func TestResolveOriginCustomHeadersResolvesDynamicReferences(t *testing.T) {
	runner := &Runner{
		options:          Options{Stdout: io.Discard},
		frontDoorSecrets: map[string]string{"/theorycloud/app/test/fronted": "resolved-secret-0123456789-abcdefgh"},
	}
	origin := &localcloudfront.DistributionOrigin{
		ID: "ApiOrigin",
		CustomHeaders: map[string]string{
			"x-front-door": "{{resolve:ssm:/theorycloud/app/test/fronted}}",
			"x-pinned":     "{{resolve:ssm:/theorycloud/app/test/fronted:4}}",
			"x-plain":      "unchanged",
		},
	}
	if err := runner.resolveOriginCustomHeaders(context.Background(), "FrontDoor", origin); err != nil {
		t.Fatalf("resolve origin custom headers: %v", err)
	}
	want := map[string]string{
		"x-front-door": "resolved-secret-0123456789-abcdefgh",
		"x-pinned":     "resolved-secret-0123456789-abcdefgh",
		"x-plain":      "unchanged",
	}
	for header, value := range want {
		if origin.CustomHeaders[header] != value {
			t.Fatalf("header %s = %q, want %q", header, origin.CustomHeaders[header], value)
		}
	}
}

func TestResolveOriginCustomHeadersNamesTheFlagWhenTheParameterIsMissing(t *testing.T) {
	server, _ := fakeFrontDoorSSM(t, map[string]string{})
	runner := &Runner{
		options:  Options{Stdout: io.Discard},
		backends: map[string]backendProcess{"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSSM}}}},
	}
	origin := &localcloudfront.DistributionOrigin{
		ID:            "ApiOrigin",
		CustomHeaders: map[string]string{"x-front-door": "{{resolve:ssm:/theorycloud/app/test/missing}}"},
	}
	err := runner.resolveOriginCustomHeaders(context.Background(), "FrontDoor", origin)
	if err == nil || !strings.Contains(err.Error(), "--front-door-parameter /theorycloud/app/test/missing") {
		t.Fatalf("want the flag named in the error, got %v", err)
	}
}

func TestResolveOriginCustomHeadersRefusesUnsupportedReferences(t *testing.T) {
	runner := &Runner{options: Options{Stdout: io.Discard}}
	origin := &localcloudfront.DistributionOrigin{
		ID:            "ApiOrigin",
		CustomHeaders: map[string]string{"x-front-door": "{{resolve:ssm-secure:/theorycloud/app/test/fronted}}"},
	}
	err := runner.resolveOriginCustomHeaders(context.Background(), "FrontDoor", origin)
	if err == nil || !strings.Contains(err.Error(), "CloudFront origin headers cannot carry") {
		t.Fatalf("want an unsupported-reference error, got %v", err)
	}
}
