package localrunner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// AWS JSON protocol services have no SDK module in this repo (adding one would
// change the embedded Go module graph the CDK asset hashes cover). The runner
// therefore speaks the small, documented subset of the protocol it needs
// itself: a signed POST whose X-Amz-Target names the operation and whose body
// is the request JSON. DynamoDB Local requires a well-formed Authorization
// header even though it does not validate the signature; the real SigV4 signer
// from the AWS SDK produces it, so the request is indistinguishable from an SDK
// call on the wire.
//
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/streams.html
// https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/Welcome.html

const (
	awsJSONContentType = "application/x-amz-json-1.0"
	// awsJSONTimeout bounds one emulator call. Every call is loopback and cheap;
	// a hung emulator must not stall the delivery engine.
	awsJSONTimeout = 30 * time.Second
)

// awsJSONError is a typed error response from an AWS JSON protocol service.
type awsJSONError struct {
	Code    string
	Message string
	Status  int
}

func (e *awsJSONError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("%s (HTTP %d)", e.Code, e.Status)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// awsJSONClient is a minimal signed AWS JSON protocol client.
type awsJSONClient struct {
	endpoint     string
	service      string
	targetPrefix string
	http         *http.Client
	signer       *v4.Signer
	credentials  aws.Credentials
}

func newAWSJSONClient(endpoint, service, targetPrefix string) *awsJSONClient {
	return &awsJSONClient{
		endpoint:     strings.TrimSuffix(endpoint, "/"),
		service:      service,
		targetPrefix: targetPrefix,
		http: &http.Client{
			Timeout:   awsJSONTimeout,
			Transport: &http.Transport{Proxy: nil, DisableKeepAlives: false},
		},
		signer:      v4.NewSigner(),
		credentials: aws.Credentials{AccessKeyID: "dummy", SecretAccessKey: "dummy"},
	}
}

// call performs one operation. input and output are JSON-marshalable values;
// input may be nil for an operation with an empty request.
func (c *awsJSONClient) call(ctx context.Context, operation string, input, output any) error {
	var body []byte
	var err error
	if input == nil {
		body = []byte("{}")
	} else if body, err = json.Marshal(input); err != nil {
		return fmt.Errorf("encode %s request: %w", operation, err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"/", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build %s request: %w", operation, err)
	}
	request.Header.Set("Content-Type", awsJSONContentType)
	request.Header.Set("X-Amz-Target", c.targetPrefix+"."+operation)
	sum := sha256.Sum256(body)
	if signErr := c.signer.SignHTTP(ctx, c.credentials, request, hex.EncodeToString(sum[:]), c.service, LocalRegion, time.Now().UTC()); signErr != nil {
		return fmt.Errorf("sign %s request: %w", operation, signErr)
	}
	response, err := c.http.Do(request) //nolint:gosec // the endpoint is the runner's loopback emulator
	if err != nil {
		return fmt.Errorf("%s: %w", operation, err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // the body is fully read before close
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return fmt.Errorf("read %s response: %w", operation, err)
	}
	if response.StatusCode >= http.StatusMultipleChoices {
		return decodeAWSJSONError(response.StatusCode, payload)
	}
	if output == nil {
		return nil
	}
	if err := json.Unmarshal(payload, output); err != nil {
		return fmt.Errorf("decode %s response: %w", operation, err)
	}
	return nil
}

// decodeAWSJSONError maps a service error body to awsJSONError. AWS JSON
// services spell the code as __type (optionally with a namespace prefix) and
// the message as message, Message or errorMessage depending on the service.
func decodeAWSJSONError(status int, payload []byte) error {
	var body struct {
		Type         string `json:"__type"`
		Message      string `json:"message"`
		MessageTitle string `json:"Message"`
		ErrorMessage string `json:"errorMessage"`
	}
	_ = json.Unmarshal(payload, &body) //nolint:errcheck // a non-JSON error page still yields the HTTP status
	code := strings.TrimSpace(body.Type)
	if index := strings.LastIndex(code, "#"); index >= 0 {
		code = code[index+1:]
	}
	message := firstNonEmpty(body.Message, body.MessageTitle, body.ErrorMessage)
	return &awsJSONError{Code: code, Message: message, Status: status}
}

// isAWSJSONError reports whether err is a service error with one of the codes.
func isAWSJSONError(err error, codes ...string) bool {
	var serviceErr *awsJSONError
	if !errors.As(err, &serviceErr) {
		return false
	}
	for _, code := range codes {
		if strings.EqualFold(serviceErr.Code, code) {
			return true
		}
	}
	return false
}
