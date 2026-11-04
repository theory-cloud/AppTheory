package localrunner

import (
	"context"
	"fmt"
)

// startDelivery registers every derived mapping, rule and subscription and
// starts the engine. It runs after the functions and listeners are ready, so a
// deliverer that starts polling finds its target container running.
func (r *Runner) startDelivery(ctx context.Context, spec *Spec) error {
	if r.delivery == nil {
		return nil
	}
	if err := r.delivery.Start(ctx, spec); err != nil {
		return err
	}
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
	if backend, ok := r.backendForService(service); ok && backend.HostURL != "" {
		return DeliveryBackend{
			Service:  service,
			Endpoint: backend.HostURL,
			Client:   deliveryClient(service, backend.HostURL),
		}, nil
	}
	if kind == DeliveryKindEventBridgeSchedule || kind == DeliveryKindEventBridgeRule {
		return DeliveryBackend{Service: "events"}, nil
	}
	return DeliveryBackend{}, fmt.Errorf("the %s backend is not running", service)
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
	default:
		return ""
	}
}

func deliveryClient(service, endpoint string) any {
	switch service {
	case backendSQS:
		return newSQSClient(endpoint)
	case backendDynamoDB:
		return newDynamoDBClient(endpoint)
	case backendSNS:
		return newSNSClient(endpoint)
	default:
		return nil
	}
}
