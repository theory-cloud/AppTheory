package localrunner

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/service/kinesis"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// startDelivery registers every derived mapping, rule and subscription and
// starts the engine. It runs after the functions and listeners are ready, so a
// deliverer that starts polling finds its target container running. The TTL
// sweep starts with the engine: DynamoDB Local does not expire items, so the
// runner performs the documented TTL delete on the run clock.
func (r *Runner) startDelivery(ctx context.Context, spec *Spec) error {
	if r.delivery == nil {
		return nil
	}
	if err := r.delivery.Start(ctx, spec); err != nil {
		return err
	}
	r.startTTLSweeper(ctx)
	for _, source := range r.delivery.State().Sources {
		if source.State == DeliveryPhaseNotDelivered {
			r.logf("delivery %s: %s", source.ID, DeliveryCell(source))
		}
	}
	return nil
}

// invokeDelivery is the engine's function invoker. It sends one event to a
// started function container through the same RIE path a session invocation
// uses.
func (r *Runner) invokeDelivery(ctx context.Context, function string, event []byte) (InvokeResult, error) {
	process, ok := r.invokers[function]
	if !ok {
		return InvokeResult{}, fmt.Errorf("delivery target %s is not running", function)
	}
	raw, err := process.Invoke(ctx, event)
	if err != nil {
		return InvokeResult{}, err
	}
	return decodeInvokeResult(raw), nil
}

// ResolveDeliveryBackend resolves the local backend a source kind delivers
// from: the loopback endpoint the runner published and the host-side SDK client
// for the services that have one. EventBridge schedules and rules are served by
// the runner itself, so their backend is the engine; a kind whose emulator is
// not running fails closed before a deliverer starts.
func (r *Runner) ResolveDeliveryBackend(kind DeliveryKind) (DeliveryBackend, error) {
	service := deliveryBackendService(kind)
	if service == "" {
		return DeliveryBackend{}, fmt.Errorf("source kind %q has no local backend", kind)
	}
	backend := DeliveryBackend{
		Service:    service,
		SQS:        r.deliverySQSClientOrNil(),
		PublishSNS: r.PublishLocalMessage,
	}
	if resolved, ok := r.backendForService(service); ok && resolved.HostURL != "" {
		backend.Endpoint = resolved.HostURL
		backend.Client = deliveryClient(service, resolved.HostURL)
		if service == logsService {
			// A subscription whose destination is a Kinesis stream puts the
			// gzip payload into moto's stream, so the Logs backend also carries
			// the Kinesis client when that backend runs on the same moto host.
			var kinesisClient *kinesis.Client
			if kin, ok := r.backendForService(backendKinesis); ok && kin.HostURL != "" {
				kinesisClient = newKinesisClient(kin.HostURL)
			}
			backend.Client = &logsLocalBackend{
				logs:    newCloudWatchLogsClient(resolved.HostURL),
				kinesis: kinesisClient,
			}
		}
		return backend, nil
	}
	if kind == DeliveryKindEventBridgeSchedule || kind == DeliveryKindEventBridgeRule {
		backend.Service = eventsService
		return backend, nil
	}
	return DeliveryBackend{}, fmt.Errorf("the %s backend is not running", service)
}

// deliverySQSClientOrNil builds the host-side ElasticMQ client used for SQS
// targets and on-failure destinations. A run without the SQS backend still
// starts rule deliverers that only target Lambda or SNS; an SQS target then
// fails with a named error.
func (r *Runner) deliverySQSClientOrNil() *sqs.Client {
	backend, ok := r.backendForService(backendSQS)
	if !ok || backend.HostURL == "" {
		return nil
	}
	return newSQSClient(backend.HostURL)
}

func deliveryBackendService(kind DeliveryKind) string {
	switch kind {
	case DeliveryKindSQS:
		return backendSQS
	case DeliveryKindDynamoDBStream:
		return backendDynamoDB
	case DeliveryKindKinesis:
		return backendKinesis
	case DeliveryKindEventBridgeSchedule, DeliveryKindEventBridgeRule:
		return "events"
	case DeliveryKindCloudWatchLogs:
		return "logs"
	case DeliveryKindSNS:
		return backendSNS
	case DeliveryKindS3Notification:
		return "s3"
	default:
		return ""
	}
}

func deliveryClient(service, endpoint string) any {
	switch service {
	case backendSQS:
		return newSQSClient(endpoint)
	case backendDynamoDB:
		return &dynamoDBLocalBackend{data: newDynamoDBClient(endpoint), streams: newDynamoStreamsClient(endpoint)}
	case backendKinesis:
		return newKinesisClient(endpoint)
	case backendSNS:
		// The SNS deliverer needs both services: moto serves the publish side
		// and the per-topic drain queue on the same endpoint.
		return &snsLocalBackend{sns: newSNSClient(endpoint), sqs: newSQSClient(endpoint)}
	default:
		return nil
	}
}
