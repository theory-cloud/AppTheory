package localrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/theory-cloud/apptheory/v6/internal/localcloudfront"
)

// Round-1 rework tests for the LOCAL-W2-R3a/R3b PR.

func TestRuntimeAPIListenerBindsLoopback(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	address := api.boundAddress()
	if address == nil {
		t.Fatal("the runtime API has no bound address")
	}
	if address.IP.IsUnspecified() {
		t.Fatalf("the runtime API listener binds every interface: %s", address)
	}
	if !address.IP.IsLoopback() {
		t.Fatalf("the loopback bind is the narrowest address: %s", address)
	}
	if !strings.HasPrefix(api.HostURL(), "http://127.0.0.1:") {
		t.Fatalf("the host URL is the loopback address: %q", api.HostURL())
	}
}

func TestRuntimeAPIGatewayFallbackKeepsLoopbackWhenTheAddressIsNotLocal(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	api.gateway = func(context.Context) (string, error) {
		// TEST-NET-1 is never an address this host owns; binding it fails, and
		// the loopback listener must stay in place.
		return "192.0.2.1", nil
	}
	before := api.listener.Addr().String()
	if api.rebindToGateway(context.Background()) {
		t.Fatal("binding a non-local gateway address must fail")
	}
	if api.listener.Addr().String() != before {
		t.Fatalf("the failed fallback moved the listener: %s -> %s", before, api.listener.Addr())
	}
	if api.gatewayBound() != "" {
		t.Fatalf("a loopback listener is not a gateway bind: %q", api.gatewayBound())
	}
}

func TestRuntimeAPIGatewayFallbackReportsAMissingGateway(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	api.gateway = func(context.Context) (string, error) {
		return "", errors.New("the run network has no gateway")
	}
	if api.rebindToGateway(context.Background()) {
		t.Fatal("a missing gateway must not move the listener")
	}
	if !api.boundAddress().IP.IsLoopback() {
		t.Fatalf("the listener must stay on loopback: %s", api.boundAddress())
	}
}

func TestNormalizeRuntimeErrorType(t *testing.T) {
	cases := map[string]string{
		"Runtime.NoSuchHandler":   "Runtime.NoSuchHandler",
		"Function.ConfigInvalid":  "Function.ConfigInvalid",
		"Runtime.lower":           "Runtime.Unknown",
		"Function.lower":          "Function.Unknown",
		"ValueError":              "Runtime.Unknown",
		"Other.Thing":             "Runtime.Unknown",
		"Runtime.":                "Runtime.Unknown",
		"":                        "",
		"  Runtime.InvalidEntry ": "Runtime.InvalidEntry",
	}
	for value, expected := range cases {
		if got := normalizeRuntimeErrorType(value); got != expected {
			t.Errorf("normalize(%q) = %q, want %q", value, got, expected)
		}
	}
}

func TestRuntimeAPIInitErrorNormalizesTheErrorTypeHeader(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	response := postRuntime(t, api, runtimeInitErrorPath, []byte(`{"errorMessage":"boom"}`),
		http.Header{runtimeErrorTypeHeader: {"ValueError"}})
	if response.status != http.StatusAccepted {
		t.Fatalf("init error status: %d", response.status)
	}
	_, result := api.Invoke(context.Background(), []byte(`{}`))
	var failure *RuntimeAPIError
	if !errors.As(result.err, &failure) {
		t.Fatalf("the init failure must fail the next invocation: %v", result.err)
	}
	if failure.Type != "Runtime.Unknown" {
		t.Fatalf("a non-conforming header must normalize: %q", failure.Type)
	}
}

func TestRuntimeAPIInvocationErrorNormalizesTheErrorTypeHeader(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	outcome := make(chan error, 1)
	go func() {
		_, result := api.Invoke(context.Background(), []byte(`{}`))
		outcome <- result.err
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	accepted := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/error",
		[]byte(`{"errorMessage":"boom"}`), http.Header{runtimeErrorTypeHeader: {"Function.bad-reason"}})
	if accepted.status != http.StatusAccepted {
		t.Fatalf("error status: %d", accepted.status)
	}
	var failure *RuntimeAPIError
	if !errors.As(<-outcome, &failure) {
		t.Fatal("the invocation error must fail the invocation")
	}
	if failure.Type != "Function.Unknown" {
		t.Fatalf("a non-conforming Function header must normalize to Function.Unknown: %+v", failure)
	}
	if failure.Message != "boom" {
		t.Fatalf("the body message must be kept: %q", failure.Message)
	}
}

func TestRuntimeAPIInvocationErrorKeepsAConformingErrorTypeHeader(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	outcome := make(chan error, 1)
	go func() {
		_, result := api.Invoke(context.Background(), []byte(`{}`))
		outcome <- result.err
	}()
	next := nextInvocation(t, api)
	requestID := next.header.Get(runtimeRequestIDHeader)
	accepted := postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/error",
		[]byte(`{"errorMessage":"boom"}`), http.Header{runtimeErrorTypeHeader: {"Function.ConfigurationError"}})
	if accepted.status != http.StatusAccepted {
		t.Fatalf("error status: %d", accepted.status)
	}
	var failure *RuntimeAPIError
	if !errors.As(<-outcome, &failure) {
		t.Fatal("the invocation error must fail the invocation")
	}
	if failure.Type != "Function.ConfigurationError" {
		t.Fatalf("a conforming header must be kept: %+v", failure)
	}
}

func TestDockerNetworkGatewayReadsTheConfiguredGateway(t *testing.T) {
	docker := &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		if !strings.Contains(strings.Join(argv, " "), "network inspect") {
			t.Fatalf("unexpected argv: %v", argv)
		}
		return "\n172.20.0.1\n\n", "", nil
	}}
	address, err := docker.NetworkGateway(context.Background(), "run-net")
	if err != nil {
		t.Fatalf("network gateway: %v", err)
	}
	if address != "172.20.0.1" {
		t.Fatalf("gateway: %q", address)
	}
}

func TestDockerNetworkGatewayFailsWithoutOne(t *testing.T) {
	docker := &Docker{exec: func(context.Context, []string) (string, string, error) {
		return "\n\n", "", nil
	}}
	if _, err := docker.NetworkGateway(context.Background(), "run-net"); err == nil {
		t.Fatal("a network with no gateway must fail")
	}
	failing := &Docker{exec: func(context.Context, []string) (string, string, error) {
		return "", "no such network", errors.New("exit status 1")
	}}
	if _, err := failing.NetworkGateway(context.Background(), "run-net"); err == nil ||
		!strings.Contains(err.Error(), "no such network") {
		t.Fatalf("inspect failure: %v", err)
	}
}

func TestFunctionProcessInvokeStreamCarriesAHandlerErrorExplicitly(t *testing.T) {
	api := testRuntimeAPI(t, 30)
	process := &FunctionProcess{Function: FunctionSpec{LogicalID: "Fn", Timeout: 30}, Container: "fn", api: api, logf: t.Logf}
	posted := make(chan struct{})
	go func() {
		next := nextInvocation(t, api)
		requestID := next.header.Get(runtimeRequestIDHeader)
		postRuntime(t, api, runtimeAPIVersionPath+"/invocation/"+requestID+"/error",
			[]byte(`{"errorMessage":"kaboom","errorType":"ValueError"}`),
			http.Header{runtimeErrorTypeHeader: {"ValueError"}})
		close(posted)
	}()
	result, err := process.InvokeStream(context.Background(), []byte(`{}`), nil)
	if err != nil {
		t.Fatalf("InvokeStream: %v", err)
	}
	<-posted
	if result.HandlerError == nil {
		t.Fatalf("a handler error must be carried explicitly, not as a body-only result: %+v", result)
	}
	if !strings.Contains(string(result.Body), "kaboom") {
		t.Fatalf("the documented error JSON stays in the body: %q", result.Body)
	}
}

func TestDecodeFunctionURLResponseInfersAGenuineJSONBody(t *testing.T) {
	body := []byte(`{"message":"Hello, world!"}`)
	decoded, err := decodeFunctionURLResponse(body)
	if err != nil {
		t.Fatalf("a non-proxy JSON body is a genuine return value: %v", err)
	}
	if decoded.StatusCode != http.StatusOK {
		t.Fatalf("inferred status: %d", decoded.StatusCode)
	}
	if got := decoded.Headers["Content-Type"]; len(got) != 1 || got[0] != "application/json" {
		t.Fatalf("inferred content type: %v", decoded.Headers)
	}
	if string(decoded.Body) != string(body) {
		t.Fatalf("inferred body: %q", decoded.Body)
	}
	quoted := []byte(`"Hello, world!"`)
	inferred, err := decodeFunctionURLResponse(quoted)
	if err != nil || inferred.StatusCode != http.StatusOK || string(inferred.Body) != string(quoted) {
		t.Fatalf("a JSON string is inferred too: %+v err=%v", inferred, err)
	}
}

func TestDecodeFunctionURLResponseRejectsAnErrorPayload(t *testing.T) {
	if _, err := decodeFunctionURLResponse([]byte(`{"errorMessage":"kaboom","errorType":"ValueError"}`)); err == nil {
		t.Fatal("an error payload is not a genuine return value")
	}
	if _, err := decodeFunctionURLResponse([]byte(`{"statusCode":"not-a-number"}`)); err == nil {
		t.Fatal("a malformed statusCode is an error")
	}
}

func TestFunctionURLPipeSinkEndAppliesTheInferenceRule(t *testing.T) {
	reader, writer := io.Pipe()
	head := make(chan streamHead, 1)
	sink := &functionURLPipeSink{writer: writer, head: head}
	sink.buffered = []byte(`{"message":"Hello, world!"}`)
	go func() {
		_, _ = io.Copy(io.Discard, reader) //nolint:errcheck // test
	}()
	_ = sink.End("", nil) //nolint:errcheck // test
	_ = writer.Close()    //nolint:errcheck // end of stream
	result := <-head
	if result.err != nil || result.status != http.StatusOK || result.header.Get("Content-Type") != "application/json" {
		t.Fatalf("inferred head: %+v", result)
	}
}

func TestFunctionURLHandlerErrorIsA502OnBothPaths(t *testing.T) {
	invoker := &fakeStreamInvoker{
		contentType: "application/json",
		streamed:    false,
		chunks:      [][]byte{[]byte(`{"errorMessage":"kaboom","errorType":"ValueError"}`)},
	}
	origin := &functionURLOrigin{originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws", authType: noneAuthorization, invoker: invoker}
	if _, fetchErr := origin.Fetch(context.Background(), localcloudfrontOriginRequest()); fetchErr == nil {
		t.Fatal("the buffered path answers a handler error with an error")
	}
	if stream, streamErr := origin.FetchStream(context.Background(), localcloudfrontOriginRequest()); streamErr == nil {
		if stream.Body != nil {
			_ = stream.Body.Close() //nolint:errcheck // test
		}
		t.Fatalf("the streaming path must answer the handler error, not %d", stream.StatusCode)
	}
}

func TestDeriveFunctionURLsRecordsTheInvokeMode(t *testing.T) {
	resources := map[string]any{
		"Fn": withAsset(lambdaFunction(nil), "asset.deadbeef"),
		"Stream": map[string]any{
			"Type": typeFunctionURL,
			"Properties": map[string]any{
				"AuthType":          noneAuthorization,
				"InvokeMode":        responseStreamMode,
				"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		},
		"Buffered": map[string]any{
			"Type": typeFunctionURL,
			"Properties": map[string]any{
				"AuthType":          noneAuthorization,
				"TargetFunctionArn": map[string]any{"Fn::GetAtt": []any{"Fn", "Arn"}},
			},
		},
	}
	dir := writeAssembly(t, resources)
	mkdirAsset(t, dir)
	spec, err := deriveAssembly(t, dir)
	if err != nil {
		t.Fatalf("derive: %v", err)
	}
	if spec.functionURLModes["Stream"] != responseStreamMode {
		t.Fatalf("RESPONSE_STREAM mode: %q", spec.functionURLModes["Stream"])
	}
	if spec.functionURLModes["Buffered"] != bufferedInvokeMode {
		t.Fatalf("an absent InvokeMode is the BUFFERED default: %q", spec.functionURLModes["Buffered"])
	}
}

func TestFunctionURLOriginUsesTheURLsInvokeMode(t *testing.T) {
	runner := &Runner{
		options:  Options{Stdout: io.Discard},
		invokers: map[string]*FunctionProcess{"Fn": {Container: "fn"}},
	}
	spec := &Spec{
		Resources: []ResourceSpec{
			{Stack: "S", LogicalID: "Url", Type: typeFunctionURL, Properties: json.RawMessage(`{"AuthType":"NONE"}`)},
		},
		functionURLTargets: map[string]string{"S/Url": "Fn"},
		functionURLModes:   map[string]string{"S/Url": bufferedInvokeMode},
	}
	origin, err := runner.functionURLOrigin(spec, &localcloudfront.DistributionOrigin{
		ID: "O", FunctionURL: "S/Url", DomainName: "url.lambda-url.local",
	})
	if err != nil {
		t.Fatalf("function URL origin: %v", err)
	}
	implementation, ok := origin.(*functionURLOrigin)
	if !ok {
		t.Fatalf("origin type: %T", origin)
	}
	if implementation.invokeMode != bufferedInvokeMode {
		t.Fatalf("the URL's InvokeMode must reach the origin: %q", implementation.invokeMode)
	}
}

func TestFunctionURLOriginFetchStreamBuffersABufferedInvokeMode(t *testing.T) {
	invoker := &fakeStreamInvoker{
		contentType: streamIntegrationContentType,
		streamed:    true,
		chunks:      framedChunks(`{"statusCode":200,"headers":{"content-type":"text/plain"}}`, "streamed"),
	}
	origin := &functionURLOrigin{
		originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws",
		authType: noneAuthorization, invokeMode: bufferedInvokeMode, invoker: invoker,
	}
	stream, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest())
	if err != nil {
		t.Fatalf("fetch stream: %v", err)
	}
	if stream.Chunked {
		t.Fatal("a BUFFERED Function URL response is complete, not chunked")
	}
	body, _ := io.ReadAll(stream.Body) //nolint:errcheck // test
	if stream.StatusCode != http.StatusOK || string(body) != "streamed" {
		t.Fatalf("buffered response: %d %q", stream.StatusCode, body)
	}
}

func TestStreamingSuffixNamesWhatEachModeDoes(t *testing.T) {
	suffix := streamingSuffix(true)
	for _, fragment := range []string{"streams in the default mode", "buffered under --rie"} {
		if !strings.Contains(suffix, fragment) {
			t.Fatalf("streaming suffix %q must say %q", suffix, fragment)
		}
	}
	if strings.Contains(suffix, "buffered locally") {
		t.Fatalf("the pre-streaming text is wrong for a streaming route: %q", suffix)
	}
	if streamingSuffix(false) != "" {
		t.Fatalf("a non-streaming route has no suffix: %q", streamingSuffix(false))
	}
}

// trailerStreamInvoker frames a response and ends it with the Runtime API
// error trailers, the documented midstream error path.
type trailerStreamInvoker struct{}

func (t *trailerStreamInvoker) Invoke(context.Context, []byte) ([]byte, error) {
	return nil, errors.New("the trailer invoker streams only")
}

func (t *trailerStreamInvoker) StreamingIncremental() bool { return true }

func (t *trailerStreamInvoker) InvokeStream(_ context.Context, _ []byte, sink StreamSink) (InvokeStreamResult, error) {
	if err := sink.Start(streamIntegrationContentType, true); err != nil {
		return InvokeStreamResult{}, err
	}
	frame := append([]byte(`{"statusCode":200,"headers":{"content-type":"text/plain"}}`), streamFrameDelimiter...)
	frame = append(frame, []byte("partial")...)
	if err := sink.Chunk(frame); err != nil {
		return InvokeStreamResult{}, err
	}
	_ = sink.End("Error", []byte(`{"errorMessage":"boom"}`)) //nolint:errcheck // test
	return InvokeStreamResult{
		Body: frame, Streamed: true, ContentType: streamIntegrationContentType,
		ErrorType: "Error", ErrorBody: []byte(`{"errorMessage":"boom"}`),
	}, nil
}

func TestFunctionURLOriginStreamEndingWithErrorTrailersIsNotACleanEOF(t *testing.T) {
	origin := &functionURLOrigin{
		originID: "origin", urlID: "url", domainName: "abc.lambda-url.us-east-1.on.aws",
		authType: noneAuthorization, invoker: &trailerStreamInvoker{},
	}
	stream, err := origin.FetchStream(context.Background(), localcloudfrontOriginRequest())
	if err != nil {
		t.Fatalf("fetch stream: %v", err)
	}
	body, readErr := io.ReadAll(stream.Body)
	if string(body) != "partial" {
		t.Fatalf("the viewer keeps the bytes the runtime wrote: %q", body)
	}
	if readErr == nil || !strings.Contains(readErr.Error(), "error trailer") {
		t.Fatalf("the trailer must end the stream with an error, not a clean EOF: %v", readErr)
	}
}

func TestStreamFrameDecoderDelimiterBeyondTheFirst16KBIsRaw(t *testing.T) {
	decoder := &streamFrameDecoder{}
	stream := append(bytes.Repeat([]byte("x"), streamFrameMetadataMax), streamFrameDelimiter...)
	stream = append(stream, []byte("payload")...)
	got := decoder.Feed(stream)
	if decoder.Framed() || !decoder.done {
		t.Fatalf("a delimiter beyond the first 16 KB must not frame the stream: framed=%v done=%v", decoder.Framed(), decoder.done)
	}
	if !bytes.Equal(got, stream) {
		t.Fatalf("the whole stream is the payload: %d bytes, want %d", len(got), len(stream))
	}
	if rest := decoder.Feed([]byte("more")); !bytes.Equal(rest, []byte("more")) {
		t.Fatalf("later chunks pass through: %q", rest)
	}
}

func TestStreamFrameDecoderDelimiterInsideTheFirst16KBFrames(t *testing.T) {
	decoder := &streamFrameDecoder{}
	metadata := `{"statusCode":200}` + strings.Repeat(" ", streamFrameMetadataMax-1-len(`{"statusCode":200}`))
	if len(metadata) != streamFrameMetadataMax-1 {
		t.Fatalf("metadata length: %d", len(metadata))
	}
	stream := append([]byte(metadata), streamFrameDelimiter...)
	stream = append(stream, []byte("payload")...)
	got := decoder.Feed(stream)
	if !decoder.Framed() {
		t.Fatal("a delimiter that starts inside the first 16 KB frames the stream")
	}
	if string(got) != "payload" {
		t.Fatalf("payload: %q", got)
	}
}
