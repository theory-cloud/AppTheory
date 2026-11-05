package localrunner

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// streamingFrameSeparator is the eight NUL bytes between a streaming response's
// metadata JSON and its payload. The runner's transports parse it as the prelude
// arrives and forward the payload; a buffered caller decodes the complete frame.
// https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html
var streamingFrameSeparator = []byte{0, 0, 0, 0, 0, 0, 0, 0}

// LambdaResponse is a decoded Lambda proxy response.
type LambdaResponse struct {
	StatusCode int
	Headers    map[string][]string
	Cookies    []string
	Body       []byte
	// Streamed reports that the RIE returned a framed streaming response. The
	// body is complete, not incremental.
	Streamed bool
}

type lambdaPayload struct {
	StatusCode        int                 `json:"statusCode"`
	Headers           map[string]string   `json:"headers"`
	MultiValueHeaders map[string][]string `json:"multiValueHeaders"`
	Cookies           []string            `json:"cookies"`
	Body              string              `json:"body"`
	IsBase64Encoded   bool                `json:"isBase64Encoded"`
	ErrorType         string              `json:"errorType"`
	ErrorMessage      string              `json:"errorMessage"`
}

// HandlerError reports a Lambda invocation that ended with a handler error
// instead of a proxy response.
type HandlerError struct {
	Type    string
	Message string
	Raw     string
}

func (e *HandlerError) Error() string {
	kind := e.Type
	if kind == "" {
		kind = "Unhandled"
	}
	message := strings.TrimSpace(e.Message)
	if message == "" {
		message = strings.TrimSpace(e.Raw)
	}
	return fmt.Sprintf("handler error (%s): %s", kind, message)
}

// DecodeResponse decodes a Runtime Interface Emulator response body. It accepts
// an ordinary proxy response, a base64 body, and the RIE's buffered streaming
// framing (metadata JSON, eight NUL bytes, body).
func DecodeResponse(raw []byte) (LambdaResponse, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return LambdaResponse{}, fmt.Errorf("lambda returned an empty response")
	}
	payloadBytes, framedBody, framed, err := splitStreamingFrame(raw)
	if err != nil {
		return LambdaResponse{}, err
	}
	var payload lambdaPayload
	if err = json.Unmarshal(payloadBytes, &payload); err != nil {
		return LambdaResponse{}, fmt.Errorf("lambda response is not JSON: %w", err)
	}
	if payload.StatusCode == 0 && (payload.ErrorType != "" || payload.ErrorMessage != "") {
		return LambdaResponse{}, &HandlerError{
			Type:    payload.ErrorType,
			Message: payload.ErrorMessage,
			Raw:     truncateForMessage(string(raw)),
		}
	}
	if payload.StatusCode < 100 || payload.StatusCode > 599 {
		return LambdaResponse{}, fmt.Errorf("lambda response has invalid statusCode %d", payload.StatusCode)
	}
	response := LambdaResponse{
		StatusCode: payload.StatusCode,
		Headers:    mergeResponseHeaders(payload.Headers, payload.MultiValueHeaders),
		Cookies:    append([]string(nil), payload.Cookies...),
		Streamed:   framed,
	}
	body := payload.Body
	if framed {
		response.Body = append([]byte(nil), framedBody...)
		if payload.IsBase64Encoded {
			response.Body, err = base64.StdEncoding.DecodeString(string(framedBody))
			if err != nil {
				return LambdaResponse{}, fmt.Errorf("decode framed base64 body: %w", err)
			}
		}
		return response, nil
	}
	if payload.IsBase64Encoded {
		decoded, err := base64.StdEncoding.DecodeString(body)
		if err != nil {
			return LambdaResponse{}, fmt.Errorf("decode base64 body: %w", err)
		}
		response.Body = decoded
		return response, nil
	}
	response.Body = []byte(body)
	return response, nil
}

// splitStreamingFrame returns the metadata JSON and, when the payload is framed,
// the bytes after the eight NUL separator.
func splitStreamingFrame(raw []byte) ([]byte, []byte, bool, error) {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if !bytes.HasPrefix(trimmed, []byte("{")) {
		return raw, nil, false, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	var metadata json.RawMessage
	if err := decoder.Decode(&metadata); err != nil {
		return raw, nil, false, nil //nolint:nilerr // not a frame; the caller reports the JSON error
	}
	offset := decoder.InputOffset()
	rest := trimmed[offset:]
	if !bytes.HasPrefix(rest, streamingFrameSeparator) {
		return raw, nil, false, nil
	}
	body := rest[len(streamingFrameSeparator):]
	return metadata, body, true, nil
}

func mergeResponseHeaders(single map[string]string, multi map[string][]string) map[string][]string {
	out := make(map[string][]string, len(single)+len(multi))
	for name, value := range single {
		out[name] = []string{value}
	}
	for name, values := range multi {
		if len(values) > 0 {
			out[name] = append([]string(nil), values...)
		}
	}
	return out
}

func truncateForMessage(value string) string {
	const limit = 512
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "..."
}
