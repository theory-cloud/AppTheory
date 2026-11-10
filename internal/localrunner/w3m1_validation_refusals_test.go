package localrunner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// LOCAL-W3-M1 validation, second pass: the refusal branch of every enumerated
// SigV4 and policy element, the JSON intrinsic refusals, the receipt-rule
// action kinds, and the custom-resource run loop.

func sigV4Authorization(credential, signedHeaders, signature string) string {
	return sigV4AuthorizationPrefix + "Credential=" + credential + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature
}

func TestVerifySigV4RefusalBranches(t *testing.T) {
	now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	scope := func(accessKey, date, region, service, terminator string) string {
		return accessKey + "/" + date + "/" + region + "/" + service + "/" + terminator
	}
	runner := iamTestRunner(t)
	check := func(request *http.Request) error {
		t.Helper()
		_, err := runner.verifySigV4(request, nil, now, iamExecuteAPIService)
		return err
	}
	request := func() *http.Request {
		value := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1/lab/items", nil)
		value.Host = "127.0.0.1"
		return value
	}

	cases := []struct {
		name   string
		mutate func(*http.Request)
		want   string
	}{
		{"no signature at all", func(*http.Request) {}, "not signed"},
		{"another algorithm", func(r *http.Request) {
			r.Header.Set("Authorization", "AWS4-HMAC-SHA1 Credential=x")
		}, "does not use AWS4-HMAC-SHA256"},
		{"no signed headers", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization("cred", "", "sig"))
		}, "missing SignedHeaders"},
		{"short scope", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization("key/date", "host", "sig"))
			r.Header.Set(sigV4DateHeader, now.Format("20060102T150405Z"))
		}, "credential scope is not"},
		{"wrong terminator", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization(scope("key", now.Format("20060102"), LocalRegion, iamExecuteAPIService, "aws4_request_x"), "host", "sig"))
			r.Header.Set(sigV4DateHeader, now.Format("20060102T150405Z"))
		}, "does not end with aws4_request"},
		{"wrong service", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization(scope("key", now.Format("20060102"), LocalRegion, "s3", sigV4Terminator), "host", "sig"))
			r.Header.Set(sigV4DateHeader, now.Format("20060102T150405Z"))
		}, "is signed for the"},
		{"wrong region", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization(scope("key", now.Format("20060102"), "eu-west-1", iamExecuteAPIService, sigV4Terminator), "host", "sig"))
			r.Header.Set(sigV4DateHeader, now.Format("20060102T150405Z"))
		}, "serves"},
		{"bad date header", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization(scope("key", "20261108", LocalRegion, iamExecuteAPIService, sigV4Terminator), "host", "sig"))
			r.Header.Set(sigV4DateHeader, "not-a-date")
		}, "no valid"},
		{"date and scope disagree", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization(scope("key", "20261107", LocalRegion, iamExecuteAPIService, sigV4Terminator), "host", "sig"))
			r.Header.Set(sigV4DateHeader, now.Format("20060102T150405Z"))
		}, "disagree"},
		{"outside the clock window", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization(scope("key", now.Format("20060102"), LocalRegion, iamExecuteAPIService, sigV4Terminator), "host", "sig"))
			r.Header.Set(sigV4DateHeader, now.Add(-time.Hour).Format("20060102T150405Z"))
		}, "15-minute window"},
		{"unknown access key", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization(scope("NOSUCHKEY", now.Format("20060102"), LocalRegion, iamExecuteAPIService, sigV4Terminator), "host", "sig"))
			r.Header.Set(sigV4DateHeader, now.Format("20060102T150405Z"))
		}, "not a credential this run"},
		{"signature is not hex", func(r *http.Request) {
			r.Header.Set("Authorization", sigV4Authorization(scope("NOSUCHKEY", now.Format("20060102"), LocalRegion, iamExecuteAPIService, sigV4Terminator), "host", "zz"))
			r.Header.Set(sigV4DateHeader, now.Format("20060102T150405Z"))
		}, "not a credential this run"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			value := request()
			tc.mutate(value)
			err := check(value)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestVerifySigV4SessionAndSignatureBranches(t *testing.T) {
	now := time.Now().UTC()
	runner := iamTestRunner(t)
	record := iamCredentialRecord{
		AccessKeyID:  "SESSIONKEY",
		Secret:       "secret",
		SessionToken: "token",
		PrincipalARN: "arn:aws:sts::787107040121:assumed-role/caller/session",
		BaseARN:      "arn:aws:iam::787107040121:role/caller",
		Account:      "787107040121",
		IssuedAt:     now,
		ExpiresAt:    now.Add(time.Hour),
	}
	if err := runner.addIAMCredential(record); err != nil {
		t.Fatalf("add the session credential: %v", err)
	}
	request := func() *http.Request {
		value := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1/lab/items", nil)
		value.Host = "127.0.0.1"
		return value
	}

	// A session credential needs its token, the right token and a signed header.
	missing := signTestRequest(t, http.MethodGet, "http://127.0.0.1/lab/items", "127.0.0.1",
		record.AccessKeyID, record.Secret, "", nil, "", now)
	if _, err := runner.verifySigV4(missing, nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "must carry") {
		t.Fatalf("a session without its token must be refused: %v", err)
	}
	wrong := signTestRequest(t, http.MethodGet, "http://127.0.0.1/lab/items", "127.0.0.1",
		record.AccessKeyID, record.Secret, "other-token", nil, "", now)
	if _, err := runner.verifySigV4(wrong, nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "does not match") {
		t.Fatalf("a wrong session token must be refused: %v", err)
	}
	// A correct signature with a wrong secret is a mismatch.
	badSecret := signTestRequest(t, http.MethodGet, "http://127.0.0.1/lab/items", "127.0.0.1",
		record.AccessKeyID, "wrong", "token", nil, "", now)
	if _, err := runner.verifySigV4(badSecret, nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "does not match the credential") {
		t.Fatalf("a wrong secret must be refused: %v", err)
	}
	good := signTestRequest(t, http.MethodGet, "http://127.0.0.1/lab/items", "127.0.0.1",
		record.AccessKeyID, record.Secret, "token", nil, "", now)
	principal, err := runner.verifySigV4(good, nil, now, iamExecuteAPIService)
	if err != nil {
		t.Fatalf("a session credential must verify: %v", err)
	}
	if !principal.Session || principal.BaseARN != record.BaseARN {
		t.Fatalf("the principal must be the session: %+v", principal)
	}

	// A request whose Authorization header drops the host from SignedHeaders is
	// refused before the signature is compared.
	noHost := request()
	noHost.Header.Set(sigV4TokenHeader, "token")
	noHost.Header.Set("Authorization", sigV4Authorization(
		record.AccessKeyID+"/"+now.Format("20060102")+"/"+LocalRegion+"/"+iamExecuteAPIService+"/"+sigV4Terminator,
		"x-amz-date;x-amz-security-token", "00"))
	noHost.Header.Set(sigV4DateHeader, now.Format("20060102T150405Z"))
	if _, err := runner.verifySigV4(noHost, nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "include host") {
		t.Fatalf("a request that signs no host must be refused: %v", err)
	}

	// A non-hexadecimal signature is named.
	notHex := request()
	notHex.Header.Set(sigV4TokenHeader, "token")
	notHex.Header.Set("Authorization", sigV4Authorization(
		record.AccessKeyID+"/"+now.Format("20060102")+"/"+LocalRegion+"/"+iamExecuteAPIService+"/"+sigV4Terminator,
		"host;x-amz-security-token", "zz"))
	notHex.Header.Set(sigV4DateHeader, now.Format("20060102T150405Z"))
	if _, err := runner.verifySigV4(notHex, nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "not hexadecimal") {
		t.Fatalf("a non-hex signature must be named: %v", err)
	}
}

func TestVerifySigV4PresignRefusalBranches(t *testing.T) {
	now := time.Now().UTC()
	runner := iamTestRunner(t)
	presigned := func(values url.Values) *http.Request {
		target := "http://127.0.0.1/lab/items?" + values.Encode()
		request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, target, nil)
		request.Host = "127.0.0.1"
		return request
	}
	base := func() url.Values {
		return url.Values{
			sigV4PresignAlgorithm:     {sigV4Algorithm},
			sigV4PresignCredential:    {"KEY/" + now.Format("20060102") + "/" + LocalRegion + "/" + iamExecuteAPIService + "/" + sigV4Terminator},
			sigV4PresignDate:          {now.Format("20060102T150405Z")},
			sigV4PresignSignature:     {"00"},
			sigV4PresignSignedHeaders: {"host"},
		}
	}

	wrongAlgorithm := base()
	wrongAlgorithm.Set(sigV4PresignAlgorithm, "AWS4-HMAC-SHA256-OTHER")
	if _, err := runner.verifySigV4(presigned(wrongAlgorithm), nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "instead of") {
		t.Fatalf("a foreign presign algorithm must be named: %v", err)
	}
	noHeaders := base()
	noHeaders.Del(sigV4PresignSignedHeaders)
	if _, err := runner.verifySigV4(presigned(noHeaders), nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "X-Amz-SignedHeaders") {
		t.Fatalf("a presigned URL with no signed headers must be named: %v", err)
	}
	badExpiry := base()
	badExpiry.Set(sigV4PresignExpires, "soon")
	if _, err := runner.verifySigV4(presigned(badExpiry), nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "positive integer") {
		t.Fatalf("a non-numeric expiry must be named: %v", err)
	}
	noExpiry := base()
	noExpiry.Set(sigV4PresignExpires, "900")
	// The expiry is valid; verification then fails on the unknown access key.
	if _, err := runner.verifySigV4(presigned(noExpiry), nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "not a credential this run") {
		t.Fatalf("a valid presigned URL with an unknown key must be named: %v", err)
	}
}

func TestResolveJSONIntrinsicRefusals(t *testing.T) {
	runner := &Runner{}
	spec := jsonSpec()
	runner.spec = spec
	cases := []struct {
		name     string
		document string
		want     string
	}{
		{"Ref not a name", `{"Ref": 7}`, "must name a parameter or resource"},
		{"GetAtt shape", `{"Fn::GetAtt": "one"}`, ""},
		{"Join shape", `{"Fn::Join": ["-"]}`, "must be [delimiter, values]"},
		{"Join delimiter", `{"Fn::Join": [1, ["a"]]}`, "delimiter must be a string"},
		{"Join values", `{"Fn::Join": ["-", "a"]}`, "values must be an array"},
		{"Join non-scalar values", `{"Fn::Join": ["-", [{"Fn::Split": ["-", "a-b"]}]]}`, "is not a scalar"},
		{"If shape", `{"Fn::If": ["On"]}`, "must be [condition"},
		{"If condition name", `{"Fn::If": [1, "a", "b"]}`, "condition must be a condition name"},
		{"Select shape", `{"Fn::Select": [0]}`, "must be [index, values]"},
		{"Select non-numeric index", `{"Fn::Select": ["x", ["a"]]}`, "not a number"},
		{"Select out of range", `{"Fn::Select": [4, ["a"]]}`, "outside a list"},
		{"Select non-list values", `{"Fn::Select": [0, "a"]}`, "values must be an array"},
		{"Split shape", `{"Fn::Split": ["-"]}`, "must be [delimiter, value]"},
		{"Split empty delimiter", `{"Fn::Split": ["", "a"]}`, "non-empty string"},
		{"Split non-scalar", `{"Fn::Split": ["-", {"Ref": "A"}]}`, ""},
		{"ImportValue", `{"Fn::ImportValue": "Export"}`, "no local value"},
		{"nested list item", `{"Fn::Join": ["-", [{"Ref": 7}]]}`, "a Ref must name"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var value any
			if err := json.Unmarshal([]byte(tc.document), &value); err != nil {
				t.Fatalf("decode %s: %v", tc.document, err)
			}
			_, err := runner.resolveJSONValue(spec, "Stack", value)
			if tc.want == "" {
				if err == nil {
					t.Fatalf("%s must fail", tc.document)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestStatementShapeRefusals(t *testing.T) {
	cases := []struct {
		name       string
		statement  string
		trust      bool
		function   bool
		want       string
		irrelevant bool
	}{
		{"NotAction", `{"Effect":"Allow","NotAction":"execute-api:Invoke","Resource":"x"}`, false, false, "NotAction", false},
		{"bad effect", `{"Effect":"Maybe","Action":"execute-api:Invoke","Resource":"x"}`, false, false, "Effect", false},
		{"no action", `{"Effect":"Allow","Resource":"x"}`, false, false, "no Action", false},
		{"wildcard action", `{"Effect":"Allow","Action":"execute-api:*","Resource":"x"}`, false, false, "outside the local IAM subset", false},
		{"no resource", `{"Effect":"Allow","Action":"execute-api:Invoke"}`, false, false, "no Resource", false},
		{"question mark wildcard", `{"Effect":"Allow","Action":"execute-api:Invoke","Resource":"arn:aws:execute-api:us-east-1:1:api/lab/GET/?tem"}`, false, false, "wildcard", false},
		{"trust without principal", `{"Effect":"Allow","Action":"sts:AssumeRole"}`, true, false, "no Principal", false},
		{"irrelevant action", `{"Effect":"Allow","Action":"s3:GetObject","Resource":"x"}`, false, false, "", true},
		{"condition outside subset", `{"Effect":"Allow","Action":"execute-api:Invoke","Resource":"x","Principal":{"AWS":"arn:aws:iam::1:root"},"Condition":{"Bool":{"aws:SecureTransport":"true"}}}`, false, false, "Condition", false},
		{"function url auth type outside subset", `{"Effect":"Allow","Action":"lambda:InvokeFunctionUrl","Resource":"arn:aws:lambda:us-east-1:1:function:f","Principal":{"AWS":"arn:aws:iam::1:root"},"Condition":{"StringLike":{"lambda:FunctionUrlAuthType":"AWS_IAM"}}}`, false, true, "Condition", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var statement iamPolicyStatement
			if err := json.Unmarshal([]byte(tc.statement), &statement); err != nil {
				t.Fatalf("decode: %v", err)
			}
			_, err := shapeStatementFor(statement, tc.trust, tc.function)
			if tc.irrelevant {
				if err == nil {
					t.Fatal("an irrelevant statement must be reported as irrelevant")
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestDeriveReceiptRuleActionKinds(t *testing.T) {
	resources := map[string]any{
		"RuleSet": map[string]any{"Type": typeSESReceiptRuleSet, "Properties": map[string]any{
			"RuleSetName": "mail",
		}},
		"Bucket": map[string]any{"Type": typeS3Bucket, "Properties": map[string]any{}},
		"Fn":     withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Rule": map[string]any{"Type": typeSESReceiptRule, "Properties": map[string]any{
			"RuleSetName": map[string]any{"Ref": "RuleSet"},
			"Rule": map[string]any{
				"Enabled":    true,
				"Recipients": []any{"inbound@example.test"},
				"Actions": []any{
					map[string]any{"SNSAction": map[string]any{"TopicArn": "arn:aws:sns:us-east-1:1:t"}},
					map[string]any{"AddHeaderAction": map[string]any{"HeaderName": "X", "HeaderValue": "y"}},
					map[string]any{"LambdaAction": map[string]any{"FunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}}}},
					map[string]any{"StopAction": map[string]any{"Scope": "RuleSet"}},
				},
			},
		}},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if len(spec.ReceiptRules) != 1 {
		t.Fatalf("the rule must be derived: %+v", spec.ReceiptRules)
	}
	rule := spec.ReceiptRules[0]
	if rule.RuleSetName != "mail" {
		t.Fatalf("the rule set name is %q", rule.RuleSetName)
	}
	if len(rule.UnservedActions) != 2 || rule.UnservedActions[0] != "AddHeaderAction" ||
		rule.UnservedActions[1] != "SNSAction" {
		t.Fatalf("the unserved actions must be reported by kind: %+v", rule.UnservedActions)
	}
	kinds := make([]string, 0, len(rule.Actions))
	for _, action := range rule.Actions {
		kinds = append(kinds, action.Kind)
	}
	if strings.Join(kinds, ",") != "lambda,stop" {
		t.Fatalf("the served actions are %v", kinds)
	}
}

func TestReceiptRuleSetNameRefusals(t *testing.T) {
	stack := assemblyStack{Name: "Stack", Template: template{Resources: map[string]templateResource{
		"RuleSet": {Type: typeSESReceiptRuleSet, Properties: json.RawMessage(`{"RuleSetName":"mail"}`)},
		"Bucket":  {Type: typeS3Bucket},
	}}}
	if _, err := receiptRuleSetName(stack, json.RawMessage(`{"Fn::GetAtt":["Bucket","Arn"]}`)); err == nil ||
		!strings.Contains(err.Error(), "neither a string nor a Ref") {
		t.Fatalf("a non-Ref expression must be named: %v", err)
	}
	if _, err := receiptRuleSetName(stack, json.RawMessage(`{"Ref":"Bucket"}`)); err == nil ||
		!strings.Contains(err.Error(), "is not an AWS::SES::ReceiptRuleSet") {
		t.Fatalf("a non-rule-set ref must be named: %v", err)
	}
	if _, err := receiptRuleSetName(stack, json.RawMessage(`{"Ref":"Nope"}`)); err == nil ||
		!strings.Contains(err.Error(), "is not an AWS::SES::ReceiptRuleSet") {
		t.Fatalf("an unknown ref must be named: %v", err)
	}
	name, err := receiptRuleSetName(stack, nil)
	if err != nil || name != "" {
		t.Fatalf("an absent name is empty: %q %v", name, err)
	}
}

// fakeS3 serves the two operations the auto-delete leg and s3.list need.
type fakeS3 struct {
	mu      sync.Mutex
	objects []string
	deleted int
	lists   int
}

func (f *fakeS3) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case request.Method == http.MethodGet && strings.Contains(request.URL.RawQuery, "list-type=2"):
		f.lists++
		writer.Header().Set("Content-Type", "application/xml")
		contents := ""
		if f.lists == 1 {
			for _, key := range f.objects {
				contents += "<Contents><Key>" + key + "</Key><Size>1</Size></Contents>"
			}
			f.objects = nil
		}
		_, _ = fmt.Fprintf(writer, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`+ //nolint:errcheck // the test asserts the listing below
			`<Name>bucket</Name><IsTruncated>false</IsTruncated>%s</ListBucketResult>`, contents)
	case request.Method == http.MethodDelete:
		f.deleted++
		writer.WriteHeader(http.StatusNoContent)
	case request.Method == http.MethodPut:
		f.objects = append(f.objects, strings.TrimPrefix(request.URL.Path, "/bucket/"))
		writer.Header().Set("ETag", `"etag"`)
		writer.WriteHeader(http.StatusOK)
	default:
		writer.WriteHeader(http.StatusBadRequest)
	}
}

func TestEmptyAutoDeleteBucketAndS3List(t *testing.T) {
	fake := &fakeS3{objects: []string{"orphan.txt"}}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)

	runner := iamTestRunner(t)
	runner.backends = map[string]backendProcess{
		"s3proxy": {HostURL: server.URL, Endpoints: []Endpoint{{Service: "s3", URL: server.URL}}},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket, Properties: json.RawMessage(`{"BucketName":"bucket"}`)},
	}}
	runner.spec = spec
	runner.resourceValues = resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"}}
	session := &localSession{runner: runner, spec: spec}
	ctx := context.Background()

	resource := CustomResourceSpec{LogicalID: "Auto", Stack: "Stack",
		Properties: json.RawMessage(`{"BucketName":"bucket"}`)}
	result, err := runner.emptyAutoDeleteBucket(ctx, spec, resource)
	if err != nil {
		t.Fatalf("emptyAutoDeleteBucket: %v", err)
	}
	if result["status"] != customResourceStatusSuccess || result["deletedObjects"] != 1 {
		t.Fatalf("the delete leg reported %+v", result)
	}
	if fake.deleted != 1 {
		t.Fatalf("the fake store saw %d deletes", fake.deleted)
	}

	listing, err := session.s3List(ctx, sessionRequest{Bucket: "Bucket"})
	if err != nil {
		t.Fatalf("s3.list: %v", err)
	}
	document, _ := listing.(map[string]any) //nolint:errcheck // the operation returns a map
	if document["bucket"] != "bucket" {
		t.Fatalf("the listing is %+v", listing)
	}

	// A bucket name the properties do not carry is named.
	if _, err := runner.emptyAutoDeleteBucket(ctx, spec, CustomResourceSpec{
		LogicalID: "Auto", Stack: "Stack", Properties: json.RawMessage(`{}`),
	}); err == nil || !strings.Contains(err.Error(), "names no bucket") {
		t.Fatalf("a bucket-less resource must be named: %v", err)
	}
	// No backend is named.
	runner.backends = map[string]backendProcess{}
	if _, err := runner.emptyAutoDeleteBucket(ctx, spec, resource); err == nil ||
		!strings.Contains(err.Error(), "needs the s3proxy backend") {
		t.Fatalf("a missing backend must be named: %v", err)
	}
}

func TestInvokeCustomResourcesRunLoop(t *testing.T) {
	server := &customResourceResponseServer{responses: map[string]chan customResourceResponse{}}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	server.containerURL = httpServer.URL

	runner := iamTestRunner(t)
	runner.customResources = server
	client := httpServer.Client()
	var statuses []string
	rie := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		payload, _ := io.ReadAll(request.Body) //nolint:errcheck // the test asserts the document below
		var document customResourceRequest
		if err := json.Unmarshal(payload, &document); err != nil {
			t.Errorf("decode: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		status := customResourceStatusSuccess
		if strings.HasPrefix(document.LogicalResourceID, "Fails") {
			status = customResourceStatusFailed
		}
		statuses = append(statuses, status)
		body := `{"Status":"` + status + `","Reason":"","PhysicalResourceId":"` + document.LogicalResourceID + `-1"}`
		if status == customResourceStatusFailed {
			body = `{"Status":"FAILED","Reason":"the migration refused","PhysicalResourceId":"x"}`
		}
		put, requestErr := http.NewRequestWithContext(context.Background(), http.MethodPut, document.ResponseURL,
			strings.NewReader(body))
		if requestErr != nil {
			t.Errorf("build the response request: %v", requestErr)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		response, err := client.Do(put)
		if err != nil {
			t.Errorf("PUT: %v", err)
		} else {
			_ = response.Body.Close() //nolint:errcheck // the test only needs delivery
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{}`)) //nolint:errcheck // the response body is fixed
	}))
	t.Cleanup(rie.Close)
	port := 0
	if parsed, err := url.Parse(rie.URL); err == nil {
		_, _ = fmt.Sscanf(parsed.Port(), "%d", &port) //nolint:errcheck // the test server always reports a port
	}
	runner.invokers["Provider"] = &FunctionProcess{
		Function: FunctionSpec{LogicalID: "Provider", Stack: "Stack"}, Port: port, rie: true,
	}

	spec := &Spec{
		accounts:  map[string]string{"Stack": LocalAccountID},
		Functions: []FunctionSpec{{LogicalID: "Provider", Stack: "Stack"}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Provider", Type: typeLambdaFunction,
				Properties: json.RawMessage(`{"FunctionName":"provider"}`)},
		},
		CustomResources: []CustomResourceSpec{
			{LogicalID: "Refused", Stack: "Stack", Type: "Custom::X", Refusal: refusedMicrovmReason},
			{LogicalID: "Deployment", Stack: "Stack", Type: typeBucketDeploy, ServedBy: "the runner copies the asset"},
			{LogicalID: "Migration", Stack: "Stack", Type: "Custom::Migration", Function: "Provider"},
			{LogicalID: "FailsMigration", Stack: "Stack", Type: "Custom::Migration", Function: "Provider"},
		},
	}
	runner.spec = spec
	successCopy := *spec
	success := &successCopy
	success.CustomResources = []CustomResourceSpec{
		{LogicalID: "Refused", Stack: "Stack", Type: "Custom::X", Refusal: refusedMicrovmReason},
		{LogicalID: "Deployment", Stack: "Stack", Type: typeBucketDeploy, ServedBy: "the runner copies the asset"},
		{LogicalID: "Migration", Stack: "Stack", Type: "Custom::Migration", Function: "Provider"},
	}
	if err := runner.invokeCustomResources(context.Background(), success); err != nil {
		t.Fatalf("a served resource must run: %v", err)
	}
	if len(statuses) != 1 || statuses[0] != customResourceStatusSuccess {
		t.Fatalf("only the handler-invoked resource runs: %v", statuses)
	}
	if runner.customResourcePhysicalIDs["Stack/Migration"] != "Migration-1" {
		t.Fatalf("the physical id is %q", runner.customResourcePhysicalIDs["Stack/Migration"])
	}

	if err := runner.invokeCustomResources(context.Background(), spec); err == nil ||
		!strings.Contains(err.Error(), "the migration refused") {
		t.Fatalf("a FAILED handler must fail the run with its reason: %v (statuses %v)", err, statuses)
	}

	// A run with no response endpoint invokes nothing.
	if err := (&Runner{}).invokeCustomResources(context.Background(), spec); err != nil {
		t.Fatalf("a run with no custom-resource endpoint must be a no-op: %v", err)
	}
}

func TestStartCustomResourceResponsesServesTheEndpoint(t *testing.T) {
	dir := t.TempDir()
	state, err := newLocalCASigner(dir)
	if err != nil {
		t.Fatalf("newLocalCASigner: %v", err)
	}
	runner := &Runner{tls: state, scratch: dir}
	t.Cleanup(func() {
		for _, server := range runner.servers {
			_ = server.Close() //nolint:errcheck // the test owns the server
		}
	})
	if err := runner.startCustomResourceResponses(context.Background()); err != nil {
		t.Fatalf("startCustomResourceResponses: %v", err)
	}
	if runner.customResources == nil || runner.customResources.containerURL == "" || runner.cfnResponsePort == "" {
		t.Fatalf("the endpoint must record its URL and port: %+v %q",
			runner.customResources, runner.cfnResponsePort)
	}
	if !strings.Contains(runner.customResources.responseURL("run.X"), customResourceRequestPath+"run.X") {
		t.Fatalf("the response URL is %q", runner.customResources.responseURL("run.X"))
	}
}
