package localrunner

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	sqstypes "github.com/aws/aws-sdk-go-v2/service/sqs/types"
)

// The SNS deliverer is the local counterpart of the SNS delivery service. A
// handler publishes through the real SDK to moto; the runner observes the
// publish and performs the fan-out itself, because moto cannot reach the
// Runtime Interface Emulator or ElasticMQ.
//
// Observation: the runner creates one drain queue on moto's own SQS for each
// topic that has a subscription and subscribes it to the topic without raw
// message delivery. moto then delivers the documented SNS notification
// envelope to that queue, and the runner polls it. The envelope preserves the
// SNS message id, subject, timestamp and message attributes. For a FIFO topic
// the drain queue is a FIFO queue with content-based deduplication, so moto
// also carries MessageGroupId and MessageDeduplicationId as SQS system
// attributes.
//
// A drain queue is used instead of an HTTP observer for two reasons. FIFO
// topics cannot deliver to HTTP(S) endpoints in AWS, and moto's HTTP fan-out
// drops the message group and deduplication ids, so an HTTP observer could not
// reproduce FIFO delivery. A drain queue also keeps the run loopback-only: it
// uses the same runner-to-moto path as every other local client instead of
// requiring moto to reach a listener on the host.
//
// Targets:
//
//   - Lambda receives the documented SNS event record.
//     https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html
//   - SQS receives the SNS envelope, or the raw body when RawMessageDelivery
//     is enabled, with message attributes and, for a FIFO queue, the message
//     group and deduplication ids.
//     https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html
//   - HTTP/HTTPS posts the documented JSON body and x-amz-sns-* headers to a
//     loopback endpoint. SubscriptionConfirmation is not sent: the runner
//     registers the subscription itself, so it is already confirmed.
//     https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html
//
// FIFO topics order delivery per message group and deduplicate within the
// five-minute interval SNS documents. The runner reproduces both on the run
// clock: the drain queue preserves order, and the hub keeps a deduplication
// window because moto's queue-level deduplication ends as soon as the drain
// message is deleted.
// https://docs.aws.amazon.com/sns/latest/dg/sns-fifo-topics.html
//
// Delivery attempts are recorded per subscription (delivered, filtered,
// failed) in the delivery engine state. A failed target is reported with its
// last error and is not retried: the runner implements one attempt, while AWS
// applies the subscription's delivery policy and dead-letter queue. The rows
// assert the successful path; the single-attempt limit is documented in
// docs/examples/local-runner.md.

const (
	snsDrainVisibility        = 300 * time.Second
	snsDrainWaitSeconds       = 1
	snsReceiveMax             = 1
	snsErrorBackoff           = 250 * time.Millisecond
	snsDeduplicationWindow    = 5 * time.Minute
	snsHTTPTimeout            = 30 * time.Second
	snsHTTPContentType        = "text/plain; charset=UTF-8"
	snsDrainQueuePrefix       = "apptheory-local-sns-drain-"
	snsDrainQueueMaximum      = 80
	snsFIFOTopicSuffix        = ".fifo"
	snsRawMessageDeliveryTrue = "true"

	snsProtocolLambda = "lambda"
	snsProtocolSQS    = "sqs"
	snsProtocolHTTP   = "http"
	snsProtocolHTTPS  = "https"
)

// snsLocalBackend is the DeliveryBackend.Client for an SNS source: the SNS
// client for the publish side and moto's SQS client for the drain queue. Both
// talk to the same moto endpoint.
type snsLocalBackend struct {
	sns *sns.Client
	sqs *sqs.Client
}

// snsQueueTarget is the provisioned target of an SQS subscription.
type snsQueueTarget struct {
	Name string
	ARN  string
}

// snsHubRegistry owns the per-topic hubs, the topic runtimes provisioning
// created and the lookups a hub needs. It is shared by every SNS deliverer of
// one run.
type snsHubRegistry struct {
	clock       Clock
	logf        func(format string, args ...any)
	queueLookup func(logicalID string) (snsQueueTarget, bool)
	sqsClient   func() (*sqs.Client, error)
	httpClient  *http.Client

	mu          sync.Mutex
	topicsByID  map[string]snsTopicRuntime
	topicsByARN map[string]snsTopicRuntime
	hubs        map[string]*snsTopicHub
	// publishSequence makes a local publish's message id unique even on a
	// fixed test clock, where Now() is identical across publishes.
	publishSequence uint64
}

func newSNSHubRegistry(
	clock Clock,
	logf func(format string, args ...any),
	queueLookup func(string) (snsQueueTarget, bool),
	sqsClient func() (*sqs.Client, error),
) *snsHubRegistry {
	if clock == nil {
		clock = RealClock{}
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &snsHubRegistry{
		clock:       clock,
		logf:        logf,
		queueLookup: queueLookup,
		sqsClient:   sqsClient,
		httpClient: &http.Client{
			Timeout: snsHTTPTimeout,
			// A loopback subscription must never follow a redirect to a
			// non-loopback address; a 3xx is a failed delivery.
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		topicsByID:  map[string]snsTopicRuntime{},
		topicsByARN: map[string]snsTopicRuntime{},
		hubs:        map[string]*snsTopicHub{},
	}
}

// registerTopic records a provisioned topic and its drain queue.
func (r *snsHubRegistry) registerTopic(topic snsTopicRuntime) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.topicsByID[topic.LogicalID] = topic
	if topic.ARN != "" {
		r.topicsByARN[topic.ARN] = topic
	}
}

// topicByID returns one provisioned topic.
func (r *snsHubRegistry) topicByID(logicalID string) (snsTopicRuntime, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	topic, ok := r.topicsByID[logicalID]
	return topic, ok
}

// topicByARN returns one provisioned topic.
func (r *snsHubRegistry) topicByARN(arn string) (snsTopicRuntime, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	topic, ok := r.topicsByARN[arn]
	return topic, ok
}

// hubFor returns the shared hub for a topic, creating it on first use.
func (r *snsHubRegistry) hubFor(topic snsTopicRuntime) *snsTopicHub {
	r.mu.Lock()
	defer r.mu.Unlock()
	hub, ok := r.hubs[topic.ARN]
	if !ok {
		hub = &snsTopicHub{
			registry:    r,
			topic:       topic,
			attachments: map[string]*snsAttachment{},
			dedup:       map[string]time.Time{},
		}
		r.hubs[topic.ARN] = hub
	}
	return hub
}

// publishLocal runs a local publish through the same fan-out path as an
// observed SDK publish. E3 and E4 use it for EventBridge and notification
// targets.
func (r *snsHubRegistry) publishLocal(ctx context.Context, topicARN string, input LocalSNSMessage) error {
	topic, ok := r.topicByARN(topicARN)
	if !ok {
		return fmt.Errorf("SNS topic %s is not provisioned in this run", topicARN)
	}
	message := snsLocalMessage(topic, input, r.clock.Now())
	message.MessageID = stableUUID(fmt.Sprintf("sns-publish:%s:%d:%d", topic.ARN, message.Timestamp.UnixNano(), atomic.AddUint64(&r.publishSequence, 1)))
	hub, ok := r.hubIfAny(topic.ARN)
	if !ok {
		// A topic with no subscriptions has no drain queue and no hub; the
		// publish succeeds and reaches nobody, as in AWS.
		return nil
	}
	return hub.publishLocal(ctx, message)
}

func (r *snsHubRegistry) hubIfAny(topicARN string) (*snsTopicHub, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	hub, ok := r.hubs[topicARN]
	return hub, ok
}

// SNSDeliverer attaches one subscription to its topic's shared hub.
type SNSDeliverer struct {
	source   DeliverySource
	registry *snsHubRegistry
}

// NewSNSDeliverer builds the SNS deliverer for one registered subscription.
func NewSNSDeliverer(source DeliverySource, registry *snsHubRegistry) (Deliverer, error) {
	if source.Subscription == nil || source.Subscription.Kind != string(DeliveryKindSNS) {
		return nil, fmt.Errorf("source %s is not an SNS subscription", source.ID)
	}
	if registry == nil {
		return nil, errors.New("the SNS deliverer has no hub registry")
	}
	return &SNSDeliverer{source: source, registry: registry}, nil
}

// Start attaches the subscription to the topic hub and reports armed. The hub
// owns the drain poller; every subscription of the topic shares it.
func (d *SNSDeliverer) Start(ctx context.Context, env DelivererEnv) error {
	subscription := *d.source.Subscription
	topic, ok := d.registry.topicByID(subscription.Topic)
	if !ok && subscription.Stack != "" {
		topic, ok = d.registry.topicByID(subscription.Stack + "/" + subscription.Topic)
	}
	if !ok && subscription.TopicARN != "" {
		topic, ok = d.registry.topicByARN(subscription.TopicARN)
	}
	if !ok {
		return fmt.Errorf("SNS subscription %s names no provisioned topic", d.source.ID)
	}
	if subscription.TopicARN == "" {
		subscription.TopicARN = topic.ARN
	}
	backend, ok := env.Backend.Client.(*snsLocalBackend)
	if !ok || backend == nil || backend.sqs == nil {
		return errors.New("the SNS delivery backend has no SNS/SQS client")
	}
	hub := d.registry.hubFor(topic)
	env.State.SetPaused(false)
	env.State.SetPhase(DeliveryPhaseArmed)
	attachment := hub.attach(subscription, env.Invoke, env.State)
	defer hub.detach(attachment)
	hub.start(ctx, env.Backend.Endpoint, backend)
	<-ctx.Done()
	return nil
}

// snsAttachment is one subscription the hub fans out to.
type snsAttachment struct {
	spec     SubscriptionSpec
	invoke   func(ctx context.Context, event []byte) (InvokeResult, error)
	reporter DeliveryReporter
}

// snsTopicHub owns one topic's drain queue, its poller and its subscriptions.
type snsTopicHub struct {
	registry *snsHubRegistry
	topic    snsTopicRuntime
	endpoint string
	backend  *snsLocalBackend

	mu          sync.Mutex
	deliverMu   sync.Mutex
	attachments map[string]*snsAttachment
	started     bool
	dedup       map[string]time.Time
	queues      map[string]snsResolvedQueue
}

type snsResolvedQueue struct {
	URL  string
	FIFO bool
}

func (h *snsTopicHub) attach(
	spec SubscriptionSpec,
	invoke func(ctx context.Context, event []byte) (InvokeResult, error),
	reporter DeliveryReporter,
) *snsAttachment {
	attachment := &snsAttachment{spec: spec, invoke: invoke, reporter: reporter}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.attachments[spec.LogicalID] = attachment
	return attachment
}

func (h *snsTopicHub) detach(attachment *snsAttachment) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.attachments, attachment.spec.LogicalID)
}

// start launches the drain poller once.
func (h *snsTopicHub) start(ctx context.Context, endpoint string, backend *snsLocalBackend) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.endpoint = endpoint
	h.backend = backend
	if h.started {
		return
	}
	// Wait until every registered subscription has attached, so a publish
	// cannot overtake a subscription while the engine is starting them.
	if h.topic.SubscriptionCount > 0 && len(h.attachments) < h.topic.SubscriptionCount {
		return
	}
	h.started = true
	go h.poll(ctx)
}

// poll drains the topic's queue until the run stops.
func (h *snsTopicHub) poll(ctx context.Context) {
	if h.topic.DrainURL == "" {
		h.failAll(errors.New("the SNS topic has no local drain queue"))
		return
	}
	for {
		if ctx.Err() != nil {
			return
		}
		output, err := h.backend.sqs.ReceiveMessage(ctx, &sqs.ReceiveMessageInput{
			QueueUrl:                    aws.String(h.topic.DrainURL),
			MaxNumberOfMessages:         snsReceiveMax, //nolint:gosec // a fixed 1
			WaitTimeSeconds:             snsDrainWaitSeconds,
			MessageSystemAttributeNames: []sqstypes.MessageSystemAttributeName{sqstypes.MessageSystemAttributeNameAll},
			MessageAttributeNames:       []string{"All"},
		})
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			h.failAll(fmt.Errorf("receive from the SNS drain queue: %w", err))
			h.wait(ctx, snsErrorBackoff)
			continue
		}
		for _, received := range output.Messages {
			h.observe(ctx, received)
			if _, err := h.backend.sqs.DeleteMessage(ctx, &sqs.DeleteMessageInput{
				QueueUrl:      aws.String(h.topic.DrainURL),
				ReceiptHandle: received.ReceiptHandle,
			}); err != nil && ctx.Err() == nil {
				// SQS can redeliver a message whose delete failed; the fan-out is
				// at-least-once, as AWS's own SNS-to-SQS path is.
				h.registry.logf("SNS topic %s: delete drain message %s: %v", h.topic.ARN, aws.ToString(received.MessageId), err)
			}
		}
	}
}

// observe turns one drain message into an SNS notification and fans it out.
func (h *snsTopicHub) observe(ctx context.Context, received sqstypes.Message) {
	body := aws.ToString(received.Body)
	system := received.Attributes
	message, err := parseSNSEnvelope(body, system)
	if err != nil {
		h.failAll(err)
		return
	}
	if message.MessageID == "" {
		message.MessageID = aws.ToString(received.MessageId)
	}
	if message.TopicARN == "" {
		message.TopicARN = h.topic.ARN
	}
	dedupID := ""
	if h.topic.FIFO {
		dedupID, _ = snsObservedDedupID(body, message)
		if dedupID != "" {
			// Forward the SNS deduplication id, not moto's envelope hash.
			message.MessageDeduplicationID = dedupID
		}
	}
	// Each subscription records its own outcome; the aggregate error is logged
	// here so a drain observation never disappears silently.
	if err := h.dispatch(ctx, message, dedupID); err != nil {
		h.registry.logf("SNS topic %s: fan-out reported an error: %v", h.topic.ARN, err)
	}
}

// publishLocal fans out a locally published message through the same path.
func (h *snsTopicHub) publishLocal(ctx context.Context, message snsMessage) error {
	dedupID := ""
	if h.topic.FIFO {
		dedupID = message.MessageDeduplicationID
	}
	return h.dispatch(ctx, message, dedupID)
}

// dispatch applies the deduplication window and then every subscription's
// filter policy and target delivery.
func (h *snsTopicHub) dispatch(ctx context.Context, message snsMessage, dedupID string) error {
	h.deliverMu.Lock()
	defer h.deliverMu.Unlock()
	h.mu.Lock()
	if h.topic.FIFO && dedupID != "" {
		now := h.registry.clock.Now()
		for id, sentAt := range h.dedup {
			if now.Sub(sentAt) >= snsDeduplicationWindow {
				delete(h.dedup, id)
			}
		}
		if sentAt, ok := h.dedup[dedupID]; ok && now.Sub(sentAt) < snsDeduplicationWindow {
			h.mu.Unlock()
			h.registry.logf("SNS topic %s: suppressed duplicate message %s (deduplication id %s)", h.topic.ARN, message.MessageID, dedupID)
			return nil
		}
		h.dedup[dedupID] = now
	}
	attachments := make([]*snsAttachment, 0, len(h.attachments))
	for _, attachment := range h.attachments {
		attachments = append(attachments, attachment)
	}
	h.mu.Unlock()
	var errs []error
	for _, attachment := range attachments {
		if err := h.deliverAttachment(ctx, attachment, message); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// deliverAttachment evaluates one subscription's filter and delivers to its
// target, recording the outcome.
func (h *snsTopicHub) deliverAttachment(ctx context.Context, attachment *snsAttachment, message snsMessage) error {
	matched, err := snsMessageMatchesFilter(attachment.spec.FilterPolicy, attachment.spec.FilterPolicyScope, message)
	if err != nil {
		attachment.reporter.Failed(err)
		attachment.reporter.SetPhase(DeliveryPhaseFailed)
		h.registry.logf("SNS subscription %s: filter evaluation failed: %v", attachment.spec.LogicalID, err)
		return err
	}
	if !matched {
		attachment.reporter.Filtered()
		return nil
	}
	err = h.deliverTarget(ctx, attachment, message)
	if err != nil {
		attachment.reporter.Failed(err)
		attachment.reporter.SetPhase(DeliveryPhaseFailed)
		h.registry.logf("SNS subscription %s: delivery failed: %v", attachment.spec.LogicalID, err)
		return err
	}
	attachment.reporter.Delivered()
	attachment.reporter.SetPhase(DeliveryPhaseArmed)
	return nil
}

func (h *snsTopicHub) deliverTarget(ctx context.Context, attachment *snsAttachment, message snsMessage) error {
	switch attachment.spec.Protocol {
	case snsProtocolLambda:
		event := snsLambdaEvent(message, attachment.spec.ARN, h.endpoint)
		result, err := attachment.invoke(ctx, event)
		if err != nil {
			return err
		}
		if strings.TrimSpace(result.HandlerError) != "" {
			return errors.New(result.HandlerError)
		}
		return nil
	case snsProtocolSQS:
		return h.deliverSQS(ctx, attachment.spec, message)
	case snsProtocolHTTP, snsProtocolHTTPS:
		return h.deliverHTTP(ctx, attachment.spec, message)
	default:
		return fmt.Errorf("SNS protocol %q is not deliverable", attachment.spec.Protocol)
	}
}

// resolveQueue maps the subscription's qualified queue logical id to a queue
// URL on ElasticMQ and reads its FIFO setting.
func (h *snsTopicHub) resolveQueue(ctx context.Context, subscription SubscriptionSpec) (snsResolvedQueue, error) {
	h.mu.Lock()
	if queue, ok := h.queues[subscription.Queue]; ok {
		h.mu.Unlock()
		return queue, nil
	}
	h.mu.Unlock()
	target, ok := h.registry.queueLookup(subscription.Queue)
	if !ok && subscription.Stack != "" {
		target, ok = h.registry.queueLookup(subscription.Stack + "/" + subscription.Queue)
	}
	if !ok {
		return snsResolvedQueue{}, fmt.Errorf("SNS subscription %s names no provisioned SQS queue", subscription.LogicalID)
	}
	client, err := h.registry.sqsClient()
	if err != nil {
		return snsResolvedQueue{}, err
	}
	found, err := client.GetQueueUrl(ctx, &sqs.GetQueueUrlInput{QueueName: aws.String(target.Name)})
	if err != nil {
		return snsResolvedQueue{}, fmt.Errorf("resolve local SQS queue %s: %w", target.Name, err)
	}
	queueURL := aws.ToString(found.QueueUrl)
	if endpoint := client.Options().BaseEndpoint; endpoint != nil && strings.TrimSpace(*endpoint) != "" {
		// ElasticMQ names the container's localhost address; the host-side
		// client must use the published loopback endpoint.
		queueURL, err = rewriteQueueURL(queueURL, *endpoint)
		if err != nil {
			return snsResolvedQueue{}, fmt.Errorf("rewrite local SQS queue %s URL: %w", target.Name, err)
		}
	}
	attributes, err := client.GetQueueAttributes(ctx, &sqs.GetQueueAttributesInput{
		QueueUrl:       aws.String(queueURL),
		AttributeNames: []sqstypes.QueueAttributeName{sqstypes.QueueAttributeNameAll},
	})
	if err != nil {
		return snsResolvedQueue{}, fmt.Errorf("read attributes for local SQS queue %s: %w", target.Name, err)
	}
	queue := snsResolvedQueue{
		URL:  queueURL,
		FIFO: strings.EqualFold(strings.TrimSpace(attributes.Attributes[string(sqstypes.QueueAttributeNameFifoQueue)]), boolTrue),
	}
	h.mu.Lock()
	if h.queues == nil {
		h.queues = map[string]snsResolvedQueue{}
	}
	h.queues[subscription.Queue] = queue
	h.mu.Unlock()
	return queue, nil
}

// deliverSQS sends one message to an SQS subscription. Raw delivery carries
// the body and message attributes; the default carries the SNS envelope. A
// FIFO queue receives the SNS message group and deduplication ids.
func (h *snsTopicHub) deliverSQS(ctx context.Context, subscription SubscriptionSpec, message snsMessage) error {
	queue, err := h.resolveQueue(ctx, subscription)
	if err != nil {
		return err
	}
	client, err := h.registry.sqsClient()
	if err != nil {
		return err
	}
	input := &sqs.SendMessageInput{QueueUrl: aws.String(queue.URL)}
	if subscription.RawMessageDelivery {
		if len(message.Attributes) > snsMaxRawSQSMessageAttributes {
			return fmt.Errorf(
				"SNS discards a raw delivery with more than %d message attributes (subscription %s has %d)",
				snsMaxRawSQSMessageAttributes,
				subscription.LogicalID,
				len(message.Attributes),
			)
		}
		input.MessageBody = aws.String(message.Message)
		input.MessageAttributes = snsSQSRawAttributes(message.Attributes)
	} else {
		input.MessageBody = aws.String(string(snsNotificationJSON(message, subscription.ARN, h.endpoint)))
	}
	if queue.FIFO {
		if message.MessageGroupID == "" {
			return fmt.Errorf(
				"SNS subscription %s targets a FIFO queue but the message has no MessageGroupId",
				subscription.LogicalID,
			)
		}
		input.MessageGroupId = aws.String(message.MessageGroupID)
		if message.MessageDeduplicationID != "" {
			input.MessageDeduplicationId = aws.String(message.MessageDeduplicationID)
		}
	}
	if _, err := client.SendMessage(ctx, input); err != nil {
		return fmt.Errorf("send the SNS notification to local SQS queue %s: %w", queue.URL, err)
	}
	return nil
}

// deliverHTTP posts one notification to a loopback HTTP(S) endpoint.
func (h *snsTopicHub) deliverHTTP(ctx context.Context, subscription SubscriptionSpec, message snsMessage) error {
	parsed, err := parseLoopbackEndpoint(subscription.Endpoint)
	if err != nil {
		return err
	}
	body := snsNotificationJSON(message, subscription.ARN, h.endpoint)
	raw := subscription.RawMessageDelivery
	if raw {
		body = []byte(message.Message)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, parsed.String(), strings.NewReader(string(body)))
	if err != nil {
		return fmt.Errorf("build the SNS HTTP request: %w", err)
	}
	request.Header.Set("Content-Type", snsHTTPContentType)
	request.Header.Set("x-amz-sns-message-type", snsNotificationType)
	request.Header.Set("x-amz-sns-message-id", message.MessageID)
	request.Header.Set("x-amz-sns-topic-arn", message.TopicARN)
	request.Header.Set("x-amz-sns-subscription-arn", subscription.ARN)
	if raw {
		request.Header.Set("x-amz-sns-rawdelivery", snsRawMessageDeliveryTrue)
	}
	response, err := h.registry.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("post the SNS notification to %s: %w", parsed.Redacted(), err)
	}
	defer func() { _ = response.Body.Close() }() //nolint:errcheck // the response is fully read only for status
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return fmt.Errorf("SNS HTTP endpoint %s answered %d", parsed.Redacted(), response.StatusCode)
	}
	return nil
}

// parseLoopbackEndpoint re-checks that an HTTP subscription still names a
// loopback host. Derive time already refused every other endpoint; this check
// means a record edited after derive cannot make the run contact the network.
func parseLoopbackEndpoint(endpoint string) (*url.URL, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("SNS HTTP subscription endpoint %q is not an absolute URL: %w", endpoint, err)
	}
	if parsed.Scheme == "" || parsed.Hostname() == "" {
		return nil, fmt.Errorf("SNS HTTP subscription endpoint %q is not an absolute URL", endpoint)
	}
	if !loopbackHost(parsed.Hostname()) {
		return nil, fmt.Errorf(
			"SNS HTTP subscription endpoint %q is not a loopback URL; the local runner never contacts the network",
			endpoint,
		)
	}
	return parsed, nil
}

func (h *snsTopicHub) failAll(err error) {
	h.mu.Lock()
	attachments := make([]*snsAttachment, 0, len(h.attachments))
	for _, attachment := range h.attachments {
		attachments = append(attachments, attachment)
	}
	h.mu.Unlock()
	for _, attachment := range attachments {
		attachment.reporter.Failed(err)
		attachment.reporter.SetPhase(DeliveryPhaseFailed)
	}
}

func (h *snsTopicHub) wait(ctx context.Context, duration time.Duration) {
	if duration <= 0 {
		return
	}
	select {
	case <-ctx.Done():
	case <-h.registry.clock.After(duration):
	}
}

// PublishLocal publishes one message to a local SNS topic through the same
// filter and fan-out path an observed SDK publish uses. E3 and E4 call it for
// their SNS rule and notification targets; it never goes through moto.
func (r *Runner) PublishLocal(ctx context.Context, topicARN, message string) error {
	return r.PublishLocalMessage(ctx, topicARN, LocalSNSMessage{Message: message})
}

// PublishLocalMessage is PublishLocal with attributes, a subject and FIFO
// group/deduplication ids.
func (r *Runner) PublishLocalMessage(ctx context.Context, topicARN string, message LocalSNSMessage) error {
	if r.sns == nil {
		return errors.New("the local SNS fan-out is not configured")
	}
	return r.sns.publishLocal(ctx, topicARN, message)
}
