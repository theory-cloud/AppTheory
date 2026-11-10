package localrunner

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"
)

// signTestRequest signs a request the way an AWS SDK's SigV4 signer does, so the
// verifier is exercised against an independent implementation of the algorithm.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
func signTestRequest(t *testing.T, method, target, host, accessKeyID, secret, sessionToken string, headers map[string]string, body string, at time.Time) *http.Request {
	t.Helper()
	request := httptest.NewRequestWithContext(context.Background(), method, target, strings.NewReader(body))
	request.Host = host
	request.Header.Set(sigV4DateHeader, at.UTC().Format("20060102T150405Z"))
	if sessionToken != "" {
		request.Header.Set(sigV4TokenHeader, sessionToken)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	payloadHash := hex.EncodeToString(sha256Text(body))
	request.Header.Set(sigV4ContentHashHeader, payloadHash)
	signed := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	if sessionToken != "" {
		signed = append(signed, "x-amz-security-token")
	}
	sort.Strings(signed)
	canonicalHeaders := ""
	for _, name := range signed {
		value := request.Header.Get(name)
		if name == "host" {
			value = host
		}
		canonicalHeaders += name + ":" + strings.Join(strings.Fields(value), " ") + "\n"
	}
	canonicalRequest := strings.Join([]string{
		strings.ToUpper(method),
		request.URL.EscapedPath(),
		canonicalQueryForTest(request.URL.Query()),
		canonicalHeaders,
		strings.Join(signed, ";"),
		payloadHash,
	}, "\n")
	scope := at.UTC().Format("20060102") + "/" + LocalRegion + "/execute-api/" + sigV4Terminator
	stringToSign := strings.Join([]string{
		sigV4Algorithm,
		at.UTC().Format("20060102T150405Z"),
		scope,
		hex.EncodeToString(sha256Text(canonicalRequest)),
	}, "\n")
	key := []byte("AWS4" + secret)
	for _, part := range []string{at.UTC().Format("20060102"), LocalRegion, "execute-api", sigV4Terminator} {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(part))
		key = mac.Sum(nil)
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(stringToSign))
	signature := hex.EncodeToString(mac.Sum(nil))
	request.Header.Set("Authorization", sigV4AuthorizationPrefix+
		"Credential="+accessKeyID+"/"+scope+", SignedHeaders="+strings.Join(signed, ";")+", Signature="+signature)
	return request
}

func sha256Text(value string) []byte {
	sum := sha256.Sum256([]byte(value))
	return sum[:]
}

func canonicalQueryForTest(values url.Values) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		for _, value := range values[key] {
			parts = append(parts, sigV4Escape(key)+"="+sigV4Escape(value))
		}
	}
	return strings.Join(parts, "&")
}

// iamTestRunner builds a runner with one role, one identity policy and one
// credential, without Docker.
func iamTestRunner(t *testing.T) *Runner {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	dir := t.TempDir()
	runner := &Runner{
		options:        Options{SharedDir: dir},
		runID:          "runA",
		scratch:        dir,
		invokers:       map[string]*FunctionProcess{},
		iamCredentials: map[string]iamCredentialRecord{},
	}
	if err := runner.startIAMPlane(&Spec{}); err != nil {
		t.Fatalf("start plane: %v", err)
	}
	t.Cleanup(runner.stopIAMPlane)
	return runner
}

// iamTestSpec is one REST API with a resource policy and one caller role.
func iamTestSpec(t *testing.T, resourcePolicy string, identityPolicy string) *Spec {
	t.Helper()
	spec := &Spec{
		accounts: map[string]string{"Stack": "787107040121"},
		regions:  map[string]string{"Stack": LocalRegion},
		APIs: []APISpec{{
			Class:          APIRESTV1,
			LogicalID:      "Api",
			Stack:          "Stack",
			Stage:          "lab",
			ResourcePolicy: json.RawMessage(resourcePolicy),
			Routes: []Route{{
				Class: APIRESTV1, Method: "GET", Path: "/items", Function: "Api",
			}},
		}},
		Functions: []FunctionSpec{{LogicalID: "Api", Stack: "Stack"}},
		Resources: []ResourceSpec{
			{Stack: "Stack", LogicalID: "Api", Type: typeRESTAPI, Properties: json.RawMessage(`{}`)},
			{Stack: "Stack", LogicalID: "ApiFn", Type: typeLambdaFunction, Properties: json.RawMessage(`{"FunctionName":"api"}`)},
			{Stack: "Stack", LogicalID: "CallerRole", Type: typeIAMRole, Properties: json.RawMessage(`{"RoleName":"caller"}`)},
			{Stack: "Stack", LogicalID: "OtherRole", Type: typeIAMRole, Properties: json.RawMessage(`{"RoleName":"other"}`)},
		},
	}
	role := iamRoleSpec{
		ARN:     "arn:aws:iam::787107040121:role/caller",
		Account: "787107040121",
		Name:    "caller",
		Stack:   "Stack",
		Logical: "CallerRole",
		Trust:   json.RawMessage(`{"Version":"2012-10-17","Statement":[]}`),
	}
	if identityPolicy != "" {
		role.Identity = []json.RawMessage{json.RawMessage(identityPolicy)}
	}
	spec.IAMRoles = []iamRoleSpec{role}
	return spec
}

func testCall(spec *Spec, caller iamPrincipal) iamCall {
	return iamCall{
		API:    spec.APIs[0],
		Stack:  "Stack",
		Method: "GET",
		Path:   "/items",
		Stage:  "lab",
		Caller: caller,
	}
}

func callerPrincipal() iamPrincipal {
	return iamPrincipal{
		ARN:         "arn:aws:iam::787107040121:role/caller",
		Account:     "787107040121",
		BaseARN:     "arn:aws:iam::787107040121:role/caller",
		AccessKeyID: "LOCALTEST",
		UserID:      "AROALOCAL:LOCALTEST",
	}
}

func identityAllow(apiID string) string {
	return `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"execute-api:Invoke","Resource":["arn:aws:execute-api:us-east-1:787107040121:` + apiID + `/lab/GET/items"]}]}`
}

func TestIAMAllowsInvokeSameAccountUnion(t *testing.T) {
	apiID := localPhysicalID("api", "Api")
	// identity only
	spec := iamTestSpec(t, "", identityAllow(apiID))
	if decision := iamTestRunner(t).iamAllowsInvoke(spec, testCall(spec, callerPrincipal())); !decision.Allowed {
		t.Fatalf("an identity-policy allow must grant a same-account call: %s", decision.Reason)
	}
	// resource policy only
	resourcePolicy := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},"Resource":"execute-api:/lab/GET/items"}]}`
	spec = iamTestSpec(t, resourcePolicy, "")
	if decision := iamTestRunner(t).iamAllowsInvoke(spec, testCall(spec, callerPrincipal())); !decision.Allowed {
		t.Fatalf("a resource-policy allow must grant a same-account call: %s", decision.Reason)
	}
	// account-root principal
	resourcePolicy = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:root"},"Resource":"execute-api:/lab/GET/items"}]}`
	spec = iamTestSpec(t, resourcePolicy, "")
	if decision := iamTestRunner(t).iamAllowsInvoke(spec, testCall(spec, callerPrincipal())); !decision.Allowed {
		t.Fatalf("an account-root principal must grant a same-account call: %s", decision.Reason)
	}
	// nothing allows
	spec = iamTestSpec(t, "", "")
	if decision := iamTestRunner(t).iamAllowsInvoke(spec, testCall(spec, callerPrincipal())); decision.Allowed {
		t.Fatal("a call no policy allows must be refused")
	}
}

func TestIAMAllowsInvokeCrossAccountIntersection(t *testing.T) {
	apiID := localPhysicalID("api", "Api")
	resourcePolicy := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::111111111111:root"},"Resource":"execute-api:/lab/GET/items"}]}`
	// The caller is in another account; its role lives in that account, so the
	// identity policy is found through the plane's role set.
	spec := iamTestSpec(t, resourcePolicy, identityAllow(apiID))
	caller := iamPrincipal{
		ARN:     "arn:aws:iam::111111111111:role/caller",
		Account: "111111111111",
		BaseARN: "arn:aws:iam::111111111111:role/caller",
	}
	spec.IAMRoles = append(spec.IAMRoles, iamRoleSpec{
		ARN:      caller.BaseARN,
		Account:  caller.Account,
		Stack:    "Stack",
		Logical:  "CallerRole",
		Identity: []json.RawMessage{json.RawMessage(identityAllow(apiID))},
	})
	runner := iamTestRunner(t)
	if decision := runner.iamAllowsInvoke(spec, testCall(spec, caller)); !decision.Allowed {
		t.Fatalf("a cross-account call both policies allow must be granted: %s", decision.Reason)
	}
	// Remove the identity allow: the cross-account call must fail closed.
	spec.IAMRoles = spec.IAMRoles[:1]
	decision := runner.iamAllowsInvoke(spec, testCall(spec, caller))
	if decision.Allowed {
		t.Fatal("a cross-account call without an identity allow must be refused")
	}
	if !strings.Contains(decision.Reason, "cross-account") {
		t.Fatalf("the refusal must name the cross-account rule: %q", decision.Reason)
	}
}

func TestIAMAllowsInvokeExplicitDenyWins(t *testing.T) {
	apiID := localPhysicalID("api", "Api")
	deny := `{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"execute-api:Invoke","Resource":"execute-api:/lab/GET/items"}]}`
	spec := iamTestSpec(t, deny, identityAllow(apiID))
	decision := iamTestRunner(t).iamAllowsInvoke(spec, testCall(spec, callerPrincipal()))
	if decision.Allowed {
		t.Fatal("an explicit Deny must refuse the call")
	}
	if !strings.Contains(decision.Reason, "Deny") {
		t.Fatalf("the refusal must name the Deny: %q", decision.Reason)
	}
}

func TestIAMAllowsInvokePrincipalArnCondition(t *testing.T) {
	resourcePolicy := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"execute-api:Invoke",
		"Principal":{"AWS":"arn:aws:iam::787107040121:root"},
		"Condition":{"StringEquals":{"aws:PrincipalArn":["arn:aws:iam::787107040121:role/caller"]}},
		"Resource":"execute-api:/lab/GET/items"}]}`
	spec := iamTestSpec(t, resourcePolicy, "")
	runner := iamTestRunner(t)
	if decision := runner.iamAllowsInvoke(spec, testCall(spec, callerPrincipal())); !decision.Allowed {
		t.Fatalf("an aws:PrincipalArn-conditioned allow must grant the named base role: %s", decision.Reason)
	}
	// A session's aws:PrincipalArn is the base role, so the same statement still
	// grants it.
	session := callerPrincipal()
	session.ARN = "arn:aws:sts::787107040121:assumed-role/caller/session"
	session.Session = true
	if decision := runner.iamAllowsInvoke(spec, testCall(spec, session)); !decision.Allowed {
		t.Fatalf("aws:PrincipalArn must compare the base role ARN, not the session ARN: %s", decision.Reason)
	}
	// A different base role is refused.
	other := iamPrincipal{ARN: "arn:aws:iam::787107040121:role/other", Account: "787107040121", BaseARN: "arn:aws:iam::787107040121:role/other"}
	if decision := runner.iamAllowsInvoke(spec, testCall(spec, other)); decision.Allowed {
		t.Fatal("a statement conditioned on another role must not grant this caller")
	}
}

func TestIAMAllowsInvokePathWildcard(t *testing.T) {
	resourcePolicy := `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:root"},"Resource":"execute-api:/lab/GET/items/*"}]}`
	spec := iamTestSpec(t, resourcePolicy, "")
	spec.APIs[0].Routes[0].Path = "/items/42"
	call := testCall(spec, callerPrincipal())
	call.Path = "/items/42"
	if decision := iamTestRunner(t).iamAllowsInvoke(spec, call); !decision.Allowed {
		t.Fatalf("a trailing path wildcard must match the rest of the path: %s", decision.Reason)
	}
	call.Path = "/items"
	if decision := iamTestRunner(t).iamAllowsInvoke(spec, call); decision.Allowed {
		t.Fatal("a trailing path wildcard must not match a shorter path")
	}
}

func TestStatementShapeFailsClosedByName(t *testing.T) {
	for _, tc := range []struct{ document, want string }{
		{`{"Effect":"Allow","NotAction":"s3:GetObject"}`, "NotAction"},
		{`{"Effect":"Allow","Action":"execute-api:*","Resource":"execute-api:/lab/GET/x"}`, "outside the local IAM subset"},
		{`{"Effect":"Allow","Action":"*","Resource":"execute-api:/lab/GET/x"}`, "outside the local IAM subset"},
		{`{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"*"},"Resource":"execute-api:/lab/GET/x"}`, "wildcard Principal"},
		{`{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:role/c*"},"Resource":"execute-api:/lab/GET/x"}`, "wildcard"},
		{`{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},"Resource":"execute-api:/lab/GET/x?y"}`, "wildcard the execute-api ARN format does not define"},
		{`{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},"Condition":{"StringLike":{"aws:PrincipalArn":"x"}},"Resource":"execute-api:/lab/GET/x"}`, "Condition operator"},
		{`{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},"Condition":{"StringEquals":{"aws:SourceVpc":"vpc-1"}},"Resource":"execute-api:/lab/GET/x"}`, "Condition key"},
		{`{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},"Condition":{"StringEquals":{"aws:PrincipalArn":"arn:aws:iam::787107040121:role/*"}},"Resource":"execute-api:/lab/GET/x"}`, "wildcard"},
		{`{"Effect":"Maybe","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"},"Resource":"execute-api:/lab/GET/x"}`, "Effect"},
		{`{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::787107040121:role/caller"}}`, "no Resource"},
	} {
		var statement iamPolicyStatement
		if err := json.Unmarshal([]byte(tc.document), &statement); err != nil {
			t.Fatalf("decode %s: %v", tc.document, err)
		}
		_, err := shapeStatement(statement, false)
		if err == nil {
			t.Fatalf("%s must fail closed", tc.document)
		}
		if !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s error %q does not name %q", tc.document, err, tc.want)
		}
	}
}

func TestStatementShapeSkipsAnIrrelevantAction(t *testing.T) {
	var statement iamPolicyStatement
	if err := json.Unmarshal([]byte(`{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::b/*"}`), &statement); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if _, err := shapeStatement(statement, false); !errors.Is(err, errStatementIrrelevant) {
		t.Fatalf("a statement whose action cannot match is skipped, not failed: %v", err)
	}
}

func TestExecuteAPIResourceMatches(t *testing.T) {
	target := policyTarget{apiID: "abc", account: "787107040121", region: LocalRegion, stage: "lab", method: "GET", path: "items/42"}
	for _, tc := range []struct {
		resource string
		want     bool
		wantErr  bool
	}{
		{"execute-api:/lab/GET/items/42", true, false},
		{"execute-api:/lab/GET/items/*", true, false},
		{"execute-api:/*/GET/items/42", true, false},
		{"execute-api:/prod/GET/items/42", false, false},
		{"execute-api:/lab/POST/items/42", false, false},
		{"execute-api:/lab/GET/items", false, false},
		{"arn:aws:execute-api:us-east-1:787107040121:abc/lab/GET/items/42", true, false},
		{"arn:aws:execute-api:us-east-1:787107040121:abc/lab/GET/items/*", true, false},
		{"arn:aws:execute-api:us-east-1:787107040121:other/lab/GET/items/42", false, false},
		{"arn:aws:execute-api:us-east-1:999999999999:abc/lab/GET/items/42", false, false},
		{"arn:aws:s3:::bucket/key", false, false},
		{"execute-api:/lab/*/items/42", false, true},
	} {
		matched, err := executeAPIResourceMatches(tc.resource, target)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("%s must fail closed", tc.resource)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: unexpected error %v", tc.resource, err)
		}
		if matched != tc.want {
			t.Fatalf("%s matched %v, want %v", tc.resource, matched, tc.want)
		}
	}
}

func TestIAMAllowsAssumeRoleByTrustAlone(t *testing.T) {
	spec := iamTestSpec(t, "", "")
	runner := iamTestRunner(t)
	role := iamRoleSpec{
		ARN:     "arn:aws:iam::787107040121:role/vending",
		Account: "787107040121",
		Stack:   "Stack",
		Logical: "OtherRole",
		Trust:   json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"AWS":"arn:aws:iam::787107040121:root"}}]}`),
	}
	allowed, reason := runner.iamAllowsAssumeRole(spec, role, callerPrincipal())
	if !allowed {
		t.Fatalf("an account-root trust must accept the caller: %s", reason)
	}
	role.Trust = json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"AWS":"arn:aws:iam::999999999999:root"}}]}`)
	allowed, reason = runner.iamAllowsAssumeRole(spec, role, callerPrincipal())
	if allowed {
		t.Fatal("a trust policy naming another account must refuse")
	}
	if !strings.Contains(reason, "trust policy") {
		t.Fatalf("the refusal must name the trust policy: %q", reason)
	}
	role.Trust = json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"sts:AssumeRole","Principal":{"AWS":"arn:aws:iam::787107040121:root"}}]}`)
	if allowed, _ := runner.iamAllowsAssumeRole(spec, role, callerPrincipal()); allowed {
		t.Fatal("an explicit Deny in a trust policy must refuse")
	}
}

func TestVerifySigV4AcceptsAndRefuses(t *testing.T) {
	runner := iamTestRunner(t)
	spec := iamTestSpec(t, "", identityAllow(localPhysicalID("api", "Api")))
	record, err := runner.mintCredential(iamCredentialRecord{
		PrincipalARN: "arn:aws:iam::787107040121:role/caller",
		BaseARN:      "arn:aws:iam::787107040121:role/caller",
		Account:      "787107040121",
		ExpiresAt:    time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	now := time.Now()
	request := signTestRequest(t, http.MethodGet, "http://127.0.0.1:8330/items", "127.0.0.1:8330",
		record.AccessKeyID, record.Secret, "", map[string]string{}, "", now)
	principal, err := runner.verifySigV4(request, nil, now, iamExecuteAPIService)
	if err != nil {
		t.Fatalf("a correctly signed request must verify: %v", err)
	}
	if principal.ARN != record.PrincipalARN || principal.BaseARN != record.BaseARN || principal.Account != "787107040121" {
		t.Fatalf("unexpected principal: %+v", principal)
	}
	if decision := runner.iamAllowsInvoke(spec, testCall(spec, principal)); !decision.Allowed {
		t.Fatalf("the verified caller must be granted by its identity policy: %s", decision.Reason)
	}

	// A tampered signature.
	tampered := signTestRequest(t, http.MethodGet, "http://127.0.0.1:8330/items", "127.0.0.1:8330",
		record.AccessKeyID, record.Secret, "", map[string]string{}, "", now)
	tampered.Header.Set("Authorization", strings.Replace(tampered.Header.Get("Authorization"), "Signature=", "Signature=00", 1))
	if _, err := runner.verifySigV4(tampered, nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "does not match the credential") {
		t.Fatalf("a tampered signature must be refused by name: %v", err)
	}

	// An unknown access key.
	unknown := signTestRequest(t, http.MethodGet, "http://127.0.0.1:8330/items", "127.0.0.1:8330",
		"LOCALUNKNOWN", "secret", "", map[string]string{}, "", now)
	if _, unknownErr := runner.verifySigV4(unknown, nil, now, iamExecuteAPIService); unknownErr == nil ||
		!strings.Contains(unknownErr.Error(), "not a credential") {
		t.Fatalf("an unknown access key must be refused by name: %v", unknownErr)
	}

	// A clock skew outside the window.
	old := signTestRequest(t, http.MethodGet, "http://127.0.0.1:8330/items", "127.0.0.1:8330",
		record.AccessKeyID, record.Secret, "", map[string]string{}, "", now.Add(-time.Hour))
	if _, err := runner.verifySigV4(old, nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "15-minute window") {
		t.Fatalf("an old signature must be refused by name: %v", err)
	}

	// An unsigned request.
	unsigned := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "http://127.0.0.1:8330/items", nil)
	if _, err := runner.verifySigV4(unsigned, nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "not signed") {
		t.Fatalf("an unsigned request must be refused by name: %v", err)
	}

	// The wrong service.
	wrongService := signTestRequest(t, http.MethodGet, "http://127.0.0.1:8330/items", "127.0.0.1:8330",
		record.AccessKeyID, record.Secret, "", map[string]string{}, "", now)
	wrongService.Header.Set("Authorization", strings.Replace(wrongService.Header.Get("Authorization"), "/execute-api/", "/s3/", 1))
	if _, err := runner.verifySigV4(wrongService, nil, now, iamExecuteAPIService); err == nil ||
		!strings.Contains(err.Error(), "signed for the") {
		t.Fatalf("a signature for another service must be refused by name: %v", err)
	}
}

func TestVerifySigV4RequiresTheSessionToken(t *testing.T) {
	runner := iamTestRunner(t)
	record, err := runner.mintCredential(iamCredentialRecord{
		PrincipalARN: "arn:aws:sts::787107040121:assumed-role/caller/session",
		BaseARN:      "arn:aws:iam::787107040121:role/caller",
		Account:      "787107040121",
		SessionToken: "session-token",
		ExpiresAt:    time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	now := time.Now()
	without := signTestRequest(t, http.MethodGet, "http://127.0.0.1:8330/items", "127.0.0.1:8330",
		record.AccessKeyID, record.Secret, "", map[string]string{}, "", now)
	if _, tokenErr := runner.verifySigV4(without, nil, now, iamExecuteAPIService); tokenErr == nil ||
		!strings.Contains(tokenErr.Error(), "must carry X-Amz-Security-Token") {
		t.Fatalf("a session without its token must be refused by name: %v", tokenErr)
	}
	with := signTestRequest(t, http.MethodGet, "http://127.0.0.1:8330/items", "127.0.0.1:8330",
		record.AccessKeyID, record.Secret, "session-token", map[string]string{}, "", now)
	principal, err := runner.verifySigV4(with, nil, now, iamExecuteAPIService)
	if err != nil {
		t.Fatalf("a session with its token must verify: %v", err)
	}
	if !principal.Session || principal.BaseARN != "arn:aws:iam::787107040121:role/caller" {
		t.Fatalf("a session must resolve to its base role: %+v", principal)
	}
}
