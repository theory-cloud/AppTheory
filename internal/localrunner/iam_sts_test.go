package localrunner

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"
)

// stsCall issues one STS AssumeRole form request through the endpoint.
func stsCall(t *testing.T, front *stsFront, record iamCredentialRecord, roleARN, sessionName string, at time.Time) *httptest.ResponseRecorder {
	t.Helper()
	form := url.Values{
		"Action":          {stsAssumeRoleAction},
		"Version":         {stsVersion},
		"RoleArn":         {roleARN},
		"RoleSessionName": {sessionName},
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "http://127.0.0.1/sts", strings.NewReader(form.Encode()))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	// The SDK signs the STS call with the credentials it already holds, for the
	// sts service. Sign it the same way.
	signed := signTestServiceRequest(t, request, record.AccessKeyID, record.Secret, record.SessionToken, "sts", at)
	recorder := httptest.NewRecorder()
	front.ServeHTTP(recorder, signed)
	return recorder
}

func readAllString(reader io.Reader) (string, error) {
	raw, err := io.ReadAll(reader)
	return string(raw), err
}

func ioNopCloser(value string) io.ReadCloser { return io.NopCloser(strings.NewReader(value)) }

func hexText(raw []byte) string { return hex.EncodeToString(raw) }

func sortStrings(values []string) { sort.Strings(values) }

func hmacSum(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

// signTestServiceRequest signs an existing request for one service.
func signTestServiceRequest(t *testing.T, request *http.Request, accessKeyID, secret, sessionToken, service string, at time.Time) *http.Request {
	t.Helper()
	body := ""
	if request.Body != nil {
		raw, err := readAllString(request.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		body = raw
		request.Body = ioNopCloser(body)
	}
	request.Header.Set(sigV4DateHeader, at.UTC().Format("20060102T150405Z"))
	if sessionToken != "" {
		request.Header.Set(sigV4TokenHeader, sessionToken)
	}
	payloadHash := hexText(sha256Text(body))
	request.Header.Set(sigV4ContentHashHeader, payloadHash)
	signed := []string{"host", "x-amz-content-sha256", "x-amz-date"}
	if sessionToken != "" {
		signed = append(signed, "x-amz-security-token")
	}
	sortStrings(signed)
	canonicalHeaders := ""
	for _, name := range signed {
		value := request.Header.Get(name)
		if name == "host" {
			value = request.Host
		}
		canonicalHeaders += name + ":" + strings.Join(strings.Fields(value), " ") + "\n"
	}
	canonicalRequest := strings.Join([]string{
		request.Method,
		request.URL.EscapedPath(),
		canonicalQueryForTest(request.URL.Query()),
		canonicalHeaders,
		strings.Join(signed, ";"),
		payloadHash,
	}, "\n")
	scope := at.UTC().Format("20060102") + "/" + LocalRegion + "/" + service + "/" + sigV4Terminator
	stringToSign := strings.Join([]string{
		sigV4Algorithm,
		at.UTC().Format("20060102T150405Z"),
		scope,
		hexText(sha256Text(canonicalRequest)),
	}, "\n")
	key := []byte("AWS4" + secret)
	for _, part := range []string{at.UTC().Format("20060102"), LocalRegion, service, sigV4Terminator} {
		key = hmacSum(key, part)
	}
	signature := hexText(hmacSum(key, stringToSign))
	request.Header.Set("Authorization", sigV4AuthorizationPrefix+
		"Credential="+accessKeyID+"/"+scope+", SignedHeaders="+strings.Join(signed, ";")+", Signature="+signature)
	return request
}

func TestSTSFrontAssumeRoleMintsASession(t *testing.T) {
	runner := iamTestRunner(t)
	spec := iamTestSpec(t, "", identityAllow(localPhysicalID("api", "Api")))
	runner.spec = spec
	role := iamRoleSpec{
		ARN:     "arn:aws:iam::787107040121:role/vending",
		Account: "787107040121",
		Stack:   "Stack",
		Logical: "OtherRole",
		Trust:   json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"AWS":"arn:aws:iam::787107040121:root"}}]}`),
	}
	spec.IAMRoles = append(spec.IAMRoles, role)
	caller, err := runner.mintCredential(iamCredentialRecord{
		PrincipalARN: "arn:aws:iam::787107040121:role/caller",
		BaseARN:      "arn:aws:iam::787107040121:role/caller",
		Account:      "787107040121",
		ExpiresAt:    time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	front := &stsFront{runner: runner}
	now := time.Now()
	recorder := stsCall(t, front, caller, role.ARN, "local-session", now)
	if recorder.Code != http.StatusOK {
		t.Fatalf("AssumeRole must succeed, got %d: %s", recorder.Code, recorder.Body.String())
	}
	document := recorder.Body.String()
	for _, needle := range []string{"AssumeRoleResult", "AccessKeyId", "SecretAccessKey", "SessionToken", "assumed-role/vending/local-session"} {
		if !strings.Contains(document, needle) {
			t.Fatalf("the AssumeRole response is missing %q: %s", needle, document)
		}
	}
	// The session's credentials verify, and the session cannot assume a role
	// whose trust policy does not name it.
	session, ok := runner.iamCredential(extractXMLField(document, "AccessKeyId"))
	if !ok {
		t.Fatalf("the minted session is not in the plane")
	}
	if session.BaseARN != role.ARN || !strings.Contains(session.PrincipalARN, "assumed-role/vending/") {
		t.Fatalf("unexpected session: %+v", session)
	}
	recorder = stsCall(t, front, caller, "arn:aws:iam::787107040121:role/other", "again", now)
	if recorder.Code != http.StatusForbidden || !strings.Contains(recorder.Body.String(), "AccessDenied") {
		t.Fatalf("assume-role for a role with no trust for the caller must be refused: %d %s", recorder.Code, recorder.Body.String())
	}
	// A different caller's credentials cannot assume the trusted role.
	stranger, err := runner.mintCredential(iamCredentialRecord{
		PrincipalARN: "arn:aws:iam::999999999999:role/stranger",
		BaseARN:      "arn:aws:iam::999999999999:role/stranger",
		Account:      "999999999999",
		ExpiresAt:    time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("mint stranger: %v", err)
	}
	recorder = stsCall(t, front, stranger, role.ARN, "stranger", now)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("an untrusted account must not assume the role: %d %s", recorder.Code, recorder.Body.String())
	}
	// The unsigned form is refused: a caller cannot name an access key without
	// holding its secret.
	unsigned := httptest.NewRequestWithContext(t.Context(), http.MethodPost, "http://127.0.0.1/sts",
		strings.NewReader(url.Values{"Action": {stsAssumeRoleAction}, "RoleArn": {role.ARN}, "RoleSessionName": {"x"}}.Encode()))
	unsigned.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	unsignedRecorder := httptest.NewRecorder()
	front.ServeHTTP(unsignedRecorder, unsigned)
	if unsignedRecorder.Code != http.StatusForbidden {
		t.Fatalf("an unsigned AssumeRole must be refused: %d %s", unsignedRecorder.Code, unsignedRecorder.Body.String())
	}
}

// extractXMLField reads one element's text from the response document.
func extractXMLField(document, field string) string {
	start := strings.Index(document, "<"+field+">")
	if start < 0 {
		return ""
	}
	start += len(field) + 2
	end := strings.Index(document[start:], "</"+field+">")
	if end < 0 {
		return ""
	}
	return document[start : start+end]
}

func TestIAMPlaneIsSharedAcrossRuns(t *testing.T) {
	shared := t.TempDir()
	runA := &Runner{options: Options{SharedDir: shared}, runID: "runA", scratch: t.TempDir()}
	runB := &Runner{options: Options{SharedDir: shared}, runID: "runB", scratch: t.TempDir()}
	specB := iamTestSpec(t, `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"execute-api:Invoke","Principal":{"AWS":"arn:aws:iam::111111111111:root"},"Resource":"execute-api:/lab/GET/items"}]}`, "")
	roleB := iamRoleSpec{
		ARN:     "arn:aws:iam::787107040121:role/vending",
		Account: "787107040121",
		Stack:   "Stack",
		Logical: "OtherRole",
		Trust:   json.RawMessage(`{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"AWS":"arn:aws:iam::111111111111:root"}}]}`),
	}
	specB.IAMRoles = append(specB.IAMRoles, roleB)
	if err := runA.startIAMPlane(&Spec{}); err != nil {
		t.Fatalf("start A: %v", err)
	}
	defer runA.stopIAMPlane()
	if err := runB.startIAMPlane(specB); err != nil {
		t.Fatalf("start B: %v", err)
	}
	defer runB.stopIAMPlane()

	// Run A sees the role run B published.
	if _, ok := runA.iamRole(&Spec{}, roleB.ARN); !ok {
		t.Fatal("a co-resident run's role must be visible")
	}
	// A credential run A issues is visible to run B, which is what lets a call
	// from run A's function be verified by run B.
	credential, err := runA.mintCredential(iamCredentialRecord{
		PrincipalARN: "arn:aws:iam::111111111111:role/caller",
		BaseARN:      "arn:aws:iam::111111111111:role/caller",
		Account:      "111111111111",
		ExpiresAt:    time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	record, ok := runB.iamCredential(credential.AccessKeyID)
	if !ok || record.PrincipalARN != credential.PrincipalARN {
		t.Fatalf("run B must resolve run A's credential: %+v %v", record, ok)
	}
	// The call verifies in run B and is evaluated against run B's resource
	// policy and the caller role's identity policy.
	now := time.Now()
	request := signTestRequest(t, http.MethodGet, "http://127.0.0.1:8330/items", "127.0.0.1:8330",
		credential.AccessKeyID, credential.Secret, "", map[string]string{}, "", now)
	principal, err := runB.verifySigV4(request, nil, now, iamExecuteAPIService)
	if err != nil {
		t.Fatalf("run B must verify run A's credential: %v", err)
	}
	specB.IAMRoles[0].Identity = []json.RawMessage{json.RawMessage(identityAllow(localPhysicalID("api", "Api")))}
	decision := runB.iamAllowsInvoke(specB, testCall(specB, principal))
	if decision.Allowed {
		t.Fatal("a cross-account call whose identity policy lives in run A must still need both sides; run B has no identity policy for it")
	}
	// With run B's resource policy naming the caller's account and run A's
	// identity policy visible through the plane, both sides accept.
	specB.IAMRoles[0].Identity = nil
	// The identity policy is published by the run that owns the role, so give
	// run A the same role definition and republish.
	runACallerRoles := []iamRoleSpec{{
		ARN:      principal.BaseARN,
		Account:  principal.Account,
		Stack:    "Stack",
		Logical:  "CallerRole",
		Identity: []json.RawMessage{json.RawMessage(identityAllow(localPhysicalID("api", "Api")))},
	}}
	if err := runA.publishIAMRun(&Spec{IAMRoles: runACallerRoles}); err != nil {
		t.Fatalf("republish: %v", err)
	}
	if decision := runB.iamAllowsInvoke(specB, testCall(specB, principal)); !decision.Allowed {
		t.Fatalf("the shared plane must make both sides accept: %s", decision.Reason)
	}
}

func TestRestIdentityAndV2IAMAuthorizer(t *testing.T) {
	principal := &iamPrincipal{
		ARN:         "arn:aws:sts::787107040121:assumed-role/vending/session",
		Account:     "787107040121",
		BaseARN:     "arn:aws:iam::787107040121:role/vending",
		Session:     true,
		AccessKeyID: "LOCALKEY",
		UserID:      "AROALOCAL:LOCALKEY",
	}
	identity := restIdentity(InvokeRequest{RequestID: "req", IAMPrincipal: principal})
	if identity["userArn"] != principal.ARN || identity["accountId"] != "787107040121" ||
		identity["caller"] != principal.UserID || identity["accessKey"] != "LOCALKEY" {
		t.Fatalf("unexpected REST identity: %+v", identity)
	}
	plain := restIdentity(InvokeRequest{RequestID: "req"})
	if plain["userArn"] != "" || plain["accountId"] != "" {
		t.Fatalf("a call with no IAM principal keeps the empty identity: %+v", plain)
	}
	iam := v2IAMAuthorizer(principal)
	if iam["userArn"] != principal.ARN || iam["accountId"] != "787107040121" ||
		iam["accessKey"] != "LOCALKEY" || iam["userId"] != principal.UserID {
		t.Fatalf("unexpected v2 authorizer: %+v", iam)
	}
	if iam["cognitoIdentity"] != nil || iam["principalOrgId"] != nil {
		t.Fatalf("the cognito and organization fields must be null: %+v", iam)
	}
	if v2IAMAuthorizer(nil) != nil {
		t.Fatal("a call with no principal carries no authorizer")
	}
}

func TestIAMGateRefusesWithoutAHook(t *testing.T) {
	transport := testTransport(fakeInvokerForIAM())
	transport.API.Routes[0].AuthorizerKind = AuthorizerKindIAM
	recorder := httptest.NewRecorder()
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "http://127.0.0.1/hello/world", nil)
	transport.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("an AWS_IAM route with no gate must fail closed, got %d", recorder.Code)
	}
}

func fakeInvokerForIAM() Invoker {
	return &fakeInvoker{response: []byte(`{"statusCode":200,"body":"ok"}`)}
}
