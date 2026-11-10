package localrunner

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// LOCAL-W3-M1 validation: the IAM gate, the STS proxy, the internal HTTPS
// endpoint, the receipt and custom-resource error paths, and the session
// operations, each exercised without Docker.

// iamGateSpec declares one AWS_IAM REST method whose function carries the
// caller role, so the credential the runner issues resolves to that role.
func iamGateSpec(resourcePolicy string) *Spec {
	return &Spec{
		accounts: map[string]string{"Stack": "787107040121"},
		regions:  map[string]string{"Stack": LocalRegion},
		APIs: []APISpec{{
			Class:          APIRESTV1,
			LogicalID:      "Api",
			Stack:          "Stack",
			Stage:          "lab",
			ResourcePolicy: json.RawMessage(resourcePolicy),
			Routes: []Route{{
				Class: APIRESTV1, Method: http.MethodGet, Path: "/items",
				Function: "ApiFn", AuthorizerKind: AuthorizerKindIAM,
			}},
		}},
		Functions: []FunctionSpec{{LogicalID: "ApiFn", Stack: "Stack"}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Api", Type: typeRESTAPI, Properties: json.RawMessage(`{}`)},
			{Stack: "Stack", LogicalID: "ApiFn", Type: typeLambdaFunction,
				Properties: json.RawMessage(`{"FunctionName":"api","Role":{"Fn::GetAtt":["CallerRole","Arn"]}}`)},
			{Stack: "Stack", LogicalID: "CallerRole", Type: typeIAMRole,
				Properties: json.RawMessage(`{"RoleName":"caller"}`)},
		},
	}
}

// iamGateAllowPolicy is the shape docs/127 W3-D1 enumerates: an exact role
// principal and the synthesized execute-api resource form.
const iamGateAllowPolicy = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow",` +
	`"Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},` +
	`"Resource":"execute-api:/lab/GET/items"}]}`

func iamGateRunner(t *testing.T, spec *Spec) *Runner {
	t.Helper()
	runner := iamTestRunner(t)
	runner.spec = spec
	if err := runner.issueCredentials(spec, []string{"ApiFn"}); err != nil {
		t.Fatalf("issue credentials: %v", err)
	}
	return runner
}

func iamGateRoute(spec *Spec) Route {
	return spec.APIs[0].Routes[0]
}

func TestIAMGateRefusesAnUnsignedCall(t *testing.T) {
	spec := iamGateSpec(iamGateAllowPolicy)
	runner := iamGateRunner(t, spec)
	request := httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1/lab/items", nil)
	request.Host = "127.0.0.1"
	result, err := runner.iamAuthorize(request, iamGateRoute(spec), "/items", "lab", nil)
	if err != nil {
		t.Fatalf("a refusal is a decision, not an error: %v", err)
	}
	if result.Status != http.StatusForbidden || result.Refusal == "" {
		t.Fatalf("an unsigned call must be refused by name: %+v", result)
	}
	if result.Principal != nil {
		t.Fatalf("a refused call carries no principal: %+v", result.Principal)
	}
}

func TestIAMGateAllowsASignedCallAndCarriesThePrincipal(t *testing.T) {
	spec := iamGateSpec(iamGateAllowPolicy)
	runner := iamGateRunner(t, spec)
	credential := runner.iamFunctionCredentials["ApiFn"]
	request := signTestRequest(t, http.MethodGet, "http://127.0.0.1/lab/items", "127.0.0.1",
		credential.AccessKeyID, credential.Secret, credential.SessionToken, nil, "", time.Now())
	result, err := runner.iamAuthorize(request, iamGateRoute(spec), "/items", "lab", nil)
	if err != nil {
		t.Fatalf("iamAuthorize: %v", err)
	}
	if result.Status != 0 || result.Principal == nil {
		t.Fatalf("the signed call must be allowed: %+v", result)
	}
	if result.Principal.ARN != "arn:aws:iam::787107040121:role/caller" {
		t.Fatalf("the resolved principal is %q", result.Principal.ARN)
	}
}

func TestIAMGateNamesTheMissingSpecAndAPI(t *testing.T) {
	runner := iamTestRunner(t)
	if _, err := runner.iamAuthorize(
		httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1/items", nil),
		Route{}, "/items", "", nil,
	); err == nil {
		t.Fatal("a run with no derived surface must refuse to evaluate")
	}
	spec := iamGateSpec(iamGateAllowPolicy)
	runner.spec = spec
	if _, err := runner.iamAuthorize(
		httptest.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1/items", nil),
		Route{Class: APIRESTV1, Method: http.MethodPost, Path: "/elsewhere"}, "/elsewhere", "", nil,
	); err == nil {
		t.Fatal("a route no API serves must be named")
	}
}

func TestIAMGateFindsAFunctionURLsAPI(t *testing.T) {
	spec := &Spec{
		accounts:  map[string]string{"Stack": "787107040121"},
		Functions: []FunctionSpec{{LogicalID: "ApiFn", Stack: "Stack"}},
		FunctionURLs: []FunctionURLSpec{{
			LogicalID: "Url", Stack: "Stack", Function: "ApiFn", IAM: true,
		}},
	}
	runner := &Runner{spec: spec}
	api := runner.apiForRoute(Route{Class: APIFunctionURL, Method: "ANY", Path: catchAllPath, Function: "ApiFn"})
	if api == nil || api.LogicalID != "Url" || api.Routes[0].AuthorizerKind != AuthorizerKindIAM {
		t.Fatalf("a Function URL route must resolve to its synthesized API: %+v", api)
	}
	if runner.apiForRoute(Route{Class: APIRESTV1, Method: "GET", Path: "/missing"}) != nil {
		t.Fatal("a route no API serves must resolve to nil")
	}
}

func TestRefusalMessageCarriesTheReason(t *testing.T) {
	if got := refusalMessage(""); got != `{"message":"Forbidden"}` {
		t.Fatalf("an empty reason = %s", got)
	}
	got := refusalMessage(`the policy says "no" \ now`)
	if !strings.Contains(got, `\"no\"`) || !strings.Contains(got, `\\`) {
		t.Fatalf("the reason must be escaped: %s", got)
	}
}

// functionURLGateSpec is an AWS_IAM Function URL with one function, one role
// and the caller's identity policy.
func functionURLGateSpec(functionPolicy string) *Spec {
	spec := &Spec{
		accounts: map[string]string{"Stack": "787107040121"},
		regions:  map[string]string{"Stack": LocalRegion},
		Functions: []FunctionSpec{
			{LogicalID: "ApiFn", Stack: "Stack"},
		},
		FunctionURLs: []FunctionURLSpec{{
			LogicalID: "Url", Stack: "Stack", Function: "ApiFn", IAM: true,
			FunctionPolicy: json.RawMessage(functionPolicy),
		}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "ApiFn", Type: typeLambdaFunction,
				Properties: json.RawMessage(`{"FunctionName":"api"}`)},
			{Stack: "Stack", LogicalID: "CallerRole", Type: typeIAMRole,
				Properties: json.RawMessage(`{"RoleName":"caller"}`)},
		},
	}
	spec.IAMRoles = []iamRoleSpec{{
		ARN:     "arn:aws:iam::787107040121:role/caller",
		Account: "787107040121",
		Name:    "caller",
		Stack:   "Stack",
		Logical: "CallerRole",
		Trust:   json.RawMessage(`{"Version":"2012-10-17","Statement":[]}`),
	}}
	return spec
}

func functionURLCall(spec *Spec, caller iamPrincipal) iamCall {
	api := functionURLAPI(spec.FunctionURLs[0])
	return iamCall{API: api, Stack: "Stack", Method: http.MethodGet, Path: "/", Stage: "$default", Caller: caller}
}

const functionURLAllowPolicy = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow",` +
	`"Action":["lambda:InvokeFunctionUrl","lambda:InvokeFunction"],` +
	`"Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},` +
	`"Resource":"arn:aws:lambda:us-east-1:787107040121:function:api",` +
	`"Condition":{"StringEquals":{"lambda:FunctionUrlAuthType":"AWS_IAM"}}}]}`

func TestIAMAllowsFunctionURLCombinationRules(t *testing.T) {
	caller := callerPrincipal()
	functionARN := "arn:aws:lambda:us-east-1:787107040121:function:api"

	// A resource-policy allow (both actions) grants within the account.
	spec := functionURLGateSpec(functionURLAllowPolicy)
	runner := iamTestRunner(t)
	if decision := runner.iamAllowsFunctionURL(spec, functionURLCall(spec, caller)); !decision.Allowed {
		t.Fatalf("a Function URL resource-policy allow must grant the call: %+v", decision)
	}

	// An identity-policy-only allow also grants within the account.
	spec = functionURLGateSpec("")
	spec.IAMRoles[0].Identity = []json.RawMessage{json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow",` +
		`"Action":["lambda:InvokeFunctionUrl","lambda:InvokeFunction"],"Resource":"` + functionARN + `"}]}`)}
	if decision := runner.iamAllowsFunctionURL(spec, functionURLCall(spec, caller)); !decision.Allowed {
		t.Fatalf("an identity-policy-only allow must grant the call: %+v", decision)
	}

	// No policy at all is refused with the union rule named.
	spec = functionURLGateSpec("")
	decision := runner.iamAllowsFunctionURL(spec, functionURLCall(spec, caller))
	if decision.Allowed || !strings.Contains(decision.Reason, "same-account union rule") {
		t.Fatalf("no policy must be refused by the union rule: %+v", decision)
	}

	// An explicit Deny wins over any allow.
	spec = functionURLGateSpec(`{"Version":"2012-10-17","Statement":[` +
		`{"Effect":"Allow","Action":["lambda:InvokeFunctionUrl","lambda:InvokeFunction"],` +
		`"Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},"Resource":"` + functionARN + `"},` +
		`{"Effect":"Deny","Action":["lambda:InvokeFunctionUrl","lambda:InvokeFunction"],` +
		`"Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},"Resource":"` + functionARN + `"}]}`)
	decision = runner.iamAllowsFunctionURL(spec, functionURLCall(spec, caller))
	if decision.Allowed || !strings.Contains(decision.Reason, "explicit Deny") {
		t.Fatalf("an explicit Deny must refuse: %+v", decision)
	}

	// Across accounts both policies must allow; the missing half is named.
	crossCaller := caller
	crossCaller.Account = "999999999999"
	spec = functionURLGateSpec("")
	spec.IAMRoles[0].Identity = []json.RawMessage{json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow",` +
		`"Action":["lambda:InvokeFunctionUrl","lambda:InvokeFunction"],"Resource":"` + functionARN + `"}]}`)}
	decision = runner.iamAllowsFunctionURL(spec, functionURLCall(spec, crossCaller))
	if decision.Allowed || !strings.Contains(decision.Reason, "cross-account intersection rule") ||
		!strings.Contains(decision.Reason, "the function's resource policy") {
		t.Fatalf("a cross-account call with only an identity allow must name the missing policy: %+v", decision)
	}
}

func TestIAMFunctionURLRefusesOutOfSubsetShapes(t *testing.T) {
	caller := callerPrincipal()
	functionARN := "arn:aws:lambda:us-east-1:787107040121:function:api"

	// An identity policy may not name a Principal.
	spec := functionURLGateSpec("")
	spec.IAMRoles[0].Identity = []json.RawMessage{json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow",` +
		`"Action":"lambda:InvokeFunction","Principal":{"AWS":"arn:aws:iam::787107040121:root"},"Resource":"` + functionARN + `"}]}`)}
	decision := iamTestRunner(t).iamAllowsFunctionURL(spec, functionURLCall(spec, caller))
	if decision.Allowed || !strings.Contains(decision.Reason, "names a Principal") {
		t.Fatalf("an identity Principal must fail closed: %+v", decision)
	}

	// A wildcard Principal is outside the subset too.
	spec = functionURLGateSpec("")
	spec.IAMRoles[0].Identity = []json.RawMessage{json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow",` +
		`"Action":"lambda:InvokeFunction","Principal":{"AWS":"*"},"Resource":"` + functionARN + `"}]}`)}
	decision = iamTestRunner(t).iamAllowsFunctionURL(spec, functionURLCall(spec, caller))
	if decision.Allowed || !strings.Contains(decision.Reason, "outside the local subset") {
		t.Fatalf("a wildcard identity Principal must fail closed: %+v", decision)
	}

	// A wildcard resource is outside the subset for a function ARN.
	spec = functionURLGateSpec(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow",` +
		`"Action":"lambda:InvokeFunctionUrl","Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},` +
		`"Resource":"arn:aws:lambda:us-east-1:787107040121:function:*"}]}`)
	decision = iamTestRunner(t).iamAllowsFunctionURL(spec, functionURLCall(spec, caller))
	if decision.Allowed || !strings.Contains(decision.Reason, "wildcard") {
		t.Fatalf("a wildcard function ARN must fail closed: %+v", decision)
	}

	// The FunctionUrlAuthType condition must name AWS_IAM.
	spec = functionURLGateSpec(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow",` +
		`"Action":["lambda:InvokeFunctionUrl","lambda:InvokeFunction"],` +
		`"Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},"Resource":"` + functionARN + `",` +
		`"Condition":{"StringEquals":{"lambda:FunctionUrlAuthType":"NONE"}}}]}`)
	decision = iamTestRunner(t).iamAllowsFunctionURL(spec, functionURLCall(spec, caller))
	if decision.Allowed {
		t.Fatalf("a NONE-auth-type condition must not grant an AWS_IAM URL call: %+v", decision)
	}
}

func TestIAMAllowsFunctionURLNamesMissingPieces(t *testing.T) {
	runner := iamTestRunner(t)
	caller := callerPrincipal()

	spec := functionURLGateSpec("")
	decision := runner.iamAllowsFunctionURL(spec, functionURLCall(spec, iamPrincipal{}))
	if decision.Allowed || !strings.Contains(decision.Reason, "could not be resolved") {
		t.Fatalf("an unresolved caller must be named: %+v", decision)
	}

	// A URL whose function the assembly does not declare has no ARN.
	spec = functionURLGateSpec("")
	spec.Resources = spec.Resources[1:]
	decision = runner.iamAllowsFunctionURL(spec, functionURLCall(spec, caller))
	if decision.Allowed || !strings.Contains(decision.Reason, "has no local ARN") {
		t.Fatalf("a URL without a function ARN must be named: %+v", decision)
	}

	// A call for a URL that is not in the derived surface.
	spec = functionURLGateSpec("")
	call := functionURLCall(spec, caller)
	call.API.LogicalID = "Other"
	decision = runner.iamAllowsFunctionURL(spec, call)
	if decision.Allowed || !strings.Contains(decision.Reason, "not in the derived surface") {
		t.Fatalf("an unknown URL must be named: %+v", decision)
	}
}

func TestSTSProxyForwardsOtherActions(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := request.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		writer.Header().Set("Content-Type", "text/xml")
		body := `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>` +
			request.Form.Get("Action") + `-proxied</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`
		_, _ = writer.Write([]byte(body)) //nolint:errcheck,gosec // a fixed XML document for the test client
	}))
	t.Cleanup(backend.Close)

	runner := iamTestRunner(t)
	runner.backends = map[string]backendProcess{
		"moto": {HostURL: backend.URL, Endpoints: []Endpoint{{Service: "sts", URL: backend.URL}}},
	}
	front := &stsFront{runner: runner}
	form := url.Values{"Action": {"GetCallerIdentity"}, "Version": {stsVersion}}
	request := httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://127.0.0.1/",
		strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "GetCallerIdentity-proxied") {
		t.Fatalf("the proxy must forward the action: %d %s", recorder.Code, recorder.Body.String())
	}

	// With no STS backend the action is refused by name instead of guessed.
	runner.backends = map[string]backendProcess{}
	recorder = httptest.NewRecorder()
	front.ServeHTTP(recorder, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "http://127.0.0.1/",
		strings.NewReader(form.Encode())))
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("no backend must be 501, got %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "needs the --backend moto STS endpoint") {
		t.Fatalf("the refusal must name the backend: %s", recorder.Body.String())
	}
}

func TestInternalHTTPSIssuesOneCertificateAndServesIt(t *testing.T) {
	dir := t.TempDir()
	state, err := newLocalCASigner(dir)
	if err != nil {
		t.Fatalf("newLocalCASigner: %v", err)
	}
	runner := &Runner{tls: state, scratch: dir}
	first, err := runner.internalControlCertificate()
	if err != nil {
		t.Fatalf("internalControlCertificate: %v", err)
	}
	second, err := runner.internalControlCertificate()
	if err != nil || first != second {
		t.Fatalf("the certificate must be issued once: %v", err)
	}

	handler := http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte("internal")) //nolint:errcheck // the test asserts the body
	})
	base, err := runner.startInternalHTTPS(context.Background(), "test", handler)
	if err != nil {
		t.Fatalf("startInternalHTTPS: %v", err)
	}
	t.Cleanup(func() {
		for _, server := range runner.servers {
			_ = server.Close() //nolint:errcheck // the test owns the server
		}
	})
	parsed, err := url.Parse(base)
	if err != nil {
		t.Fatalf("parse %q: %v", base, err)
	}
	if parsed.Scheme != "https" || parsed.Hostname() != controlLeafName {
		t.Fatalf("the container URL is %q", base)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(state.caPEM) {
		t.Fatal("the CA PEM must parse")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS12,
		RootCAs:    pool,
	}}}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet,
		"https://127.0.0.1:"+parsed.Port(), nil)
	if err != nil {
		t.Fatalf("build the internal request: %v", err)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("GET the internal endpoint: %v", err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // the test only reads the status
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the internal endpoint answered %d", response.StatusCode)
	}

	// A run with no CA refuses to issue the certificate.
	if _, err := (&Runner{}).internalControlCertificate(); err == nil {
		t.Fatal("a run with no CA must refuse")
	}
}

func TestReceiptDeliveryRefusesBadInput(t *testing.T) {
	runner := iamTestRunner(t)
	runner.clock = RealClock{}
	spec := &Spec{}
	session := &localSession{runner: runner, spec: spec}
	ctx := context.Background()

	if _, err := session.runner.receiveMessage(ctx, session.spec, receivedMessage{Raw: "", Recipients: []string{"a@b"}}); err == nil {
		t.Fatal("an empty message must be refused")
	}
	if _, err := session.runner.receiveMessage(ctx, session.spec, receivedMessage{Raw: "raw"}); err == nil {
		t.Fatal("a message with no recipient must be refused")
	}
	if _, err := session.runner.receiveMessage(ctx, session.spec, receivedMessage{Raw: "raw", Recipients: []string{"a@b"}}); err == nil ||
		!strings.Contains(err.Error(), "no AWS::SES::ReceiptRule") {
		t.Fatalf("an assembly with no rule must be refused by name: %v", err)
	}

	session.spec = &Spec{ReceiptRules: []ReceiptRuleSpec{{
		LogicalID: "Rule", Name: "rule", Enabled: true, Recipients: []string{"other@example.test"},
		Actions: []ReceiptAction{{Kind: receiptActionStop}},
	}}}
	message := "From: sender@example.test\r\nTo: a@b\r\nSubject: test\r\n\r\nbody"
	if _, err := session.runner.receiveMessage(ctx, session.spec, receivedMessage{Raw: message, Recipients: []string{"a@b"}}); err == nil ||
		!strings.Contains(err.Error(), "has no enabled receipt rule") {
		t.Fatalf("a non-matching recipient must be refused by name: %v", err)
	}
}

func TestRunReceiptRuleStopsAndNamesAMissingTarget(t *testing.T) {
	runner := iamTestRunner(t)
	session := &localSession{runner: runner, spec: &Spec{}}
	message := receivedMessage{Raw: "raw", Recipients: []string{"a@b"}}

	stop := ReceiptRuleSpec{LogicalID: "Rule", Actions: []ReceiptAction{{Kind: receiptActionStop}}}
	outcome, err := session.runner.runReceiptRule(context.Background(), session.spec, stop, message, "id", time.Now(), nil, nil)
	if err != nil {
		t.Fatalf("a Stop action must succeed: %v", err)
	}
	if outcome.LogicalID != "Rule" || len(outcome.Actions) != 0 {
		t.Fatalf("a Stop action ends the rule: %+v", outcome)
	}

	lambda := ReceiptRuleSpec{LogicalID: "Rule", Actions: []ReceiptAction{{
		Kind: receiptActionLambda, Function: "Missing",
	}}}
	if _, err := session.runner.runReceiptRule(context.Background(), session.spec, lambda, message, "id", time.Now(), nil, nil); err == nil ||
		!strings.Contains(err.Error(), "not running") {
		t.Fatalf("a missing Lambda target must be named: %v", err)
	}

	s3 := ReceiptRuleSpec{LogicalID: "Rule", Actions: []ReceiptAction{{
		Kind: receiptActionS3, Bucket: "Stack/Bucket", ObjectKeyPrefix: "mail/",
	}}}
	if _, err := session.runner.runReceiptRule(context.Background(), session.spec, s3, message, "id", time.Now(), nil, nil); err == nil {
		t.Fatal("an S3 action for an undeclared bucket must fail")
	}
}

func TestWriteReceiptObjectNeedsTheBucketAndBackend(t *testing.T) {
	runner := iamTestRunner(t)
	runner.spec = &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket, Properties: json.RawMessage(`{}`)},
	}}
	ctx := context.Background()
	if err := runner.writeReceiptObject(ctx, "Stack/Missing", "key", "body"); err == nil ||
		!strings.Contains(err.Error(), "does not declare") {
		t.Fatalf("an undeclared bucket must be named: %v", err)
	}
	if err := runner.writeReceiptObject(ctx, "Stack/Bucket", "key", "body"); err == nil ||
		!strings.Contains(err.Error(), "not provisioned") {
		t.Fatalf("a bucket the run did not provision must be named: %v", err)
	}
	if _, ok := runner.bucketResource("Stack/Bucket"); !ok {
		t.Fatal("a stack-qualified bucket must resolve")
	}
	if _, ok := runner.bucketResource("Other/Bucket"); ok {
		t.Fatal("a bucket in another stack must not resolve")
	}
	if _, ok := runner.bucketResource("Bucket"); !ok {
		t.Fatal("an unqualified bucket must resolve in the one stack")
	}
	runner.resourceValues = resourceValues{"Stack/Bucket": {Type: typeS3Bucket, Name: "bucket"}}
	if err := runner.writeReceiptObject(ctx, "Stack/Bucket", "key", "body"); err == nil ||
		!strings.Contains(err.Error(), "needs the s3proxy backend") {
		t.Fatalf("a provisioned bucket with no backend must be named: %v", err)
	}
}

func TestCustomResourceHelpers(t *testing.T) {
	runner := iamTestRunner(t)
	spec := &Spec{
		accounts: map[string]string{"Stack": LocalAccountID},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Bucket", Type: typeS3Bucket, Properties: json.RawMessage(`{}`)},
		},
		CustomResources: []CustomResourceSpec{
			{LogicalID: "Served", Stack: "Stack", Type: typeBucketDeploy, ServedBy: "the runner copies the asset"},
			{LogicalID: "Refused", Stack: "Stack", Type: "Custom::X", Refusal: refusedMicrovmReason},
			{LogicalID: "Missing", Stack: "Stack", Type: "Custom::X", Function: "NoHandler"},
		},
	}
	runner.spec = spec

	if properties, err := runner.resolveCustomResourceProperties(spec, CustomResourceSpec{}); err != nil ||
		len(properties) != 0 {
		t.Fatalf("an empty property document resolves to an empty object: %v %v", properties, err)
	}
	if _, err := runner.resolveCustomResourceProperties(spec, CustomResourceSpec{
		Properties: json.RawMessage(`not json`),
	}); err == nil {
		t.Fatal("a non-JSON property document must fail")
	}
	if _, err := runner.resolveCustomResourceProperties(spec, CustomResourceSpec{
		Stack: "Stack", Properties: json.RawMessage(`["a"]`),
	}); err == nil || !strings.Contains(err.Error(), "not a JSON object") {
		t.Fatalf("a list property document must fail by name: %v", err)
	}
	if id := requestIDFor("runA", "Deploy"); id != "runA.Deploy" {
		t.Fatalf("requestIDFor = %q", id)
	}
	if _, ok := customResourceByLogicalID(spec, "Nothing"); ok {
		t.Fatal("an unknown logical id must not resolve")
	}
	if _, err := runner.customResourceDelete(context.Background(), spec, "Nothing"); err == nil {
		t.Fatal("deleting an unknown custom resource must fail")
	}
	if _, err := runner.customResourceDelete(context.Background(), spec, "Refused"); err == nil ||
		!strings.Contains(err.Error(), "refused") {
		t.Fatalf("a refused custom resource must be named: %v", err)
	}
	if _, err := runner.customResourceDelete(context.Background(), spec, "Served"); err == nil ||
		!strings.Contains(err.Error(), "no handler to invoke") {
		t.Fatalf("a natively served custom resource must be named: %v", err)
	}
	if _, err := runner.customResourceDelete(context.Background(), spec, "Missing"); err == nil ||
		!strings.Contains(err.Error(), "not running") {
		t.Fatalf("a missing handler must be named: %v", err)
	}
}

func TestInvokeCustomResourceRunsTheDocumentedContract(t *testing.T) {
	server := &customResourceResponseServer{responses: map[string]chan customResourceResponse{}}
	httpServer := httptest.NewTLSServer(server)
	t.Cleanup(httpServer.Close)
	server.containerURL = httpServer.URL

	runner := iamTestRunner(t)
	runner.customResources = server
	runner.invokers = map[string]*FunctionProcess{}
	spec := &Spec{
		accounts:  map[string]string{"Stack": LocalAccountID},
		Functions: []FunctionSpec{{LogicalID: "Provider", Stack: "Stack"}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Provider", Type: typeLambdaFunction,
				Properties: json.RawMessage(`{"FunctionName":"provider"}`)},
		},
		CustomResources: []CustomResourceSpec{{
			LogicalID:  "Migration",
			Stack:      "Stack",
			Type:       "Custom::Migration",
			Function:   "Provider",
			Properties: json.RawMessage(`{"Timeout":"30","Region":{"Ref":"AWS::Region"}}`),
		}},
	}
	runner.spec = spec

	client := httpServer.Client()
	var document customResourceRequest
	rie := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		payload, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read the invocation payload: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		if decodeErr := json.Unmarshal(payload, &document); decodeErr != nil {
			t.Errorf("decode the custom-resource request: %v", decodeErr)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		body := `{"Status":"SUCCESS","PhysicalResourceId":"migration-1","Data":{"Version":"1"}}`
		put, err := http.NewRequestWithContext(context.Background(), http.MethodPut, document.ResponseURL,
			strings.NewReader(body))
		if err != nil {
			t.Errorf("build the response request: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		response, err := client.Do(put)
		if err != nil {
			t.Errorf("PUT the response document: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = response.Body.Close() //nolint:errcheck // the test only needs delivery
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{}`)) //nolint:errcheck // the response body is fixed
	}))
	t.Cleanup(rie.Close)
	port := 0
	if parsed, err := url.Parse(rie.URL); err == nil {
		_, _ = fmt.Sscanf(parsed.Port(), "%d", &port) //nolint:errcheck // the test server always reports a port
	}
	runner.invokers["Provider"] = &FunctionProcess{
		Function: FunctionSpec{LogicalID: "Provider", Stack: "Stack"},
		Port:     port,
		rie:      true,
	}

	response, err := runner.invokeCustomResource(context.Background(), spec, spec.CustomResources[0], "Create", "")
	if err != nil {
		t.Fatalf("invokeCustomResource: %v", err)
	}
	if document.RequestType != "Create" || document.LogicalResourceID != "Migration" ||
		document.ResourceType != "Custom::Migration" || document.ServiceToken == "" ||
		document.ResponseURL == "" || !strings.HasSuffix(document.StackID, "/Stack/local") {
		t.Fatalf("the request document is wrong: %+v", document)
	}
	if response.Status != customResourceStatusSuccess || response.PhysicalResourceID != "migration-1" ||
		response.Data["Version"] != "1" {
		t.Fatalf("the response document is wrong: %+v", response)
	}
	if response.RequestID != requestIDFor(runner.runID, "Migration") {
		t.Fatalf("the response carries request id %q", response.RequestID)
	}

	if _, err := runner.invokeCustomResource(context.Background(), spec,
		CustomResourceSpec{LogicalID: "None", Function: "NoHandler"}, "Create", ""); err == nil {
		t.Fatal("a custom resource with no running handler must fail")
	}
}

func TestSessionCustomOperationsNameTheirGaps(t *testing.T) {
	runner := iamTestRunner(t)
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Queue", Type: typeSQSQueue, Properties: json.RawMessage(`{}`)},
	}}
	runner.spec = spec
	session := &localSession{runner: runner, spec: spec}
	ctx := context.Background()

	if _, err := session.sesReceive(ctx, sessionRequest{}); err == nil {
		t.Fatal("ses.receive with no message must fail")
	}
	if _, err := session.customResourceDeleteOp(ctx, sessionRequest{}); err == nil ||
		!strings.Contains(err.Error(), "needs the resource logical id") {
		t.Fatalf("customResource.delete must name the missing id: %v", err)
	}
	if _, err := session.s3List(ctx, sessionRequest{Bucket: "Missing"}); err == nil {
		t.Fatal("s3.list for an unknown bucket must fail")
	}
	if _, err := session.s3List(ctx, sessionRequest{Bucket: "Queue"}); err == nil ||
		!strings.Contains(err.Error(), "not an S3 bucket") {
		t.Fatalf("s3.list must name a non-bucket resource: %v", err)
	}
}

func TestSTSErrorDocumentIsXML(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeSTSError(recorder, http.StatusForbidden, "AccessDenied", "the trust policy refuses the role")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d", recorder.Code)
	}
	var document struct {
		Code    string `xml:"Error>Code"`
		Message string `xml:"Error>Message"`
	}
	if err := xml.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
		t.Fatalf("the error body must be XML: %v", err)
	}
	if document.Code != "AccessDenied" || !strings.Contains(document.Message, "trust policy") {
		t.Fatalf("the error document is %+v", document)
	}
}
