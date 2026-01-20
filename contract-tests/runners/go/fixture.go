package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Fixture struct {
	ID     string        `json:"id"`
	Tier   string        `json:"tier"`
	Name   string        `json:"name"`
	Setup  FixtureSetup  `json:"setup"`
	Input  FixtureInput  `json:"input"`
	Expect FixtureExpect `json:"expect"`
}

type FixtureSetup struct {
	Limits      FixtureLimits             `json:"limits,omitempty"`
	Routes      []FixtureRoute            `json:"routes,omitempty"`
	WebSockets  []FixtureWebSocketRoute   `json:"websockets,omitempty"`
	SQS         []FixtureSQSRoute         `json:"sqs,omitempty"`
	EventBridge []FixtureEventBridgeRoute `json:"eventbridge,omitempty"`
	DynamoDB    []FixtureDynamoDBRoute    `json:"dynamodb,omitempty"`
}

type FixtureRoute struct {
	Method       string `json:"method"`
	Path         string `json:"path"`
	Handler      string `json:"handler"`
	AuthRequired bool   `json:"auth_required,omitempty"`
}

type FixtureWebSocketRoute struct {
	RouteKey string `json:"route_key"`
	Handler  string `json:"handler"`
}

type FixtureSQSRoute struct {
	Queue   string `json:"queue"`
	Handler string `json:"handler"`
}

type FixtureEventBridgeRoute struct {
	RuleName   string `json:"rule_name,omitempty"`
	Source     string `json:"source,omitempty"`
	DetailType string `json:"detail_type,omitempty"`
	Handler    string `json:"handler"`
}

type FixtureDynamoDBRoute struct {
	Table   string `json:"table"`
	Handler string `json:"handler"`
}

type FixtureInput struct {
	Context  FixtureContext   `json:"context,omitempty"`
	Request  *FixtureRequest  `json:"request,omitempty"`
	AWSEvent *FixtureAWSEvent `json:"aws_event,omitempty"`
}

type FixtureAWSEvent struct {
	Source string          `json:"source"`
	Event  json.RawMessage `json:"event"`
}

type FixtureContext struct {
	RemainingMS int `json:"remaining_ms,omitempty"`
}

type FixtureRequest struct {
	Method   string              `json:"method"`
	Path     string              `json:"path"`
	Query    map[string][]string `json:"query"`
	Headers  map[string][]string `json:"headers"`
	Body     FixtureBody         `json:"body"`
	IsBase64 bool                `json:"is_base64"`
}

type FixtureExpect struct {
	Response       *FixtureResponse       `json:"response,omitempty"`
	Output         json.RawMessage        `json:"output_json,omitempty"`
	WebSocketCalls []FixtureWebSocketCall `json:"ws_calls,omitempty"`
	Logs           []FixtureLogRecord     `json:"logs,omitempty"`
	Metrics        []FixtureMetricRecord  `json:"metrics,omitempty"`
	Spans          []FixtureSpanRecord    `json:"spans,omitempty"`
}

type FixtureResponse struct {
	Status   int                 `json:"status"`
	Headers  map[string][]string `json:"headers"`
	Cookies  []string            `json:"cookies"`
	Body     *FixtureBody        `json:"body,omitempty"`
	BodyJSON json.RawMessage     `json:"body_json,omitempty"`
	IsBase64 bool                `json:"is_base64"`
}

type FixtureWebSocketCall struct {
	Op           string       `json:"op"`
	Endpoint     string       `json:"endpoint,omitempty"`
	ConnectionID string       `json:"connection_id"`
	Data         *FixtureBody `json:"data,omitempty"`
}

type FixtureBody struct {
	Encoding string `json:"encoding"`
	Value    string `json:"value"`
}

type FixtureLimits struct {
	MaxRequestBytes  int `json:"max_request_bytes,omitempty"`
	MaxResponseBytes int `json:"max_response_bytes,omitempty"`
}

type FixtureLogRecord struct {
	Level     string `json:"level"`
	Event     string `json:"event"`
	RequestID string `json:"request_id"`
	TenantID  string `json:"tenant_id"`
	Method    string `json:"method"`
	Path      string `json:"path"`
	Status    int    `json:"status"`
	ErrorCode string `json:"error_code"`
}

type FixtureMetricRecord struct {
	Name  string            `json:"name"`
	Value int               `json:"value"`
	Tags  map[string]string `json:"tags"`
}

type FixtureSpanRecord struct {
	Name       string            `json:"name"`
	Attributes map[string]string `json:"attributes"`
}

func loadFixtures(fixturesRoot string) ([]Fixture, error) {
	var files []string
	for _, tier := range []string{"p0", "p1", "p2", "m1", "m2", "m3"} {
		matches, err := filepath.Glob(filepath.Join(fixturesRoot, tier, "*.json"))
		if err != nil {
			return nil, fmt.Errorf("glob %s fixtures: %w", tier, err)
		}
		files = append(files, matches...)
	}

	sort.Strings(files)
	if len(files) == 0 {
		return nil, errors.New("no fixtures found")
	}

	fixtures := make([]Fixture, 0, len(files))
	for _, file := range files {
		//nolint:gosec // Fixture files are discovered from the repo-owned fixtures directory.
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("read fixture %s: %w", file, err)
		}

		var f Fixture
		if err := json.Unmarshal(raw, &f); err != nil {
			return nil, fmt.Errorf("parse fixture %s: %w", file, err)
		}
		if strings.TrimSpace(f.ID) == "" {
			return nil, fmt.Errorf("fixture %s missing id", file)
		}
		fixtures = append(fixtures, f)
	}

	return fixtures, nil
}
