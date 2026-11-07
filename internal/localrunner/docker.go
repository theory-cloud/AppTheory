package localrunner

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
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
	case archARM64, archARM64Alias:
		return archARM64, nil
	case archAMD64, archAMD64Alias:
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

// EnsureImage pulls a digest-pinned image when the local daemon does not have
// it. A digest reference is immutable, so an existing image is already the
// pinned content.
func (d *Docker) EnsureImage(ctx context.Context, image string) error {
	if _, _, err := d.exec(ctx, []string{"docker", "image", "inspect", "--format", "{{.Id}}", image}); err == nil {
		return nil
	}
	stdout, stderr, err := d.exec(ctx, []string{"docker", "pull", image})
	if err != nil {
		return fmt.Errorf("pull %s: %s", image, firstNonEmpty(stderr, stdout, err.Error()))
	}
	return nil
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

// ExitCode returns a stopped container's exit code.
func (d *Docker) ExitCode(ctx context.Context, name string) (int, error) {
	stdout, stderr, err := d.exec(ctx, []string{
		"docker", "inspect", "--format", "{{.State.ExitCode}}", name,
	})
	if err != nil {
		return 0, fmt.Errorf("read exit code of %s: %s", name, firstNonEmpty(stderr, err.Error()))
	}
	code, parseErr := strconv.Atoi(strings.TrimSpace(stdout))
	if parseErr != nil {
		return 0, fmt.Errorf("container %s returned an unreadable exit code %q", name, strings.TrimSpace(stdout))
	}
	return code, nil
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

// NetworkGateway returns a network's IPAM gateway address: the address a
// container on that network reaches the host at when the host's loopback is
// not forwarded to it (the Linux bridge case).
func (d *Docker) NetworkGateway(ctx context.Context, name string) (string, error) {
	stdout, stderr, err := d.exec(ctx, []string{
		"docker", "network", "inspect", "--format", "{{range .IPAM.Config}}{{println .Gateway}}{{end}}", name,
	})
	if err != nil {
		return "", fmt.Errorf("inspect network %s: %s", name, firstNonEmpty(stderr, err.Error()))
	}
	for _, line := range strings.Split(stdout, "\n") {
		if address := strings.TrimSpace(line); address != "" {
			return address, nil
		}
	}
	return "", fmt.Errorf("network %s has no IPAM gateway", name)
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

// ImageBuildOptions describes one locally built container-image function.
type ImageBuildOptions struct {
	Tag        string
	Directory  string
	DockerFile string
	BuildArgs  map[string]string
	Target     string
	Platform   string
	Labels     map[string]string
}

// BuildImageArgv is the exact docker build argv for options, sorted so a test
// can pin what the runner asks Docker to do.
func BuildImageArgv(options ImageBuildOptions) []string {
	argv := []string{"docker", "build", "-t", options.Tag}
	for _, label := range sortedLabels(options.Labels) {
		argv = append(argv, "--label", label)
	}
	dockerFile := options.DockerFile
	if dockerFile != "" {
		if !filepath.IsAbs(dockerFile) {
			dockerFile = filepath.Join(options.Directory, dockerFile)
		}
		argv = append(argv, "-f", dockerFile)
	}
	if options.Target != "" {
		argv = append(argv, "--target", options.Target)
	}
	if options.Platform != "" {
		argv = append(argv, "--platform", options.Platform)
	}
	for _, argument := range sortedBuildArgs(options.BuildArgs) {
		argv = append(argv, "--build-arg", argument)
	}
	return append(argv, options.Directory)
}

// BuildImage builds one container image from the cloud assembly's Docker asset.
func (d *Docker) BuildImage(ctx context.Context, options ImageBuildOptions) error {
	stdout, stderr, err := d.exec(ctx, BuildImageArgv(options))
	if err != nil {
		return fmt.Errorf("docker build %s: %s", options.Tag, firstNonEmpty(stderr, stdout, err.Error()))
	}
	return nil
}

// ImageEnv reads the environment the image itself declares, so the layer
// paths can be prepended to the image's own PATH and LD_LIBRARY_PATH.
func (d *Docker) ImageEnv(ctx context.Context, image string) (map[string]string, error) {
	stdout, stderr, err := d.exec(ctx, []string{
		"docker", "image", "inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", image,
	})
	if err != nil {
		return nil, fmt.Errorf("inspect image %s: %s", image, firstNonEmpty(stderr, err.Error()))
	}
	values := map[string]string{}
	for _, line := range splitLines(stdout) {
		name, value, found := strings.Cut(line, "=")
		if !found || strings.TrimSpace(name) == "" {
			continue
		}
		values[strings.TrimSpace(name)] = value
	}
	return values, nil
}

// ImageID resolves an image reference to the daemon's immutable id. A watch
// reload records it before a rebuild can move the tag, and a rollback starts
// the previous container from that id, so the tag's new target cannot leak into
// the restored container.
func (d *Docker) ImageID(ctx context.Context, image string) (string, error) {
	stdout, stderr, err := d.exec(ctx, []string{
		"docker", "image", "inspect", "--format", "{{.Id}}", image,
	})
	if err != nil {
		return "", fmt.Errorf("inspect image %s: %s", image, firstNonEmpty(stderr, err.Error()))
	}
	id := strings.TrimSpace(stdout)
	if id == "" {
		return "", fmt.Errorf("inspect image %s: docker returned no id", image)
	}
	return id, nil
}

// TagImage points tag at a source image id (or another tag). A watch rollback
// uses it to put back the tag a rebuild moved.
func (d *Docker) TagImage(ctx context.Context, source, tag string) error {
	stdout, stderr, err := d.exec(ctx, []string{"docker", "tag", source, tag})
	if err != nil {
		return fmt.Errorf("tag image %s as %s: %s", source, tag, firstNonEmpty(stderr, stdout, err.Error()))
	}
	return nil
}

// RemoveImage removes an image the run built. A missing image is not an error:
// cleanup runs after failures too.
func (d *Docker) RemoveImage(ctx context.Context, tag string) {
	_, _, _ = d.exec(ctx, []string{"docker", "image", "rm", "-f", tag}) //nolint:errcheck // best-effort cleanup
}

// ImageReferences is what still names or uses an image: the repo tags and repo
// digests that point at it and the containers (running or stopped) that run it.
type ImageReferences struct {
	RepoTags    []string
	RepoDigests []string
	Containers  []string
}

// ImageReferences reports the repo tags and repo digests that name an image and
// the containers that run it, so a cleanup can tell the dangling image a reload
// built from an image a foreign tag, a digest reference or a container still
// holds. Docker exposes no reference count; these are the references its
// removal rule consults (https://docs.docker.com/reference/cli/docker/image/rm/).
//
// A daemon using the containerd image store records one RepoDigest for each
// repository its RepoTags name: a fresh build with one tag reports
// "<tag repository>@sha256:<image id>", and moving the tag away removes the
// digest with it (observed on docker 29.5.2; two tags in one repository share
// one entry). A digest entry whose repository no tag on the image carries is
// therefore a reference that outlives the run, such as a foreign
// "repository@sha256:<digest>" pin with no tag of its own.
// removeDanglingImage is where that distinction is made.
func (d *Docker) ImageReferences(ctx context.Context, image string) (ImageReferences, error) {
	stdout, stderr, err := d.exec(ctx, []string{
		"docker", "image", "inspect", "--format", "{{json .RepoTags}} {{json .RepoDigests}}", image,
	})
	if err != nil {
		return ImageReferences{}, fmt.Errorf("inspect image %s: %s", image, firstNonEmpty(stderr, err.Error()))
	}
	references := ImageReferences{}
	decoder := json.NewDecoder(strings.NewReader(strings.TrimSpace(stdout)))
	if parseErr := decoder.Decode(&references.RepoTags); parseErr != nil {
		return ImageReferences{}, fmt.Errorf("inspect image %s: parse its repo tags: %w", image, parseErr)
	}
	if parseErr := decoder.Decode(&references.RepoDigests); parseErr != nil {
		return ImageReferences{}, fmt.Errorf("inspect image %s: parse its repo digests: %w", image, parseErr)
	}
	stdout, stderr, err = d.exec(ctx, []string{
		"docker", "ps", "-a", "--filter", "ancestor=" + image, "--format", "{{.ID}}",
	})
	if err != nil {
		return ImageReferences{}, fmt.Errorf("list the containers using image %s: %s", image, firstNonEmpty(stderr, err.Error()))
	}
	references.Containers = splitLines(stdout)
	return references, nil
}

// imageReferenceTagRepository returns the repository of a "repository:tag"
// reference. A digest reference ("repository@sha256:...") and a bare repository
// name report false: neither is a tag the run wrote.
func imageReferenceTagRepository(reference string) (string, bool) {
	if strings.Contains(reference, "@") {
		return "", false
	}
	index := strings.LastIndex(reference, ":")
	if index <= 0 || index < strings.LastIndex(reference, "/") {
		return "", false
	}
	return reference[:index], true
}

// imageTagReference names the reference docker records for a tag this run
// wrote. A repository with no tag defaults to :latest, and docker reports that
// form in RepoTags: a build with "-t run-fn-image" reports
// ["run-fn-image:latest"] (observed on docker 29.5.2). A cleanup compares an
// owned tag against this form rather than the bare name it passed to docker.
func imageTagReference(reference string) string {
	if reference == "" || strings.Contains(reference, "@") {
		return reference
	}
	if _, ok := imageReferenceTagRepository(reference); ok {
		return reference
	}
	return reference + ":latest"
}

// imageReferenceDigestRepository returns the repository of a
// "repository@sha256:..." reference. Anything else reports false, and the
// caller leaves the image in place rather than guess at a malformed reference.
func imageReferenceDigestRepository(reference string) (string, bool) {
	repository, digest, found := strings.Cut(reference, "@")
	if !found || repository == "" || !strings.HasPrefix(digest, "sha256:") {
		return "", false
	}
	return repository, true
}

// RemoveImageByID removes an image by its immutable id without forcing. Docker
// refuses while a container (running or stopped) references the image or while
// two or more repo tags name it, and untags the last tag and deletes the image
// when exactly one does. It never forces, so a refusal leaves every reference
// intact. https://docs.docker.com/reference/cli/docker/image/rm/
func (d *Docker) RemoveImageByID(ctx context.Context, image string) error {
	stdout, stderr, err := d.exec(ctx, []string{"docker", "image", "rm", image})
	if err != nil {
		return fmt.Errorf("remove image %s: %s", image, firstNonEmpty(stderr, stdout, err.Error()))
	}
	return nil
}

// ListImages lists the images carrying one label.
func (d *Docker) ListImages(ctx context.Context, label string) ([]string, error) {
	stdout, stderr, err := d.exec(ctx, []string{
		"docker", "image", "ls", "--filter", "label=" + label, "--format", "{{.Repository}}:{{.Tag}}",
	})
	if err != nil {
		return nil, fmt.Errorf("list docker images: %s", firstNonEmpty(stderr, err.Error()))
	}
	return splitLines(stdout), nil
}
