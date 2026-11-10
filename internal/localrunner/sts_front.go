package localrunner

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The local STS endpoint.
//
// Every function the run starts receives credentials the runner issued and
// `AWS_ENDPOINT_URL_STS` pointing at this endpoint, so an SDK's AssumeRole call
// is answered locally. The pinned moto answers STS too, and it answers any role
// whether or not it exists or trusts the caller; the runner therefore fronts it:
// AssumeRole is decided by the role's trust policy alone, which is the one named
// local divergence docs/127 W3-D1 records. Every other STS action is proxied to
// the configured backend unchanged, so GetCallerIdentity keeps working exactly
// as it did.
//
// https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
// https://docs.aws.amazon.com/STS/latest/APIReference/welcome.html

const (
	// stsVersion is the API version the SDKs send.
	stsVersion = "2011-06-15"
	// stsAssumeRoleAction is the one action the runner decides itself.
	stsAssumeRoleAction = "AssumeRole"
)

// stsFront serves the local STS endpoint.
type stsFront struct {
	runner *Runner
}

// startSTSFront serves the STS endpoint and records the URL functions reach.
func (r *Runner) startSTSFront(ctx context.Context) error {
	listeners, err := r.listenControl(ctx, "STS")
	if err != nil {
		return err
	}
	front := &stsFront{runner: r}
	server := &http.Server{
		Handler:           front,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	r.servers = append(r.servers, server)
	go func() {
		if serveErr := server.Serve(listeners.Loopback); serveErr != nil &&
			!errors.Is(serveErr, http.ErrServerClosed) {
			r.logf("local STS endpoint stopped: %v", serveErr)
		}
	}()
	if listeners.Gateway != nil {
		go func() {
			if serveErr := server.Serve(listeners.Gateway); serveErr != nil &&
				!errors.Is(serveErr, http.ErrServerClosed) {
				r.logf("local STS endpoint stopped: %v", serveErr)
			}
		}()
	}
	r.iamSTSURL = fmt.Sprintf("http://%s:%d", controlLeafName, listeners.Port)
	r.logf("local STS endpoint for functions: %s", r.iamSTSURL)
	return nil
}

// ServeHTTP answers AssumeRole and proxies every other action.
//
// https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
func (f *stsFront) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	values, body, err := stsRequestValues(request)
	if err != nil {
		writeSTSError(writer, http.StatusBadRequest, "InvalidParameterValue", err.Error())
		return
	}
	// The signature covers the form body, so the verifier reads the same bytes
	// the parser did.
	request.Body = io.NopCloser(bytes.NewReader(body))
	if values.Get("Action") != stsAssumeRoleAction {
		f.proxy(writer, request, values)
		return
	}
	credentials, err := f.runner.assumeRole(request, assumeRoleRequest{
		RoleARN:         values.Get("RoleArn"),
		RoleSessionName: values.Get("RoleSessionName"),
		DurationSeconds: values.Get("DurationSeconds"),
		ExternalID:      values.Get("ExternalId"),
	})
	if err != nil {
		var refusal *stsRefusal
		if errors.As(err, &refusal) {
			writeSTSError(writer, refusal.status, refusal.code, refusal.message)
			return
		}
		writeSTSError(writer, http.StatusInternalServerError, "ServiceFailure", err.Error())
		return
	}
	writeSTSResponse(writer, credentials)
}

// proxy forwards an action the runner does not implement to the configured STS
// backend, so an action the pinned emulator serves keeps its behavior.
func (f *stsFront) proxy(writer http.ResponseWriter, request *http.Request, values url.Values) {
	backend, ok := f.runner.backendForService("sts")
	if !ok || backend.HostURL == "" {
		writeSTSError(writer, http.StatusNotImplemented, "InvalidAction",
			fmt.Sprintf("the local STS endpoint serves AssumeRole; %q needs the --backend moto STS endpoint", values.Get("Action")))
		return
	}
	target, err := url.Parse(backend.HostURL)
	if err != nil {
		writeSTSError(writer, http.StatusInternalServerError, "ServiceFailure", err.Error())
		return
	}
	target.Path = "/"
	body := strings.NewReader(values.Encode())
	outbound, err := http.NewRequestWithContext(request.Context(), http.MethodPost, target.String(), body)
	if err != nil {
		writeSTSError(writer, http.StatusInternalServerError, "ServiceFailure", err.Error())
		return
	}
	outbound.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	outbound.Header.Set("Host", target.Host)
	response, err := (&http.Client{Timeout: 30 * time.Second}).Do(outbound)
	if err != nil {
		writeSTSError(writer, http.StatusBadGateway, "ServiceFailure", err.Error())
		return
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // the body is streamed below
	writer.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	writer.WriteHeader(response.StatusCode)
	_, _ = io.Copy(writer, response.Body) //nolint:errcheck // the response is committed
}

// stsRequestValues reads the query-protocol form. An SDK posts it; a caller may
// also send it in the query string.
func stsRequestValues(request *http.Request) (url.Values, []byte, error) {
	values := url.Values{}
	for key, list := range request.URL.Query() {
		values[key] = append(values[key], list...)
	}
	var body []byte
	if request.Method == http.MethodPost && request.Body != nil {
		raw, err := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		if err != nil {
			return nil, nil, fmt.Errorf("read the STS request body: %w", err)
		}
		body = raw
		form, err := url.ParseQuery(string(raw))
		if err != nil {
			return nil, nil, fmt.Errorf("parse the STS request body: %w", err)
		}
		for key, list := range form {
			values[key] = append(values[key], list...)
		}
	}
	return values, body, nil
}

// assumeRoleRequest is one AssumeRole call the endpoint decides.
type assumeRoleRequest struct {
	RoleARN         string
	RoleSessionName string
	DurationSeconds string
	ExternalID      string
}

// stsRefusal is a named STS error.
type stsRefusal struct {
	status  int
	code    string
	message string
}

func (e *stsRefusal) Error() string { return e.code + ": " + e.message }

// assumeRole decides AssumeRole by the role's trust policy alone and mints a
// session.
//
// https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
func (r *Runner) assumeRole(httpRequest *http.Request, request assumeRoleRequest) (iamCredentialRecord, error) {
	if strings.TrimSpace(request.RoleARN) == "" {
		return iamCredentialRecord{}, &stsRefusal{http.StatusBadRequest, "ValidationError", "RoleArn is required"}
	}
	spec := r.CurrentSpec()
	if spec == nil {
		return iamCredentialRecord{}, &stsRefusal{http.StatusInternalServerError, "ServiceFailure", "the run has no derived surface"}
	}
	// The SDK signs the STS call with the credentials it already has, for the
	// sts service. The same canonicalization verifies it, so a request cannot
	// name an access key without holding its secret.
	caller, err := r.verifySigV4SignedRequest(httpRequest, "sts")
	if err != nil {
		var refusal *sigV4Error
		if errors.As(err, &refusal) {
			return iamCredentialRecord{}, &stsRefusal{http.StatusForbidden, "InvalidClientTokenId", refusal.reason}
		}
		return iamCredentialRecord{}, &stsRefusal{http.StatusForbidden, "InvalidClientTokenId", err.Error()}
	}
	role, ok := r.iamRole(spec, request.RoleARN)
	if !ok {
		return iamCredentialRecord{}, &stsRefusal{
			http.StatusForbidden, "AccessDenied",
			fmt.Sprintf("role %s is not defined by this run or any co-resident run", request.RoleARN),
		}
	}
	allowed, reason := r.iamAllowsAssumeRole(spec, role, caller)
	if !allowed {
		return iamCredentialRecord{}, &stsRefusal{http.StatusForbidden, "AccessDenied", reason}
	}
	duration := iamSessionDefaultDuration
	if strings.TrimSpace(request.DurationSeconds) != "" {
		var seconds int
		if _, scanErr := fmt.Sscanf(request.DurationSeconds, "%d", &seconds); scanErr != nil || seconds < 900 {
			return iamCredentialRecord{}, &stsRefusal{
				http.StatusBadRequest, "ValidationError",
				"DurationSeconds must be an integer of at least 900 seconds",
			}
		}
		duration = time.Duration(seconds) * time.Second
		if duration > iamSessionMaxDuration {
			duration = iamSessionMaxDuration
		}
	}
	sessionName := iamSessionName(request.RoleSessionName)
	secret, err := newSecretKey()
	if err != nil {
		return iamCredentialRecord{}, err
	}
	token, err := newSecretKey()
	if err != nil {
		return iamCredentialRecord{}, err
	}
	record := iamCredentialRecord{
		Kind:         iamCredentialFileType,
		AccessKeyID:  newAccessKeyID(),
		Secret:       secret,
		SessionToken: token,
		PrincipalARN: iamSessionARN(role.ARN, sessionName),
		BaseARN:      role.ARN,
		Account:      role.Account,
		IssuedAt:     time.Now().UTC(),
		ExpiresAt:    time.Now().UTC().Add(duration),
	}
	if err := r.addIAMCredential(record); err != nil {
		return iamCredentialRecord{}, err
	}
	r.logf("local STS: %s assumed %s as %s for %s", caller.ARN, role.ARN, sessionName, duration)
	return record, nil
}

// writeSTSResponse writes the AssumeRole result document.
//
// https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html
func writeSTSResponse(writer http.ResponseWriter, credentials iamCredentialRecord) {
	type assumedRoleUser struct {
		AssumedRoleID string `xml:"AssumedRoleId"`
		ARN           string `xml:"Arn"`
	}
	type credentialsXML struct {
		AccessKeyID     string `xml:"AccessKeyId"`
		SecretAccessKey string `xml:"SecretAccessKey"`
		SessionToken    string `xml:"SessionToken"`
		Expiration      string `xml:"Expiration"`
	}
	type result struct {
		Credentials     credentialsXML  `xml:"Credentials"`
		AssumedRoleUser assumedRoleUser `xml:"AssumedRoleUser"`
	}
	type response struct {
		XMLName xml.Name `xml:"https://sts.amazonaws.com/doc/2011-06-15/ AssumeRoleResponse"`
		Result  result   `xml:"AssumeRoleResult"`
	}
	document := response{Result: result{
		Credentials: credentialsXML{
			AccessKeyID:     credentials.AccessKeyID,
			SecretAccessKey: credentials.Secret,
			SessionToken:    credentials.SessionToken,
			Expiration:      credentials.ExpiresAt.UTC().Format(time.RFC3339),
		},
		AssumedRoleUser: assumedRoleUser{
			AssumedRoleID: "AROALOCAL:" + credentials.PrincipalARN[strings.LastIndex(credentials.PrincipalARN, "/")+1:],
			ARN:           credentials.PrincipalARN,
		},
	}}
	encoded, err := xml.Marshal(document)
	if err != nil {
		writeSTSError(writer, http.StatusInternalServerError, "ServiceFailure", err.Error())
		return
	}
	writer.Header().Set("Content-Type", "text/xml")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write([]byte(xml.Header)) //nolint:errcheck // the response is committed
	_, _ = writer.Write(encoded)            //nolint:errcheck // the response is committed
}

// writeSTSError writes the STS error document.
//
// https://docs.aws.amazon.com/STS/latest/APIReference/CommonErrors.html
func writeSTSError(writer http.ResponseWriter, status int, code, message string) {
	type errorResponse struct {
		XMLName xml.Name `xml:"https://sts.amazonaws.com/doc/2011-06-15/ ErrorResponse"`
		Type    string   `xml:"Error>Type"`
		Code    string   `xml:"Error>Code"`
		Message string   `xml:"Error>Message"`
	}
	document := errorResponse{Type: "Sender", Code: code, Message: message}
	encoded, err := xml.Marshal(document)
	if err != nil {
		http.Error(writer, message, status)
		return
	}
	writer.Header().Set("Content-Type", "text/xml")
	writer.WriteHeader(status)
	_, _ = writer.Write([]byte(xml.Header)) //nolint:errcheck // the response is committed
	_, _ = writer.Write(encoded)            //nolint:errcheck // the response is committed
}
