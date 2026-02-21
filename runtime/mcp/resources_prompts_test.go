package mcp

import (
	"context"
	"encoding/json"
	"testing"
)

func mustMarshal(t testing.TB, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	return b
}

func TestResourcesListAndRead_RoundTrip(t *testing.T) {
	s := NewServer("test", "1.0.0")

	if err := s.Resources().RegisterResource(ResourceDef{
		URI:         "file://hello.txt",
		Name:        "hello",
		Description: "test",
		MimeType:    "text/plain",
	}, func(_ context.Context) ([]ResourceContent, error) {
		return []ResourceContent{{URI: "file://hello.txt", MimeType: "text/plain", Text: "hello"}}, nil
	}); err != nil {
		t.Fatalf("register resource: %v", err)
	}

	listReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: "resources/list"})
	listResp, err := invokeHandler(s, listReq, nil)
	if err != nil {
		t.Fatalf("invoke resources/list: %v", err)
	}
	rpcList, err := parseJSONRPCResponse(listResp)
	if err != nil {
		t.Fatalf("parse resources/list: %v", err)
	}
	if rpcList.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcList.Error)
	}

	resultBytes := mustMarshal(t, rpcList.Result)
	var listResult struct {
		Resources []ResourceDef `json:"resources"`
	}
	if unmarshalErr := json.Unmarshal(resultBytes, &listResult); unmarshalErr != nil {
		t.Fatalf("unmarshal list result: %v", unmarshalErr)
	}
	if len(listResult.Resources) != 1 || listResult.Resources[0].URI != "file://hello.txt" {
		t.Fatalf("unexpected resources: %+v", listResult.Resources)
	}

	readParams := mustMarshal(t, map[string]any{"uri": "file://hello.txt"})
	readReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 2, Method: "resources/read", Params: readParams})
	readResp, err := invokeHandler(s, readReq, nil)
	if err != nil {
		t.Fatalf("invoke resources/read: %v", err)
	}
	rpcRead, err := parseJSONRPCResponse(readResp)
	if err != nil {
		t.Fatalf("parse resources/read: %v", err)
	}
	if rpcRead.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcRead.Error)
	}

	readResultBytes := mustMarshal(t, rpcRead.Result)
	var readResult struct {
		Contents []ResourceContent `json:"contents"`
	}
	if unmarshalErr := json.Unmarshal(readResultBytes, &readResult); unmarshalErr != nil {
		t.Fatalf("unmarshal read result: %v", unmarshalErr)
	}
	if len(readResult.Contents) != 1 || readResult.Contents[0].Text != "hello" {
		t.Fatalf("unexpected contents: %+v", readResult.Contents)
	}
}

func TestPromptsListAndGet_RoundTrip(t *testing.T) {
	s := NewServer("test", "1.0.0")

	if err := s.Prompts().RegisterPrompt(PromptDef{
		Name:        "greet",
		Description: "test",
	}, func(_ context.Context, _ json.RawMessage) (*PromptResult, error) {
		return &PromptResult{
			Messages: []PromptMessage{
				{Role: "user", Content: ContentBlock{Type: "text", Text: "hello"}},
			},
		}, nil
	}); err != nil {
		t.Fatalf("register prompt: %v", err)
	}

	listReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: "prompts/list"})
	listResp, err := invokeHandler(s, listReq, nil)
	if err != nil {
		t.Fatalf("invoke prompts/list: %v", err)
	}
	rpcList, err := parseJSONRPCResponse(listResp)
	if err != nil {
		t.Fatalf("parse prompts/list: %v", err)
	}
	if rpcList.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcList.Error)
	}

	resultBytes := mustMarshal(t, rpcList.Result)
	var listResult struct {
		Prompts []PromptDef `json:"prompts"`
	}
	if unmarshalErr := json.Unmarshal(resultBytes, &listResult); unmarshalErr != nil {
		t.Fatalf("unmarshal list result: %v", unmarshalErr)
	}
	if len(listResult.Prompts) != 1 || listResult.Prompts[0].Name != "greet" {
		t.Fatalf("unexpected prompts: %+v", listResult.Prompts)
	}

	getParams := mustMarshal(t, map[string]any{"name": "greet", "arguments": json.RawMessage(`{}`)})
	getReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 2, Method: "prompts/get", Params: getParams})
	getResp, err := invokeHandler(s, getReq, nil)
	if err != nil {
		t.Fatalf("invoke prompts/get: %v", err)
	}
	rpcGet, err := parseJSONRPCResponse(getResp)
	if err != nil {
		t.Fatalf("parse prompts/get: %v", err)
	}
	if rpcGet.Error != nil {
		t.Fatalf("unexpected error: %+v", rpcGet.Error)
	}

	getResultBytes := mustMarshal(t, rpcGet.Result)
	var out PromptResult
	if unmarshalErr := json.Unmarshal(getResultBytes, &out); unmarshalErr != nil {
		t.Fatalf("unmarshal get result: %v", unmarshalErr)
	}
	if len(out.Messages) != 1 || out.Messages[0].Content.Text != "hello" {
		t.Fatalf("unexpected messages: %+v", out.Messages)
	}
}

func TestResourcesRead_NotFoundIsInvalidParams(t *testing.T) {
	s := NewServer("test", "1.0.0")

	readParams := mustMarshal(t, map[string]any{"uri": "file://missing.txt"})
	readReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: "resources/read", Params: readParams})
	readResp, err := invokeHandler(s, readReq, nil)
	if err != nil {
		t.Fatalf("invoke resources/read: %v", err)
	}
	rpcRead, err := parseJSONRPCResponse(readResp)
	if err != nil {
		t.Fatalf("parse resources/read: %v", err)
	}
	if rpcRead.Error == nil || rpcRead.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid params error, got: %+v", rpcRead.Error)
	}
}

func TestPromptsGet_NotFoundIsInvalidParams(t *testing.T) {
	s := NewServer("test", "1.0.0")

	getParams := mustMarshal(t, map[string]any{"name": "missing", "arguments": json.RawMessage(`{}`)})
	getReq := mustMarshal(t, Request{JSONRPC: "2.0", ID: 1, Method: "prompts/get", Params: getParams})
	getResp, err := invokeHandler(s, getReq, nil)
	if err != nil {
		t.Fatalf("invoke prompts/get: %v", err)
	}
	rpcGet, err := parseJSONRPCResponse(getResp)
	if err != nil {
		t.Fatalf("parse prompts/get: %v", err)
	}
	if rpcGet.Error == nil || rpcGet.Error.Code != CodeInvalidParams {
		t.Fatalf("expected invalid params error, got: %+v", rpcGet.Error)
	}
}
