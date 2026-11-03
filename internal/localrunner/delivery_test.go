package localrunner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/sqs"
)

func deliveryTestSpec() *Spec {
	return &Spec{
		EventSources: []EventSourceSpec{
			{LogicalID: "QueueMapping", Stack: "Stack", Function: "Stack/Worker", Type: backendSQS, SourceName: "events", Enabled: true},
			{LogicalID: "StreamMapping", Stack: "Stack", Function: "Stack/Worker", Type: backendDynamoDB, SourceName: "table", Enabled: true},
		},
		Rules: []RuleSpec{
			{LogicalID: "ScheduleRule", Stack: "Stack", Name: "schedule", Schedule: "rate(1 minute)", Targets: []string{"Stack/Worker"}, Enabled: true},
			{LogicalID: "PatternRule", Stack: "Stack", Name: "pattern", EventPattern: json.RawMessage(`{"source":["x"]}`), Targets: []string{"Stack/Worker"}, Enabled: true},
		},
		Subscriptions: []SubscriptionSpec{
			{LogicalID: "LogFilter", Stack: "Stack", Kind: string(DeliveryKindCloudWatchLogs), Function: "Stack/Worker", FilterName: "all"},
		},
	}
}

type probeDeliverer struct {
	started chan DelivererEnv
	stopped chan struct{}
	once    sync.Once
}

func newProbeDeliverer() *probeDeliverer {
	return &probeDeliverer{started: make(chan DelivererEnv, 1), stopped: make(chan struct{})}
}

func (d *probeDeliverer) Start(ctx context.Context, env DelivererEnv) error {
	d.started <- env
	<-ctx.Done()
	d.once.Do(func() { close(d.stopped) })
	return nil
}

type burstDeliverer struct {
	count int
	done  chan struct{}
}

func (d *burstDeliverer) Start(ctx context.Context, env DelivererEnv) error {
	var wait sync.WaitGroup
	for index := 0; index < d.count; index++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			//nolint:errcheck // the concurrency test only measures overlap.
			_, _ = env.Invoke(ctx, []byte(`{}`))
		}()
	}
	wait.Wait()
	close(d.done)
	<-ctx.Done()
	return nil
}

type blockingDeliverer struct {
	started chan struct{}
	release chan struct{}
}

func (d blockingDeliverer) Start(context.Context, DelivererEnv) error {
	d.started <- struct{}{}
	<-d.release
	return nil
}

type failingDeliverer struct {
	err error
}

func (d failingDeliverer) Start(context.Context, DelivererEnv) error {
	return d.err
}

func waitForPhase(t *testing.T, engine *DeliveryEngine, id string, phase DeliveryPhase) DeliveryState {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, state := range engine.State().Sources {
			if state.ID == id && state.State == phase {
				return state
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("source %s never reached %s: %+v", id, phase, engine.State().Sources)
	return DeliveryState{}
}

func TestDeliveryPlannedReportsEverySourceWithItsTask(t *testing.T) {
	engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), 2, nil, nil, nil)
	planned := engine.Planned(deliveryTestSpec())
	want := map[string]string{
		"QueueMapping":  "E1b",
		"StreamMapping": "E2",
		"ScheduleRule":  "E3",
		"PatternRule":   "E3",
		"LogFilter":     "E5",
	}
	if len(planned) != len(want) {
		t.Fatalf("want %d planned sources, got %+v", len(want), planned)
	}
	for _, state := range planned {
		if state.State != DeliveryPhaseNotDelivered {
			t.Fatalf("%s must be not-delivered, got %s", state.ID, state.State)
		}
		if state.Task != want[state.ID] {
			t.Fatalf("%s: want task %s, got %q", state.ID, want[state.ID], state.Task)
		}
		if !strings.Contains(state.Reason, "engine present") {
			t.Fatalf("%s: reason does not name the engine: %q", state.ID, state.Reason)
		}
	}
	byID := map[string]DeliveryState{}
	for _, state := range planned {
		byID[state.ID] = state
	}
	if byID["ScheduleRule"].Kind != DeliveryKindEventBridgeSchedule {
		t.Fatalf("a scheduled rule must register as a schedule: %+v", byID["ScheduleRule"])
	}
	if byID["PatternRule"].Kind != DeliveryKindEventBridgeRule {
		t.Fatalf("a pattern rule must register as a rule: %+v", byID["PatternRule"])
	}
}

func TestDeliveryPlannedReportsARegisteredKind(t *testing.T) {
	engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), 2, nil, nil, nil)
	engine.RegisterDeliverer(DeliveryKindSQS, func(source DeliverySource) (Deliverer, error) {
		return failingDeliverer{}, nil
	})
	planned := engine.Planned(deliveryTestSpec())
	for _, state := range planned {
		if state.ID != "QueueMapping" {
			continue
		}
		if state.State != DeliveryPhaseRegistered || state.Task != "" || state.Reason != "" {
			t.Fatalf("a kind with a deliverer must be registered: %+v", state)
		}
		return
	}
	t.Fatal("the sqs mapping was not registered")
}

func TestDeliveryEngineStartsAndStopsADeliverer(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	clock := NewTestClock(start)
	var mu sync.Mutex
	var invoked []string
	invoker := func(_ context.Context, function string, event []byte) (InvokeResult, error) {
		mu.Lock()
		defer mu.Unlock()
		invoked = append(invoked, function+" "+string(event))
		return InvokeResult{Raw: event}, nil
	}
	resolver := func(kind DeliveryKind) (DeliveryBackend, error) {
		if kind != DeliveryKindSQS {
			t.Fatalf("unexpected kind %s", kind)
		}
		return DeliveryBackend{Service: "sqs", Endpoint: "http://127.0.0.1:9324"}, nil
	}
	engine := NewDeliveryEngine(clock, 2, resolver, invoker, nil)
	deliverer := newProbeDeliverer()
	engine.RegisterDeliverer(DeliveryKindSQS, func(source DeliverySource) (Deliverer, error) {
		return deliverer, nil
	})
	spec := &Spec{EventSources: []EventSourceSpec{{
		LogicalID: "QueueMapping", Stack: "Stack", Function: "Worker", Type: backendSQS, SourceName: "events", Enabled: true,
	}}}
	if err := engine.Start(context.Background(), spec); err != nil {
		t.Fatalf("start: %v", err)
	}
	state := engine.State()
	if !state.Running || state.Concurrency != 2 || state.Clock.Mode != string(ClockModeTest) {
		t.Fatalf("unexpected engine state: %+v", state)
	}
	if len(state.Sources) != 1 || state.Sources[0].State != DeliveryPhaseRegistered {
		t.Fatalf("a deliverer source must start registered: %+v", state.Sources)
	}
	env := <-deliverer.started
	if env.Source.ID != "QueueMapping" || env.Source.Mapping == nil || env.Source.Mapping.Type != backendSQS {
		t.Fatalf("deliverer got the wrong source: %+v", env.Source)
	}
	if ClockModeOf(env.Clock) != ClockModeTest || !env.Clock.Now().Equal(start) {
		t.Fatalf("deliverer got the wrong clock: %s", env.Clock.Now())
	}
	if env.Backend.Endpoint != "http://127.0.0.1:9324" || env.Backend.Service != "sqs" {
		t.Fatalf("deliverer got the wrong backend: %+v", env.Backend)
	}
	if _, err := env.Invoke(context.Background(), []byte(`{"Records":[]}`)); err != nil {
		t.Fatalf("invoke: %v", err)
	}
	if _, err := env.InvokeTarget(context.Background(), "Other", []byte(`{}`)); err != nil {
		t.Fatalf("invoke target: %v", err)
	}
	mu.Lock()
	if len(invoked) != 2 || invoked[0] != `Worker {"Records":[]}` || invoked[1] != "Other {}" {
		t.Fatalf("deliverer invoked the wrong functions: %+v", invoked)
	}
	mu.Unlock()

	env.State.SetPhase(DeliveryPhasePolling)
	waitForPhase(t, engine, "QueueMapping", DeliveryPhasePolling)
	env.State.Delivered()
	env.State.Failed(errors.New("boom"))
	env.State.SetPaused(true)
	for _, source := range engine.State().Sources {
		if source.ID != "QueueMapping" {
			continue
		}
		if source.Delivered != 1 || source.Failed != 1 || source.LastError != "boom" || !source.Paused {
			t.Fatalf("counters and pause were not reported: %+v", source)
		}
		if source.State != DeliveryPhasePaused {
			t.Fatalf("a paused source must report paused: %+v", source)
		}
	}

	stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := engine.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	select {
	case <-deliverer.stopped:
	default:
		t.Fatal("the deliverer did not observe the stop")
	}
	for _, source := range engine.State().Sources {
		if source.State != DeliveryPhaseStopped || source.Paused {
			t.Fatalf("a stopped source must report stopped: %+v", source)
		}
	}
	if engine.State().Running {
		t.Fatal("a stopped engine must not report running")
	}
	if err := engine.Start(context.Background(), spec); err == nil {
		t.Fatal("starting a started engine must fail")
	}
}

func TestDeliveryEngineStopsADelivererThatIgnoresItsContext(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), 1, nil, nil, nil)
	engine.RegisterDeliverer(DeliveryKindSQS, func(DeliverySource) (Deliverer, error) {
		return blockingDeliverer{started: started, release: release}, nil
	})
	spec := &Spec{EventSources: []EventSourceSpec{{
		LogicalID: "QueueMapping", Stack: "Stack", Function: "Worker", Type: backendSQS, Enabled: true,
	}}}
	if err := engine.Start(context.Background(), spec); err != nil {
		t.Fatalf("start: %v", err)
	}
	<-started
	stopCtx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	if err := engine.Stop(stopCtx); err == nil {
		t.Fatal("a deliverer that ignores its context must time out the stop")
	}
	cancel()
	close(release)
}

func TestDeliveryEngineCancelsAnInvocationWaitingForTheBound(t *testing.T) {
	engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), 1, nil, func(context.Context, string, []byte) (InvokeResult, error) {
		return InvokeResult{}, nil
	}, nil)
	engine.sem <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := engine.invoke(ctx, "Worker", []byte(`{}`)); !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}

func TestDeliveryEngineRegistersEveryKindWithoutDeliveringIt(t *testing.T) {
	engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), 4, nil, nil, nil)
	if err := engine.Start(context.Background(), deliveryTestSpec()); err != nil {
		t.Fatalf("start: %v", err)
	}
	state := engine.State()
	if !state.Running || state.Concurrency != 4 || len(state.Sources) != 5 {
		t.Fatalf("unexpected engine state: %+v", state)
	}
	for _, source := range state.Sources {
		if source.State != DeliveryPhaseNotDelivered || source.Task == "" || source.Reason == "" {
			t.Fatalf("unimplemented kind is not visible: %+v", source)
		}
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engine.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	for _, source := range engine.State().Sources {
		if source.State != DeliveryPhaseNotDelivered {
			t.Fatalf("a never-delivered source must stay not-delivered after stop: %+v", source)
		}
	}
}

func TestDeliveryEngineBoundsConcurrentInvocations(t *testing.T) {
	const bound = 2
	var current, peak int32
	invoker := func(context.Context, string, []byte) (InvokeResult, error) {
		value := atomic.AddInt32(&current, 1)
		for {
			observed := atomic.LoadInt32(&peak)
			if value <= observed || atomic.CompareAndSwapInt32(&peak, observed, value) {
				break
			}
		}
		time.Sleep(5 * time.Millisecond)
		atomic.AddInt32(&current, -1)
		return InvokeResult{}, nil
	}
	done := make(chan struct{})
	engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), bound, nil, invoker, nil)
	engine.RegisterDeliverer(DeliveryKindSQS, func(source DeliverySource) (Deliverer, error) {
		return &burstDeliverer{count: 12, done: done}, nil
	})
	spec := &Spec{EventSources: []EventSourceSpec{{
		LogicalID: "QueueMapping", Stack: "Stack", Function: "Worker", Type: backendSQS, Enabled: true,
	}}}
	if err := engine.Start(context.Background(), spec); err != nil {
		t.Fatalf("start: %v", err)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the burst deliverer did not finish")
	}
	if observed := atomic.LoadInt32(&peak); observed > bound {
		t.Fatalf("the engine ran %d concurrent deliveries above the bound %d", observed, bound)
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := engine.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

func TestDeliveryEngineReportsFailures(t *testing.T) {
	cases := []struct {
		name     string
		factory  DelivererFactory
		resolver DeliveryResolver
		want     string
	}{
		{
			name: "factory",
			factory: func(DeliverySource) (Deliverer, error) {
				return nil, errors.New("no client")
			},
			want: "no client",
		},
		{
			name: "resolver",
			factory: func(DeliverySource) (Deliverer, error) {
				return failingDeliverer{}, nil
			},
			resolver: func(DeliveryKind) (DeliveryBackend, error) {
				return DeliveryBackend{}, errors.New("backend down")
			},
			want: "backend down",
		},
		{
			name: "start",
			factory: func(DeliverySource) (Deliverer, error) {
				return failingDeliverer{err: errors.New("poll failed")}, nil
			},
			want: "poll failed",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), 1, testCase.resolver, nil, nil)
			engine.RegisterDeliverer(DeliveryKindSQS, testCase.factory)
			spec := &Spec{EventSources: []EventSourceSpec{{
				LogicalID: "QueueMapping", Stack: "Stack", Function: "Worker", Type: backendSQS, Enabled: true,
			}}}
			if err := engine.Start(context.Background(), spec); err != nil {
				t.Fatalf("start: %v", err)
			}
			state := waitForPhase(t, engine, "QueueMapping", DeliveryPhaseFailed)
			if state.LastError != testCase.want {
				t.Fatalf("want last error %q, got %q", testCase.want, state.LastError)
			}
			stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if err := engine.Stop(stopCtx); err != nil {
				t.Fatalf("stop: %v", err)
			}
		})
	}
}

func TestDeliveryEngineDrainsInFlightInvocations(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	invoker := func(ctx context.Context, function string, event []byte) (InvokeResult, error) {
		entered <- struct{}{}
		select {
		case <-release:
		case <-ctx.Done():
		}
		return InvokeResult{}, nil
	}
	engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), 1, nil, invoker, nil)
	deliverer := newProbeDeliverer()
	engine.RegisterDeliverer(DeliveryKindSQS, func(DeliverySource) (Deliverer, error) {
		return deliverer, nil
	})
	spec := &Spec{EventSources: []EventSourceSpec{{
		LogicalID: "QueueMapping", Stack: "Stack", Function: "Worker", Type: backendSQS, Enabled: true,
	}}}
	if err := engine.Start(context.Background(), spec); err != nil {
		t.Fatalf("start: %v", err)
	}
	env := <-deliverer.started
	invoked := make(chan struct{})
	go func() {
		//nolint:errcheck // the invocation is released below; its result is not the subject.
		_, _ = env.Invoke(context.Background(), []byte(`{}`))
		close(invoked)
	}()
	<-entered

	drainCtx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	if err := engine.Drain(drainCtx); err == nil {
		t.Fatal("drain must time out while an invocation is in flight")
	}
	cancel()
	if _, err := env.Invoke(context.Background(), []byte(`{}`)); err == nil || !strings.Contains(err.Error(), "draining") {
		t.Fatalf("a draining engine must reject new deliveries, got %v", err)
	}
	close(release)
	<-invoked
	drainCtx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engine.Drain(drainCtx); err != nil {
		t.Fatalf("drain after the invocation finished: %v", err)
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engine.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

func TestDeliveryEngineAdvancesTheInjectedClock(t *testing.T) {
	clock := NewTestClock(DefaultTestClockStart)
	engine := NewDeliveryEngine(clock, 1, nil, nil, nil)
	deliverer := newProbeDeliverer()
	engine.RegisterDeliverer(DeliveryKindSQS, func(DeliverySource) (Deliverer, error) {
		return deliverer, nil
	})
	spec := &Spec{EventSources: []EventSourceSpec{{
		LogicalID: "QueueMapping", Stack: "Stack", Function: "Worker", Type: backendSQS, Enabled: true,
	}}}
	if err := engine.Start(context.Background(), spec); err != nil {
		t.Fatalf("start: %v", err)
	}
	env := <-deliverer.started
	timer := env.Clock.After(90 * time.Minute)
	if fired, err := clock.Advance(90 * time.Minute); err != nil || fired != 1 {
		t.Fatalf("advance: fired=%d err=%v", fired, err)
	}
	select {
	case at := <-timer:
		if !at.Equal(DefaultTestClockStart.Add(90 * time.Minute)) {
			t.Fatalf("timer fired at %s", at)
		}
	default:
		t.Fatal("the deliverer's timer did not fire")
	}
	if !env.Clock.Now().Equal(DefaultTestClockStart.Add(90 * time.Minute)) {
		t.Fatalf("the deliverer clock did not advance: %s", env.Clock.Now())
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engine.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

func TestDeliveryCell(t *testing.T) {
	cell := DeliveryCell(DeliveryState{State: DeliveryPhaseNotDelivered, Task: "E1b", Reason: "engine present; SQS delivery lands in E1b"})
	if !strings.Contains(cell, "not-delivered: engine present") || !strings.Contains(cell, "task E1b") {
		t.Fatalf("unexpected cell %q", cell)
	}
	if got := DeliveryCell(DeliveryState{State: DeliveryPhasePolling}); got != "polling" {
		t.Fatalf("unexpected registered cell %q", got)
	}
}

func TestResolveDeliveryBackend(t *testing.T) {
	runner := &Runner{backends: map[string]backendProcess{
		backendSQS: {
			HostURL:   "http://127.0.0.1:9324",
			Endpoints: []Endpoint{{Service: backendSQS, URL: "http://sqs:9324"}},
		},
		backendDynamoDB: {
			HostURL:   "http://127.0.0.1:8000",
			Endpoints: []Endpoint{{Service: backendDynamoDB, URL: "http://dynamodb-local:8000"}},
		},
	}}
	backend, err := runner.ResolveDeliveryBackend(DeliveryKindSQS)
	if err != nil || backend.Endpoint != "http://127.0.0.1:9324" || backend.Service != backendSQS {
		t.Fatalf("sqs backend: %+v %v", backend, err)
	}
	if _, ok := backend.Client.(*sqs.Client); !ok {
		t.Fatalf("sqs backend has no client: %T", backend.Client)
	}
	for _, kind := range []DeliveryKind{DeliveryKindDynamoDBStream} {
		backend, err = runner.ResolveDeliveryBackend(kind)
		if err != nil || backend.Endpoint == "" || backend.Client == nil {
			t.Fatalf("%s backend: %+v %v", kind, backend, err)
		}
	}
	if _, resolveErr := (&Runner{}).ResolveDeliveryBackend(DeliveryKindSQS); resolveErr == nil {
		t.Fatal("a missing sqs backend must fail closed")
	}
	for _, kind := range []DeliveryKind{DeliveryKindEventBridgeSchedule, DeliveryKindEventBridgeRule} {
		backend, err = (&Runner{}).ResolveDeliveryBackend(kind)
		if err != nil || backend.Service != "events" {
			t.Fatalf("%s backend: %+v %v", kind, backend, err)
		}
	}
	runner.backends["kinesis"] = backendProcess{
		HostURL:   "http://127.0.0.1:4566",
		Endpoints: []Endpoint{{Service: backendKinesis, URL: "http://kinesis:4566"}},
	}
	backend, err = runner.ResolveDeliveryBackend(DeliveryKindKinesis)
	if err != nil || backend.Client != nil || backend.Endpoint == "" {
		t.Fatalf("kinesis backend: %+v %v", backend, err)
	}
	if _, err := (&Runner{}).ResolveDeliveryBackend(DeliveryKindCloudWatchLogs); err == nil {
		t.Fatal("a missing logs backend must fail closed")
	}
	if _, err := (&Runner{}).ResolveDeliveryBackend(DeliveryKind("kafka")); err == nil {
		t.Fatal("an unknown kind must fail closed")
	}
}

func TestInvokeDeliveryCallsTheStartedFunction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		if _, err := writer.Write([]byte(`{"statusCode":200,"body":"{\"delivered\":true}"}`)); err != nil {
			t.Errorf("write response: %v", err)
		}
	}))
	defer server.Close()
	address, ok := server.Listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("unexpected listener address type %T", server.Listener.Addr())
	}
	runner := &Runner{invokers: map[string]*FunctionProcess{"Worker": {Port: address.Port}}}
	result, err := runner.invokeDelivery(context.Background(), "Worker", []byte(`{"Records":[]}`))
	if err != nil {
		t.Fatalf("invoke delivery: %v", err)
	}
	if !result.Proxy || result.StatusCode != 200 || !strings.Contains(result.Body, "delivered") {
		t.Fatalf("unexpected delivery result: %+v", result)
	}
	if _, err := runner.invokeDelivery(context.Background(), "Missing", nil); err == nil {
		t.Fatal("an unstarted target must fail closed")
	}
	failing := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "boom", http.StatusInternalServerError)
	}))
	defer failing.Close()
	failingAddress, ok := failing.Listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("unexpected listener address type %T", failing.Listener.Addr())
	}
	failingRunner := &Runner{invokers: map[string]*FunctionProcess{"Worker": {Port: failingAddress.Port}}}
	if _, err := failingRunner.invokeDelivery(context.Background(), "Worker", nil); err == nil {
		t.Fatal("a failed RIE response must fail the delivery")
	}
}

func TestDeliverySourcesSortsByKindThenID(t *testing.T) {
	sources := DeliverySources(&Spec{EventSources: []EventSourceSpec{
		{LogicalID: "B", Type: backendSQS},
		{LogicalID: "A", Type: backendSQS},
		{LogicalID: "C", Type: backendDynamoDB},
	}})
	if len(sources) != 3 || sources[0].ID != "C" || sources[1].ID != "A" || sources[2].ID != "B" {
		t.Fatalf("unexpected delivery source order: %+v", sources)
	}
}

func TestNewDeliveryEngineDefaults(t *testing.T) {
	engine := NewDeliveryEngine(nil, 0, nil, nil, nil)
	if ClockModeOf(engine.Clock()) != ClockModeReal {
		t.Fatalf("a nil clock must default to real time")
	}
	state := engine.State()
	if state.Running || state.Concurrency != defaultDeliveryConcurrency || len(state.Sources) != 0 {
		t.Fatalf("unexpected default engine state: %+v", state)
	}
}

func TestSubscriptionHelpers(t *testing.T) {
	if got := arnName("no-colon"); got != "" {
		t.Fatalf("arnName without a colon: %q", got)
	}
	if got := arnName("arn:aws:logs:us-east-1:1:destination:name"); got != "name" {
		t.Fatalf("arnName: %q", got)
	}
	joined := flattenString(map[string]any{"Fn::Join": []any{"-", []any{"a", map[string]any{"Ref": "X"}, "b"}}})
	if joined != "a--b" {
		t.Fatalf("flattenString join: %q", joined)
	}
	if got := flattenString(42); got != "" {
		t.Fatalf("flattenString scalar: %q", got)
	}
	if got := flattenString(map[string]any{"Fn::Join": "bad"}); got != "" {
		t.Fatalf("flattenString malformed join: %q", got)
	}
	if got := resolvedString(json.RawMessage(`{`)); got != "" {
		t.Fatalf("resolvedString invalid JSON: %q", got)
	}
	if got := logDestinationName(templateResource{Properties: json.RawMessage(`{`)}); got != "" {
		t.Fatalf("logDestinationName invalid properties: %q", got)
	}
	stack := assemblyStack{Template: template{Resources: map[string]templateResource{
		"Empty":   {Type: typeLogsDestination, Properties: json.RawMessage(`{}`)},
		"Lambda":  {Type: typeLogsDestination, Properties: json.RawMessage(`{"TargetArn":{"Fn::GetAtt":["Fn","Arn"]}}`)},
		"NotLogs": {Type: typeSQSQueue, Properties: json.RawMessage(`{}`)},
	}}}
	types := map[string]string{"Empty": typeLogsDestination, "Lambda": typeLogsDestination, "NotLogs": typeSQSQueue}
	for _, id := range []string{"Empty", "Lambda", "Missing"} {
		if _, ok := logDestinationStream(stack, types, id); ok {
			t.Fatalf("%s must not resolve to a stream", id)
		}
	}
	if got := subscriptionLogGroup(stack, json.RawMessage(`{"Ref":"NotLogs"}`)); got != "" {
		t.Fatalf("a non-log-group ref must resolve to an empty name: %q", got)
	}
	if got := subscriptionLogGroup(stack, json.RawMessage(`42`)); got != "" {
		t.Fatalf("an invalid log group name must resolve to an empty name: %q", got)
	}
}

func TestDeliveryEngineBoundaries(t *testing.T) {
	engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), 1, nil, nil, nil)
	if err := engine.Drain(context.Background()); err != nil {
		t.Fatalf("draining an unstarted engine: %v", err)
	}
	if err := engine.Stop(context.Background()); err != nil {
		t.Fatalf("stopping an unstarted engine: %v", err)
	}
	if _, err := engine.invoke(context.Background(), "Fn", nil); err == nil {
		t.Fatal("invoking without an invoker must fail")
	}
	if _, err := engine.invoke(context.Background(), "", nil); err == nil {
		t.Fatal("invoking without a function must fail")
	}
	if sources := DeliverySources(nil); sources != nil {
		t.Fatalf("a nil spec has no sources: %+v", sources)
	}
	if reason := notDeliveredReason(DeliveryKind("kafka")); !strings.Contains(reason, "no deliverer") {
		t.Fatalf("an unknown kind must name the missing deliverer: %q", reason)
	}
	if cell := DeliveryCell(DeliveryState{State: DeliveryPhaseNotDelivered, Reason: "engine present"}); strings.Contains(cell, "task") {
		t.Fatalf("a state without a task must not print one: %q", cell)
	}

	deliverer := newProbeDeliverer()
	engine.RegisterDeliverer(DeliveryKindSQS, func(DeliverySource) (Deliverer, error) {
		return deliverer, nil
	})
	spec := &Spec{EventSources: []EventSourceSpec{{
		LogicalID: "QueueMapping", Stack: "Stack", Function: "Worker", Type: backendSQS, Enabled: true,
	}}}
	if err := engine.Start(context.Background(), spec); err != nil {
		t.Fatalf("start: %v", err)
	}
	env := <-deliverer.started
	env.State.SetPaused(true)
	env.State.SetPaused(false)
	for _, source := range engine.State().Sources {
		if source.Paused {
			t.Fatalf("an unpaused source still reports paused: %+v", source)
		}
	}
	// A background stop exercises the default stop budget.
	if err := engine.Stop(context.Background()); err != nil {
		t.Fatalf("stop with a background context: %v", err)
	}
}

func TestRunnerNowUsesTheRunClock(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if now := (&Runner{clock: NewTestClock(start)}).now(); !now.Equal(start) {
		t.Fatalf("runner now: got %s want %s", now, start)
	}
	if now := (&Runner{}).now(); now.IsZero() || time.Since(now) > time.Minute {
		t.Fatalf("a runner without a clock must fall back to real time, got %s", now)
	}
	if err := (&Runner{}).startDelivery(context.Background(), &Spec{}); err != nil {
		t.Fatalf("startDelivery without an engine: %v", err)
	}
}

func TestStartDeliveryLogsUnimplementedKinds(t *testing.T) {
	var log bytes.Buffer
	engine := NewDeliveryEngine(RealClock{}, 4, nil, nil, func(format string, args ...any) {
		log.WriteString(format + "\n")
	})
	runner := &Runner{delivery: engine, clock: RealClock{}, options: Options{Stdout: &log}}
	if err := runner.startDelivery(context.Background(), deliveryTestSpec()); err != nil {
		t.Fatalf("start delivery: %v", err)
	}
	if !strings.Contains(log.String(), "delivery QueueMapping: not-delivered") {
		t.Fatalf("the run log does not report unimplemented kinds: %s", log.String())
	}
	if err := runner.startDelivery(context.Background(), deliveryTestSpec()); err == nil {
		t.Fatal("starting the engine twice must fail")
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := engine.Stop(stopCtx); err != nil {
		t.Fatalf("stop: %v", err)
	}
}

func TestSessionClockOperations(t *testing.T) {
	start := time.Date(2026, 11, 3, 9, 30, 0, 0, time.UTC)
	session := &localSession{runner: &Runner{clock: NewTestClock(start)}}
	now, err := session.execute(context.Background(), sessionRequest{Op: "clock.now"})
	if err != nil {
		t.Fatalf("clock.now: %v", err)
	}
	nowFields := mustMap(t, now)
	if nowFields["mode"] != string(ClockModeTest) || nowFields["now"] != "2026-11-03T09:30:00Z" {
		t.Fatalf("unexpected clock.now: %+v", nowFields)
	}
	advanced, err := session.execute(context.Background(), sessionRequest{Op: "clock.advance", Duration: "90m"})
	if err != nil {
		t.Fatalf("clock.advance: %v", err)
	}
	advancedFields := mustMap(t, advanced)
	if advancedFields["now"] != "2026-11-03T11:00:00Z" || advancedFields["advanced"] != "1h30m0s" {
		t.Fatalf("unexpected clock.advance: %+v", advancedFields)
	}
	if fired, ok := advancedFields["timersFired"].(int); !ok || fired != 0 {
		t.Fatalf("unexpected timer count: %+v", advancedFields["timersFired"])
	}

	realSession := &localSession{runner: &Runner{clock: RealClock{}}}
	if _, advanceErr := realSession.execute(context.Background(), sessionRequest{Op: "clock.advance", Duration: "1m"}); advanceErr == nil {
		t.Fatal("the real clock must not be advanced")
	}
	if _, advanceErr := session.execute(context.Background(), sessionRequest{Op: "clock.advance", Duration: "-1m"}); advanceErr == nil {
		t.Fatal("a negative advance must fail")
	}
	if _, advanceErr := session.execute(context.Background(), sessionRequest{Op: "clock.advance", Duration: "later"}); advanceErr == nil {
		t.Fatal("an invalid duration must fail")
	}
	bare := &localSession{runner: &Runner{}}
	realNow, err := bare.execute(context.Background(), sessionRequest{Op: "clock.now"})
	if err != nil {
		t.Fatalf("clock.now without a clock: %v", err)
	}
	if mustMap(t, realNow)["mode"] != string(ClockModeReal) {
		t.Fatalf("a runner without a clock must report real time: %+v", realNow)
	}
}

func TestSessionDescribeReportsTheDeliveryEngine(t *testing.T) {
	engine := NewDeliveryEngine(NewTestClock(DefaultTestClockStart), 4, nil, nil, nil)
	if err := engine.Start(context.Background(), deliveryTestSpec()); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := engine.Stop(stopCtx); err != nil {
			t.Errorf("stop: %v", err)
		}
	})
	session := &localSession{runner: &Runner{clock: engine.Clock(), delivery: engine}, spec: &Spec{}}
	described, err := session.describe()
	if err != nil {
		t.Fatalf("describe: %v", err)
	}
	delivery, ok := described["delivery"].(EngineState)
	if !ok {
		t.Fatalf("describe has no engine state: %T", described["delivery"])
	}
	if !delivery.Running || delivery.Concurrency != 4 || delivery.Clock.Mode != string(ClockModeTest) {
		t.Fatalf("unexpected describe delivery state: %+v", delivery)
	}
	if len(delivery.Sources) != 5 {
		t.Fatalf("describe lost a registered source: %+v", delivery.Sources)
	}
	bare, err := (&localSession{runner: &Runner{}, spec: &Spec{}}).describe()
	if err != nil {
		t.Fatalf("describe without an engine: %v", err)
	}
	if state, ok := bare["delivery"].(EngineState); !ok || state.Running {
		t.Fatalf("an engine-less session must report a stopped engine: %+v", bare["delivery"])
	}
}
