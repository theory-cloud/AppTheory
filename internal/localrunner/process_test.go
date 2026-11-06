package localrunner

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestDockerWrapperCommands(t *testing.T) {
	calls := map[string]string{
		"docker version --format {{.Server.Arch}}":                                    "arm64\n",
		"docker network create --driver bridge --label apptheory.local.run=abc net-a": "net-id\n",
		"docker network rm net-a":                                                     "",
		"docker run -d --name fn --network net-a --dns 127.0.0.2 image handler":       "container-id\n",
		"docker run --rm --name probe image":                                          "{\"ok\":true}\n",
		"docker rm -f fn":                                                             "",
		"docker network ls -q --filter label=app=abc":                                 "net-1\nnet-2\n",
	}
	docker := fakeDocker(calls)
	ctx := context.Background()

	if err := docker.Available(ctx); err != nil {
		t.Fatalf("available: %v", err)
	}
	arch, err := docker.ServerArch(ctx)
	if err != nil || arch != archARM64 {
		t.Fatalf("arch: %q %v", arch, err)
	}
	if err = docker.CreateNetwork(ctx, "net-a", map[string]string{labelRun: "abc"}); err != nil {
		t.Fatalf("create network: %v", err)
	}
	docker.RemoveNetwork(ctx, "net-a")
	id, err := docker.StartContainer(ctx, ContainerOptions{
		Name: "fn", Network: "net-a", Image: "image", Command: []string{"handler"}, Detach: true,
	})
	if err != nil || id != "container-id" {
		t.Fatalf("start container: %q %v", id, err)
	}
	output, err := docker.RunOnce(ctx, ContainerOptions{Name: "probe", Image: "image"})
	if err != nil || !strings.Contains(output, "ok") {
		t.Fatalf("run once: %q %v", output, err)
	}
	docker.RemoveContainer(ctx, "fn")
	networks, err := docker.ListNetworks(ctx, "app=abc")
	if err != nil || len(networks) != 2 {
		t.Fatalf("networks: %v %v", networks, err)
	}
}

func TestDockerErrorsAreReported(t *testing.T) {
	docker := &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		return "", "daemon is down", errors.New("exit status 1")
	}}
	if err := docker.Available(context.Background()); err == nil || !strings.Contains(err.Error(), "daemon is down") {
		t.Fatalf("available error not reported: %v", err)
	}
	if _, err := docker.StartContainer(context.Background(), ContainerOptions{Name: "x"}); err == nil {
		t.Fatal("start container error not reported")
	}
	if _, err := docker.RunOnce(context.Background(), ContainerOptions{Name: "x"}); err == nil {
		t.Fatal("run once error not reported")
	}
	if _, err := docker.ContainerIP(context.Background(), "x", "net"); err == nil {
		t.Fatal("container ip error not reported")
	}
	if _, err := docker.ListContainers(context.Background(), "a=b"); err == nil {
		t.Fatal("list containers error not reported")
	}
	if _, err := docker.ListNetworks(context.Background(), "a=b"); err == nil {
		t.Fatal("list networks error not reported")
	}
}

func TestContainerIPAndLogs(t *testing.T) {
	docker := fakeDocker(map[string]string{
		`docker inspect --format {{(index .NetworkSettings.Networks "net-a").IPAddress}} fn`: "172.18.0.2\n",
		"docker logs --tail 60 fn": "line one\nline two\n",
	})
	address, err := docker.ContainerIP(context.Background(), "fn", "net-a")
	if err != nil || address != "172.18.0.2" {
		t.Fatalf("unexpected address: %q %v", address, err)
	}
	if logs := docker.Logs(context.Background(), "fn"); !strings.Contains(logs, "line two") {
		t.Fatalf("unexpected logs: %q", logs)
	}
	missing := fakeDocker(map[string]string{
		`docker inspect --format {{(index .NetworkSettings.Networks "net-a").IPAddress}} fn`: "\n",
	})
	if _, err := missing.ContainerIP(context.Background(), "fn", "net-a"); err == nil {
		t.Fatal("an empty address must fail")
	}
}

func TestFunctionProcessInvoke(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		gotPath = request.URL.Path
		writer.Header().Set("Content-Type", "application/json")
		if _, writeErr := writer.Write([]byte(`{"statusCode":200}`)); writeErr != nil {
			t.Errorf("write response: %v", writeErr)
		}
	}))
	defer server.Close()
	port := serverPort(t, server.URL)

	process := &FunctionProcess{Container: "fn", Port: port, Function: FunctionSpec{LogicalID: "Fn"}}
	body, err := process.Invoke(context.Background(), []byte(`{"x":1}`))
	if err != nil || string(body) != `{"statusCode":200}` {
		t.Fatalf("invoke: %q %v", body, err)
	}
	if gotPath != invocationPath {
		t.Fatalf("unexpected invocation path: %s", gotPath)
	}
	if !strings.HasPrefix(process.URL(), "http://127.0.0.1:") {
		t.Fatalf("unexpected URL: %s", process.URL())
	}

	broken := &FunctionProcess{Container: "fn", Port: 1}
	if _, err := broken.Invoke(context.Background(), []byte(`{}`)); err == nil {
		t.Fatal("a refused connection must fail")
	}
}

func TestFunctionProcessRejectsErrorStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
		if _, writeErr := writer.Write([]byte("runtime exploded")); writeErr != nil {
			t.Errorf("write response: %v", writeErr)
		}
	}))
	defer server.Close()
	process := &FunctionProcess{Container: "fn", Port: serverPort(t, server.URL)}
	if _, err := process.Invoke(context.Background(), []byte(`{}`)); err == nil || !strings.Contains(err.Error(), "HTTP 500") {
		t.Fatalf("expected an HTTP status error, got %v", err)
	}
}

func TestRIEServing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	ready, err := rieServing(context.Background(), serverPort(t, server.URL))
	if err != nil || !ready {
		t.Fatalf("expected the emulator endpoint to answer: %v %v", ready, err)
	}
	closed := &net.TCPAddr{}
	if ready, err := rieServing(context.Background(), closed.Port); ready || err == nil {
		t.Fatalf("expected a closed port to fail: %v %v", ready, err)
	}
	if ready, err := rieServing(nil, 1); ready || err == nil {
		t.Fatalf("expected a nil context to fail: %v %v", ready, err)
	}
}

func TestWaitForContainerReady(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	port := serverPort(t, server.URL)
	docker := fakeDocker(map[string]string{
		"docker inspect --format {{.State.Running}} fn": "true\n",
		"docker port fn 8080":                           "127.0.0.1:" + strconv.Itoa(port) + "\n",
	})
	got, err := waitForContainerReady(context.Background(), docker, "fn")
	if err != nil || got != port {
		t.Fatalf("wait ready: %d %v", got, err)
	}

	exited := fakeDocker(map[string]string{
		"docker inspect --format {{.State.Running}} fn": "false\n",
		"docker logs --tail 60 fn":                      "entrypoint requires the handler name",
	})
	if _, err := waitForContainerReady(context.Background(), exited, "fn"); err == nil ||
		!strings.Contains(err.Error(), "entrypoint requires the handler name") {
		t.Fatalf("an exited container must report its logs: %v", err)
	}
}

func TestWaitForContainerReadyHonorsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	docker := fakeDocker(map[string]string{
		"docker inspect --format {{.State.Running}} fn": "true\n",
	})
	if _, err := waitForContainerReady(ctx, docker, "fn"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context cancellation, got %v", err)
	}
}

func serverPort(t *testing.T, rawURL string) int {
	t.Helper()
	trimmed := strings.TrimPrefix(rawURL, "http://127.0.0.1:")
	port, err := strconv.Atoi(strings.TrimSuffix(trimmed, "/"))
	if err != nil {
		t.Fatalf("parse server port %q: %v", rawURL, err)
	}
	return port
}

func TestWaitForContainerReadyTicksWithDeadline(t *testing.T) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	docker := fakeDocker(map[string]string{
		"docker inspect --format {{.State.Running}} fn": "true\n",
	})
	if _, err := waitForContainerReady(ctx, docker, "fn"); err == nil {
		t.Fatal("expected the deadline to be reported")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("waitForContainerReady did not honor the context deadline")
	}
}
