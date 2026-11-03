package localrunner

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// RunSession is the automation interface behind `apptheory-local session`. It
// prepares the same run environment as Run, starts every function the CDK
// definition targets, serves any HTTP surface, and then reads one JSON command
// per line from in, writing one JSON response per line to out. It is how the
// examples harness receives real messages, writes real items and builds the
// event an event-source mapping would deliver.
func (r *Runner) RunSession(ctx context.Context, in io.Reader, out io.Writer) error {
	cleanup := r.cleanupFunc()
	defer cleanup()

	spec, err := r.prepareRun(ctx)
	if err != nil {
		return err
	}
	r.logf("local-run: ready")
	return r.serveSession(ctx, spec, in, out)
}

type sessionRequest struct {
	Op                  string               `json:"op"`
	Function            string               `json:"function,omitempty"`
	Event               json.RawMessage      `json:"event,omitempty"`
	Queue               string               `json:"queue,omitempty"`
	Body                string               `json:"body,omitempty"`
	MessageAttributes   map[string]string    `json:"messageAttributes,omitempty"`
	Max                 int                  `json:"max,omitempty"`
	WaitSeconds         int                  `json:"waitSeconds,omitempty"`
	VisibilitySeconds   int                  `json:"visibilitySeconds,omitempty"`
	Delete              bool                 `json:"delete,omitempty"`
	Table               string               `json:"table,omitempty"`
	Item                map[string]any       `json:"item,omitempty"`
	Key                 map[string]any       `json:"key,omitempty"`
	EventName           string               `json:"eventName,omitempty"`
	Bucket              string               `json:"bucket,omitempty"`
	ObjectKey           string               `json:"objectKey,omitempty"`
	ContentType         string               `json:"contentType,omitempty"`
	Rule                string               `json:"rule,omitempty"`
	Detail              json.RawMessage      `json:"detail,omitempty"`
	Source              string               `json:"source,omitempty"`
	DetailType          string               `json:"detailType,omitempty"`
	Stream              string               `json:"stream,omitempty"`
	LogGroup            string               `json:"logGroup,omitempty"`
	LogStream           string               `json:"logStream,omitempty"`
	SubscriptionFilters []string             `json:"subscriptionFilters,omitempty"`
	LogEvents           []CloudWatchLogEvent `json:"logEvents,omitempty"`
	Data                []string             `json:"data,omitempty"`
	PartitionKeys       []string             `json:"partitionKeys,omitempty"`
	SequenceNumbers     []string             `json:"sequenceNumbers,omitempty"`
	// Duration is a Go duration for clock.advance, for example "90m".
	Duration string `json:"duration,omitempty"`
}

type sessionResponse struct {
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

type localSession struct {
	runner   *Runner
	spec     *Spec
	previous map[string]map[string]types.AttributeValue
	sequence int64
	lastOp   string
}

func (r *Runner) serveSession(ctx context.Context, spec *Spec, in io.Reader, out io.Writer) error {
	session := &localSession{
		runner:   r,
		spec:     spec,
		previous: map[string]map[string]types.AttributeValue{},
	}
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 16<<20)
	writer := bufio.NewWriter(out)
	defer func() { _ = writer.Flush() }() //nolint:errcheck // the response writer is flushed after each response

	lines := make(chan string)
	readErr := make(chan error, 1)
	go func() {
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
		readErr <- scanner.Err()
	}()

	for {
		select {
		case <-ctx.Done():
			r.logShutdown()
			return nil
		case err := <-readErr:
			if err != nil {
				return fmt.Errorf("read session command: %w", err)
			}
			r.logShutdown()
			return nil
		case line := <-lines:
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			response := session.handle(ctx, line)
			encoded, err := json.Marshal(response)
			if err != nil {
				encoded = []byte(`{"ok":false,"error":"encode session response"}`)
			}
			if _, err := writer.Write(append(encoded, '\n')); err != nil {
				return fmt.Errorf("write session response: %w", err)
			}
			if err := writer.Flush(); err != nil {
				return fmt.Errorf("flush session response: %w", err)
			}
			if response.OK && session.lastOp == "shutdown" {
				r.logShutdown()
				return nil
			}
		}
	}
}

// lastOp is set by handle so serveSession can end after a successful shutdown
// command without parsing the response again.
func (s *localSession) handle(ctx context.Context, line string) sessionResponse {
	var request sessionRequest
	if err := json.Unmarshal([]byte(line), &request); err != nil {
		return sessionResponse{Error: "session command is not valid JSON: " + err.Error()}
	}
	s.lastOp = request.Op
	result, err := s.execute(ctx, request)
	if err != nil {
		return sessionResponse{Error: err.Error()}
	}
	return sessionResponse{OK: true, Result: result}
}

//nolint:gocyclo // the switch is the session's explicit operation contract.
func (s *localSession) execute(ctx context.Context, request sessionRequest) (any, error) {
	switch request.Op {
	case "shutdown":
		return map[string]any{"shutdown": true}, nil
	case "describe":
		return s.describe()
	case "clock.now":
		return s.clockNow(), nil
	case "clock.advance":
		return s.clockAdvance(request)
	case "invoke":
		return s.invoke(ctx, request)
	case "sqs.send":
		return s.sqsSend(ctx, request)
	case "sqs.receive":
		return s.sqsReceive(ctx, request, false)
	case "sqs.event":
		return s.sqsReceive(ctx, request, true)
	case "ddb.put":
		return s.ddbPut(ctx, request)
	case "ddb.get":
		return s.ddbGet(ctx, request)
	case "ddb.scan":
		return s.ddbScan(ctx, request)
	case "ddb.stream-event":
		return s.ddbStreamEvent(ctx, request)
	case "s3.put":
		return s.s3Put(ctx, request)
	case "eventbridge.event":
		return s.eventBridgeEvent(request)
	case "kinesis.event":
		return s.kinesisEvent(request)
	case "kinesis.cloudwatch-event":
		return s.kinesisCloudWatchEvent(request)
	default:
		return nil, fmt.Errorf("unknown session operation %q", request.Op)
	}
}

func (s *localSession) describe() (map[string]any, error) {
	functions := make([]map[string]any, 0)
	targets, err := s.runner.runtimeFunctions(s.spec)
	if err != nil {
		return nil, err
	}
	for _, id := range targets {
		function, ok := s.spec.Function(id)
		if !ok {
			continue
		}
		entry := map[string]any{
			"logicalId":   function.LogicalID,
			"runtime":     function.Runtime,
			"environment": function.Environment,
		}
		if process, ok := s.runner.invokers[id]; ok {
			entry["port"] = process.Port
		}
		functions = append(functions, entry)
	}
	apis := make([]map[string]any, 0)
	for _, api := range s.spec.APIs {
		if url, ok := s.runner.apiURLs[api.LogicalID]; ok {
			apis = append(apis, map[string]any{"class": api.Class, "logicalId": api.LogicalID, "url": url})
		}
	}
	for _, url := range s.spec.FunctionURLs {
		if address, ok := s.runner.apiURLs[url.LogicalID]; ok {
			apis = append(apis, map[string]any{"class": APIFunctionURL, "logicalId": url.LogicalID, "url": address})
		}
	}
	cloudFront := make([]map[string]any, 0, len(s.spec.CloudFront))
	for _, distribution := range s.spec.CloudFront {
		entry := map[string]any{
			"logicalId": distribution.LogicalID,
			"servable":  distribution.Servable(),
			"refusals":  distribution.Refusals,
		}
		if distribution.DefaultBehavior != nil {
			entry["defaultOrigin"] = distribution.DefaultBehavior.TargetOriginID
		}
		if url, ok := s.runner.apiURLs[distribution.LogicalID]; ok {
			entry["url"] = url
		}
		cloudFront = append(cloudFront, entry)
	}
	resources := make([]map[string]any, 0, len(s.runner.resourceValues))
	for key, value := range s.runner.resourceValues {
		stack, id := splitResourceKey(key)
		resources = append(resources, map[string]any{
			"logicalId": id,
			"stack":     stack,
			"type":      value.Type,
			"name":      value.Name,
			"url":       value.URL,
			"arn":       value.ARN,
			"streamArn": value.StreamARN,
		})
	}
	secrets := map[string]string{}
	for name, value := range s.runner.localSecrets {
		secrets[name] = value
	}
	endpoints := s.describeEndpoints()
	delivery := EngineState{}
	if s.runner.delivery != nil {
		delivery = s.runner.delivery.State()
	}
	return map[string]any{
		"functions":     functions,
		"apis":          apis,
		"cloudFront":    cloudFront,
		"eventSources":  s.spec.EventSources,
		"rules":         s.spec.Rules,
		"subscriptions": s.spec.Subscriptions,
		"resources":     resources,
		"secrets":       secrets,
		"endpoints":     endpoints,
		"delivery":      delivery,
	}, nil
}

// clockNow reports the run's clock mode and current instant.
func (s *localSession) clockNow() map[string]any {
	clock := s.runner.clock
	if clock == nil {
		clock = RealClock{}
	}
	return map[string]any{
		"mode": string(ClockModeOf(clock)),
		"now":  clock.Now().UTC().Format(time.RFC3339Nano),
	}
}

// clockAdvance moves a test clock forward by a Go duration. The real clock
// cannot be advanced: every existing session keeps its default behavior.
func (s *localSession) clockAdvance(request sessionRequest) (any, error) {
	testClock, ok := s.runner.clock.(*TestClock)
	if !ok {
		return nil, errors.New("clock.advance needs a test clock; start the session with --clock test[=<RFC3339 start>]")
	}
	duration, err := time.ParseDuration(strings.TrimSpace(request.Duration))
	if err != nil {
		return nil, fmt.Errorf("clock.advance needs a Go duration such as 90m: %w", err)
	}
	if duration <= 0 {
		return nil, fmt.Errorf("clock.advance needs a positive duration (got %s)", duration)
	}
	fired, err := testClock.Advance(duration)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"mode":        string(ClockModeTest),
		"advanced":    duration.String(),
		"timersFired": fired,
		"now":         testClock.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func (s *localSession) describeEndpoints() []map[string]any {
	endpoints := make([]map[string]any, 0)
	for _, name := range sortedKeys(s.runner.backends) {
		backend := s.runner.backends[name]
		if backend.HostURL == "" {
			continue
		}
		for _, endpoint := range backend.Endpoints {
			endpoints = append(endpoints, map[string]any{
				"service": endpoint.Service,
				"url":     backend.HostURL,
			})
		}
	}
	return endpoints
}

func splitResourceKey(key string) (string, string) {
	if stack, id, ok := strings.Cut(key, "/"); ok {
		return stack, id
	}
	return "", key
}

func (s *localSession) invoke(ctx context.Context, request sessionRequest) (any, error) {
	function, err := s.findFunction(request.Function)
	if err != nil {
		return nil, err
	}
	process, ok := s.runner.invokers[function.LogicalID]
	if !ok {
		return nil, fmt.Errorf("function %s is not running", function.LogicalID)
	}
	if len(request.Event) == 0 || !json.Valid(request.Event) {
		return nil, fmt.Errorf("invoke needs a valid JSON event")
	}
	raw, err := process.Invoke(ctx, request.Event)
	if err != nil {
		return nil, err
	}
	return decodeInvokeResult(raw), nil
}

func (s *localSession) findFunction(id string) (FunctionSpec, error) {
	if function, ok := s.spec.Function(id); ok {
		return function, nil
	}
	for _, function := range s.spec.Functions {
		if function.Stack+"/"+function.LogicalID == id {
			return function, nil
		}
	}
	return FunctionSpec{}, fmt.Errorf("assembly defines no function %q", id)
}

func (s *localSession) findResource(id string) (ResourceSpec, string, error) {
	for _, resource := range s.spec.Resources {
		if resource.LogicalID == id || resource.Stack+"/"+resource.LogicalID == id {
			return resource, resource.Stack + "/" + resource.LogicalID, nil
		}
	}
	return ResourceSpec{}, "", fmt.Errorf("assembly defines no resource %q", id)
}

func (s *localSession) queue(id string) (*sqs.Client, string, string, string, error) {
	resource, key, err := s.findResource(id)
	if err != nil {
		return nil, "", "", "", err
	}
	if resource.Type != typeSQSQueue {
		return nil, "", "", "", fmt.Errorf("%s is %s, not an SQS queue", id, resource.Type)
	}
	value, ok := s.runner.resourceValues[key]
	if !ok {
		return nil, "", "", "", fmt.Errorf("SQS queue %s is not provisioned; start the run with --backend sqs", id)
	}
	backend, ok := s.runner.backendForService(backendSQS)
	if !ok || backend.HostURL == "" {
		return nil, "", "", "", fmt.Errorf("the sqs backend is not running")
	}
	hostURL, err := hostQueueURL(value.URL, backend.HostURL)
	if err != nil {
		return nil, "", "", "", err
	}
	return newSQSClient(backend.HostURL), hostURL, value.Name, value.ARN, nil
}

func (s *localSession) sqsSend(ctx context.Context, request sessionRequest) (any, error) {
	client, queueURL, _, _, err := s.queue(request.Queue)
	if err != nil {
		return nil, err
	}
	input := &sqs.SendMessageInput{
		QueueUrl:    aws.String(queueURL),
		MessageBody: aws.String(request.Body),
	}
	if len(request.MessageAttributes) > 0 {
		attributes := map[string]sqstypes.MessageAttributeValue{}
		for name, value := range request.MessageAttributes {
			text := value
			attributes[name] = sqstypes.MessageAttributeValue{DataType: aws.String("String"), StringValue: aws.String(text)}
		}
		input.MessageAttributes = attributes
	}
	sent, err := client.SendMessage(ctx, input)
	if err != nil {
		return nil, err
	}
	return map[string]any{"messageId": aws.ToString(sent.MessageId)}, nil
}

func receiveSQSMessages(ctx context.Context, client *sqs.Client, queueURL string, limit, waitSeconds, visibilitySeconds int) ([]sqstypes.Message, error) {
	var messages []sqstypes.Message
	for len(messages) < limit {
		count := limit - len(messages)
		if count > 10 {
			count = 10
		}
		input := &sqs.ReceiveMessageInput{
			QueueUrl:                    aws.String(queueURL),
			MaxNumberOfMessages:         boundedInt32(count, 10),
			MessageSystemAttributeNames: []sqstypes.MessageSystemAttributeName{sqstypes.MessageSystemAttributeNameAll},
			MessageAttributeNames:       []string{"All"},
		}
		if waitSeconds > 0 {
			input.WaitTimeSeconds = boundedInt32(waitSeconds, 20)
		}
		if visibilitySeconds >= 0 {
			input.VisibilityTimeout = boundedInt32(visibilitySeconds, 43200)
		}
		out, err := client.ReceiveMessage(ctx, input)
		if err != nil {
			return nil, err
		}
		if len(out.Messages) == 0 {
			break
		}
		messages = append(messages, out.Messages...)
		if waitSeconds <= 0 && len(messages) >= limit {
			break
		}
	}
	return messages, nil
}

func boundedInt32(value, maximum int) int32 {
	if value < 0 {
		value = 0
	}
	if value > maximum {
		value = maximum
	}
	return int32(value) //nolint:gosec // value is clamped to a service range above
}

func (s *localSession) sqsReceive(ctx context.Context, request sessionRequest, buildEvent bool) (any, error) {
	client, queueURL, _, queueARN, err := s.queue(request.Queue)
	if err != nil {
		return nil, err
	}
	limit := request.Max
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	messages, err := receiveSQSMessages(ctx, client, queueURL, limit, request.WaitSeconds, request.VisibilitySeconds)
	if err != nil {
		return nil, err
	}
	if request.Delete {
		for _, message := range messages {
			if message.ReceiptHandle == nil {
				continue
			}
			if _, deleteErr := client.DeleteMessage(ctx, &sqs.DeleteMessageInput{
				QueueUrl:      aws.String(queueURL),
				ReceiptHandle: message.ReceiptHandle,
			}); deleteErr != nil {
				return nil, fmt.Errorf("delete message %s: %w", aws.ToString(message.MessageId), deleteErr)
			}
		}
	}
	serialized := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		serialized = append(serialized, map[string]any{
			"messageId":     aws.ToString(message.MessageId),
			"receiptHandle": aws.ToString(message.ReceiptHandle),
			"body":          aws.ToString(message.Body),
			"attributes":    message.Attributes,
			"md5OfBody":     aws.ToString(message.MD5OfBody),
		})
	}
	if !buildEvent {
		return map[string]any{"messages": serialized}, nil
	}
	event, err := BuildSQSEvent(queueARN, messages)
	if err != nil {
		return nil, err
	}
	return map[string]any{"event": json.RawMessage(event), "messages": serialized}, nil
}

func (s *localSession) table(id string) (*dynamodb.Client, string, tableInfo, error) {
	resource, key, err := s.findResource(id)
	if err != nil {
		return nil, "", tableInfo{}, err
	}
	if resource.Type != typeDynamoTable {
		return nil, "", tableInfo{}, fmt.Errorf("%s is %s, not a DynamoDB table", id, resource.Type)
	}
	info, ok := s.runner.tables[key]
	if !ok {
		return nil, "", tableInfo{}, fmt.Errorf("DynamoDB table %s is not provisioned; start the run with --backend dynamodb", id)
	}
	backend, ok := s.runner.backendForService("dynamodb")
	if !ok || backend.HostURL == "" {
		return nil, "", tableInfo{}, fmt.Errorf("the dynamodb backend is not running")
	}
	return newDynamoDBClient(backend.HostURL), info.Name, info, nil
}

func (s *localSession) ddbPut(ctx context.Context, request sessionRequest) (any, error) {
	client, name, info, err := s.table(request.Table)
	if err != nil {
		return nil, err
	}
	item, err := marshalItem(request.Item)
	if err != nil {
		return nil, fmt.Errorf("encode item: %w", err)
	}
	key := tableKey(item, info.KeySchema)
	if len(key) != len(info.KeySchema) {
		return nil, fmt.Errorf("item does not carry every key attribute of table %s", name)
	}
	existing, err := client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(name),
		Key:       key,
	})
	if err != nil {
		return nil, err
	}
	if len(existing.Item) > 0 {
		s.previous[tableKeyString(key)] = existing.Item
	}
	if _, err := client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(name),
		Item:      item,
	}); err != nil {
		return nil, err
	}
	return map[string]any{"item": request.Item, "key": attributeMapJSON(key)}, nil
}

func (s *localSession) ddbGet(ctx context.Context, request sessionRequest) (any, error) {
	client, name, info, err := s.table(request.Table)
	if err != nil {
		return nil, err
	}
	key, err := marshalItem(request.Key)
	if err != nil {
		return nil, fmt.Errorf("encode key: %w", err)
	}
	if len(key) != len(info.KeySchema) {
		return nil, fmt.Errorf("key does not carry every key attribute of table %s", name)
	}
	out, err := client.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(name), Key: key})
	if err != nil {
		return nil, err
	}
	if len(out.Item) == 0 {
		return map[string]any{"item": nil}, nil
	}
	item, err := unmarshalItem(out.Item)
	if err != nil {
		return nil, fmt.Errorf("decode item: %w", err)
	}
	return map[string]any{"item": item}, nil
}

func (s *localSession) ddbScan(ctx context.Context, request sessionRequest) (any, error) {
	client, name, _, err := s.table(request.Table)
	if err != nil {
		return nil, err
	}
	out, err := client.Scan(ctx, &dynamodb.ScanInput{TableName: aws.String(name)})
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0, len(out.Items))
	for _, typed := range out.Items {
		item, err := unmarshalItem(typed)
		if err != nil {
			return nil, fmt.Errorf("decode scanned item: %w", err)
		}
		items = append(items, item)
	}
	return map[string]any{"items": items}, nil
}

//nolint:gocyclo // the stream event name and image rules are explicit contract cases.
func (s *localSession) ddbStreamEvent(ctx context.Context, request sessionRequest) (any, error) {
	client, name, info, err := s.table(request.Table)
	if err != nil {
		return nil, err
	}
	if info.StreamARN == "" {
		return nil, fmt.Errorf("DynamoDB table %s declares no stream", name)
	}
	key, err := marshalItem(request.Key)
	if err != nil {
		return nil, fmt.Errorf("encode key: %w", err)
	}
	if len(key) != len(info.KeySchema) {
		return nil, fmt.Errorf("key does not carry every key attribute of table %s", name)
	}
	current, err := client.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(name), Key: key})
	if err != nil {
		return nil, err
	}
	keyText := tableKeyString(key)
	previous := s.previous[keyText]
	eventName := strings.ToUpper(strings.TrimSpace(request.EventName))
	if eventName == "" {
		switch {
		case len(previous) > 0 && len(current.Item) > 0:
			eventName = streamEventModify
		case len(previous) > 0:
			eventName = streamEventRemove
		default:
			eventName = streamEventInsert
		}
	}
	if eventName == streamEventRemove && len(previous) == 0 && len(current.Item) == 0 {
		return nil, fmt.Errorf("no stored image for %s to remove", keyText)
	}
	s.sequence++
	input := DynamoDBStreamInput{
		EventSourceARN: info.StreamARN,
		EventName:      eventName,
		Keys:           key,
		StreamViewType: info.StreamViewType,
		SequenceNumber: fmt.Sprintf("%d", 1000000000000000000+s.sequence),
		Now:            s.runner.now(),
	}
	if eventName != streamEventRemove {
		input.NewImage = current.Item
	}
	if eventName != streamEventInsert {
		if len(previous) > 0 {
			input.OldImage = previous
		} else {
			input.OldImage = current.Item
		}
	}
	event, err := BuildDynamoDBStreamEvent(input)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(event), nil
}

func (s *localSession) s3Put(ctx context.Context, request sessionRequest) (any, error) {
	resource, key, err := s.findResource(request.Bucket)
	if err != nil {
		return nil, err
	}
	if resource.Type != typeS3Bucket {
		return nil, fmt.Errorf("%s is %s, not an S3 bucket", request.Bucket, resource.Type)
	}
	value, ok := s.runner.resourceValues[key]
	if !ok {
		return nil, fmt.Errorf("S3 bucket %s is not provisioned; start the run with --backend s3proxy", request.Bucket)
	}
	backend, ok := s.runner.backendForService("s3")
	if !ok || backend.HostURL == "" {
		return nil, fmt.Errorf("the s3 backend is not running")
	}
	if strings.TrimSpace(request.ObjectKey) == "" {
		return nil, fmt.Errorf("s3.put needs objectKey")
	}
	input := &s3.PutObjectInput{
		Bucket: aws.String(value.Name),
		Key:    aws.String(request.ObjectKey),
		Body:   strings.NewReader(request.Body),
	}
	if strings.TrimSpace(request.ContentType) != "" {
		input.ContentType = aws.String(request.ContentType)
	}
	put, err := newS3Client(backend.HostURL).PutObject(ctx, input)
	if err != nil {
		return nil, err
	}
	return map[string]any{"bucket": value.Name, "key": request.ObjectKey, "etag": aws.ToString(put.ETag)}, nil
}

func (s *localSession) eventBridgeEvent(request sessionRequest) (any, error) {
	rule, err := s.findRule(request.Rule)
	if err != nil {
		return nil, err
	}
	event, err := BuildEventBridgeEvent(rule, request.Detail, request.Source, request.DetailType, s.runner.now())
	if err != nil {
		return nil, err
	}
	return json.RawMessage(event), nil
}

func (s *localSession) findRule(id string) (RuleSpec, error) {
	for _, rule := range s.spec.Rules {
		if rule.LogicalID == id || rule.Name == id {
			return rule, nil
		}
	}
	return RuleSpec{}, fmt.Errorf("assembly defines no EventBridge rule %q", id)
}

func (s *localSession) kinesisEvent(request sessionRequest) (any, error) {
	value, err := s.kinesisStream(request.Stream)
	if err != nil {
		return nil, err
	}
	records := make([]KinesisRecordInput, 0, len(request.Data))
	for index, encoded := range request.Data {
		data, decodeErr := base64.StdEncoding.DecodeString(encoded)
		if decodeErr != nil {
			return nil, fmt.Errorf("decode Kinesis data %d: %w", index, decodeErr)
		}
		record := KinesisRecordInput{Data: data}
		if index < len(request.PartitionKeys) {
			record.PartitionKey = request.PartitionKeys[index]
		}
		if index < len(request.SequenceNumbers) {
			record.SequenceNumber = request.SequenceNumbers[index]
		}
		records = append(records, record)
	}
	event, err := BuildKinesisEvent(value.ARN, records, s.runner.now())
	if err != nil {
		return nil, err
	}
	return json.RawMessage(event), nil
}

func (s *localSession) kinesisCloudWatchEvent(request sessionRequest) (any, error) {
	value, err := s.kinesisStream(request.Stream)
	if err != nil {
		return nil, err
	}
	logGroup := strings.TrimSpace(request.LogGroup)
	if logGroup == "" {
		logGroup = s.defaultLogGroup()
	}
	if logGroup == "" {
		return nil, fmt.Errorf("no log group was supplied and the assembly declares none")
	}
	filters := append([]string(nil), request.SubscriptionFilters...)
	if len(filters) == 0 {
		filters = s.defaultSubscriptionFilters()
	}
	logStream := strings.TrimSpace(request.LogStream)
	if logStream == "" {
		logStream = "local-log-stream"
	}
	event, err := BuildCloudWatchLogsKinesisEvent(value.ARN, logGroup, logStream, filters, request.LogEvents, s.runner.now())
	if err != nil {
		return nil, err
	}
	return json.RawMessage(event), nil
}

func (s *localSession) kinesisStream(id string) (resourceValue, error) {
	resource, _, err := s.findResource(id)
	if err != nil {
		return resourceValue{}, err
	}
	if resource.Type != typeKinesisStream {
		return resourceValue{}, fmt.Errorf("%s is %s, not a Kinesis stream", id, resource.Type)
	}
	return s.runner.localResourceValue(resource, s.runner.resourceValues)
}

func (s *localSession) defaultLogGroup() string {
	for _, resource := range s.spec.Resources {
		if resource.Type != "AWS::Logs::LogGroup" {
			continue
		}
		var props struct {
			LogGroupName string `json:"LogGroupName"`
		}
		if err := json.Unmarshal(resource.Properties, &props); err == nil && strings.TrimSpace(props.LogGroupName) != "" {
			return strings.TrimSpace(props.LogGroupName)
		}
	}
	return ""
}

func (s *localSession) defaultSubscriptionFilters() []string {
	var filters []string
	for _, resource := range s.spec.Resources {
		if resource.Type != "AWS::Logs::SubscriptionFilter" {
			continue
		}
		var props struct {
			FilterName string `json:"FilterName"`
		}
		if err := json.Unmarshal(resource.Properties, &props); err == nil && strings.TrimSpace(props.FilterName) != "" {
			filters = append(filters, strings.TrimSpace(props.FilterName))
		}
	}
	return filters
}

func tableKey(item map[string]types.AttributeValue, schema []keySchemaAttribute) map[string]types.AttributeValue {
	key := map[string]types.AttributeValue{}
	for _, attribute := range schema {
		if value, ok := item[attribute.Name]; ok {
			key[attribute.Name] = value
		}
	}
	return key
}

// marshalItem converts the JSON object a session command carries into the
// DynamoDB attribute values the SDK sends. It deliberately supports only the
// JSON shapes a harness or a developer writes by hand.
func marshalItem(values map[string]any) (map[string]types.AttributeValue, error) {
	out := make(map[string]types.AttributeValue, len(values))
	for name, value := range values {
		converted, err := marshalValue(value)
		if err != nil {
			return nil, fmt.Errorf("attribute %s: %w", name, err)
		}
		out[name] = converted
	}
	return out, nil
}

func marshalValue(value any) (types.AttributeValue, error) {
	switch typed := value.(type) {
	case string:
		return &types.AttributeValueMemberS{Value: typed}, nil
	case bool:
		return &types.AttributeValueMemberBOOL{Value: typed}, nil
	case nil:
		return &types.AttributeValueMemberNULL{Value: true}, nil
	case json.Number:
		return &types.AttributeValueMemberN{Value: typed.String()}, nil
	case float64:
		return &types.AttributeValueMemberN{Value: strconv.FormatFloat(typed, 'f', -1, 64)}, nil
	case []any:
		items := make([]types.AttributeValue, 0, len(typed))
		for index, item := range typed {
			converted, err := marshalValue(item)
			if err != nil {
				return nil, fmt.Errorf("list item %d: %w", index, err)
			}
			items = append(items, converted)
		}
		return &types.AttributeValueMemberL{Value: items}, nil
	case map[string]any:
		converted, err := marshalItem(typed)
		if err != nil {
			return nil, err
		}
		return &types.AttributeValueMemberM{Value: converted}, nil
	default:
		return nil, fmt.Errorf("unsupported JSON value type %T", value)
	}
}

func unmarshalItem(values map[string]types.AttributeValue) (map[string]any, error) {
	out := make(map[string]any, len(values))
	for name, value := range values {
		converted, err := unmarshalValue(value)
		if err != nil {
			return nil, fmt.Errorf("attribute %s: %w", name, err)
		}
		out[name] = converted
	}
	return out, nil
}

func unmarshalValue(value types.AttributeValue) (any, error) {
	switch typed := value.(type) {
	case *types.AttributeValueMemberS:
		return typed.Value, nil
	case *types.AttributeValueMemberN:
		return json.Number(typed.Value), nil
	case *types.AttributeValueMemberB:
		return base64.StdEncoding.EncodeToString(typed.Value), nil
	case *types.AttributeValueMemberBOOL:
		return typed.Value, nil
	case *types.AttributeValueMemberNULL:
		return nil, nil
	case *types.AttributeValueMemberSS:
		return append([]string(nil), typed.Value...), nil
	case *types.AttributeValueMemberNS:
		return append([]string(nil), typed.Value...), nil
	case *types.AttributeValueMemberBS:
		values := make([]string, 0, len(typed.Value))
		for _, item := range typed.Value {
			values = append(values, base64.StdEncoding.EncodeToString(item))
		}
		return values, nil
	case *types.AttributeValueMemberL:
		items := make([]any, 0, len(typed.Value))
		for _, item := range typed.Value {
			converted, err := unmarshalValue(item)
			if err != nil {
				return nil, err
			}
			items = append(items, converted)
		}
		return items, nil
	case *types.AttributeValueMemberM:
		return unmarshalItem(typed.Value)
	default:
		return nil, fmt.Errorf("unsupported DynamoDB attribute value %T", value)
	}
}

func tableKeyString(key map[string]types.AttributeValue) string {
	encoded, err := json.Marshal(attributeMapJSON(key))
	if err != nil {
		return fmt.Sprintf("%v", key)
	}
	return string(encoded)
}

// logShutdown mirrors the message Run prints when its context ends, so a
// session's lifecycle is visible in the same place.
func (r *Runner) logShutdown() {
	r.logf("shutting down: removing %d container(s) and network %s", len(r.invokers), r.network)
}
