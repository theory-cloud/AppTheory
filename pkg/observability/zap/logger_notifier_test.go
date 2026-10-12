package zap

import (
	"context"
	"io"
	"runtime"
	"sync"
	"testing"
	"time"

	ubzap "go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/theory-cloud/apptheory/v6/pkg/observability"
)

type recordingNotifier struct {
	mu      sync.Mutex
	entries []observability.LogEntry
	err     error

	// block, when non-nil, holds the notifier inside Notify until it is closed,
	// so a test can pin the context-ignoring notifier that the bounded queue must
	// stay safe under. entered, when non-nil, is signaled (non-blocking) the
	// first time Notify runs so a test can wait for the worker to be stuck.
	block   <-chan struct{}
	entered chan struct{}
}

func (n *recordingNotifier) Notify(_ context.Context, entry observability.LogEntry) error {
	if n.entered != nil {
		select {
		case n.entered <- struct{}{}:
		default:
		}
	}
	if n.block != nil {
		<-n.block
	}
	n.mu.Lock()
	n.entries = append(n.entries, entry)
	err := n.err
	n.mu.Unlock()
	return err
}

func TestZapLogger_Notifier_SendsEntry_WithIDsAndFieldOverrides(t *testing.T) {
	t.Parallel()

	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	notifier := &recordingNotifier{}
	logger, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries:  1,
		RetryDelay:  time.Millisecond,
		BufferSize:  8,
		Level:       "debug",
		Format:      "json",
		EnableStack: false,
	}, WithZapLogger(base), WithErrorNotifier(notifier), WithSanitizer(nil))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}

	logger.WithFields(map[string]any{"k": "base"}).
		WithRequestID("req_1").
		WithTenantID("t1").
		WithUserID("u1").
		WithTraceID("tr1").
		WithSpanID("sp1").
		Info("no notify", map[string]any{"k": "info"})

	logger.WithFields(map[string]any{"k": "base"}).
		WithRequestID("req_1").
		WithTenantID("t1").
		WithUserID("u1").
		WithTraceID("tr1").
		WithSpanID("sp1").
		Error("boom", map[string]any{"k": "call"})

	if err := logger.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	notifier.mu.Lock()
	defer notifier.mu.Unlock()
	if len(notifier.entries) != 1 {
		t.Fatalf("expected 1 notification entry, got %d", len(notifier.entries))
	}
	entry := notifier.entries[0]
	if entry.Level != levelError || entry.Message != "boom" {
		t.Fatalf("unexpected entry: %#v", entry)
	}
	if entry.RequestID != "req_1" || entry.TenantID != "t1" || entry.UserID != "u1" || entry.TraceID != "tr1" || entry.SpanID != "sp1" {
		t.Fatalf("unexpected IDs: %#v", entry)
	}
	if entry.Fields["k"] != "call" {
		t.Fatalf("expected call fields to override base fields, got %#v", entry.Fields)
	}

	if err := logger.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

// TestZapLogger_Notifier_DeliversThroughQueue_AndDropsAfterClose pins E4: an
// error log hands its notification to the bounded background queue instead of
// delivering it on the request goroutine, and a closed logger drops instead of
// queueing.
func TestZapLogger_Notifier_DeliversThroughQueue_AndDropsAfterClose(t *testing.T) {
	t.Parallel()

	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	notifier := &recordingNotifier{}
	loggerAny, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries: 1,
		Level:      "debug",
		Format:     "json",
	}, WithZapLogger(base), WithErrorNotifier(notifier))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}
	logger, ok := loggerAny.(*Logger)
	if !ok {
		t.Fatalf("expected *Logger, got %T", loggerAny)
	}

	logger.Error("queued")

	// The logging call enqueues; the background worker delivers. Flush waits for
	// the bounded queue to drain.
	if err := logger.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	notifier.mu.Lock()
	delivered := len(notifier.entries)
	notifier.mu.Unlock()
	if delivered != 1 {
		t.Fatalf("expected the queued notification to be delivered, got %d", delivered)
	}

	if err := logger.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// A closed logger has nothing to deliver to, so the notification is dropped
	// rather than handed to a consumer that is no longer running.
	logger.core.enqueueNotification(observability.LogEntry{})
	if logger.core.entriesDropped.Load() == 0 {
		t.Fatalf("expected a drop after close, got %#v", logger.GetStats())
	}
}

func TestZapLogger_NotifierFailure_SetsLastErrorAndUnhealthy(t *testing.T) {
	t.Parallel()

	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	notifier := &recordingNotifier{err: context.Canceled}
	loggerAny, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries: 1,
		BufferSize: 8,
		Level:      "debug",
		Format:     "json",
	}, WithZapLogger(base), WithErrorNotifier(notifier))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}
	logger, ok := loggerAny.(*Logger)
	if !ok {
		t.Fatalf("expected *Logger, got %T", loggerAny)
	}

	logger.Error("boom")
	if err := logger.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	if logger.IsHealthy() {
		t.Fatal("expected IsHealthy=false after notifier failure")
	}
	stats := logger.GetStats()
	if stats.ErrorCount == 0 || stats.LastError == "" {
		t.Fatalf("expected stats to include error, got %#v", stats)
	}

	if err := logger.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

// TestZapLogger_Notifier_BlockedNotifier_RepeatedFlushDoesNotAccumulateGoroutines
// pins the availability contract for a notifier that ignores its context and
// blocks: each Flush returns at its own deadline, and repeated Flush calls must
// not leave a watcher goroutine behind. It is intentionally not parallel so the
// process goroutine count is stable while it measures.
func TestZapLogger_Notifier_BlockedNotifier_RepeatedFlushDoesNotAccumulateGoroutines(t *testing.T) {
	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	block := make(chan struct{})
	entered := make(chan struct{}, 1)
	notifier := &recordingNotifier{block: block, entered: entered}
	loggerAny, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries: 1,
		RetryDelay: time.Millisecond,
		BufferSize: 256,
		Level:      "debug",
		Format:     "json",
	}, WithZapLogger(base), WithErrorNotifier(notifier))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}
	logger, ok := loggerAny.(*Logger)
	if !ok {
		t.Fatalf("expected *Logger, got %T", loggerAny)
	}

	// Release the blocked notifier before the test returns so the single worker
	// can finish and the test leaves no goroutine behind.
	defer func() {
		if cerr := logger.Close(); cerr != nil {
			t.Errorf("Close: %v", cerr)
		}
	}()
	defer close(block)

	logger.Error("boom")
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the worker never entered Notify")
	}

	before := runtime.NumGoroutine()

	const flushes = 120
	for i := 0; i < flushes; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Millisecond)
		start := time.Now()
		flushErr := logger.Flush(ctx)
		cancel()
		if flushErr != nil {
			t.Fatalf("Flush %d: %v", i, flushErr)
		}
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Fatalf("Flush %d blocked for %v past its deadline", i, elapsed)
		}
	}

	runtime.Gosched()
	after := runtime.NumGoroutine()
	if after > before+8 {
		t.Fatalf("repeated Flush accumulated goroutines: before=%d after=%d flushes=%d", before, after, flushes)
	}
}

// TestZapLogger_Notifier_CloseIsBoundedWithBlockedNotifier pins that Close
// returns within a bounded grace even while the single worker is stuck inside a
// notifier that ignores its context, instead of hanging forever.
func TestZapLogger_Notifier_CloseIsBoundedWithBlockedNotifier(t *testing.T) {
	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	block := make(chan struct{})
	entered := make(chan struct{}, 1)
	notifier := &recordingNotifier{block: block, entered: entered}
	loggerAny, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries: 1,
		RetryDelay: time.Millisecond,
		BufferSize: 8,
		Level:      "debug",
		Format:     "json",
	}, WithZapLogger(base), WithErrorNotifier(notifier))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}
	logger, ok := loggerAny.(*Logger)
	if !ok {
		t.Fatalf("expected *Logger, got %T", loggerAny)
	}

	defer close(block)

	logger.Error("boom")
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the worker never entered Notify")
	}

	done := make(chan error, 1)
	go func() { done <- logger.Close() }()

	select {
	case closeErr := <-done:
		if closeErr != nil {
			t.Fatalf("Close: %v", closeErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Close did not return within its bounded grace")
	}
}

// TestZapLogger_Notifier_FullQueueDropsWithoutGrowing pins that a queue bounded
// to its configured size drops the overflow (counting it) instead of growing the
// backlog while a blocked worker holds the single in-flight entry.
func TestZapLogger_Notifier_FullQueueDropsWithoutGrowing(t *testing.T) {
	t.Parallel()

	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	block := make(chan struct{})
	entered := make(chan struct{}, 1)
	notifier := &recordingNotifier{block: block, entered: entered}
	loggerAny, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries: 1,
		RetryDelay: time.Millisecond,
		BufferSize: 1,
		Level:      "debug",
		Format:     "json",
	}, WithZapLogger(base), WithErrorNotifier(notifier))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}
	logger, ok := loggerAny.(*Logger)
	if !ok {
		t.Fatalf("expected *Logger, got %T", loggerAny)
	}

	defer func() {
		if cerr := logger.Close(); cerr != nil {
			t.Errorf("Close: %v", cerr)
		}
	}()
	defer close(block)

	logger.Error("in-flight")
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the worker never entered Notify")
	}

	// The worker holds the in-flight entry, so the one-slot queue is free to take
	// the next entry and every log after that overflows.
	logger.Error("queued")
	for i := 0; i < 16; i++ {
		logger.Error("overflow")
	}

	logger.core.notifyMu.Lock()
	queued := len(logger.core.notifyCh)
	logger.core.notifyMu.Unlock()
	if queued > 1 {
		t.Fatalf("queue grew past its configured bound: len=%d", queued)
	}
	if drops := logger.core.entriesDropped.Load(); drops == 0 {
		t.Fatalf("expected overflow drops, got %#v", logger.GetStats())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	if err := logger.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
}

// TestZapLogger_Notifier_ConcurrentEnqueueFlushCloseStaysSafe drives the queue,
// the flush wait and Close from several goroutines at once (run under -race) so
// the wait scheme has no Add/Wait race and no data race.
func TestZapLogger_Notifier_ConcurrentEnqueueFlushCloseStaysSafe(t *testing.T) {
	t.Parallel()

	base := ubzap.New(zapcore.NewCore(
		zapcore.NewJSONEncoder(zapEncoderConfig(false)),
		zapcore.AddSync(io.Discard),
		zapcore.DebugLevel,
	))

	notifier := &recordingNotifier{}
	loggerAny, err := NewZapLogger(observability.LoggerConfig{
		MaxRetries: 1,
		RetryDelay: time.Microsecond,
		BufferSize: 8,
		Level:      "debug",
		Format:     "json",
	}, WithZapLogger(base), WithErrorNotifier(notifier))
	if err != nil {
		t.Fatalf("NewZapLogger: %v", err)
	}
	logger, ok := loggerAny.(*Logger)
	if !ok {
		t.Fatalf("expected *Logger, got %T", loggerAny)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})

	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					logger.Error("boom")
				}
			}
		}()
	}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
					if ferr := logger.Flush(ctx); ferr != nil {
						t.Errorf("Flush: %v", ferr)
					}
					cancel()
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(25 * time.Millisecond)
		if closeErr := logger.Close(); closeErr != nil {
			t.Errorf("Close: %v", closeErr)
		}
	}()

	time.Sleep(75 * time.Millisecond)
	close(stop)
	wg.Wait()
}

type ctxHonoringNotifier struct {
	mu    sync.Mutex
	calls int
}

func (n *ctxHonoringNotifier) Notify(ctx context.Context, _ observability.LogEntry) error {
	n.mu.Lock()
	n.calls++
	n.mu.Unlock()
	<-ctx.Done()
	return ctx.Err()
}

// TestZapCore_NotifyWithRetries_BoundedByPerDeliveryDeadline pins that a
// notifier that honors its context cannot tie the worker up forever: the retry
// loop observes the per-delivery deadline and returns instead of retrying past
// it.
func TestZapCore_NotifyWithRetries_BoundedByPerDeliveryDeadline(t *testing.T) {
	t.Parallel()

	notifier := &ctxHonoringNotifier{}
	core := &zapCore{notifier: notifier, maxRetries: 2, retryDelay: 5 * time.Millisecond}

	start := time.Now()
	err := core.notifyWithRetries(observability.LogEntry{Message: "x"})
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected a delivery error when the context deadline is reached")
	}
	if elapsed > 5*time.Second {
		t.Fatalf("notifyWithRetries ran %v, past its bounded deadline", elapsed)
	}
}
