package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// LOCAL-W3-M1 validation, third pass: the Ref/GetAtt forms a policy document
// names, the local Lambda endpoint's refusals, the STS validation branches, the
// EventBridge input-path grammar, and the CodeBuild reference forms.

func TestResolveJSONRefForms(t *testing.T) {
	runner := &Runner{resourceValues: resourceValues{}}
	spec := jsonSpec()
	runner.spec = spec
	spec.Resources = append(spec.Resources,
		ResourceSpec{Stack: "Stack", LogicalID: "VersionBadTarget", Type: "AWS::Lambda::Version",
			Properties: json.RawMessage(`{"FunctionName":{"Ref":"Api"}}`)},
		ResourceSpec{Stack: "Stack", LogicalID: "VersionUnknown", Type: "AWS::Lambda::Version",
			Properties: json.RawMessage(`{"FunctionName":{"Fn::GetAtt":["Nope","Arn"]}}`)},
		ResourceSpec{Stack: "Stack", LogicalID: "VersionBadProps", Type: "AWS::Lambda::Version",
			Properties: json.RawMessage(`not json`)},
	)

	cases := []struct {
		document string
		want     string
	}{
		{`{"Ref":"AWS::Partition"}`, LocalPartition},
		{`{"Ref":"AWS::Region"}`, "us-east-1"},
		{`{"Ref":"AWS::AccountId"}`, "787107040121"},
		{`{"Ref":"AWS::StackName"}`, "Stack"},
		{`{"Ref":"AWS::URLSuffix"}`, "amazonaws.com"},
		{`{"Ref":"AWS::NoValue"}`, "<nil>"},
		{`{"Ref":"Stage"}`, "lab"},
		{`{"Ref":"Api"}`, localPhysicalID("api", "Api")},
		{`{"Ref":"Role"}`, "arn:aws:iam::787107040121:role/vending-caller"},
		{`{"Ref":"Version"}`, "arn:aws:lambda:us-east-1:787107040121:function:worker"},
		{`{"Fn::GetAtt":["Role","Arn"]}`, "arn:aws:iam::787107040121:role/vending-caller"},
		{`{"Fn::GetAtt":["Role","RoleId"]}`, "arn:aws:iam::787107040121:role/vending-caller"},
		{`{"Fn::GetAtt":["Api","RootResourceId"]}`, localPhysicalID("resource", "Api")},
		{`{"Fn::GetAtt":["Worker","Arn"]}`, "arn:aws:lambda:us-east-1:787107040121:function:worker"},
	}
	for _, tc := range cases {
		value := resolveDocument(t, runner, spec, tc.document)
		if got := jsonScalarText(value); got != tc.want {
			t.Fatalf("%s = %q, want %q", tc.document, got, tc.want)
		}
	}

	refusals := []struct {
		document string
		want     string
	}{
		{`{"Ref":"NoSuchThing"}`, "names no parameter or resource"},
		{`{"Ref":"VersionBadTarget"}`, "does not name a Lambda function"},
		{`{"Ref":"VersionUnknown"}`, "does not name a Lambda function"},
		{`{"Ref":"VersionBadProps"}`, "parse version"},
		{`{"Fn::GetAtt":["Nothing","Arn"]}`, "names no resource"},
		{`{"Fn::GetAtt":["Trigger","Data"]}`, "has not reported yet"},
		{`{"Fn::Join":["-",[{"Ref":"Trigger"}]]}`, ""},
	}
	for _, tc := range refusals {
		var value any
		if err := json.Unmarshal([]byte(tc.document), &value); err != nil {
			t.Fatalf("decode: %v", err)
		}
		_, err := runner.resolveJSONValue(spec, "Stack", value)
		if err == nil {
			t.Fatalf("%s must fail", tc.document)
		}
		if tc.want != "" && !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s = %v, want %q", tc.document, err, tc.want)
		}
	}

	// A custom resource's reported Data is what a GetAtt reads.
	runner.customResourceData = map[string]map[string]string{
		"Stack/Trigger": {"Value": "reported"},
	}
	if value := resolveDocument(t, runner, spec, `{"Fn::GetAtt":["Trigger","Value"]}`); jsonScalarText(value) != "reported" {
		t.Fatalf("a reported attribute = %v", value)
	}
	if _, err := runner.resolveJSONValue(spec, "Stack", mustJSONValue(t, `{"Fn::GetAtt":["Trigger","Absent"]}`)); err == nil ||
		!strings.Contains(err.Error(), "names no Data attribute") {
		t.Fatalf("an unreported attribute must be named: %v", err)
	}
}

func jsonScalarText(value any) string {
	if text, ok := jsonScalarString(value); ok {
		return text
	}
	return "<nil>"
}

func mustJSONValue(t *testing.T, document string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(document), &value); err != nil {
		t.Fatalf("decode %s: %v", document, err)
	}
	return value
}

func TestLookupEventPathBranches(t *testing.T) {
	event := map[string]any{
		"detail": map[string]any{
			"list": []any{"a", "b"},
			"n":    float64(1),
		},
	}
	cases := []struct {
		path string
		want any
		ok   bool
	}{
		{"$.detail.n", float64(1), true},
		{"$.detail.list[1]", "b", true},
		{"$", event, true},
		{"detail.n", nil, false},
		{"$.detail.list[x]", nil, false},
		{"$.detail.list[9]", nil, false},
		{"$.detail.list[0", nil, false},
		{"$.detail.missing", nil, false},
		{"$.detail.list.name", nil, false},
		{"$x", nil, false},
	}
	for _, tc := range cases {
		value, ok := lookupEventPath(event, tc.path)
		if ok != tc.ok {
			t.Fatalf("%s ok = %v, want %v", tc.path, ok, tc.ok)
		}
		if ok && tc.path != "$" && value != tc.want {
			t.Fatalf("%s = %v, want %v", tc.path, value, tc.want)
		}
	}
}

func TestSTSFrontRefusesBadAssumeRoleRequests(t *testing.T) {
	runner := iamTestRunner(t)
	runner.spec = &Spec{accounts: map[string]string{"Stack": LocalAccountID}}
	record := iamCredentialRecord{AccessKeyID: "KEY", Secret: "secret", Account: LocalAccountID,
		PrincipalARN: "arn:aws:iam::787107040121:role/caller", BaseARN: "arn:aws:iam::787107040121:role/caller"}
	if err := runner.addIAMCredential(record); err != nil {
		t.Fatalf("add credential: %v", err)
	}
	front := &stsFront{runner: runner}
	call := func(form url.Values) *httptest.ResponseRecorder {
		request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://127.0.0.1/sts",
			strings.NewReader(form.Encode()))
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		signed := signTestServiceRequest(t, request, record.AccessKeyID, record.Secret, "", "sts", time.Now())
		recorder := httptest.NewRecorder()
		front.ServeHTTP(recorder, signed)
		return recorder
	}

	missingRole := call(url.Values{"Action": {stsAssumeRoleAction}})
	if missingRole.Code != http.StatusBadRequest || !strings.Contains(missingRole.Body.String(), "RoleArn is required") {
		t.Fatalf("a missing RoleArn must be 400: %d %s", missingRole.Code, missingRole.Body.String())
	}
	unknown := call(url.Values{"Action": {stsAssumeRoleAction}, "RoleArn": {"arn:aws:iam::1:role/nope"}})
	if unknown.Code != http.StatusForbidden || !strings.Contains(unknown.Body.String(), "is not defined") {
		t.Fatalf("an unknown role must be 403: %d %s", unknown.Code, unknown.Body.String())
	}

	// A role the run defines but whose trust refuses the caller.
	runner.spec.IAMRoles = []iamRoleSpec{{
		ARN: "arn:aws:iam::787107040121:role/refuser", Account: "787107040121",
		Stack: "Stack", Logical: "Refuser",
		Trust: json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole",` +
			`"Principal":{"AWS":"arn:aws:iam::787107040121:role/someone-else"}}]}`),
	}}
	refused := call(url.Values{"Action": {stsAssumeRoleAction}, "RoleArn": {"arn:aws:iam::787107040121:role/refuser"}})
	if refused.Code != http.StatusForbidden || !strings.Contains(refused.Body.String(), "AccessDenied") {
		t.Fatalf("a trust refusal must be 403: %d %s", refused.Code, refused.Body.String())
	}

	// A duration below the floor is refused, and one above the ceiling is
	// capped rather than refused.
	runner.spec.IAMRoles = []iamRoleSpec{{
		ARN: "arn:aws:iam::787107040121:role/caller", Account: "787107040121",
		Stack: "Stack", Logical: "Caller",
		Trust: json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole",` +
			`"Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"}}]}`),
	}}
	short := call(url.Values{"Action": {stsAssumeRoleAction}, "RoleArn": {"arn:aws:iam::787107040121:role/caller"},
		"DurationSeconds": {"60"}})
	if short.Code != http.StatusBadRequest || !strings.Contains(short.Body.String(), "at least 900") {
		t.Fatalf("a short duration must be 400: %d %s", short.Code, short.Body.String())
	}
	long := call(url.Values{"Action": {stsAssumeRoleAction}, "RoleArn": {"arn:aws:iam::787107040121:role/caller"},
		"DurationSeconds": {"999999"}, "RoleSessionName": {"probe"}})
	if long.Code != http.StatusOK || !strings.Contains(long.Body.String(), "AssumedRole") {
		t.Fatalf("a long duration must be capped, not refused: %d %s", long.Code, long.Body.String())
	}
}

func TestSTSFrontRefusesANonFormRequest(t *testing.T) {
	front := &stsFront{runner: iamTestRunner(t)}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://127.0.0.1/sts",
		strings.NewReader("%zz"))
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "InvalidParameterValue") {
		t.Fatalf("a malformed body must be 400: %d %s", recorder.Code, recorder.Body.String())
	}
}

// lambdaFrontInvoker answers one invocation with a fixed result.
type lambdaFrontInvoker struct {
	result []byte
	err    error
	calls  int
}

func (f *lambdaFrontInvoker) Invoke(_ context.Context, _ []byte) ([]byte, error) {
	f.calls++
	return f.result, f.err
}

func lambdaFrontTestRunner(t *testing.T) (*Runner, *lambdaFrontInvoker) {
	t.Helper()
	runner := iamTestRunner(t)
	runner.spec = &Spec{
		Functions: []FunctionSpec{{LogicalID: "ApiFn", Stack: "Stack"}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "ApiFn", Type: typeLambdaFunction,
				Properties: json.RawMessage(`{"FunctionName":"api"}`)},
		},
	}
	invoker := &lambdaFrontInvoker{result: []byte(`{"ok":true}`)}
	return runner, invoker
}

func TestLambdaInvokeFrontServeHTTP(t *testing.T) {
	runner, invoker := lambdaFrontTestRunner(t)
	front := &lambdaInvokeFront{runner: runner, invokerFor: func(string) (Invoker, bool) { return invoker, true }}
	invoke := func(method, path, body, invocationType string) *httptest.ResponseRecorder {
		target := "http://127.0.0.1" + lambdaInvokePathPrefix + path + lambdaInvokePathSuffix
		request := httptest.NewRequestWithContext(context.Background(), method, target, strings.NewReader(body))
		if invocationType != "" {
			request.Header.Set(lambdaInvocationTypeHeader, invocationType)
		}
		recorder := httptest.NewRecorder()
		front.ServeHTTP(recorder, request)
		return recorder
	}

	if got := invoke(http.MethodGet, "api", "", ""); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("a GET must be 405, got %d", got.Code)
	}
	if got := invoke(http.MethodPost, "", "", ""); got.Code != http.StatusNotFound {
		t.Fatalf("a path with no function must be 404, got %d", got.Code)
	}
	if got := invoke(http.MethodPost, "missing", "", ""); got.Code != http.StatusNotFound {
		t.Fatalf("an unknown function must be 404, got %d", got.Code)
	}
	if got := invoke(http.MethodPost, "api", "", ""); got.Code != http.StatusOK || got.Body.String() != `{"ok":true}` {
		t.Fatalf("the invocation must answer the handler's payload: %d %s", got.Code, got.Body.String())
	}
	if got := invoke(http.MethodPost, "api", "", lambdaInvocationEvent); got.Code != http.StatusAccepted {
		t.Fatalf("an Event invocation must be 202, got %d", got.Code)
	}
	if got := invoke(http.MethodPost, "api", "", "DryRun"); got.Code != http.StatusBadRequest {
		t.Fatalf("an unsupported invocation type must be 400, got %d", got.Code)
	}

	// A handler error is reported in the Lambda error header, not as HTTP 500.
	invoker.err = errors.New("boom")
	if got := invoke(http.MethodPost, "api", "{}", ""); got.Code != http.StatusOK ||
		got.Header().Get(lambdaFunctionErrorHeader) != "Unhandled" || !strings.Contains(got.Body.String(), "boom") {
		t.Fatalf("a handler error must be a 200 with the error header: %d %+v", got.Code, got.Header())
	}

	// A function the run did not start is 503.
	front.invokerFor = func(string) (Invoker, bool) { return nil, false }
	if got := invoke(http.MethodPost, "api", "", ""); got.Code != http.StatusServiceUnavailable {
		t.Fatalf("a function that is not running must be 503, got %d", got.Code)
	}
}

func TestCodeBuildLocalReference(t *testing.T) {
	stack := assemblyStack{Name: "Stack", Template: template{Resources: map[string]templateResource{
		"Bucket": {Type: typeS3Bucket, Properties: json.RawMessage(`{"BucketName":"bucket-name"}`)},
		"Queue":  {Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"queue-name"}`)},
		"Role":   {Type: typeIAMRole, Properties: json.RawMessage(`{"RoleName":"role-name"}`)},
	}}}
	if name, ok := codeBuildLocalReference(map[string]any{"Ref": "Bucket"}, stack); !ok || name != "bucket-name" {
		t.Fatalf("a bucket Ref must resolve to its name: %q %v", name, ok)
	}
	if _, ok := codeBuildLocalReference(map[string]any{"Fn::GetAtt": "Bucket.Arn"}, stack); ok {
		t.Fatal("a GetAtt with a dotted string must not resolve")
	}
	if _, ok := codeBuildLocalReference(map[string]any{"Ref": "Missing"}, stack); ok {
		t.Fatal("an unknown Ref must not resolve")
	}
	if _, ok := codeBuildLocalReference("literal", stack); ok {
		t.Fatal("a literal is not a reference")
	}
	if _, ok := codeBuildLocalReference(map[string]any{"Ref": "Bucket", "Fn::GetAtt": []any{"Bucket", "Arn"}}, stack); ok {
		t.Fatal("an expression with two keys is not a reference")
	}
}

func TestNewLocalCASignerReusesAndRefusesACorruptCA(t *testing.T) {
	dir := t.TempDir()
	first, err := newLocalCASigner(dir)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	second, err := newLocalCASigner(dir)
	if err != nil {
		t.Fatalf("reuse: %v", err)
	}
	if string(first.caPEM) != string(second.caPEM) {
		t.Fatal("a persistent CA must be stable across runs")
	}

	// A CA file that does not parse fails closed instead of being replaced.
	corrupt := t.TempDir()
	if err := os.WriteFile(filepath.Join(corrupt, tlsCACertFile), []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := newLocalCASigner(corrupt); err == nil {
		t.Fatal("a corrupt CA must be refused")
	}
}
