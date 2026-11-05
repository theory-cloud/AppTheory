package localrunner

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// cleanupDocker is a Docker double that owns the resources the runner creates,
// so a test can assert what is left after shutdown.
type cleanupDocker struct {
	mu          sync.Mutex
	containers  map[string]bool
	networks    map[string]bool
	riePort     int
	backendPort int
	blockName   string
	started     chan struct{}
	startedOne  sync.Once
	release     chan struct{}
}

func newCleanupDocker(riePort, backendPort int) *cleanupDocker {
	return &cleanupDocker{
		containers:  map[string]bool{},
		networks:    map[string]bool{},
		riePort:     riePort,
		backendPort: backendPort,
		started:     make(chan struct{}),
		release:     make(chan struct{}),
	}
}

// newBackendStub answers the DynamoDB readiness probe, so a cleanup test
// reaches the function containers it exercises.
func newBackendStub(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("content-type", "application/x-amz-json-1.0")
		if _, err := writer.Write([]byte(`{"TableNames":[]}`)); err != nil {
			t.Errorf("write backend response: %v", err)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func (d *cleanupDocker) docker() *Docker {
	return &Docker{exec: d.exec}
}

func (d *cleanupDocker) exec(ctx context.Context, argv []string) (string, string, error) {
	if len(argv) < 2 {
		return "", "", nil
	}
	switch argv[1] {
	case "version":
		return "arm64\n", "", nil
	case "network":
		return d.network(argv)
	case "run":
		return d.run(ctx, argv)
	case "inspect":
		if strings.Contains(strings.Join(argv, " "), "IPAddress") {
			return "172.18.0.2\n", "", nil
		}
		return "true\n", "", nil
	case "port":
		if len(argv) > 2 && strings.Contains(argv[2], "dynamodb") {
			return fmt.Sprintf("127.0.0.1:%d\n", d.backendPort), "", nil
		}
		return fmt.Sprintf("127.0.0.1:%d\n", d.riePort), "", nil
	case "logs":
		return "", "", nil
	case "ps":
		d.mu.Lock()
		defer d.mu.Unlock()
		names := make([]string, 0, len(d.containers))
		for name := range d.containers {
			names = append(names, name)
		}
		sort.Strings(names)
		return strings.Join(names, "\n"), "", nil
	case "rm":
		name := argv[len(argv)-1]
		d.mu.Lock()
		delete(d.containers, name)
		d.mu.Unlock()
		return "", "", nil
	}
	return "", "", nil
}

func (d *cleanupDocker) network(argv []string) (string, string, error) {
	if len(argv) < 3 {
		return "", "", nil
	}
	switch argv[2] {
	case "create":
		name := argv[len(argv)-1]
		d.mu.Lock()
		d.networks[name] = true
		d.mu.Unlock()
		return "network-id\n", "", nil
	case "rm":
		name := argv[len(argv)-1]
		d.mu.Lock()
		delete(d.networks, name)
		d.mu.Unlock()
		return "", "", nil
	}
	return "", "", nil
}

func (d *cleanupDocker) run(ctx context.Context, argv []string) (string, string, error) {
	if hasArgument(argv, "--name", "preflight") {
		return `{"ok":true,"checks":{"credentials":"dummy static"}}`, "", nil
	}
	name := argumentValue(argv, "--name")
	if !containsArgument(argv, "-d") {
		return "", "", nil
	}
	d.mu.Lock()
	d.containers[name] = true
	block := d.blockName != "" && name == d.blockName
	d.mu.Unlock()
	if !block {
		return "container-id\n", "", nil
	}
	d.startedOne.Do(func() { close(d.started) })
	select {
	case <-ctx.Done():
		return "", "", ctx.Err()
	case <-d.release:
		return "container-id\n", "", nil
	}
}

func argumentValue(argv []string, flagName string) string {
	for index := 0; index < len(argv)-1; index++ {
		if argv[index] == flagName {
			return argv[index+1]
		}
	}
	return ""
}

func containsArgument(argv []string, flagName string) bool {
	for _, argument := range argv {
		if argument == flagName {
			return true
		}
	}
	return false
}

func (d *cleanupDocker) leftovers() (containers, networks []string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for name := range d.containers {
		containers = append(containers, name)
	}
	for name := range d.networks {
		networks = append(networks, name)
	}
	sort.Strings(containers)
	sort.Strings(networks)
	return containers, networks
}

func waitForRunnerReady(t *testing.T, runner *Runner, done <-chan error) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for !strings.Contains(mustSyncBuffer(t, runner.options.Stdout).String(), "local-run: ready") {
		if time.Now().After(deadline) {
			t.Fatalf("runner did not become ready:\n%s", mustSyncBuffer(t, runner.options.Stdout).String())
		}
		select {
		case err := <-done:
			t.Fatalf("run returned early: %v\n%s", err, mustSyncBuffer(t, runner.options.Stdout).String())
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForRunEnd(t *testing.T, done <-chan error, timeout time.Duration) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		t.Fatalf("run did not shut down within %s", timeout)
		return nil
	}
}

func assertNoLeftovers(t *testing.T, docker *cleanupDocker, runner *Runner) {
	t.Helper()
	containers, networks := docker.leftovers()
	if len(containers) > 0 || len(networks) > 0 {
		t.Fatalf("shutdown left containers %v or networks %v behind", containers, networks)
	}
	if _, err := os.Stat(runner.Scratch()); !os.IsNotExist(err) {
		t.Fatalf("shutdown left the scratch directory: %v", err)
	}
}

func TestRunnerRemovesEveryResourceOnRepeatedTermination(t *testing.T) {
	for iteration := 1; iteration <= 5; iteration++ {
		t.Run(fmt.Sprintf("iteration-%d", iteration), func(t *testing.T) {
			base := testBase(t)
			runner := newTestRunner(t, base)
			listener := listenLoopback(t)
			docker := newCleanupDocker(listenerPort(t, listener), serverPort(t, newBackendStub(t).URL))
			runner.docker = docker.docker()
			runner.options.RIEMode = true

			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- runner.Run(ctx) }()
			waitForRunnerReady(t, runner, done)
			cancel()
			if err := waitForRunEnd(t, done, 10*time.Second); err != nil {
				t.Fatalf("run: %v\n%s", err, mustSyncBuffer(t, runner.options.Stdout).String())
			}
			assertNoLeftovers(t, docker, runner)
		})
	}
}

func TestRunnerCleanupRemovesContainerStartedBeforeReady(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)
	docker := newCleanupDocker(1, serverPort(t, newBackendStub(t).URL))
	docker.blockName = runner.containerName("Fn")
	runner.docker = docker.docker()
	runner.options.RIEMode = true

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()

	select {
	case <-docker.started:
	case err := <-done:
		t.Fatalf("run returned before the function container started: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("function container start was not reached")
	}
	cancel()
	err := waitForRunEnd(t, done, 10*time.Second)
	if err != nil && !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("run: %v", err)
	}
	close(docker.release)
	assertNoLeftovers(t, docker, runner)
}

func TestRunnerCleanupDoesNotWaitForInFlightRequest(t *testing.T) {
	base := testBase(t)
	runner := newTestRunner(t, base)

	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseRequest := func() { releaseOnce.Do(func() { close(release) }) }
	started := make(chan struct{})
	var startedOnce sync.Once
	rie := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		startedOnce.Do(func() { close(started) })
		<-release
		if _, err := writer.Write([]byte(`{"statusCode":200,"headers":{"content-type":"application/json"},"body":"{}"}`)); err != nil {
			t.Errorf("write blocking response: %v", err)
		}
	}))
	// Cleanups run last-in first-out: release the handler before the server
	// waits for it to return.
	t.Cleanup(rie.Close)
	t.Cleanup(releaseRequest)

	docker := newCleanupDocker(serverPort(t, rie.URL), serverPort(t, newBackendStub(t).URL))
	runner.docker = docker.docker()
	probe := listenLoopback(t)
	port := listenerPort(t, probe)
	if err := probe.Close(); err != nil {
		t.Fatalf("release probe listener: %v", err)
	}
	runner.options.PortBase = port
	runner.options.RIEMode = true

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	waitForRunnerReady(t, runner, done)

	requestDone := make(chan error, 1)
	go func() {
		response, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/hello", port)) //nolint:gosec,noctx // loopback listener the test owns
		if err == nil {
			if closeErr := response.Body.Close(); closeErr != nil {
				t.Errorf("close response body: %v", closeErr)
			}
		}
		requestDone <- err
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the in-flight request never reached the handler")
	}

	startedAt := time.Now()
	cancel()
	if err := waitForRunEnd(t, done, 10*time.Second); err != nil {
		t.Fatalf("run: %v", err)
	}
	if elapsed := time.Since(startedAt); elapsed > 5*time.Second {
		t.Fatalf("shutdown waited %s for the in-flight request", elapsed)
	}
	assertNoLeftovers(t, docker, runner)

	releaseRequest()
	select {
	case <-requestDone:
	case <-time.After(10 * time.Second):
		t.Fatal("the in-flight request did not end after shutdown")
	}
}
