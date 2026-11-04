package localrunner

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Docker talks to the Docker CLI. The local runner never uses the SDK: every
// container, network and port operation is an explicit CLI call with a name and
// label the runner owns.
type Docker struct {
	exec func(ctx context.Context, argv []string) (string, string, error)
}

// NewDocker returns a Docker client backed by the docker CLI on PATH.
func NewDocker() *Docker {
	return &Docker{exec: runCommand}
}

func runCommand(ctx context.Context, argv []string) (string, string, error) {
	command := exec.CommandContext(ctx, argv[0], argv[1:]...) //nolint:gosec // argv is built from fixed docker subcommands and runner-owned names
	var stdout, stderr strings.Builder
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	return stdout.String(), stderr.String(), err
}

// Available verifies the Docker daemon answers.
func (d *Docker) Available(ctx context.Context) error {
	stdout, stderr, err := d.exec(ctx, []string{"docker", "version", "--format", "{{.Server.Arch}}"})
	if err != nil {
		return fmt.Errorf("docker daemon is not available: %s", firstNonEmpty(stderr, stdout, err.Error()))
	}
	if strings.TrimSpace(stdout) == "" {
		return fmt.Errorf("docker daemon returned no server architecture")
	}
	return nil
}

// ServerArch returns the Docker server architecture (arm64 or amd64).
func (d *Docker) ServerArch(ctx context.Context) (string, error) {
	stdout, stderr, err := d.exec(ctx, []string{"docker", "version", "--format", "{{.Server.Arch}}"})
	if err != nil {
		return "", fmt.Errorf("read docker server architecture: %s", firstNonEmpty(stderr, stdout, err.Error()))
	}
	switch arch := strings.TrimSpace(strings.ToLower(stdout)); arch {
	case archARM64, "aarch64":
		return archARM64, nil
	case archAMD64, "x86_64":
		return archAMD64, nil
	default:
		return "", fmt.Errorf("unsupported docker server architecture %q", arch)
	}
}

// CreateNetwork creates the run's private network.
func (d *Docker) CreateNetwork(ctx context.Context, name string, labels map[string]string) error {
	argv := make([]string, 0, 5+2*len(labels))
	argv = append(argv, "docker", "network", "create", "--driver", "bridge")
	for _, label := range sortedLabels(labels) {
		argv = append(argv, "--label", label)
	}
	argv = append(argv, name)
	_, stderr, err := d.exec(ctx, argv)
	if err != nil {
		return fmt.Errorf("create docker network %s: %s", name, firstNonEmpty(stderr, err.Error()))
	}
	return nil
}

// RemoveNetwork removes a network the runner created. A missing network is not
// an error: cleanup runs after failures too.
func (d *Docker) RemoveNetwork(ctx context.Context, name string) {
	_, _, _ = d.exec(ctx, []string{"docker", "network", "rm", name}) //nolint:errcheck // best-effort cleanup
}

// ContainerOptions describes one function or probe container.
type ContainerOptions struct {
	Name    string
	Network string
	// Aliases are additional network names, so an emulator can answer on its
	// service name while the container keeps the run's unique name.
	Aliases    []string
	Image      string
	Command    []string
	Entrypoint string
	Env        map[string]string
	AddHosts   []string
	MemoryMB   int
	Mounts     []string
	Publish    int
	Labels     map[string]string
	// Detach starts the container in the background (function containers).
	Detach bool
}

// ContainerArgv is the exact docker run argv for options, sorted so a test can
// pin what the runner asks Docker to do.
func ContainerArgv(options ContainerOptions) []string {
	argv := []string{"docker", "run"}
	if options.Detach {
		argv = append(argv, "-d")
	} else {
		argv = append(argv, "--rm")
	}
	if options.Name != "" {
		argv = append(argv, "--name", options.Name)
	}
	for _, label := range sortedLabels(options.Labels) {
		argv = append(argv, "--label", label)
	}
	if options.Network != "" {
		argv = append(argv, "--network", options.Network, "--dns", ClosedDNSServer)
	}
	for _, alias := range options.Aliases {
		argv = append(argv, "--network-alias", alias)
	}
	for _, host := range options.AddHosts {
		argv = append(argv, "--add-host", host)
	}
	if options.Publish > 0 {
		argv = append(argv, "-p", fmt.Sprintf("127.0.0.1::%d", options.Publish))
	}
	if options.MemoryMB > 0 {
		argv = append(argv, "--memory", fmt.Sprintf("%dm", options.MemoryMB))
	}
	if options.Entrypoint != "" {
		argv = append(argv, "--entrypoint", options.Entrypoint)
	}
	for _, mount := range options.Mounts {
		argv = append(argv, "-v", mount)
	}
	for _, key := range sortedKeys(options.Env) {
		argv = append(argv, "-e", key+"="+options.Env[key])
	}
	argv = append(argv, options.Image)
	argv = append(argv, options.Command...)
	return argv
}

// StartContainer starts one container and returns its id.
func (d *Docker) StartContainer(ctx context.Context, options ContainerOptions) (string, error) {
	stdout, stderr, err := d.exec(ctx, ContainerArgv(options))
	if err != nil {
		return "", fmt.Errorf("start container %s: %s", options.Name, firstNonEmpty(stderr, err.Error()))
	}
	id := strings.TrimSpace(stdout)
	if id == "" {
		return "", fmt.Errorf("docker run %s returned no container id", options.Name)
	}
	return id, nil
}

// RunOnce runs one foreground container and returns its combined output. The
// probe uses it; function containers are detached instead.
func (d *Docker) RunOnce(ctx context.Context, options ContainerOptions) (string, error) {
	stdout, stderr, err := d.exec(ctx, ContainerArgv(options))
	if err != nil {
		return stdout + stderr, fmt.Errorf("run container %s: %s", options.Name, firstNonEmpty(stderr, stdout, err.Error()))
	}
	return stdout, nil
}

// Running reports whether a container is still running.
func (d *Docker) Running(ctx context.Context, name string) (bool, error) {
	stdout, stderr, err := d.exec(ctx, []string{
		"docker", "inspect", "--format", "{{.State.Running}}", name,
	})
	if err != nil {
		return false, fmt.Errorf("inspect container %s: %s", name, firstNonEmpty(stderr, err.Error()))
	}
	return strings.TrimSpace(stdout) == boolTrue, nil
}

// PublishedPort returns the loopback host port Docker assigned to a container
// port, or zero while it is not published yet.
func (d *Docker) PublishedPort(ctx context.Context, name string, containerPort int) (int, error) {
	stdout, stderr, err := d.exec(ctx, []string{
		"docker", "port", name, strconv.Itoa(containerPort),
	})
	if err != nil {
		return 0, fmt.Errorf("read published port of %s: %s", name, firstNonEmpty(stderr, err.Error()))
	}
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		port, ok := strings.CutPrefix(line, "127.0.0.1:")
		if !ok {
			// The runner publishes on loopback only; anything else is not a
			// port the transport may use.
			continue
		}
		value, err := strconv.Atoi(port)
		if err != nil {
			continue
		}
		return value, nil
	}
	return 0, nil
}

// ContainerIP returns a container's address on a Docker network.
func (d *Docker) ContainerIP(ctx context.Context, name, network string) (string, error) {
	format := fmt.Sprintf("{{(index .NetworkSettings.Networks %q).IPAddress}}", network)
	stdout, stderr, err := d.exec(ctx, []string{"docker", "inspect", "--format", format, name})
	if err != nil {
		return "", fmt.Errorf("inspect container %s: %s", name, firstNonEmpty(stderr, err.Error()))
	}
	address := strings.TrimSpace(stdout)
	if address == "" {
		return "", fmt.Errorf("container %s has no address on network %s", name, network)
	}
	return address, nil
}

// Logs returns a bounded tail of a container's output.
func (d *Docker) Logs(ctx context.Context, name string) string {
	stdout, stderr, _ := d.exec(ctx, []string{"docker", "logs", "--tail", "60", name}) //nolint:errcheck // logs are diagnostic
	return strings.TrimSpace(stdout + stderr)
}

// RemoveContainer force-removes one container.
func (d *Docker) RemoveContainer(ctx context.Context, name string) {
	_, _, _ = d.exec(ctx, []string{"docker", "rm", "-f", name}) //nolint:errcheck // best-effort cleanup
}

// ListContainers returns container ids carrying a label.
func (d *Docker) ListContainers(ctx context.Context, label string) ([]string, error) {
	stdout, stderr, err := d.exec(ctx, []string{"docker", "ps", "-aq", "--filter", "label=" + label})
	if err != nil {
		return nil, fmt.Errorf("list containers with label %s: %s", label, firstNonEmpty(stderr, err.Error()))
	}
	return splitLines(stdout), nil
}

// ListNetworks returns network names carrying a label.
func (d *Docker) ListNetworks(ctx context.Context, label string) ([]string, error) {
	stdout, stderr, err := d.exec(ctx, []string{"docker", "network", "ls", "-q", "--filter", "label=" + label})
	if err != nil {
		return nil, fmt.Errorf("list networks with label %s: %s", label, firstNonEmpty(stderr, err.Error()))
	}
	return splitLines(stdout), nil
}

func sortedLabels(labels map[string]string) []string {
	out := make([]string, 0, len(labels))
	for key, value := range labels {
		out = append(out, key+"="+value)
	}
	sort.Strings(out)
	return out
}

func splitLines(value string) []string {
	var out []string
	for _, line := range strings.Split(value, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// FollowLogs streams a container's stdout and stderr until the context ends.
// Docker prefixes each line with an RFC3339 timestamp because the runner asks
// for --timestamps; the caller parses it. The command is killed with the
// context, so a stopped run leaves no follower behind.
func (d *Docker) FollowLogs(ctx context.Context, name string, since time.Time, onLine func(string)) error {
	command := exec.CommandContext(ctx, "docker", "logs", "--follow", "--timestamps", "--since", since.UTC().Format(time.RFC3339Nano), name) //nolint:gosec // name is a runner-owned container
	stdout, err := command.StdoutPipe()
	if err != nil {
		return fmt.Errorf("follow logs of %s: %w", name, err)
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return fmt.Errorf("follow logs of %s: %w", name, err)
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("start log follower for %s: %w", name, err)
	}
	var wait sync.WaitGroup
	scan := func(reader io.Reader) {
		defer wait.Done()
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64*1024), 1<<20)
		for scanner.Scan() {
			onLine(scanner.Text())
		}
	}
	wait.Add(2)
	go scan(stdout)
	go scan(stderr)
	wait.Wait()
	if ctx.Err() != nil {
		return nil
	}
	return command.Wait()
}
