package localrunner

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

// functionURLOrigin invokes the real Lambda function behind an AWS::Lambda::Url
// through the function's container.
//
// The request is the payload format version 2.0 event Lambda builds for a
// Function URL; the response is the statusCode/headers/cookies/isBase64Encoded/
// body payload mapped back:
// https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
//
// A RESPONSE_STREAM URL is forwarded to the gateway as the runtime writes it:
// the prelude supplies the status and headers, and the payload after the
// 8-null-byte delimiter is the origin body.
// https://docs.aws.amazon.com/lambda/latest/dg/config-rs-invoke-furls.html
type functionURLOrigin struct {
	originID   string
	urlID      string
	functionID string
	authType   string
	// invokeMode is the URL's InvokeMode: RESPONSE_STREAM or BUFFERED (the
	// template default). An empty value on a directly constructed origin keeps
	// the streaming behaviour.
	invokeMode string
	domainName string
	invoker    Invoker
	signer     *localOACSigner
	verifyFn   func(*signedRequest) error
	now        func() time.Time
	logf       func(string, ...any)
}

// prepare builds the Function URL event, or the documented refusal when the
// URL's AWS_IAM signature does not verify. The refusal never invokes the
// function.
func (o *functionURLOrigin) prepare(request localcloudfront.OriginRequest, now time.Time) ([]byte, *localcloudfront.OriginResponse, error) {
	host := request.Host
	if host == "" {
		host = o.domainName
	}
	signed := &signedRequest{
		Method: request.Method,
		Path:   request.Path(),
		Query:  request.Query,
		Host:   host,
		Body:   request.Body,
		Now:    now,
		Header: http.Header{},
	}
	if o.authType != noneAuthorization {
		if o.signer == nil {
			return nil, nil, &localcloudfront.OriginUnavailableError{
				OriginID: o.originID,
				Reason:   fmt.Sprintf("Function URL auth type %s needs a local OAC signer", o.authType),
			}
		}
		if err := o.signer.sign(signed); err != nil {
			return nil, nil, fmt.Errorf("sign Function URL request for %s: %w", o.urlID, err)
		}
		verify := o.verifyFn
		if verify == nil {
			verify = o.signer.verify
		}
		if err := verify(signed); err != nil {
			o.logMessage("origin %s: Function URL AWS_IAM signature was rejected: %v", o.originID, err)
			refusal := localcloudfront.OriginResponse{
				StatusCode: http.StatusForbidden,
				Header:     http.Header{"Content-Type": []string{"text/plain; charset=utf-8"}},
				Body:       []byte("Forbidden: the Function URL AWS_IAM signature did not verify\n"),
			}
			return nil, &refusal, nil
		}
	}
	event, err := buildFunctionURLEvent(request, o, host, now)
	if err != nil {
		return nil, nil, err
	}
	return event, nil, nil
}

func (o *functionURLOrigin) Fetch(ctx context.Context, request localcloudfront.OriginRequest) (localcloudfront.OriginResponse, error) {
	now := time.Now().UTC()
	if o.now != nil {
		now = o.now().UTC()
	}
	event, refusal, err := o.prepare(request, now)
	if err != nil {
		return localcloudfront.OriginResponse{}, err
	}
	if refusal != nil {
		return *refusal, nil
	}
	raw, err := o.invoker.Invoke(ctx, event)
	if err != nil {
		return localcloudfront.OriginResponse{}, fmt.Errorf("invoke Function URL %s: %w", o.urlID, err)
	}
	decoded, err := decodeFunctionURLResponse(raw)
	if err != nil {
		return localcloudfront.OriginResponse{}, fmt.Errorf("decode Function URL %s response: %w", o.urlID, err)
	}
	header := http.Header{}
	for name, values := range decoded.Headers {
		if isHopByHopHeader(name) {
			continue
		}
		for _, value := range values {
			header.Add(name, value)
		}
	}
	for _, cookie := range decoded.Cookies {
		header.Add("Set-Cookie", cookie)
	}
	return localcloudfront.OriginResponse{
		StatusCode:        decoded.StatusCode,
		StatusDescription: http.StatusText(decoded.StatusCode),
		Header:            header,
		Body:              decoded.Body,
	}, nil
}

// FetchStream returns the function's status and headers as soon as its stream
// produces the prelude, with a body that yields each payload chunk.
func (o *functionURLOrigin) FetchStream(ctx context.Context, request localcloudfront.OriginRequest) (localcloudfront.StreamResponse, error) {
	streamer, ok := o.invoker.(streamInvoker)
	if !ok || !streamer.StreamingIncremental() || o.invokeMode == bufferedInvokeMode {
		// The URL is BUFFERED, or the invoker cannot forward chunks (the --rie
		// emulator buffers every response, and any other invoker without
		// StreamingIncremental does too). Serve the buffered response as a
		// complete, non-chunked stream so a CloudFront distribution with this
		// origin works in that mode, exactly as the Function URL listener
		// falls back to Invoke.
		response, err := o.Fetch(ctx, request)
		if err != nil {
			return localcloudfront.StreamResponse{}, err
		}
		return localcloudfront.StreamResponse{
			StatusCode:        response.StatusCode,
			StatusDescription: response.StatusDescription,
			Header:            response.Header,
			Body:              io.NopCloser(bytes.NewReader(response.Body)),
			Chunked:           false,
		}, nil
	}
	now := time.Now().UTC()
	if o.now != nil {
		now = o.now().UTC()
	}
	event, refusal, err := o.prepare(request, now)
	if err != nil {
		return localcloudfront.StreamResponse{}, err
	}
	if refusal != nil {
		return localcloudfront.StreamResponse{
			StatusCode: refusal.StatusCode,
			Header:     refusal.Header,
			Body:       io.NopCloser(bytes.NewReader(refusal.Body)),
			Chunked:    true,
		}, nil
	}
	reader, writer := io.Pipe()
	head := make(chan streamHead, 1)
	sink := &functionURLPipeSink{writer: writer, head: head}
	go func() {
		result, invokeErr := streamer.InvokeStream(ctx, event, sink)
		if invokeErr == nil && result.HandlerError != nil {
			// A handler error, a timeout, a crash or an init failure never
			// produces a response; answer the gateway now instead of leaving it
			// blocked on the viewer's request context.
			invokeErr = result.HandlerError
		}
		sink.finish(invokeErr)
		_ = writer.CloseWithError(invokeErr) //nolint:errcheck // the reader decides how to report it
	}()
	select {
	case result := <-head:
		if result.err != nil {
			_ = reader.CloseWithError(result.err) //nolint:errcheck // the gateway reports the error
			return localcloudfront.StreamResponse{}, fmt.Errorf("invoke Function URL %s: %w", o.urlID, result.err)
		}
		return localcloudfront.StreamResponse{
			StatusCode:        result.status,
			StatusDescription: http.StatusText(result.status),
			Header:            result.header,
			Body:              reader,
			Chunked:           true,
		}, nil
	case <-ctx.Done():
		_ = reader.CloseWithError(ctx.Err()) //nolint:errcheck // the request is over
		return localcloudfront.StreamResponse{}, ctx.Err()
	}
}

// streamHead is the status and headers the gateway needs before it can begin
// forwarding the payload.
type streamHead struct {
	status int
	header http.Header
	err    error
}

// functionURLPipeSink parses the Function URL streaming prelude and pipes the
// payload to the gateway.
type functionURLPipeSink struct {
	writer   *io.PipeWriter
	head     chan streamHead
	sent     bool
	buffered []byte
	decoder  streamFrameDecoder
	raw      bool
	ctype    string
}

func (s *functionURLPipeSink) Start(contentType string, streamed bool) error {
	s.ctype = contentType
	if !streamed {
		// A buffered proxy response is decoded when the invocation ends.
		s.raw = false
		return nil
	}
	s.raw = strings.TrimSpace(contentType) != streamIntegrationContentType
	return nil
}

//nolint:gocognit,gocyclo // the framed/raw split is the documented Function URL format
func (s *functionURLPipeSink) Chunk(chunk []byte) error {
	if s.ctype == "" || s.raw {
		if !s.sent {
			header := http.Header{}
			if s.ctype != "" {
				header.Set("Content-Type", s.ctype)
			}
			s.send(http.StatusOK, header)
		}
		if len(chunk) > 0 {
			if _, err := s.writer.Write(chunk); err != nil {
				return err
			}
		}
		return nil
	}
	s.buffered = append(s.buffered, chunk...)
	payload := s.decoder.Feed(chunk)
	if s.decoder.done && !s.sent {
		if !s.decoder.Framed() {
			s.send(http.StatusOK, http.Header{"Content-Type": []string{streamIntegrationContentType}})
			if len(payload) > 0 {
				if _, err := s.writer.Write(payload); err != nil {
					return err
				}
			}
			return nil
		}
		metadata, err := s.decoder.Metadata()
		if err != nil {
			s.send(http.StatusOK, http.Header{"Content-Type": []string{streamIntegrationContentType}})
			if len(payload) > 0 {
				if _, writeErr := s.writer.Write(payload); writeErr != nil {
					return writeErr
				}
			}
			return nil
		}
		header := http.Header{}
		status := metadata.apply(header)
		s.send(status, header)
		if len(payload) > 0 {
			if _, err := s.writer.Write(payload); err != nil {
				return err
			}
		}
		return nil
	}
	if s.sent && len(payload) > 0 {
		if _, err := s.writer.Write(payload); err != nil {
			return err
		}
	}
	return nil
}

func (s *functionURLPipeSink) send(status int, header http.Header) {
	if s.sent {
		return
	}
	s.sent = true
	s.head <- streamHead{status: status, header: header}
}

func (s *functionURLPipeSink) End(_ string, _ []byte) error {
	if s.sent {
		return nil
	}
	if s.decoder.done && s.decoder.Framed() {
		return nil
	}
	// A buffered response: decode it with the same rule as Fetch and emit it as
	// a complete body. A body the buffered path answers with 502 is a 502 here
	// too, never a 200 carrying the raw bytes.
	decoded, err := decodeFunctionURLResponse(s.buffered)
	if err != nil {
		s.sendError(fmt.Errorf("decode Function URL response: %w", err))
		return nil
	}
	header := http.Header{}
	for name, values := range decoded.Headers {
		if isHopByHopHeader(name) {
			continue
		}
		for _, value := range values {
			header.Add(name, value)
		}
	}
	for _, cookie := range decoded.Cookies {
		header.Add("Set-Cookie", cookie)
	}
	s.send(decoded.StatusCode, header)
	if len(decoded.Body) > 0 {
		_, _ = s.writer.Write(decoded.Body) //nolint:errcheck // reported by the pipe
	}
	return nil
}

// sendError answers the prelude with an error instead of a status; FetchStream
// turns it into the gateway's 502, the same status the buffered path produces.
func (s *functionURLPipeSink) sendError(err error) {
	if s.sent {
		return
	}
	s.sent = true
	s.head <- streamHead{err: err}
}

// finish reports a transport failure when no head was produced, so the gateway
// can answer instead of waiting on a body that will never arrive.
func (s *functionURLPipeSink) finish(err error) {
	if s.sent || err == nil {
		return
	}
	s.sendError(err)
}

func (o *functionURLOrigin) logMessage(format string, args ...any) {
	if o.logf != nil {
		o.logf(format, args...)
	}
}

// decodeFunctionURLResponse is the one Function URL decoding rule: the buffered
// Fetch path and the Function URL pipe sink both use it, so a body the buffered
// path answers with 502 is a 502 on the streaming path too.
//
// A non-proxy return value follows the page's inference rule: "If your function
// returns valid JSON and doesn't return a statusCode, Lambda assumes the
// following: statusCode is 200 ... content-type is application/json ... body is
// the function response ... isBase64Encoded is false." An error payload
// (errorType/errorMessage without a statusCode) is a failed invocation, not a
// genuine return value: the runner's documented handler-error rule keeps it a
// 502.
// https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
func decodeFunctionURLResponse(raw []byte) (LambdaResponse, error) {
	response, err := DecodeResponse(raw)
	if err == nil {
		return response, nil
	}
	var handlerErr *HandlerError
	if errors.As(err, &handlerErr) {
		return LambdaResponse{}, err
	}
	trimmed := bytes.TrimSpace(raw)
	if !json.Valid(trimmed) {
		return LambdaResponse{}, err
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(trimmed, &object) == nil {
		if _, hasStatus := object["statusCode"]; hasStatus {
			return LambdaResponse{}, err
		}
	}
	return LambdaResponse{
		StatusCode: http.StatusOK,
		Headers:    map[string][]string{"Content-Type": {"application/json"}},
		Body:       raw,
	}, nil
}

func buildFunctionURLEvent(
	request localcloudfront.OriginRequest,
	origin *functionURLOrigin,
	host string,
	now time.Time,
) ([]byte, error) {
	headers := map[string]string{}
	for name, values := range request.Header {
		lower := strings.ToLower(name)
		if lower == "cookie" || strings.HasPrefix(lower, "x-amz-") || lower == "authorization" {
			continue
		}
		headers[lower] = strings.Join(values, ",")
	}
	headers["host"] = host
	cookies := cookiePairsToStrings(request.Header.Values("Cookie"))
	query := queryStringParameters(request.Query)
	body := request.Body
	isBase64 := false
	bodyText := string(body)
	if len(body) > 0 && !utf8.Valid(body) {
		bodyText = base64.StdEncoding.EncodeToString(body)
		isBase64 = true
	}
	domainName := host
	if domainName == "" {
		domainName = origin.domainName
	}
	domainPrefix := domainName
	if index := strings.IndexByte(domainPrefix, '.'); index >= 0 {
		domainPrefix = domainPrefix[:index]
	}
	requestContext := map[string]any{
		"accountId":      LocalAccountID,
		"apiId":          domainPrefix,
		"authentication": nil,
		"domainName":     domainName,
		"domainPrefix":   domainPrefix,
		"http": map[string]any{
			"method":    request.Method,
			"path":      request.Path(),
			"protocol":  "HTTP/1.1",
			"sourceIp":  request.ViewerIP,
			"userAgent": request.Header.Get("User-Agent"),
		},
		"requestId": request.RequestID,
		"routeKey":  "$default",
		"stage":     "$default",
		"time":      now.UTC().Format("02/Jan/2006:15:04:05 -0700"),
		"timeEpoch": now.UnixMilli(),
	}
	if origin.authType != noneAuthorization && origin.signer != nil {
		requestContext["authorizer"] = map[string]any{
			"iam": map[string]any{
				"accessKey":       origin.signer.accessKey,
				"accountId":       LocalAccountID,
				"callerId":        "APPTHEORYLOCALOAC",
				"cognitoIdentity": nil,
				"principalOrgId":  nil,
				"userArn":         "arn:" + LocalPartition + ":iam::" + LocalAccountID + ":user/apptheory-local-oac",
				"userId":          "APPTHEORYLOCALOAC",
			},
		}
	}
	event := map[string]any{
		"version":               "2.0",
		"routeKey":              "$default",
		"rawPath":               request.Path(),
		"rawQueryString":        request.Query,
		"cookies":               cookies,
		"headers":               headers,
		"queryStringParameters": query,
		"requestContext":        requestContext,
		"body":                  bodyText,
		"isBase64Encoded":       isBase64,
		"pathParameters":        nil,
		"stageVariables":        nil,
	}
	return json.Marshal(event)
}

func cookiePairsToStrings(values []string) []string {
	var out []string
	for _, header := range values {
		for _, part := range strings.Split(header, ";") {
			part = strings.TrimSpace(part)
			name, value, found := strings.Cut(part, "=")
			if !found || strings.TrimSpace(name) == "" {
				continue
			}
			out = append(out, strings.TrimSpace(name)+"="+value)
		}
	}
	return out
}

func queryStringParameters(raw string) map[string]string {
	if raw == "" {
		return nil
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil
	}
	out := make(map[string]string, len(values))
	for name, entries := range values {
		out[name] = strings.Join(entries, ",")
	}
	return out
}

// localOACSigner reproduces the SigV4 signing CloudFront OAC performs for an
// AWS_IAM Function URL: every origin request is signed over the method, path,
// query, Host, body hash and date, and the Function URL verifies the signature
// before the handler is invoked. The credentials are per-run loopback values;
// IAM policy evaluation (the function's resource-based policy and CloudFront's
// source ARN condition) is not emulated.
type localOACSigner struct {
	accessKey    string
	secretKey    string
	region       string
	service      string
	maxClockSkew time.Duration
}

type signedRequest struct {
	Method string
	Path   string
	Query  string
	Host   string
	Body   []byte
	Now    time.Time
	Header http.Header
}

const (
	localOACAccessKey = "APPTHEORYLOCALOAC"
	localOACSecretKey = "apptheory-local-oac-secret" //nolint:gosec // loopback dummy credential, never valid against AWS
)

func newLocalOACSigner() *localOACSigner {
	return &localOACSigner{
		accessKey:    localOACAccessKey,
		secretKey:    localOACSecretKey,
		region:       LocalRegion,
		service:      "lambda",
		maxClockSkew: 5 * time.Minute,
	}
}

func (s *localOACSigner) sign(request *signedRequest) error {
	if request.Header == nil {
		request.Header = http.Header{}
	}
	now := request.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	amzDate := now.Format("20060102T150405Z")
	date := now.Format("20060102")
	payloadHash := sha256Hex(request.Body)
	canonicalHeaders := "host:" + strings.ToLower(request.Host) + "\n" +
		"x-amz-content-sha256:" + payloadHash + "\n" +
		"x-amz-date:" + amzDate + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalRequest := strings.Join([]string{
		request.Method,
		canonicalURI(request.Path),
		canonicalQuery(request.Query),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")
	scope := date + "/" + s.region + "/" + s.service + "/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")
	signature := hex.EncodeToString(hmacSHA256(s.signingKey(date), []byte(stringToSign)))
	request.Header.Set("X-Amz-Date", amzDate)
	request.Header.Set("X-Amz-Content-Sha256", payloadHash)
	request.Header.Set("Authorization", "AWS4-HMAC-SHA256 Credential="+s.accessKey+"/"+scope+
		", SignedHeaders="+signedHeaders+", Signature="+signature)
	return nil
}

func (s *localOACSigner) verify(request *signedRequest) error {
	fields, err := parseOACAuthorization(request.Header.Get("Authorization"))
	if err != nil {
		return err
	}
	credential := fields["Credential"]
	parts := strings.Split(credential, "/")
	if len(parts) != 5 || parts[0] != s.accessKey {
		return fmt.Errorf("authorization credential %q is not the local OAC access key", credential)
	}
	date, region, service, terminator := parts[1], parts[2], parts[3], parts[4]
	if region != s.region || service != s.service || terminator != "aws4_request" {
		return fmt.Errorf("authorization scope %q is not the local OAC scope", strings.Join(parts[1:], "/"))
	}
	amzDate := request.Header.Get("X-Amz-Date")
	signedAt, err := time.Parse("20060102T150405Z", amzDate)
	if err != nil {
		return fmt.Errorf("x-amz-date %q is not an ISO 8601 timestamp: %w", amzDate, err)
	}
	if err := s.verifyClock(request.Now, signedAt); err != nil {
		return err
	}
	payloadHash := request.Header.Get("X-Amz-Content-Sha256")
	if payloadHash != sha256Hex(request.Body) {
		return errors.New("the payload hash does not match the request body")
	}
	signedHeaders := fields["SignedHeaders"]
	if signedHeaders != "host;x-amz-content-sha256;x-amz-date" {
		return fmt.Errorf("signed headers %q are not the ones the local OAC signs", signedHeaders)
	}
	scope := date + "/" + region + "/" + service + "/aws4_request"
	canonicalRequest := canonicalOACRequest(request, payloadHash, signedHeaders, amzDate)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256Hex([]byte(canonicalRequest)),
	}, "\n")
	expected := hex.EncodeToString(hmacSHA256(s.signingKey(date), []byte(stringToSign)))
	if !hmac.Equal([]byte(expected), []byte(fields["Signature"])) {
		return errors.New("the signature does not match the request")
	}
	return nil
}

func parseOACAuthorization(authorization string) (map[string]string, error) {
	if !strings.HasPrefix(authorization, "AWS4-HMAC-SHA256 ") {
		return nil, errors.New("missing AWS4-HMAC-SHA256 authorization header")
	}
	fields := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(authorization, "AWS4-HMAC-SHA256 "), ",") {
		name, value, found := strings.Cut(strings.TrimSpace(part), "=")
		if found {
			fields[name] = value
		}
	}
	if fields["Credential"] == "" || fields["SignedHeaders"] == "" || fields["Signature"] == "" {
		return nil, errors.New("authorization header is missing its credential, signed headers or signature")
	}
	return fields, nil
}

func (s *localOACSigner) verifyClock(now, signedAt time.Time) error {
	if s.maxClockSkew <= 0 {
		return nil
	}
	skew := now.Sub(signedAt)
	if skew < 0 {
		skew = -skew
	}
	if skew > s.maxClockSkew {
		return fmt.Errorf("the signature is outside the %s clock skew window", s.maxClockSkew)
	}
	return nil
}

func canonicalOACRequest(request *signedRequest, payloadHash, signedHeaders, amzDate string) string {
	canonicalHeaders := "host:" + strings.ToLower(request.Host) + "\n" +
		"x-amz-content-sha256:" + payloadHash + "\n" +
		"x-amz-date:" + amzDate + "\n"
	return strings.Join([]string{
		request.Method,
		canonicalURI(request.Path),
		canonicalQuery(request.Query),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")
}

func (s *localOACSigner) signingKey(date string) []byte {
	key := hmacSHA256([]byte("AWS4"+s.secretKey), []byte(date))
	key = hmacSHA256(key, []byte(s.region))
	key = hmacSHA256(key, []byte(s.service))
	return hmacSHA256(key, []byte("aws4_request"))
}

func hmacSHA256(key, value []byte) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(value) //nolint:errcheck // hash.Hash.Write never fails
	return mac.Sum(nil)
}

func sha256Hex(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func canonicalURI(path string) string {
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return path
}

func canonicalQuery(query string) string {
	if query == "" {
		return ""
	}
	values, err := url.ParseQuery(query)
	if err != nil {
		return query
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var parts []string
	for _, key := range keys {
		for _, value := range values[key] {
			parts = append(parts, url.QueryEscape(key)+"="+url.QueryEscape(value))
		}
	}
	return strings.Join(parts, "&")
}
