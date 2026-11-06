package localrunner

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestContainerArgvDetachedFunction(t *testing.T) {
	argv := ContainerArgv(ContainerOptions{
		Name:     "run-fn",
		Network:  "run-net",
		Image:    "public.ecr.aws/lambda/provided:al2023@sha256:" + strings.Repeat("a", 64),
		Command:  []string{"bootstrap"},
		Env:      map[string]string{"B": "2", "A": "1"},
		AddHosts: []string{"dynamodb-local:host-gateway"},
		MemoryMB: 256,
		Mounts:   []string{"/tmp/code:/var/task:ro"},
		Publish:  riePort,
		Labels:   map[string]string{labelRun: "abc", labelApp: "def"},
		Detach:   true,
	})
	expected := []string{
		"docker", "run", "-d",
		"--name", "run-fn",
		"--label", "apptheory.local.app=def",
		"--label", "apptheory.local.run=abc",
		"--network", "run-net", "--dns", ClosedDNSServer,
		"--add-host", "dynamodb-local:host-gateway",
		"-p", "127.0.0.1::8080",
		"--memory", "256m",
		"-v", "/tmp/code:/var/task:ro",
		"-e", "A=1",
		"-e", "B=2",
		"public.ecr.aws/lambda/provided:al2023@sha256:" + strings.Repeat("a", 64),
		"bootstrap",
	}
	if !reflect.DeepEqual(argv, expected) {
		t.Fatalf("unexpected docker argv:\n got: %#v\nwant: %#v", argv, expected)
	}
}

func TestContainerArgvForegroundProbe(t *testing.T) {
	argv := ContainerArgv(ContainerOptions{
		Name:       "run-probe",
		Image:      "python-image",
		Entrypoint: "python3",
		Command:    []string{"-c", "print(1)"},
	})
	joined := strings.Join(argv, " ")
	for _, fragment := range []string{"--rm", "--entrypoint python3", "python-image -c print(1)"} {
		if !strings.Contains(joined, fragment) {
			t.Fatalf("probe argv missing %q: %v", fragment, argv)
		}
	}
	if strings.Contains(joined, "-d") {
		t.Fatalf("the probe must not detach: %v", argv)
	}
}

func fakeDocker(outputs map[string]string) *Docker {
	return &Docker{exec: func(_ context.Context, argv []string) (string, string, error) {
		key := strings.Join(argv, " ")
		return outputs[key], "", nil
	}}
}

func TestDockerPublishedPortParsing(t *testing.T) {
	docker := fakeDocker(map[string]string{
		"docker port run-fn 8080": "127.0.0.1:49152\n",
		"docker port none 8080":   "",
		"docker port public 8080": "0.0.0.0:9\n[::1]:8080\n",
	})
	port, err := docker.PublishedPort(context.Background(), "run-fn", riePort)
	if err != nil || port != 49152 {
		t.Fatalf("unexpected published port: %d %v", port, err)
	}
	port, err = docker.PublishedPort(context.Background(), "none", riePort)
	if err != nil || port != 0 {
		t.Fatalf("unpublished container must report zero: %d %v", port, err)
	}
	port, err = docker.PublishedPort(context.Background(), "public", riePort)
	if err != nil || port != 0 {
		t.Fatalf("non-loopback bindings must be refused: %d %v", port, err)
	}
}

func TestDockerRunningAndList(t *testing.T) {
	docker := fakeDocker(map[string]string{
		"docker inspect --format {{.State.Running}} run-fn":     "true\n",
		"docker ps -aq --filter label=apptheory.local.app=hash": "one\ntwo\n",
	})
	running, err := docker.Running(context.Background(), "run-fn")
	if err != nil || !running {
		t.Fatalf("unexpected running state: %v %v", running, err)
	}
	containers, err := docker.ListContainers(context.Background(), labelApp+"=hash")
	if err != nil || len(containers) != 2 {
		t.Fatalf("unexpected containers: %v %v", containers, err)
	}
}

func TestSanitizeName(t *testing.T) {
	cases := map[string]string{
		"HandlerFunction0D87A48C": "handlerfunction0d87a48c",
		"Stack/Function":          "stack-function",
		"":                        "function",
	}
	for input, expected := range cases {
		if actual := sanitizeName(input); actual != expected {
			t.Fatalf("sanitizeName(%q) = %q, want %q", input, actual, expected)
		}
	}
	long := strings.Repeat("a", 80)
	if actual := sanitizeName(long); len(actual) > 40 || !strings.HasPrefix(actual, "aaaaaaaa") {
		t.Fatalf("long names must be truncated with a hash: %q", actual)
	}
}

func TestValidateImageOverride(t *testing.T) {
	digest := "@sha256:" + strings.Repeat("a", 64)
	if err := validateImageOverride(imageClassGo, "public.ecr.aws/lambda/provided:al2023"+digest); err != nil {
		t.Fatalf("valid pin rejected: %v", err)
	}
	invalid := map[string]string{
		"tag only":     "public.ecr.aws/lambda/provided:al2023",
		"short digest": "public.ecr.aws/lambda/provided:al2023@sha256:abc",
		"wrong image":  "public.ecr.aws/lambda/nodejs:24" + digest,
	}
	if err := validateImageOverride("java", invalid["unknown class"]); err == nil {
		t.Fatal("unknown image class must fail")
	}
	for name, image := range invalid {
		if err := validateImageOverride(imageClassGo, image); err == nil {
			t.Fatalf("%s must fail: %s", name, image)
		}
	}
}

func TestValidateEndpointRejectsAWSHosts(t *testing.T) {
	for _, raw := range []string{
		"http://dynamodb.us-east-1.amazonaws.com",
		"https://s3.amazonaws.com",
		"http://bucket.s3.us-east-1.amazonaws.com",
		"http://service.api.aws",
		"http://abcd.lambda-url.us-east-1.on.aws",
	} {
		if err := ValidateEndpoint(Endpoint{Service: "dynamodb", URL: raw}); err == nil {
			t.Fatalf("AWS endpoint must be refused: %s", raw)
		}
	}
	for _, raw := range []string{
		"http://dynamodb-local:8000",
		"http://127.0.0.1:8130",
		"https://localhost:4566",
	} {
		if err := ValidateEndpoint(Endpoint{Service: "dynamodb", URL: raw}); err != nil {
			t.Fatalf("local endpoint rejected: %s: %v", raw, err)
		}
	}
	if err := ValidateEndpoint(Endpoint{Service: "dynamodb", URL: "ftp://localhost"}); err == nil {
		t.Fatal("non-HTTP endpoints must fail")
	}
	if err := ValidateEndpoint(Endpoint{Service: "", URL: "http://localhost:1"}); err == nil {
		t.Fatal("endpoints without a service must fail")
	}
}
