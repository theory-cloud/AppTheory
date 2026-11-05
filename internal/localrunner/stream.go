package localrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

const (
	// streamFrameDelimiterSize is the length of the separator between a
	// streaming response's metadata JSON and its payload: "The delimiter must
	// be 8 null bytes".
	// https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
	streamFrameDelimiterSize = 8
	// streamFrameMetadataMax bounds where the delimiter may appear: "it must
	// appear within the first 16KB of stream data".
	streamFrameMetadataMax = 16 << 10
	// streamIntegrationContentType is the Content-Type the Node runtime sets on
	// a response it frames for a Function URL or an API Gateway proxy
	// integration.
	// https://docs.aws.amazon.com/lambda/latest/dg/runtimes-custom.html
	streamIntegrationContentType = "application/vnd.awslambda.http-integration-response"
)

var streamFrameDelimiter = []byte{0, 0, 0, 0, 0, 0, 0, 0}

// streamFrameDecoder splits an incrementally received streaming response into
// its metadata prelude and payload. A response whose first 16 KB carry no
// delimiter is not framed: its bytes are the payload.
type streamFrameDecoder struct {
	pending  []byte
	metadata []byte
	done     bool
	framed   bool
}

// Feed accepts one chunk and returns the payload bytes that are ready to
// forward. It returns nil until the prelude is known, so a caller never writes
// the metadata JSON to the client.
func (d *streamFrameDecoder) Feed(chunk []byte) []byte {
	if d.done {
		return chunk
	}
	d.pending = append(d.pending, chunk...)
	index := bytes.Index(d.pending, streamFrameDelimiter)
	if index < 0 {
		if len(d.pending) > streamFrameMetadataMax {
			d.done = true
			d.framed = false
			out := d.pending
			d.pending = nil
			return out
		}
		return nil
	}
	metadata := bytes.TrimSpace(d.pending[:index])
	d.metadata = append([]byte(nil), metadata...)
	d.framed = len(metadata) > 0 && metadata[0] == '{'
	body := d.pending[index+streamFrameDelimiterSize:]
	d.pending = nil
	d.done = true
	if !d.framed {
		// No valid prelude: the whole stream is the payload.
		return append(append([]byte(nil), metadata...), body...)
	}
	return body
}

// Framed reports whether a metadata prelude was found.
func (d *streamFrameDecoder) Framed() bool { return d.framed }

// Metadata parses the prelude after the decoder found its frame.
func (d *streamFrameDecoder) Metadata() (streamFrameMetadata, error) {
	var metadata streamFrameMetadata
	if !d.framed {
		return metadata, nil
	}
	if err := json.Unmarshal(d.metadata, &metadata); err != nil {
		return metadata, fmt.Errorf("the streaming response metadata is not JSON: %w", err)
	}
	return metadata, nil
}

// streamFrameMetadata is the documented output format for a Lambda proxy
// integration with response streaming. A Function URL streaming prelude uses
// the same payload field names as its buffered response format.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
// https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html
type streamFrameMetadata struct {
	StatusCode        *int                `json:"statusCode"`
	Headers           map[string]string   `json:"headers"`
	MultiValueHeaders map[string][]string `json:"multiValueHeaders"`
	Cookies           []string            `json:"cookies"`
}

// apply writes the prelude's status, headers and cookies to a response. It
// drops the hop-by-hop headers the local transport owns.
func (m streamFrameMetadata) apply(header http.Header) int {
	status := http.StatusOK
	if m.StatusCode != nil && *m.StatusCode >= 100 && *m.StatusCode <= 599 {
		status = *m.StatusCode
	}
	for name, value := range m.Headers {
		if isHopByHopHeader(name) {
			continue
		}
		header.Set(name, value)
	}
	for name, values := range m.MultiValueHeaders {
		if isHopByHopHeader(name) {
			continue
		}
		header.Del(name)
		for _, value := range values {
			header.Add(name, value)
		}
	}
	for _, cookie := range m.Cookies {
		if strings.TrimSpace(cookie) != "" {
			header.Add("Set-Cookie", cookie)
		}
	}
	return status
}

// streamInvoker is the streaming half of a function process. A transport uses
// it only when the function is declared streaming and the process can forward
// chunks as they arrive.
type streamInvoker interface {
	InvokeStream(ctx context.Context, payload []byte, sink StreamSink) (InvokeStreamResult, error)
	StreamingIncremental() bool
}

// functionURLStream forwards a Function URL streaming response. A stream
// without a prelude is delivered as a raw 200 response with the runtime's
// Content-Type; the Function URL pages define only the framed case, so the
// local rule is documented in the runner reference.
type functionURLStream struct {
	writer   http.ResponseWriter
	flusher  http.Flusher
	decoder  streamFrameDecoder
	raw      bool
	buffered bool
	started  bool
	body     bytes.Buffer
}

func (f *functionURLStream) Start(contentType string, streamed bool) error {
	if !streamed {
		// A buffered response is decoded and written by the caller.
		f.buffered = true
		return nil
	}
	f.raw = strings.TrimSpace(contentType) != streamIntegrationContentType
	if f.raw {
		f.start(http.StatusOK, contentType)
	}
	return nil
}

func (f *functionURLStream) start(status int, contentType string) {
	if f.started {
		return
	}
	if contentType != "" {
		f.writer.Header().Set("Content-Type", contentType)
	}
	f.writer.WriteHeader(status)
	f.started = true
	f.flusher.Flush()
}

func (f *functionURLStream) Chunk(chunk []byte) error {
	if f.buffered {
		return nil
	}
	f.body.Write(chunk)
	if f.raw {
		return f.write(chunk)
	}
	payload := f.decoder.Feed(chunk)
	if f.started {
		return f.write(payload)
	}
	if !f.decoder.done {
		return nil
	}
	if !f.decoder.Framed() {
		f.start(http.StatusOK, streamIntegrationContentType)
		return f.write(payload)
	}
	metadata, err := f.decoder.Metadata()
	if err != nil {
		f.start(http.StatusOK, streamIntegrationContentType)
		return f.write(payload)
	}
	header := f.writer.Header()
	header.Del("Content-Type")
	status := metadata.apply(header)
	f.start(status, "")
	return f.write(payload)
}

func (f *functionURLStream) write(payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	// codeql[go/reflected-xss]
	if _, err := f.writer.Write(payload); err != nil { //nolint:gosec // the payload is the function's own response
		return err
	}
	f.flusher.Flush()
	return nil
}

func (f *functionURLStream) End(string, []byte) error {
	if f.buffered {
		return nil
	}
	if !f.started {
		f.start(http.StatusOK, "")
	}
	return nil
}

// apiGatewayStream forwards a REST API proxy integration's streaming response.
// API Gateway begins the payload stream only after it receives valid metadata
// and the delimiter; output that does not adhere to the format is a 500.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
type apiGatewayStream struct {
	writer  http.ResponseWriter
	flusher http.Flusher
	decoder streamFrameDecoder
	started bool
	invalid bool
}

func (f *apiGatewayStream) Start(_ string, streamed bool) error {
	if !streamed {
		// A buffered response has no metadata prelude, so it does not adhere to
		// the streaming format.
		f.invalid = true
	}
	return nil
}

func (f *apiGatewayStream) Chunk(chunk []byte) error {
	if f.invalid {
		return nil
	}
	payload := f.decoder.Feed(chunk)
	if f.started {
		return f.write(payload)
	}
	if !f.decoder.done {
		return nil
	}
	if !f.decoder.Framed() {
		f.invalid = true
		return nil
	}
	metadata, err := f.decoder.Metadata()
	if err != nil {
		f.invalid = true
		return nil
	}
	status := metadata.apply(f.writer.Header())
	f.writer.WriteHeader(status)
	f.started = true
	f.flusher.Flush()
	return f.write(payload)
}

func (f *apiGatewayStream) write(payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	// codeql[go/reflected-xss]
	if _, err := f.writer.Write(payload); err != nil { //nolint:gosec // the payload is the function's own response
		return err
	}
	f.flusher.Flush()
	return nil
}

// End reports whether the response adhered to the format. A caller that gets
// an error answers 500, as the API Gateway table documents.
func (f *apiGatewayStream) End(string, []byte) error {
	if f.invalid || !f.started {
		return fmt.Errorf("the streaming response did not start with valid metadata and an 8-byte delimiter")
	}
	return nil
}
