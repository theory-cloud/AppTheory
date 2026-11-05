package localrunner

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

// The delivery engine is the local counterpart of the Lambda service that owns
// event source mappings, EventBridge rule delivery and log subscriptions. It
// registers every derived source, runs one deliverer goroutine per source kind
// and reports delivery state. E1a ships the engine and the interfaces; the
// per-service deliverers land in E1b–E6.
//
// State vocabulary: AWS reports an event source mapping's lifecycle in State
// (Creating, Enabling, Enabled, Disabling, Disabled, Updating, Deleting) and
// its processing outcome in LastProcessingResult, with StateTransitionReason
// saying who made the last change. See
// https://docs.aws.amazon.com/lambda/latest/dg/API_EventSourceMappingConfiguration.html
// and https://docs.aws.amazon.com/lambda/latest/dg/invocation-eventsourcemapping.html.
// The local engine keeps the same shape in a reduced vocabulary: registered
// (≈ Creating), polling (≈ Enabled for a queue or stream poller), armed
// (≈ Enabled for a schedule or rule waiting on the clock), paused (≈ Disabled),
// stopped (≈ Deleting) and failed (≈ a LastProcessingResult that reports a
// problem). A source kind without a deliverer is not-delivered and names the
// task that will implement it.

const (
	// defaultDeliveryConcurrency is the documented delivery bound for the
	// Colima host (4 CPU / ~6 GB). One delivery per CPU leaves a core for the
	// emulator containers and the HTTP transport, and a larger bound only
	// queues inside the one container per function.
	defaultDeliveryConcurrency = 4
	// maxDeliveryConcurrency is the same upper bound the HTTP transport uses.
	maxDeliveryConcurrency = maxConcurrency
	// deliveryStopTimeout bounds how long one deliverer may take to stop.
	deliveryStopTimeout = 5 * time.Second
)

// DeliveryKind names one source kind the engine can deliver. The mapping kinds
// match EventSourceSpec.Type; rule kinds split scheduled rules from pattern
// rules, and cloudwatch-logs covers a log subscription filter.
type DeliveryKind string

const (
	// DeliveryKindSQS is an SQS event source mapping.
	DeliveryKindSQS DeliveryKind = "sqs"
	// DeliveryKindDynamoDBStream is a DynamoDB Streams event source mapping.
	DeliveryKindDynamoDBStream DeliveryKind = "dynamodb"
	// DeliveryKindKinesis is a Kinesis event source mapping.
	DeliveryKindKinesis DeliveryKind = "kinesis"
	// DeliveryKindEventBridgeSchedule is an EventBridge scheduled rule.
	DeliveryKindEventBridgeSchedule DeliveryKind = "eventbridge-schedule"
	// DeliveryKindEventBridgeRule is an EventBridge pattern rule.
	DeliveryKindEventBridgeRule DeliveryKind = "eventbridge-rule"
	// DeliveryKindCloudWatchLogs is a CloudWatch Logs subscription filter.
	DeliveryKindCloudWatchLogs DeliveryKind = "cloudwatch-logs"
	// DeliveryKindSNS is an SNS topic subscription.
	DeliveryKindSNS DeliveryKind = "sns"
	// DeliveryKindS3Notification is one S3 bucket notification configuration
	// entry: a Lambda, SQS or SNS destination, or the bucket's EventBridge
	// configuration.
	DeliveryKindS3Notification DeliveryKind = "s3-notification"
)

// deliveryTask names the wave-2 task that implements a kind's deliverer.
var deliveryTask = map[DeliveryKind]string{
	DeliveryKindSQS:                 "E1b",
	DeliveryKindDynamoDBStream:      "E2",
	DeliveryKindKinesis:             "E5",
	DeliveryKindEventBridgeSchedule: "E3",
	DeliveryKindEventBridgeRule:     "E3",
	DeliveryKindCloudWatchLogs:      "E5",
	DeliveryKindSNS:                 "E6",
	DeliveryKindS3Notification:      "E4",
}

// deliveryKindLabel describes a kind in the delivery state reason.
var deliveryKindLabel = map[DeliveryKind]string{
	DeliveryKindSQS:                 "SQS event-source delivery",
	DeliveryKindDynamoDBStream:      "DynamoDB Streams delivery",
	DeliveryKindKinesis:             "Kinesis delivery",
	DeliveryKindEventBridgeSchedule: "EventBridge schedule delivery",
	DeliveryKindEventBridgeRule:     "EventBridge rule delivery",
	DeliveryKindCloudWatchLogs:      "CloudWatch Logs subscription delivery",
	DeliveryKindSNS:                 "SNS subscription delivery",
	DeliveryKindS3Notification:      "S3 event notification delivery",
}

// DeliveryPhase is one source's delivery state, the local counterpart of the
// event source mapping State field.
type DeliveryPhase string

const (
	// DeliveryPhaseRegistered is a source whose kind has a deliverer, before
	// the deliverer reports that it is polling or armed.
	DeliveryPhaseRegistered DeliveryPhase = "registered"
	// DeliveryPhasePolling is a deliverer actively polling a queue or stream.
	DeliveryPhasePolling DeliveryPhase = "polling"
	// DeliveryPhaseArmed is a deliverer waiting for the clock to reach the next
	// schedule or matching an event against a rule.
	DeliveryPhaseArmed DeliveryPhase = "armed"
	// DeliveryPhasePaused is a deliverer that is registered but not delivering.
	DeliveryPhasePaused DeliveryPhase = "paused"
	// DeliveryPhaseStopped is a deliverer that has stopped.
	DeliveryPhaseStopped DeliveryPhase = "stopped"
	// DeliveryPhaseFailed is a deliverer that could not start or deliver.
	DeliveryPhaseFailed DeliveryPhase = "failed"
	// DeliveryPhaseNotDelivered is a source kind with no deliverer yet.
	DeliveryPhaseNotDelivered DeliveryPhase = "not-delivered"
)

// DeliveryBackend is the resolved local backend a deliverer talks to: the
// service name, its loopback endpoint and the host-side SDK client, when the
// service has one. SQS and PublishSNS are the auxiliary clients an event
// deliverer needs for its targets and on-failure destinations.
type DeliveryBackend struct {
	Service  string `json:"service"`
	Endpoint string `json:"endpoint,omitempty"`
	Client   any    `json:"-"`
	// SQS is the host-side ElasticMQ client when the SQS backend is running.
	SQS *sqs.Client `json:"-"`
	// PublishSNS runs one message through the local SNS fan-out.
	PublishSNS func(ctx context.Context, topicARN string, message LocalSNSMessage) error `json:"-"`
}

// DeliveryResolver resolves the backend for one source kind. The runner
// implements it from the profile endpoints it started; tests can supply their
// own.
type DeliveryResolver func(kind DeliveryKind) (DeliveryBackend, error)

// DeliverFunc sends one provider event to one registered function.
type DeliverFunc func(ctx context.Context, function string, event []byte) (InvokeResult, error)

// DeliverySource is one derived mapping, rule or subscription the engine
// registers. Exactly one of Mapping, Rule or Subscription is set.
type DeliverySource struct {
	// ID is stable across plan and session: the qualified logical id.
	ID        string       `json:"id"`
	Kind      DeliveryKind `json:"kind"`
	Stack     string       `json:"stack"`
	LogicalID string       `json:"logicalId"`
	// Function is the single function a mapping or subscription delivers to.
	Function string `json:"function,omitempty"`
	// Targets are the functions a rule invokes, in the declared order.
	Targets      []string          `json:"targets,omitempty"`
	Mapping      *EventSourceSpec  `json:"mapping,omitempty"`
	Rule         *RuleSpec         `json:"rule,omitempty"`
	Subscription *SubscriptionSpec `json:"subscription,omitempty"`
	Notification *NotificationSpec `json:"notification,omitempty"`
}

// DeliveryState is one source's reported delivery state.
type DeliveryState struct {
	ID       string        `json:"id"`
	Kind     DeliveryKind  `json:"kind"`
	Function string        `json:"function,omitempty"`
	Targets  []string      `json:"targets,omitempty"`
	State    DeliveryPhase `json:"state"`
	// Delivered and Failed count handler invocations the deliverer completed.
	Delivered int64 `json:"delivered"`
	Failed    int64 `json:"failed"`
	// Filtered counts messages a subscription filter policy did not match.
	Filtered int64 `json:"filtered,omitempty"`
	// Fired counts the rule evaluations or schedule ticks a rule produced.
	Fired int64 `json:"fired,omitempty"`
	// Discarded counts stream records sent to an on-failure destination, and
	// DeadLettered counts EventBridge events sent to a target DLQ.
	Discarded    int64 `json:"discarded,omitempty"`
	DeadLettered int64 `json:"deadLettered,omitempty"`
	// Inflight is the number of batches the deliverer is invoking right now;
	// PeakInflight is the highest observed value. They make a mapping's
	// MaximumConcurrency observable from session describe.
	Inflight     int `json:"inflight"`
	PeakInflight int `json:"peakInflight"`
	// Left counts the records the deliverer left undeleted for redelivery, in
	// total. A partial batch response or a failed invocation adds to it.
	Left int64 `json:"left"`
	// LastError is the last delivery error, empty after a success.
	LastError string `json:"lastError,omitempty"`
	Paused    bool   `json:"paused"`
	// Task names the delivery task that implements the kind when the engine has
	// no deliverer for it.
	Task string `json:"task,omitempty"`
	// Reason explains a state that is not delivering.
	Reason string `json:"reason,omitempty"`
}

// DeliveryCell renders one state for the human plan output.
func DeliveryCell(state DeliveryState) string {
	if state.State != DeliveryPhaseNotDelivered {
		return string(state.State)
	}
	cell := string(state.State) + ": " + state.Reason
	if state.Task != "" {
		cell += " (task " + state.Task + ")"
	}
	return cell
}

// EngineState is the delivery engine's live state.
type EngineState struct {
	Running     bool            `json:"running"`
	Clock       ClockState      `json:"clock"`
	Concurrency int             `json:"concurrency"`
	Sources     []DeliveryState `json:"sources"`
}

// ClockState reports the run's clock mode and current instant.
type ClockState struct {
	Mode string    `json:"mode"`
	Now  time.Time `json:"now"`
}

// DeliveryReporter is the engine-owned state a running deliverer updates.
type DeliveryReporter interface {
	// SetPhase reports the deliverer's current phase.
	SetPhase(phase DeliveryPhase)
	// Delivered records a completed handler invocation.
	Delivered()
	// Failed records a failed handler invocation.
	Failed(err error)
	// Filtered records a message a subscription filter did not match.
	Filtered()
	// SetPaused records whether delivery is paused.
	SetPaused(paused bool)
	// SetInflight records how many batches the deliverer is invoking now. The
	// engine keeps the observed peak.
	SetInflight(inflight int)
	// Left records how many records the deliverer left for redelivery.
	Left(count int)
	// Discarded records how many stream records were sent to an on-failure
	// destination.
	Discarded(count int)
	// Fired records one rule evaluation or schedule tick.
	Fired()
	// DeadLettered records one EventBridge event sent to a target DLQ.
	DeadLettered()
}

// DelivererEnv is everything a deliverer receives from the engine.
type DelivererEnv struct {
	// Source is the registered mapping, rule or subscription.
	Source DeliverySource
	// Clock is the run's time source. Schedules, TTL expiry and visibility
	// timeouts must take their time from it, never from time.Now.
	Clock Clock
	// Backend is the resolved local backend client and endpoint.
	Backend DeliveryBackend
	// Invoke sends one event to the source's own function.
	Invoke func(ctx context.Context, event []byte) (InvokeResult, error)
	// InvokeTarget sends one event to a named function. A rule can target
	// several functions.
	InvokeTarget DeliverFunc
	// State is the engine-owned reporting surface for this source.
	State DeliveryReporter
	// Concurrency is the engine's global invocation bound. A deliverer with
	// its own per-mapping bound never exceeds it.
	Concurrency int
	// Logf writes one line to the run log.
	Logf func(format string, args ...any)
}

// Deliverer is one source kind's delivery loop. E1b–E6 implement it. Start
// blocks until ctx is canceled; it reports polling or armed through env.State
// as soon as it is delivering, and returns an error when it cannot deliver.
type Deliverer interface {
	Start(ctx context.Context, env DelivererEnv) error
}

// DelivererFactory builds the deliverer for one registered source.
type DelivererFactory func(source DeliverySource) (Deliverer, error)

// DeliveryEngine owns the registry of deliverers, the registered sources, the
// bounded concurrency and the reported state.
type DeliveryEngine struct {
	clock       Clock
	concurrency int
	resolver    DeliveryResolver
	invoker     DeliverFunc
	logf        func(format string, args ...any)

	mu        sync.Mutex
	factories map[DeliveryKind]DelivererFactory
	order     []string
	states    map[string]*DeliveryState
	started   bool
	stopped   bool
	draining  bool
	ctx       context.Context
	cancel    context.CancelFunc
	wg        sync.WaitGroup
	inflight  sync.WaitGroup
	sem       chan struct{}
}

// NewDeliveryEngine builds the engine for one run. A nil clock is the real
// clock; a concurrency of zero is the documented default; a nil resolver or
// invoker makes the corresponding operation fail closed.
func NewDeliveryEngine(clock Clock, concurrency int, resolver DeliveryResolver, invoker DeliverFunc, logf func(format string, args ...any)) *DeliveryEngine {
	if clock == nil {
		clock = RealClock{}
	}
	if concurrency <= 0 {
		concurrency = defaultDeliveryConcurrency
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &DeliveryEngine{
		clock:       clock,
		concurrency: concurrency,
		resolver:    resolver,
		invoker:     invoker,
		logf:        logf,
		factories:   map[DeliveryKind]DelivererFactory{},
		states:      map[string]*DeliveryState{},
		sem:         make(chan struct{}, concurrency),
	}
}

// Clock returns the engine's time source.
func (e *DeliveryEngine) Clock() Clock {
	return e.clock
}

// RegisterDeliverer installs the deliverer implementation for one source kind.
// E1b–E6 call it once per kind.
func (e *DeliveryEngine) RegisterDeliverer(kind DeliveryKind, factory DelivererFactory) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.factories[kind] = factory
}

// DeliverySources lists every derived mapping, rule and subscription in the
// order the engine registers them.
func DeliverySources(spec *Spec) []DeliverySource {
	if spec == nil {
		return nil
	}
	sources := make([]DeliverySource, 0, len(spec.EventSources)+len(spec.Rules)+len(spec.Subscriptions))
	for index := range spec.EventSources {
		mapping := spec.EventSources[index]
		sources = append(sources, DeliverySource{
			ID:        mapping.LogicalID,
			Kind:      DeliveryKind(mapping.Type),
			Stack:     mapping.Stack,
			LogicalID: mapping.LogicalID,
			Function:  mapping.Function,
			Mapping:   &mapping,
		})
	}
	for index := range spec.Rules {
		rule := spec.Rules[index]
		sources = append(sources, DeliverySource{
			ID:        rule.LogicalID,
			Kind:      ruleDeliveryKind(rule),
			Stack:     rule.Stack,
			LogicalID: rule.LogicalID,
			Targets:   append([]string(nil), rule.Targets...),
			Rule:      &rule,
		})
	}
	for index := range spec.Subscriptions {
		subscription := spec.Subscriptions[index]
		sources = append(sources, DeliverySource{
			ID:           subscription.LogicalID,
			Kind:         DeliveryKind(subscription.Kind),
			Stack:        subscription.Stack,
			LogicalID:    subscription.LogicalID,
			Function:     subscription.Function,
			Subscription: &subscription,
		})
	}
	for index := range spec.Notifications {
		notification := spec.Notifications[index]
		function := ""
		if notification.DestinationType == notificationDestinationFunction {
			function = notification.Destination
		}
		sources = append(sources, DeliverySource{
			ID:           notification.LogicalID,
			Kind:         DeliveryKindS3Notification,
			Stack:        notification.Stack,
			LogicalID:    notification.LogicalID,
			Function:     function,
			Notification: &notification,
		})
	}
	sort.Slice(sources, func(i, j int) bool {
		if sources[i].Kind != sources[j].Kind {
			return sources[i].Kind < sources[j].Kind
		}
		return sources[i].ID < sources[j].ID
	})
	return sources
}

func ruleDeliveryKind(rule RuleSpec) DeliveryKind {
	if strings.TrimSpace(rule.Schedule) != "" {
		return DeliveryKindEventBridgeSchedule
	}
	return DeliveryKindEventBridgeRule
}

// Planned reports the state the engine would register for every derived
// source, without starting a run. It is what `plan` prints: a kind with a
// deliverer is registered; every other kind is not-delivered with the task
// that will implement it.
func (e *DeliveryEngine) Planned(spec *Spec) []DeliveryState {
	e.mu.Lock()
	factories := make(map[DeliveryKind]bool, len(e.factories))
	for kind := range e.factories {
		factories[kind] = true
	}
	e.mu.Unlock()

	sources := DeliverySources(spec)
	states := make([]DeliveryState, 0, len(sources))
	for _, source := range sources {
		state := baseDeliveryState(source)
		if factories[source.Kind] {
			state.State = DeliveryPhaseRegistered
		} else {
			state.State = DeliveryPhaseNotDelivered
			state.Task = deliveryTask[source.Kind]
			state.Reason = notDeliveredReason(source.Kind)
		}
		states = append(states, state)
	}
	return states
}

// Start registers every derived source and starts one deliverer per source
// whose kind has one. A source kind without a deliverer is recorded as
// not-delivered; it never prevents the run from starting.
func (e *DeliveryEngine) Start(ctx context.Context, spec *Spec) error {
	e.mu.Lock()
	if e.started {
		e.mu.Unlock()
		return errors.New("the delivery engine is already started")
	}
	e.started = true
	e.ctx, e.cancel = context.WithCancel(ctx)
	sources, started := e.startSourcesLocked(spec)
	e.mu.Unlock()
	e.logf(
		"delivery engine: %s clock, concurrency %d, %d source(s), %d deliverer(s)",
		ClockModeOf(e.clock),
		e.concurrency,
		len(sources),
		started,
	)
	return nil
}

// startSourcesLocked registers every derived source and starts one deliverer
// per kind that has one. The caller holds e.mu.
func (e *DeliveryEngine) startSourcesLocked(spec *Spec) ([]DeliverySource, int) {
	sources := DeliverySources(spec)
	var started int
	for _, source := range sources {
		state := baseDeliveryState(source)
		factory, ok := e.factories[source.Kind]
		if !ok {
			state.State = DeliveryPhaseNotDelivered
			state.Task = deliveryTask[source.Kind]
			state.Reason = notDeliveredReason(source.Kind)
			e.order = append(e.order, source.ID)
			e.states[source.ID] = &state
			continue
		}
		state.State = DeliveryPhaseRegistered
		e.order = append(e.order, source.ID)
		e.states[source.ID] = &state
		started++
		e.wg.Add(1)
		go e.runSource(factory, source)
	}
	return sources, started
}

// Restart re-derives every registered source after a watch reload. The
// running deliverers are canceled and drained, then the new Spec's sources are
// registered on a fresh engine context. Counters start from zero, which is the
// honest reading of a rebuilt local session.
func (e *DeliveryEngine) Restart(ctx context.Context, spec *Spec) error {
	e.mu.Lock()
	if !e.started {
		e.mu.Unlock()
		return e.Start(ctx, spec)
	}
	cancel := e.cancel
	e.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	e.wg.Wait()

	e.mu.Lock()
	if e.stopped {
		e.mu.Unlock()
		return nil
	}
	e.ctx, e.cancel = context.WithCancel(ctx)
	e.draining = false
	e.order = nil
	e.states = map[string]*DeliveryState{}
	sources, started := e.startSourcesLocked(spec)
	e.mu.Unlock()
	e.logf("delivery engine reloaded: %d source(s), %d deliverer(s)", len(sources), started)
	return nil
}

// runSource resolves the backend, builds the deliverer environment and runs one
// deliverer until its context ends or it fails.
func (e *DeliveryEngine) runSource(factory DelivererFactory, source DeliverySource) {
	defer e.wg.Done()
	deliverer, err := factory(source)
	if err != nil {
		e.logf("delivery %s: build deliverer failed: %v", source.ID, err)
		e.fail(source.ID, err)
		return
	}
	backend := DeliveryBackend{}
	if e.resolver != nil {
		backend, err = e.resolver(source.Kind)
		if err != nil {
			e.logf("delivery %s: resolve backend failed: %v", source.ID, err)
			e.fail(source.ID, err)
			return
		}
	}
	env := DelivererEnv{
		Source:  source,
		Clock:   e.clock,
		Backend: backend,
		Invoke: func(ctx context.Context, event []byte) (InvokeResult, error) {
			return e.invoke(ctx, source.Function, event)
		},
		InvokeTarget: e.invoke,
		State:        &sourceReporter{engine: e, id: source.ID},
		Concurrency:  e.concurrency,
		Logf:         e.logf,
	}
	if startErr := deliverer.Start(e.ctx, env); startErr != nil && !errors.Is(startErr, context.Canceled) {
		e.logf("delivery %s: deliverer failed: %v", source.ID, startErr)
		e.fail(source.ID, startErr)
		return
	}
	e.setPhase(source.ID, DeliveryPhaseStopped)
}

// invoke runs one handler invocation under the engine's concurrency bound.
func (e *DeliveryEngine) invoke(ctx context.Context, function string, event []byte) (InvokeResult, error) {
	if strings.TrimSpace(function) == "" {
		return InvokeResult{}, errors.New("the delivery source has no target function")
	}
	if e.invoker == nil {
		return InvokeResult{}, errors.New("the delivery engine has no function invoker")
	}
	e.mu.Lock()
	draining := e.draining
	e.mu.Unlock()
	if draining {
		return InvokeResult{}, errors.New("the delivery engine is draining")
	}
	select {
	case e.sem <- struct{}{}:
	case <-ctx.Done():
		return InvokeResult{}, ctx.Err()
	}
	defer func() { <-e.sem }()
	e.inflight.Add(1)
	defer e.inflight.Done()
	return e.invoker(ctx, function, event)
}

// Drain stops accepting new deliveries and waits for in-flight invocations to
// finish. It is the graceful half of shutdown; Stop cancels the deliverers.
func (e *DeliveryEngine) Drain(ctx context.Context) error {
	e.mu.Lock()
	if !e.started || e.stopped {
		e.mu.Unlock()
		return nil
	}
	e.draining = true
	e.mu.Unlock()

	done := make(chan struct{})
	go func() {
		e.inflight.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("the delivery engine did not drain in time: %w", ctx.Err())
	}
}

// Stop cancels every deliverer, waits for them to return and records the
// stopped state. It is safe to call more than once.
func (e *DeliveryEngine) Stop(ctx context.Context) error {
	e.mu.Lock()
	if !e.started || e.stopped {
		e.mu.Unlock()
		return nil
	}
	cancel := e.cancel
	e.mu.Unlock()

	stopCtx, stopCancel := stopContext(ctx)
	defer stopCancel()
	drainErr := e.Drain(stopCtx)
	if cancel != nil {
		cancel()
	}
	done := make(chan struct{})
	go func() {
		e.wg.Wait()
		close(done)
	}()
	var stopErr error
	select {
	case <-done:
	case <-stopCtx.Done():
		stopErr = fmt.Errorf("a delivery deliverer did not stop in time: %w", stopCtx.Err())
	}
	e.mu.Lock()
	e.stopped = true
	e.draining = false
	for _, id := range e.order {
		if state := e.states[id]; state != nil && state.State != DeliveryPhaseNotDelivered {
			state.State = DeliveryPhaseStopped
			state.Paused = false
		}
	}
	count := len(e.order)
	e.mu.Unlock()
	e.logf("delivery engine stopped: %d source(s)", count)
	return errors.Join(drainErr, stopErr)
}

// State snapshots the live engine state for `session describe`.
func (e *DeliveryEngine) State() EngineState {
	e.mu.Lock()
	defer e.mu.Unlock()
	state := EngineState{
		Running:     e.started && !e.stopped,
		Clock:       ClockState{Mode: string(ClockModeOf(e.clock)), Now: e.clock.Now()},
		Concurrency: e.concurrency,
		Sources:     make([]DeliveryState, 0, len(e.order)),
	}
	for _, id := range e.order {
		if source := e.states[id]; source != nil {
			state.Sources = append(state.Sources, *source)
		}
	}
	return state
}

// stopContext caps a stop at deliveryStopTimeout unless the caller already set
// a shorter deadline.
func stopContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) <= deliveryStopTimeout {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, deliveryStopTimeout)
}

func (e *DeliveryEngine) setPhase(id string, phase DeliveryPhase) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if state := e.states[id]; state != nil {
		state.State = phase
	}
}

func (e *DeliveryEngine) fail(id string, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if state := e.states[id]; state != nil {
		state.State = DeliveryPhaseFailed
		state.LastError = err.Error()
	}
}

func baseDeliveryState(source DeliverySource) DeliveryState {
	return DeliveryState{
		ID:       source.ID,
		Kind:     source.Kind,
		Function: source.Function,
		Targets:  append([]string(nil), source.Targets...),
	}
}

func notDeliveredReason(kind DeliveryKind) string {
	label := deliveryKindLabel[kind]
	if label == "" {
		label = string(kind) + " delivery"
	}
	task := deliveryTask[kind]
	if task == "" {
		return "no deliverer is registered for " + label
	}
	return "engine present; " + label + " lands in " + task
}

// sourceReporter is the per-source DeliveryReporter handed to one deliverer.
type sourceReporter struct {
	engine *DeliveryEngine
	id     string
}

func (r *sourceReporter) SetPhase(phase DeliveryPhase) {
	r.engine.setPhase(r.id, phase)
}

func (r *sourceReporter) Delivered() {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if state := r.engine.states[r.id]; state != nil {
		state.Delivered++
		state.LastError = ""
	}
}

func (r *sourceReporter) Failed(err error) {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if state := r.engine.states[r.id]; state != nil {
		state.Failed++
		if err != nil {
			state.LastError = err.Error()
		}
	}
}

func (r *sourceReporter) Filtered() {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if state := r.engine.states[r.id]; state != nil {
		state.Filtered++
	}
}

func (r *sourceReporter) SetPaused(paused bool) {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if state := r.engine.states[r.id]; state != nil {
		state.Paused = paused
		if paused {
			state.State = DeliveryPhasePaused
		}
	}
}

func (r *sourceReporter) Left(count int) {
	if count <= 0 {
		return
	}
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if state := r.engine.states[r.id]; state != nil {
		state.Left += int64(count)
	}
}

func (r *sourceReporter) Discarded(count int) {
	if count <= 0 {
		return
	}
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if state := r.engine.states[r.id]; state != nil {
		state.Discarded += int64(count)
	}
}

func (r *sourceReporter) Fired() {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if state := r.engine.states[r.id]; state != nil {
		state.Fired++
	}
}

func (r *sourceReporter) DeadLettered() {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if state := r.engine.states[r.id]; state != nil {
		state.DeadLettered++
	}
}

func (r *sourceReporter) SetInflight(inflight int) {
	r.engine.mu.Lock()
	defer r.engine.mu.Unlock()
	if state := r.engine.states[r.id]; state != nil {
		state.Inflight = inflight
		if inflight > state.PeakInflight {
			state.PeakInflight = inflight
		}
	}
}
