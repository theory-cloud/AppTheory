package localrunner

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Function log capture writes every started function's stdout and stderr to the
// CloudWatch Logs group /aws/lambda/<function name>, through the real Logs API
// on moto. A subscription filter on that group then carries real invocation
// output to its destination.
//
// What is captured: every line the runtime process writes to its standard out
// or standard error, including handler logging, runtime initialisation output
// and the platform-style lines the official runtime image prints itself
// (START, END, REPORT and the rapid-runtime INIT/INVOKE lines). What is not
// captured: anything the AWS Lambda service records outside the container;
// there is no separate service-side request log locally. This is documented in
// docs/examples/local-runner.md.
//
// The log group name follows the documented default:
// https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs.html

const (
	functionLogFlushInterval = 250 * time.Millisecond
	functionLogFlushLines    = 100
)

// startFunctionLogs starts one follower per started function when the Logs
// backend is running.
func (r *Runner) startFunctionLogs(ctx context.Context, spec *Spec, targets []string) {
	backend, ok := r.backendForService(logsService)
	if !ok || backend.HostURL == "" {
		return
	}
	client := newCloudWatchLogsClient(backend.HostURL)
	for _, id := range targets {
		process, ok := r.invokers[id]
		if !ok {
			continue
		}
		function, ok := spec.Function(id)
		if !ok {
			continue
		}
		name, err := functionPhysicalName(spec, function)
		if err != nil {
			r.logf("function %s: capture logs skipped: %v", id, err)
			continue
		}
		group, stream, err := client.ensureFunctionLogGroup(ctx, name, process.Container, r.clock.Now())
		if err != nil {
			r.logf("function %s: create log group failed: %v", id, err)
			continue
		}
		since := process.Started
		if since.IsZero() {
			since = r.clock.Now().Add(-10 * time.Second)
		}
		go r.followFunctionLog(ctx, client, process, group, stream, since)
		r.logf("function %s: log capture into %s/%s", id, group, stream)
	}
}

// followFunctionLog follows one container and writes its lines in batches.
func (r *Runner) followFunctionLog(
	ctx context.Context,
	client *cloudWatchLogsClient,
	process *FunctionProcess,
	group, stream string,
	since time.Time,
) {
	lines := make(chan string, 256)
	go func() {
		if err := r.docker.FollowLogs(ctx, process.Container, since, func(line string) {
			select {
			case lines <- line:
			case <-ctx.Done():
			}
		}); err != nil && ctx.Err() == nil {
			r.logf("function %s: log follower stopped: %v", process.Function.LogicalID, err)
		}
		close(lines)
	}()

	var batch []cloudWatchLogEvent
	lastMillis := int64(0)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		if err := client.PutLogEvents(ctx, group, stream, batch); err != nil && ctx.Err() == nil {
			r.logf("function %s: write log events failed: %v", process.Function.LogicalID, err)
		}
		batch = batch[:0]
	}
	ticker := time.NewTicker(functionLogFlushInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			flush()
			return
		case <-ticker.C:
			flush()
		case line, ok := <-lines:
			if !ok {
				flush()
				return
			}
			// Log event timestamps are ingestion times: moto rejects an event
			// outside its retention window, so the capture uses the wall clock
			// even when the run's delivery clock is a test clock.
			timestamp := time.Now().UnixMilli()
			if timestamp <= lastMillis {
				timestamp = lastMillis + 1
			}
			lastMillis = timestamp
			batch = append(batch, cloudWatchLogEvent{Timestamp: timestamp, Message: logMessageLine(line)})
			if len(batch) >= functionLogFlushLines {
				flush()
			}
		}
	}
}

// logMessageLine strips the RFC3339 timestamp docker adds for --timestamps and
// keeps the rest of the line verbatim.
func logMessageLine(line string) string {
	if space := strings.IndexByte(line, ' '); space > 0 {
		if _, err := time.Parse(time.RFC3339Nano, line[:space]); err == nil {
			return line[space+1:]
		}
	}
	return line
}

// functionPhysicalName resolves the CDK physical name of a function resource.
func functionPhysicalName(spec *Spec, function FunctionSpec) (string, error) {
	for _, resource := range spec.Resources {
		if resource.Type != typeLambdaFunction {
			continue
		}
		if resource.LogicalID != function.LogicalID || resource.Stack != function.Stack {
			continue
		}
		return resourceName(resource)
	}
	return "", fmt.Errorf("the assembly has no Lambda resource for %s", function.LogicalID)
}
