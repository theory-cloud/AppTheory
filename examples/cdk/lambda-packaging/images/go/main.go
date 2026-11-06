// A provided-runtime bootstrap that speaks the Lambda Runtime API directly, so
// the image needs no third-party module at build time.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

type proxyResponse struct {
	StatusCode int               `json:"statusCode"`
	Headers    map[string]string `json:"headers"`
	Body       string            `json:"body"`
}

func main() {
	endpoint := os.Getenv("AWS_LAMBDA_RUNTIME_API")
	if endpoint == "" {
		fmt.Fprintln(os.Stderr, "AWS_LAMBDA_RUNTIME_API is not set; this image expects the Lambda Runtime Interface Emulator")
		os.Exit(1)
	}
	client := &http.Client{}
	for {
		event, requestID, err := nextInvocation(client, endpoint)
		if err != nil {
			fmt.Fprintln(os.Stderr, "next invocation:", err)
			os.Exit(1)
		}
		_ = event
		body, err := json.Marshal(handler())
		if err != nil {
			fmt.Fprintln(os.Stderr, "encode response:", err)
			os.Exit(1)
		}
		if err := respond(client, endpoint, requestID, body); err != nil {
			fmt.Fprintln(os.Stderr, "post response:", err)
			os.Exit(1)
		}
	}
}

func handler() proxyResponse {
	value, err := os.ReadFile("/var/task/image-value.txt")
	if err != nil {
		value = []byte("missing")
	}
	payload, _ := json.Marshal(map[string]string{
		"runtime":    "go-provided-image",
		"imageValue": string(value),
		"taskRoot":   os.Getenv("LAMBDA_TASK_ROOT"),
	})
	return proxyResponse{
		StatusCode: 200,
		Headers:    map[string]string{"content-type": "application/json"},
		Body:       string(payload),
	}
}

func nextInvocation(client *http.Client, endpoint string) ([]byte, string, error) {
	response, err := client.Get("http://" + endpoint + "/2018-06-01/runtime/invocation/next")
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, "", err
	}
	return body, response.Header.Get("Lambda-Runtime-Aws-Request-Id"), nil
}

func respond(client *http.Client, endpoint, requestID string, body []byte) error {
	request, err := http.NewRequest(
		http.MethodPost,
		"http://"+endpoint+"/2018-06-01/runtime/invocation/"+requestID+"/response",
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusAccepted {
		return fmt.Errorf("runtime API answered %d", response.StatusCode)
	}
	return nil
}
