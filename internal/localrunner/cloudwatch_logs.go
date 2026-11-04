package localrunner

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// The CloudWatch Logs client speaks the small AWS JSON protocol subset the
// runner needs: log groups, log streams, PutLogEvents and FilterLogEvents.
// CloudWatch Logs uses the AWS JSON protocol with lowerCamelCase members
// (https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutLogEvents.html),
// so it shares the signed JSON transport with DynamoDB Streams.
//
// The observed moto responses are modeled in the unit tests; the wire shapes
// are:
//   - CreateLogGroup {logGroupName}
//   - CreateLogStream {logGroupName, logStreamName}
//   - DescribeLogGroups {logGroupNamePrefix} -> {logGroups:[{logGroupName,...}]}
//   - DescribeLogStreams {logGroupName} -> {logStreams:[{logStreamName,
//     firstEventTimestamp, lastEventTimestamp, uploadSequenceToken}]}
//   - PutLogEvents {logGroupName, logStreamName, logEvents:[{timestamp,message}],
//     sequenceToken} -> {nextSequenceToken, rejectedLogEventsInfo}
//   - FilterLogEvents {logGroupName, startTime, interleaved, limit} ->
//     {events:[{eventId, logStreamName, timestamp, message, ingestionTime}]}
const (
	logsService = "logs"
	logsTarget  = "Logs_20140328"
	// logsEventLimit is the AWS maximum for one FilterLogEvents page.
	logsEventLimit = 10000
	// logsPutBatch is the AWS maximum number of events in one PutLogEvents call.
	logsPutBatch = 10000
)

// cloudWatchLogsClient talks to the local Logs emulator.
type cloudWatchLogsClient struct {
	client *awsJSONClient
	mu     sync.Mutex
	tokens map[string]string
}

func newCloudWatchLogsClient(endpoint string) *cloudWatchLogsClient {
	return &cloudWatchLogsClient{
		client: newAWSJSONClient(endpoint, logsService, logsTarget),
		tokens: map[string]string{},
	}
}

// cloudWatchLogStream is one log stream's metadata.
type cloudWatchLogStream struct {
	LogStreamName       string `json:"logStreamName"`
	FirstEventTimestamp int64  `json:"firstEventTimestamp"`
	LastEventTimestamp  int64  `json:"lastEventTimestamp"`
	UploadSequenceToken string `json:"uploadSequenceToken"`
}

// cloudWatchLogEvent is one log event in a subscription payload. The payload
// field is `id`, as AWS documents; FilterLogEvents spells it `eventId`, so the
// response uses cloudWatchFilterEvent.
type cloudWatchLogEvent struct {
	ID        string `json:"id,omitempty"`
	Timestamp int64  `json:"timestamp"`
	Message   string `json:"message"`
}

// cloudWatchFilterEvent is one FilterLogEvents response event.
type cloudWatchFilterEvent struct {
	EventID       string `json:"eventId"`
	LogStreamName string `json:"logStreamName"`
	Timestamp     int64  `json:"timestamp"`
	Message       string `json:"message"`
	IngestionTime int64  `json:"ingestionTime,omitempty"`
}

// Ping sends one read-only DescribeLogGroups call. It is the backend readiness
// probe, so the runner never provisions against a Logs endpoint that is not
// answering.
func (c *cloudWatchLogsClient) Ping(ctx context.Context) error {
	var output struct {
		LogGroups []map[string]any `json:"logGroups"`
	}
	return c.client.call(ctx, "DescribeLogGroups", map[string]any{}, &output)
}

// CreateLogGroup creates a group. An existing group is not an error: the run
// re-provisions from the CDK definition on every start.
func (c *cloudWatchLogsClient) CreateLogGroup(ctx context.Context, name string) error {
	err := c.client.call(ctx, "CreateLogGroup", map[string]any{"logGroupName": name}, nil)
	if err != nil && !isAWSJSONError(err, "ResourceAlreadyExistsException") {
		return err
	}
	return nil
}

// CreateLogStream creates a stream. An existing stream is not an error.
func (c *cloudWatchLogsClient) CreateLogStream(ctx context.Context, group, stream string) error {
	err := c.client.call(ctx, "CreateLogStream", map[string]any{
		"logGroupName":  group,
		"logStreamName": stream,
	}, nil)
	if err != nil && !isAWSJSONError(err, "ResourceAlreadyExistsException") {
		return err
	}
	return nil
}

// GroupExists reports whether a log group exists.
func (c *cloudWatchLogsClient) GroupExists(ctx context.Context, name string) (bool, error) {
	var output struct {
		LogGroups []struct {
			LogGroupName string `json:"logGroupName"`
		} `json:"logGroups"`
	}
	if err := c.client.call(ctx, "DescribeLogGroups", map[string]any{"logGroupNamePrefix": name}, &output); err != nil {
		return false, err
	}
	for _, group := range output.LogGroups {
		if group.LogGroupName == name {
			return true, nil
		}
	}
	return false, nil
}

// DescribeLogStreams lists one group's streams, following the documented
// pagination.
func (c *cloudWatchLogsClient) DescribeLogStreams(ctx context.Context, group string) ([]cloudWatchLogStream, error) {
	var streams []cloudWatchLogStream
	next := ""
	for {
		input := map[string]any{"logGroupName": group, "limit": 50}
		if next != "" {
			input["nextToken"] = next
		}
		var output struct {
			LogStreams []cloudWatchLogStream `json:"logStreams"`
			NextToken  string                `json:"nextToken"`
		}
		if err := c.client.call(ctx, "DescribeLogStreams", input, &output); err != nil {
			return nil, err
		}
		streams = append(streams, output.LogStreams...)
		next = strings.TrimSpace(output.NextToken)
		if next == "" {
			return streams, nil
		}
	}
}

// PutLogEvents writes one batch. The per-stream sequence token the service
// returns is passed back on the next call.
func (c *cloudWatchLogsClient) PutLogEvents(ctx context.Context, group, stream string, events []cloudWatchLogEvent) error {
	if len(events) == 0 {
		return nil
	}
	for start := 0; start < len(events); start += logsPutBatch {
		end := start + logsPutBatch
		if end > len(events) {
			end = len(events)
		}
		chunk := make([]map[string]any, 0, end-start)
		for _, event := range events[start:end] {
			chunk = append(chunk, map[string]any{
				"timestamp": event.Timestamp,
				"message":   event.Message,
			})
		}
		input := map[string]any{
			"logGroupName":  group,
			"logStreamName": stream,
			"logEvents":     chunk,
		}
		c.mu.Lock()
		token := c.tokens[group+"\x00"+stream]
		c.mu.Unlock()
		if token != "" {
			input["sequenceToken"] = token
		}
		var output struct {
			NextSequenceToken string `json:"nextSequenceToken"`
		}
		if err := c.client.call(ctx, "PutLogEvents", input, &output); err != nil {
			return err
		}
		if output.NextSequenceToken != "" {
			c.mu.Lock()
			c.tokens[group+"\x00"+stream] = output.NextSequenceToken
			c.mu.Unlock()
		}
	}
	return nil
}

// FilterLogEvents returns events at or after startTime (milliseconds). It asks
// for interleaved results so one call covers every stream in the group.
func (c *cloudWatchLogsClient) FilterLogEvents(ctx context.Context, group string, startTimeMillis int64) ([]cloudWatchFilterEvent, error) {
	var output struct {
		Events []cloudWatchFilterEvent `json:"events"`
	}
	input := map[string]any{
		"logGroupName": group,
		"startTime":    startTimeMillis,
		"interleaved":  true,
		"limit":        logsEventLimit,
	}
	if err := c.client.call(ctx, "FilterLogEvents", input, &output); err != nil {
		return nil, err
	}
	return output.Events, nil
}

// ensureFunctionLogGroup creates /aws/lambda/<function> and one stream for the
// container before its output is followed.
func (c *cloudWatchLogsClient) ensureFunctionLogGroup(ctx context.Context, functionName, container string, now time.Time) (string, string, error) {
	group := "/aws/lambda/" + functionName
	stream := fmt.Sprintf("%s/%s", now.UTC().Format("2006/01/02"), container)
	if err := c.CreateLogGroup(ctx, group); err != nil {
		return "", "", fmt.Errorf("create function log group %s: %w", group, err)
	}
	if err := c.CreateLogStream(ctx, group, stream); err != nil {
		return "", "", fmt.Errorf("create function log stream %s/%s: %w", group, stream, err)
	}
	return group, stream, nil
}
