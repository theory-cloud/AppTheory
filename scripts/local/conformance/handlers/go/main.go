// Command conformance-go is the Go handler set the Runtime API conformance
// suite runs under the runner and under the Runtime Interface Emulator.
package main

import (
	"context"
	"errors"
	"io"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
)

type event struct {
	Case string `json:"case"`
}

func handler(_ context.Context, in event) (any, error) {
	switch in.Case {
	case "proxy":
		return map[string]any{
			"statusCode": 201,
			"headers": map[string]string{
				"content-type": "text/plain; charset=utf-8",
				"x-case":       "proxy",
			},
			"cookies": []string{"a=1", "b=2"},
			"body":    "go proxy body",
		}, nil
	case "error":
		return nil, errors.New("go handler error")
	case "timeout":
		time.Sleep(3 * time.Second)
		return map[string]any{"ok": true}, nil
	case "stream":
		reader, writer := io.Pipe()
		go func() {
			_, _ = writer.Write([]byte("go-1\n"))
			time.Sleep(400 * time.Millisecond)
			_, _ = writer.Write([]byte("go-2\n"))
			_ = writer.Close()
		}()
		return reader, nil
	default:
		return map[string]any{"ok": true, "case": in.Case, "runtime": "go"}, nil
	}
}

func main() {
	lambda.Start(handler)
}
