package localrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

func TestCloudFrontOriginsWiresS3FunctionURLAndGroups(t *testing.T) {
	var s3Paths []string
	s3Server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		s3Paths = append(s3Paths, request.URL.Path)
		writer.Header().Set("Content-Type", "text/plain")
		writer.Header().Set("Content-Length", "5")
		_, _ = writer.Write([]byte("hello")) //nolint:errcheck // test response fixture
	}))
	defer s3Server.Close()

	var riePayload []byte
	rieServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		riePayload, _ = io.ReadAll(request.Body) //nolint:errcheck // test body
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"statusCode":200,"headers":{"Content-Type":"text/html"},"body":"ssr"}`)) //nolint:errcheck // test response fixture
	}))
	defer rieServer.Close()
	port, err := strconv.Atoi(strings.TrimPrefix(rieServer.URL, "http://127.0.0.1:"))
	if err != nil {
		t.Fatalf("rie port: %v", err)
	}

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"s3proxy": {HostURL: s3Server.URL, Endpoints: []Endpoint{{Service: "s3"}}},
		},
		resourceValues: resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"}},
		invokers:       map[string]*FunctionProcess{"Function1": {Port: port}},
	}
	spec := &Spec{
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Url1", Type: typeFunctionURL, Properties: json.RawMessage(`{"AuthType":"NONE"}`)},
			{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket, Properties: json.RawMessage(`{"CorsConfiguration":{"CorsRules":[]}}`)},
		},
		functionURLTargets: map[string]string{"Url1": "Function1"},
	}
	distribution := &localcloudfront.Distribution{
		LogicalID: "Distribution",
		Origins: []*localcloudfront.DistributionOrigin{
			{ID: "Html", DomainName: "bucket.s3.local", Kind: localcloudfront.OriginS3, Bucket: "Bucket", OriginPath: "/html",
				OriginAccessControl: "Oac1", S3: &localcloudfront.S3Origin{}},
			{ID: "Ssr", DomainName: "url.lambda-url.local", Kind: localcloudfront.OriginCustom, FunctionURL: "Url1",
				Custom: &localcloudfront.CustomOrigin{}},
			{ID: "Api", DomainName: "example.execute-api.us-east-1.amazonaws.com", Kind: localcloudfront.OriginCustom,
				Custom: &localcloudfront.CustomOrigin{}},
		},
		OriginGroups: []*localcloudfront.OriginGroup{{
			ID: "Group", Members: []string{"Html", "Ssr"}, FailoverStatusCodes: []int{403, 404},
		}},
	}
	origins, err := runner.cloudFrontOrigins(spec, distribution)
	if err != nil {
		t.Fatalf("cloudfront origins: %v", err)
	}
	if len(origins) != 4 {
		t.Fatalf("origins = %v", origins)
	}
	response, err := origins["Html"].Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/x", OriginPath: "/html"})
	if err != nil || string(response.Body) != "hello" {
		t.Fatalf("s3 response = %+v err = %v", response, err)
	}
	if len(s3Paths) != 1 || s3Paths[0] != "/bucket/html/x" {
		t.Fatalf("s3 paths = %v", s3Paths)
	}
	response, err = origins["Ssr"].Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/x", RequestID: "rid"})
	if err != nil || string(response.Body) != "ssr" {
		t.Fatalf("function URL response = %+v err = %v", response, err)
	}
	var event map[string]any
	if decodeErr := json.Unmarshal(riePayload, &event); decodeErr != nil {
		t.Fatalf("event: %v", decodeErr)
	}
	if event["rawPath"] != "/x" {
		t.Fatalf("event = %+v", event)
	}
	_, err = origins["Api"].Fetch(context.Background(), localcloudfront.OriginRequest{Method: http.MethodGet, URI: "/x"})
	if err == nil || !strings.Contains(err.Error(), "external network") {
		t.Fatalf("external origin err = %v", err)
	}
	group, ok := origins["Group"].(*localcloudfront.OriginGroupOrigin)
	if !ok || len(group.Members) != 2 || group.Members[1].OriginPath != "" || group.Members[0].OriginPath != "/html" {
		t.Fatalf("group = %+v", origins["Group"])
	}
}

func TestCloudFrontOriginWiringFailsClosed(t *testing.T) {
	distribution := &localcloudfront.Distribution{
		LogicalID: "Distribution",
		Origins: []*localcloudfront.DistributionOrigin{{
			ID: "Html", DomainName: "bucket.s3.local", Kind: localcloudfront.OriginS3, Bucket: "Bucket", S3: &localcloudfront.S3Origin{},
		}},
	}
	runner := &Runner{options: Options{Stdout: io.Discard}, resourceValues: resourceValues{}}
	if _, err := runner.cloudFrontOrigins(&Spec{}, distribution); err == nil || !strings.Contains(err.Error(), "s3proxy backend") {
		t.Fatalf("missing backend err = %v", err)
	}
	runner.backends = map[string]backendProcess{"s3proxy": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: "s3"}}}}
	if _, err := runner.cloudFrontOrigins(&Spec{}, distribution); err == nil || !strings.Contains(err.Error(), "not provisioned") {
		t.Fatalf("missing bucket err = %v", err)
	}
	runner.resourceValues = resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"}}
	if _, err := runner.cloudFrontOrigins(&Spec{}, distribution); err != nil {
		t.Fatalf("wired origin: %v", err)
	}
}

func TestRuntimeFunctionsIncludesCloudFrontOriginFunctions(t *testing.T) {
	spec := &Spec{
		FunctionURLs: []FunctionURLSpec{},
		CloudFront: []*localcloudfront.Distribution{{
			LogicalID: "Distribution",
			Origins: []*localcloudfront.DistributionOrigin{{
				ID: "Ssr", Kind: localcloudfront.OriginCustom, FunctionURL: "Url1",
			}},
		}},
		functionURLTargets: map[string]string{"Url1": "Function1"},
	}
	functions := spec.RuntimeFunctions()
	if len(functions) != 1 || functions[0] != "Function1" {
		t.Fatalf("runtime functions = %v", functions)
	}
}

func TestFunctionURLAuthTypeAndBucketCORS(t *testing.T) {
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Url1", Type: typeFunctionURL, Properties: json.RawMessage(`{"AuthType":"AWS_IAM"}`)},
		{Stack: "Stack", LogicalID: "Url2", Type: typeFunctionURL, Properties: json.RawMessage(`{"AuthType":"NONE"}`)},
		{Stack: "Stack", LogicalID: "Bucket1", Type: typeS3Bucket, Properties: json.RawMessage(`{"CorsConfiguration":{"CorsRules":[]}}`)},
		{Stack: "Stack", LogicalID: "Bucket2", Type: typeS3Bucket, Properties: json.RawMessage(`{}`)},
	}}
	if auth, err := functionURLAuthType(spec, "Url1"); err != nil || auth != "AWS_IAM" {
		t.Fatalf("AuthType = %q err = %v", auth, err)
	}
	if auth, err := functionURLAuthType(spec, "Stack/Url2"); err != nil || auth != noneAuthorization {
		t.Fatalf("AuthType = %q err = %v", auth, err)
	}
	if _, err := functionURLAuthType(spec, "Missing"); err == nil {
		t.Fatal("a missing Function URL must be an error")
	}
	if !bucketDeclaresCORS(spec, "Bucket1") || bucketDeclaresCORS(spec, "Bucket2") {
		t.Fatal("CORS declaration detection is wrong")
	}
}

func TestCloudFrontOriginWiringReportsEachMissingPiece(t *testing.T) {
	base := &Runner{
		options:        Options{Stdout: io.Discard},
		backends:       map[string]backendProcess{"s3proxy": {HostURL: "http://127.0.0.1:1", Endpoints: []Endpoint{{Service: "s3"}}}},
		resourceValues: resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"}},
		invokers:       map[string]*FunctionProcess{},
	}
	cases := []struct {
		name         string
		distribution *localcloudfront.Distribution
		spec         *Spec
		want         string
	}{
		{
			name: "group member missing",
			distribution: &localcloudfront.Distribution{
				LogicalID: "D",
				Origins: []*localcloudfront.DistributionOrigin{{
					ID: "Bucket", DomainName: "bucket.s3.local", Kind: localcloudfront.OriginS3, Bucket: "Bucket", S3: &localcloudfront.S3Origin{},
				}},
				OriginGroups: []*localcloudfront.OriginGroup{{ID: "Group", Members: []string{"Bucket", "Nope"}}},
			},
			spec: &Spec{},
			want: "not an origin",
		},
		{
			name: "unknown kind",
			distribution: &localcloudfront.Distribution{
				LogicalID: "D",
				Origins:   []*localcloudfront.DistributionOrigin{{ID: "Odd", DomainName: "odd.example"}},
			},
			spec: &Spec{},
			want: "not implemented locally",
		},
		{
			name: "function URL target missing",
			distribution: &localcloudfront.Distribution{
				LogicalID: "D",
				Origins: []*localcloudfront.DistributionOrigin{{
					ID: "Fn", DomainName: "url.lambda-url.local", Kind: localcloudfront.OriginCustom, FunctionURL: "Missing",
				}},
			},
			spec: &Spec{},
			want: "does not target a Lambda function",
		},
		{
			name: "function URL invoker missing",
			distribution: &localcloudfront.Distribution{
				LogicalID: "D",
				Origins: []*localcloudfront.DistributionOrigin{{
					ID: "Fn", DomainName: "url.lambda-url.local", Kind: localcloudfront.OriginCustom, FunctionURL: "Url1",
				}},
			},
			spec: &Spec{functionURLTargets: map[string]string{"Url1": "Function1"}},
			want: "is not running",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := base.cloudFrontOrigins(testCase.spec, testCase.distribution)
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("err = %v, want %q", err, testCase.want)
			}
		})
	}
}

func TestFunctionURLAuthTypeRejectsAnUnknownType(t *testing.T) {
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Url1", Type: typeFunctionURL, Properties: json.RawMessage(`{"AuthType":"OTHER"}`),
	}}}
	if _, err := functionURLAuthType(spec, "Url1"); err == nil || !strings.Contains(err.Error(), "not implemented") {
		t.Fatalf("err = %v", err)
	}
}

func TestBucketNameAcceptsAQualifiedKeyAndRejectsAMissingBucket(t *testing.T) {
	runner := &Runner{resourceValues: resourceValues{
		"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"},
		"Stack/Other":  {Type: typeDynamoTable, Name: "table"},
	}}
	if name, ok := runner.bucketName("Stack/Bucket"); !ok || name != "bucket" {
		t.Fatalf("qualified bucket = %q %v", name, ok)
	}
	if name, ok := runner.bucketName("Bucket"); !ok || name != "bucket" {
		t.Fatalf("bare bucket = %q %v", name, ok)
	}
	if _, ok := runner.bucketName("Stack/Other"); ok {
		t.Fatal("a non-bucket resource must not resolve as a bucket")
	}
	if bucketDeclaresCORS(&Spec{Resources: []ResourceSpec{{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket, Properties: json.RawMessage(`{`)}}}, "Bucket") {
		t.Fatal("malformed properties must not report CORS")
	}
}
