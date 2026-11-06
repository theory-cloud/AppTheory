package localrunner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// CodeBuild control endpoint and local build execution.

const (
	serviceCodeBuild = "codebuild"
	// codeBuildTargetPrefix is the JSON 1.1 target prefix the AWS SDK sends.
	codeBuildTargetPrefix = "CodeBuild_20161006."
)

type codeBuildService struct {
	runner   *Runner
	hostArch string
	// projects maps every accepted project name and logical id to its spec.
	projects map[string]CodeBuildProjectSpec
	// localImages maps a project's logical id to the digest-pinned local image.
	localImages map[string]string
	agentImage  string

	mu        sync.Mutex
	builds    map[string]*codeBuildRecord
	byProject map[string][]string
	numbers   map[string]int

	endpointURL string
	// ctx is the run's context; a build is canceled when the session ends.
	ctx context.Context
}

type codeBuildEnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	Type  string `json:"type,omitempty"`
}

type codeBuildRecord struct {
	ID            string            `json:"id"`
	ARN           string            `json:"arn"`
	ProjectName   string            `json:"projectName"`
	BuildNumber   int               `json:"buildNumber"`
	StartTime     float64           `json:"startTime"`
	EndTime       float64           `json:"endTime,omitempty"`
	CurrentPhase  string            `json:"currentPhase"`
	BuildStatus   string            `json:"buildStatus"`
	SourceVersion string            `json:"sourceVersion,omitempty"`
	Phases        []codeBuildPhase  `json:"phases"`
	Logs          codeBuildLogs     `json:"logs"`
	Environment   codeBuildBuildEnv `json:"environment"`
	project       CodeBuildProjectSpec
}

type codeBuildPhase struct {
	PhaseType         string              `json:"phaseType"`
	PhaseStatus       string              `json:"phaseStatus"`
	StartTime         float64             `json:"startTime,omitempty"`
	EndTime           float64             `json:"endTime,omitempty"`
	DurationInSeconds int64               `json:"durationInSeconds"`
	Contexts          []map[string]string `json:"contexts,omitempty"`
}

type codeBuildLogs struct {
	GroupName  string `json:"groupName,omitempty"`
	StreamName string `json:"streamName,omitempty"`
	DeepLink   string `json:"deepLink,omitempty"`
	// Text is a local extension: BatchGetBuilds would not carry log bytes, but
	// the local row needs the agent's output to prove the buildspec ran.
	Text string `json:"text,omitempty"`
}

type codeBuildBuildEnv struct {
	Type                 string            `json:"type,omitempty"`
	Image                string            `json:"image"`
	ComputeType          string            `json:"computeType,omitempty"`
	PrivilegedMode       bool              `json:"privilegedMode"`
	EnvironmentVariables []codeBuildEnvVar `json:"environmentVariables,omitempty"`
	// LocalImage is the profile's digest-pinned image the agent runs.
	LocalImage string `json:"localImage,omitempty"`
}

// newCodeBuildService resolves every project's local images before the run
// starts, so an unmapped project fails closed at plan/start rather than at the
// first build.
func newCodeBuildService(r *Runner, spec *Spec, hostArch string) (*codeBuildService, error) {
	if len(spec.CodeBuildProjects) == 0 {
		return nil, nil
	}
	agent, err := r.profile.CodeBuildAgent(hostArch)
	if err != nil {
		return nil, err
	}
	service := &codeBuildService{
		runner:      r,
		hostArch:    hostArch,
		projects:    map[string]CodeBuildProjectSpec{},
		localImages: map[string]string{},
		agentImage:  agent,
		builds:      map[string]*codeBuildRecord{},
		byProject:   map[string][]string{},
		numbers:     map[string]int{},
	}
	for _, project := range spec.CodeBuildProjects {
		image, err := r.profile.CodeBuildImage(hostArch, project.Image)
		if err != nil {
			return nil, fmt.Errorf("CodeBuild project %s: %w", project.LogicalID, err)
		}
		service.projects[project.Name] = project
		service.projects[project.LogicalID] = project
		service.localImages[project.LogicalID] = image
	}
	return service, nil
}

// ServeHTTP speaks the AWS JSON 1.1 CodeBuild protocol.
func (s *codeBuildService) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/codebuild/builds/") && strings.HasSuffix(request.URL.Path, "/logs") {
		s.serveLog(writer, request)
		return
	}
	if request.Method != http.MethodPost {
		writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException", "CodeBuild accepts POST requests")
		return
	}
	target := strings.TrimSpace(request.Header.Get("X-Amz-Target"))
	operation := strings.TrimPrefix(target, codeBuildTargetPrefix)
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, 4<<20))
	if err != nil {
		writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException", err.Error())
		return
	}
	switch operation {
	case "StartBuild":
		s.startBuild(writer, body)
	case "BatchGetBuilds":
		s.batchGetBuilds(writer, body)
	case "ListBuildsForProject":
		s.listBuildsForProject(writer, body)
	case "BatchGetProjects":
		s.batchGetProjects(writer, body)
	case "ListProjects":
		s.listProjects(writer)
	default:
		writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException",
			fmt.Sprintf("the local CodeBuild endpoint does not serve %q", operation))
	}
}

type codeBuildStartInput struct {
	ProjectName                  string `json:"projectName"`
	SourceVersion                string `json:"sourceVersion"`
	BuildspecOverride            string `json:"buildspecOverride"`
	ImageOverride                string `json:"imageOverride"`
	ComputeTypeOverride          string `json:"computeTypeOverride"`
	TimeoutInMinutesOverride     int    `json:"timeoutInMinutesOverride"`
	PrivilegedModeOverride       *bool  `json:"privilegedModeOverride"`
	EnvironmentVariablesOverride []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
		Type  string `json:"type"`
	} `json:"environmentVariablesOverride"`
}

func (s *codeBuildService) startBuild(writer http.ResponseWriter, body []byte) {
	var input codeBuildStartInput
	if err := json.Unmarshal(body, &input); err != nil {
		writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException", err.Error())
		return
	}
	project, ok := s.projects[strings.TrimSpace(input.ProjectName)]
	if !ok {
		writeCodeBuildError(writer, http.StatusBadRequest, "ResourceNotFoundException",
			fmt.Sprintf("project %q is not declared by the assembly", input.ProjectName))
		return
	}
	if input.PrivilegedModeOverride != nil && *input.PrivilegedModeOverride {
		writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException",
			"privilegedModeOverride is not available locally: the local agent starts the build container unprivileged")
		return
	}
	if strings.TrimSpace(input.ComputeTypeOverride) != "" && input.ComputeTypeOverride != "BUILD_GENERAL1_SMALL" {
		writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException",
			fmt.Sprintf("computeTypeOverride %q is not available locally; the documented host runs one small build at a time", input.ComputeTypeOverride))
		return
	}
	image := s.localImages[project.LogicalID]
	if override := strings.TrimSpace(input.ImageOverride); override != "" {
		mapped, err := s.runner.profile.CodeBuildImage(s.hostArch, override)
		if err != nil {
			writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException", err.Error())
			return
		}
		image = mapped
	}
	s.mu.Lock()
	s.numbers[project.LogicalID]++
	number := s.numbers[project.LogicalID]
	buildID := project.Name + ":" + shortID() + shortID()
	now := s.runner.now().UTC()
	record := &codeBuildRecord{
		ID:            buildID,
		ARN:           "arn:" + LocalPartition + ":codebuild:" + LocalRegion + ":" + LocalAccountID + ":build/" + buildID,
		ProjectName:   project.Name,
		BuildNumber:   number,
		StartTime:     floatTimestamp(now),
		CurrentPhase:  "SUBMITTED",
		BuildStatus:   "IN_PROGRESS",
		SourceVersion: strings.TrimSpace(input.SourceVersion),
		project:       project,
		Environment: codeBuildBuildEnv{
			Type:           "LINUX_CONTAINER",
			Image:          project.Image,
			ComputeType:    "BUILD_GENERAL1_SMALL",
			PrivilegedMode: false,
			LocalImage:     image,
		},
		Phases: []codeBuildPhase{{
			PhaseType:   "SUBMITTED",
			PhaseStatus: "SUCCEEDED",
			StartTime:   floatTimestamp(now),
			EndTime:     floatTimestamp(now),
		}},
	}
	for _, variable := range project.EnvironmentVariables {
		record.Environment.EnvironmentVariables = append(record.Environment.EnvironmentVariables, codeBuildEnvVar{
			Name: variable, Value: project.EnvironmentVariables[variable], Type: "PLAINTEXT",
		})
	}
	for _, variable := range input.EnvironmentVariablesOverride {
		record.Environment.EnvironmentVariables = append(record.Environment.EnvironmentVariables, codeBuildEnvVar{
			Name: variable.Name, Value: variable.Value, Type: "PLAINTEXT",
		})
	}
	sort.Slice(record.Environment.EnvironmentVariables, func(i, j int) bool {
		return record.Environment.EnvironmentVariables[i].Name < record.Environment.EnvironmentVariables[j].Name
	})
	s.builds[buildID] = record
	s.byProject[project.LogicalID] = append(s.byProject[project.LogicalID], buildID)
	s.mu.Unlock()

	s.publish(record, "IN_PROGRESS")
	// Marshal the initial record before the build goroutine can update it.
	s.mu.Lock()
	initial := recordSnapshot(record)
	s.mu.Unlock()
	writeCodeBuildJSON(writer, http.StatusOK, map[string]any{"build": initial})
	go s.runBuild(record, input, image)
}

func (s *codeBuildService) runBuild(record *codeBuildRecord, input codeBuildStartInput, localImage string) {
	if s.ctx != nil && s.ctx.Err() != nil {
		return
	}
	s.runner.logf("codebuild: starting build %s for project %s (%s)", record.ID, record.ProjectName, localImage)
	status, output := s.executeBuild(record, input, localImage)
	s.mu.Lock()
	record.EndTime = floatTimestamp(s.runner.now().UTC())
	record.BuildStatus = status
	record.Logs.Text = output
	record.CurrentPhase = "COMPLETED"
	record.Phases = append(record.Phases, codeBuildPhase{
		PhaseType:   "COMPLETED",
		PhaseStatus: status,
		StartTime:   record.EndTime,
		EndTime:     record.EndTime,
	})
	s.mu.Unlock()
	s.publish(record, status)
	s.runner.logf("codebuild: build %s %s", record.ID, status)
}

func (s *codeBuildService) executeBuild(record *codeBuildRecord, input codeBuildStartInput, localImage string) (string, string) {
	project := record.project
	root := filepath.Join(s.runner.scratch, "codebuild", sanitizeName(project.LogicalID), sanitizeName(record.ID))
	sourceDir := filepath.Join(root, "src")
	artifactDir := filepath.Join(root, "artifacts")
	envDir := filepath.Join(root, "env")
	for _, dir := range []string{sourceDir, artifactDir, envDir} {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return "FAILED", fmt.Sprintf("create %s: %v", dir, err)
		}
		if err := ensureSharedPath(dir); err != nil {
			return "FAILED", err.Error()
		}
	}
	buildspec := strings.TrimSpace(input.BuildspecOverride)
	if buildspec == "" {
		buildspec = project.BuildSpec
	}
	if buildspec == "" && project.BuildSpecPath != "" {
		return "FAILED", fmt.Sprintf(
			"the project's buildspec is the source path %q, and a NO_SOURCE project has no files to read it from",
			project.BuildSpecPath,
		)
	}
	if buildspec == "" {
		return "FAILED", "the project declares no inline buildspec"
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "buildspec.yml"), []byte(buildspec), 0o600); err != nil {
		return "FAILED", fmt.Sprintf("write buildspec.yml: %v", err)
	}
	envFile := filepath.Join(envDir, "env.list")
	lines := []string{
		"AWS_ACCESS_KEY_ID=dummy",
		"AWS_SECRET_ACCESS_KEY=dummy",
		"AWS_REGION=" + LocalRegion,
		"AWS_DEFAULT_REGION=" + LocalRegion,
		"AWS_EC2_METADATA_DISABLED=true",
		// The build container is not on the run network, so it cannot resolve a
		// backend container name. Point the SDK at a closed local port: a build
		// that calls AWS fails closed instead of reaching real AWS.
		"AWS_ENDPOINT_URL=" + ClosedEndpoint,
	}
	for _, variable := range record.Environment.EnvironmentVariables {
		lines = append(lines, variable.Name+"="+variable.Value)
	}
	sort.Strings(lines)
	if err := os.WriteFile(envFile, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return "FAILED", fmt.Sprintf("write the environment file: %v", err)
	}

	runCtx := s.ctx
	if runCtx == nil {
		runCtx = context.Background()
	}
	if err := s.runner.docker.EnsureImage(runCtx, s.agentImage); err != nil {
		return "FAILED", err.Error()
	}
	if err := s.runner.docker.EnsureImage(runCtx, localImage); err != nil {
		return "FAILED", err.Error()
	}
	composeProject := sanitizeName("apptheory-codebuild-" + record.ID)
	defer s.cleanupBuild(composeProject, sanitizeName(s.runner.namePrefix+"-codebuild-"+record.ID))
	timeout := time.Duration(project.TimeoutMinutes) * time.Minute
	if timeout <= 0 {
		timeout = time.Hour
	}
	buildCtx, cancel := context.WithTimeout(runCtx, timeout)
	defer cancel()
	output, runErr := s.runner.docker.RunOnce(buildCtx, ContainerOptions{
		Name:   sanitizeName(s.runner.namePrefix + "-codebuild-" + record.ID),
		Image:  s.agentImage,
		Labels: s.runner.labels(),
		Env: map[string]string{
			"IMAGE_NAME":             localImage,
			"ARTIFACTS":              artifactDir,
			"SOURCE":                 sourceDir,
			"LOCAL_AGENT_IMAGE_NAME": s.agentImage,
			"INITIATOR":              "apptheory-local",
			"COMPOSE_PROJECT_NAME":   composeProject,
			"ENV_VAR_FILE":           filepath.Base(envFile),
			"AWS_CONFIGURATION":      "NONE",
			"MOUNT_SOURCE_DIRECTORY": "FALSE",
			"DOCKER_PRIVILEGED_MODE": "FALSE",
		},
		Mounts: []string{
			"/var/run/docker.sock:/var/run/docker.sock",
			envDir + ":/LocalBuild/envFile:ro",
		},
		Detach: false,
	})
	s.applyBuildLog(record, output)
	if runErr != nil {
		return "FAILED", output + "\n" + runErr.Error()
	}
	for _, phase := range record.Phases {
		if phase.PhaseStatus == "FAILED" {
			return "FAILED", output
		}
	}
	if !strings.Contains(output, "Phase complete:") {
		return "FAILED", output + "\nthe local agent produced no build phases"
	}
	return "SUCCEEDED", output
}

var (
	codeBuildContainerLine = regexp.MustCompile(`\[Container\]\s+(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+(.*)$`)
	codeBuildEnteringPhase = regexp.MustCompile(`^Entering phase ([A-Z_]+)$`)
	codeBuildPhaseIs       = regexp.MustCompile(`^Phase is ([A-Z_]+)$`)
	codeBuildPhaseComplete = regexp.MustCompile(`^Phase complete: ([A-Z_]+) State: ([A-Z]+)$`)
)

// applyBuildLog turns the agent's documented phase lines into the build's
// phase list and current phase.
func (s *codeBuildService) applyBuildLog(record *codeBuildRecord, output string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, line := range strings.Split(output, "\n") {
		match := codeBuildContainerLine.FindStringSubmatch(line)
		if len(match) != 3 {
			continue
		}
		timestamp, err := time.ParseInLocation("2006/01/02 15:04:05.000000", match[1], time.Local)
		if err != nil {
			timestamp = s.runner.now()
		}
		message := strings.TrimSpace(match[2])
		if entering := codeBuildEnteringPhase.FindStringSubmatch(message); len(entering) == 2 {
			s.startPhaseLocked(record, entering[1], timestamp)
			continue
		}
		if isPhase := codeBuildPhaseIs.FindStringSubmatch(message); len(isPhase) == 2 {
			s.startPhaseLocked(record, isPhase[1], timestamp)
			continue
		}
		if complete := codeBuildPhaseComplete.FindStringSubmatch(message); len(complete) == 3 {
			s.completePhaseLocked(record, complete[1], complete[2], timestamp)
		}
	}
}

func (s *codeBuildService) startPhaseLocked(record *codeBuildRecord, phase string, when time.Time) {
	for index := range record.Phases {
		if record.Phases[index].PhaseType == phase {
			if record.Phases[index].PhaseStatus == "" || record.Phases[index].PhaseStatus == "IN_PROGRESS" {
				return
			}
		}
	}
	record.Phases = append(record.Phases, codeBuildPhase{
		PhaseType:   phase,
		PhaseStatus: "IN_PROGRESS",
		StartTime:   floatTimestamp(when),
	})
	record.CurrentPhase = phase
}

func (s *codeBuildService) completePhaseLocked(record *codeBuildRecord, phase, status string, when time.Time) {
	for index := range record.Phases {
		if record.Phases[index].PhaseType != phase {
			continue
		}
		record.Phases[index].PhaseStatus = status
		record.Phases[index].EndTime = floatTimestamp(when)
		if record.Phases[index].StartTime > 0 {
			record.Phases[index].DurationInSeconds = int64(floatTimestamp(when) - record.Phases[index].StartTime)
		}
		if record.Phases[index].DurationInSeconds < 0 {
			record.Phases[index].DurationInSeconds = 0
		}
		return
	}
	record.Phases = append(record.Phases, codeBuildPhase{
		PhaseType:         phase,
		PhaseStatus:       status,
		StartTime:         floatTimestamp(when),
		EndTime:           floatTimestamp(when),
		DurationInSeconds: 0,
	})
}

// publish sends one "CodeBuild Build State Change" event on the run's bus.
// https://docs.aws.amazon.com/codebuild/latest/userguide/sample-build-notifications.html
func (s *codeBuildService) publish(record *codeBuildRecord, status string) {
	if s.runner.eventBus == nil {
		return
	}
	s.mu.Lock()
	currentPhase := record.CurrentPhase
	s.mu.Unlock()
	detail, err := json.Marshal(map[string]any{
		"build-status":  status,
		"project-name":  record.ProjectName,
		"build-id":      record.ID,
		"current-phase": currentPhase,
		"additional-information": map[string]any{
			"environment": record.Environment,
			"initiator":   "apptheory-local",
		},
	})
	if err != nil {
		s.runner.logf("codebuild: encode state-change event: %v", err)
		return
	}
	_, failed := s.runner.eventBus.putEvents(context.Background(), []eventBridgeEntry{{
		Source:       "aws.codebuild",
		DetailType:   "CodeBuild Build State Change",
		Detail:       string(detail),
		EventBusName: defaultEventBus,
		Resources:    []string{record.ARN},
		Time:         s.runner.now().UTC().Format(time.RFC3339Nano),
	}})
	if failed > 0 {
		s.runner.logf("codebuild: %d state-change event(s) failed to publish", failed)
	}
}

func (s *codeBuildService) cleanupBuild(composeProject, containerName string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	listCtx, listCancel := context.WithTimeout(ctx, 10*time.Second)
	names, _, err := s.runner.docker.exec(listCtx, []string{
		"docker", "ps", "-a", "--filter", "name=" + composeProject + "-", "--format", "{{.Names}}",
	})
	listCancel()
	if err == nil {
		for _, name := range strings.Split(strings.TrimSpace(names), "\n") {
			if strings.TrimSpace(name) != "" {
				s.runner.docker.RemoveContainer(ctx, strings.TrimSpace(name))
			}
		}
	}
	s.runner.docker.RemoveContainer(ctx, containerName)
	s.runner.docker.RemoveNetwork(ctx, composeProject+"_default")
	volumeCtx, volumeCancel := context.WithTimeout(ctx, 10*time.Second)
	volumes, _, volumeErr := s.runner.docker.exec(volumeCtx, []string{
		"docker", "volume", "ls", "--filter", "label=com.docker.compose.project=" + composeProject, "--format", "{{.Name}}",
	})
	volumeCancel()
	if volumeErr == nil {
		for _, volume := range strings.Split(strings.TrimSpace(volumes), "\n") {
			if strings.TrimSpace(volume) == "" {
				continue
			}
			removeCtx, removeCancel := context.WithTimeout(ctx, 10*time.Second)
			_, _, _ = s.runner.docker.exec(removeCtx, []string{"docker", "volume", "rm", strings.TrimSpace(volume)})
			removeCancel()
		}
	}
}

func (s *codeBuildService) batchGetBuilds(writer http.ResponseWriter, body []byte) {
	var input struct {
		IDs []string `json:"ids"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException", err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	builds := make([]*codeBuildRecord, 0, len(input.IDs))
	missing := make([]string, 0)
	for _, id := range input.IDs {
		record, ok := s.builds[id]
		if !ok {
			missing = append(missing, id)
			continue
		}
		builds = append(builds, recordSnapshot(record))
	}
	writeCodeBuildJSON(writer, http.StatusOK, map[string]any{"builds": builds, "buildsNotFound": missing})
}

func (s *codeBuildService) listBuildsForProject(writer http.ResponseWriter, body []byte) {
	var input struct {
		ProjectName string `json:"projectName"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException", err.Error())
		return
	}
	project, ok := s.projects[strings.TrimSpace(input.ProjectName)]
	if !ok {
		writeCodeBuildError(writer, http.StatusBadRequest, "ResourceNotFoundException",
			fmt.Sprintf("project %q is not declared by the assembly", input.ProjectName))
		return
	}
	s.mu.Lock()
	ids := append([]string(nil), s.byProject[project.LogicalID]...)
	s.mu.Unlock()
	// AWS returns newest first.
	for left, right := 0, len(ids)-1; left < right; left, right = left+1, right-1 {
		ids[left], ids[right] = ids[right], ids[left]
	}
	writeCodeBuildJSON(writer, http.StatusOK, map[string]any{"ids": ids})
}

func (s *codeBuildService) batchGetProjects(writer http.ResponseWriter, body []byte) {
	var input struct {
		Names []string `json:"names"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		writeCodeBuildError(writer, http.StatusBadRequest, "InvalidInputException", err.Error())
		return
	}
	projects := make([]map[string]any, 0, len(input.Names))
	missing := make([]string, 0)
	for _, name := range input.Names {
		project, ok := s.projects[name]
		if !ok {
			missing = append(missing, name)
			continue
		}
		projects = append(projects, s.projectDocument(project))
	}
	writeCodeBuildJSON(writer, http.StatusOK, map[string]any{"projects": projects, "projectsNotFound": missing})
}

func (s *codeBuildService) listProjects(writer http.ResponseWriter) {
	seen := map[string]bool{}
	names := make([]string, 0, len(s.projects))
	for _, project := range s.projects {
		if seen[project.LogicalID] {
			continue
		}
		seen[project.LogicalID] = true
		names = append(names, project.Name)
	}
	sort.Strings(names)
	writeCodeBuildJSON(writer, http.StatusOK, map[string]any{"projects": names})
}

func (s *codeBuildService) projectDocument(project CodeBuildProjectSpec) map[string]any {
	return map[string]any{
		"name":        project.Name,
		"arn":         "arn:" + LocalPartition + ":codebuild:" + LocalRegion + ":" + LocalAccountID + ":project/" + project.Name,
		"description": project.LogicalID,
		"source":      map[string]any{"type": project.SourceType},
		"environment": map[string]any{
			"type":        "LINUX_CONTAINER",
			"image":       project.Image,
			"localImage":  s.localImages[project.LogicalID],
			"computeType": "BUILD_GENERAL1_SMALL",
		},
		"timeoutInMinutes": project.TimeoutMinutes,
	}
}

func (s *codeBuildService) serveLog(writer http.ResponseWriter, request *http.Request) {
	id := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/codebuild/builds/"), "/logs")
	s.mu.Lock()
	record, ok := s.builds[id]
	text := ""
	if ok {
		text = record.Logs.Text
	}
	s.mu.Unlock()
	if !ok {
		http.NotFound(writer, request)
		return
	}
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(writer, text) //nolint:errcheck // the log response is best effort
}

func writeCodeBuildJSON(writer http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(writer, "encode CodeBuild response", http.StatusInternalServerError)
		return
	}
	writer.Header().Set("Content-Type", "application/x-amz-json-1.1")
	writer.WriteHeader(status)
	_, _ = writer.Write(encoded) //nolint:errcheck // the HTTP server reports the write error
}

func writeCodeBuildError(writer http.ResponseWriter, status int, kind, message string) {
	writeCodeBuildJSON(writer, status, map[string]any{"__type": kind, "message": message})
}

func floatTimestamp(when time.Time) float64 {
	return float64(when.UnixNano()) / float64(time.Second)
}

// recordSnapshot copies a record and its phase slice for a concurrent read.
// The caller holds s.mu.
func recordSnapshot(record *codeBuildRecord) *codeBuildRecord {
	copyRecord := *record
	copyRecord.Phases = append([]codeBuildPhase(nil), record.Phases...)
	return &copyRecord
}

// startCodeBuildControl serves the CodeBuild control endpoint when the assembly
// declares a project, and injects its URL into every function as
// AWS_ENDPOINT_URL_CODEBUILD.
func (r *Runner) startCodeBuildControl(ctx context.Context, spec *Spec, hostArch string) error {
	service, err := newCodeBuildService(r, spec, hostArch)
	if err != nil {
		return err
	}
	if service == nil {
		return nil
	}
	listeners, err := r.listenControl(ctx, serviceCodeBuild)
	if err != nil {
		return err
	}
	service.endpointURL = listeners.HostURL
	service.ctx = ctx
	r.codeBuild = service
	r.codeBuildURL = listeners.HostURL
	r.endpoints = append(r.endpoints, Endpoint{Service: serviceCodeBuild, URL: listeners.ContainerURL})
	server := &http.Server{
		Handler:           service,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	r.servers = append(r.servers, server)
	go func() {
		if serveErr := server.Serve(listeners.Loopback); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			r.logf("codebuild control listener stopped: %v", serveErr)
		}
	}()
	if listeners.Gateway != nil {
		go func() {
			if serveErr := server.Serve(listeners.Gateway); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				r.logf("codebuild gateway listener stopped: %v", serveErr)
			}
		}()
	}
	r.logf("codebuild API at %s (containers: %s, agent %s)", listeners.HostURL, listeners.ContainerURL, service.agentImage)
	return nil
}

// CodeBuildBuilds returns a snapshot for session describe and plan.
func (s *codeBuildService) CodeBuildBuilds() []map[string]any {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[string]bool{}
	out := make([]map[string]any, 0, len(s.projects))
	for _, project := range s.projects {
		if seen[project.LogicalID] {
			continue
		}
		seen[project.LogicalID] = true
		builds := make([]map[string]any, 0, len(s.byProject[project.LogicalID]))
		for _, id := range s.byProject[project.LogicalID] {
			if record, ok := s.builds[id]; ok {
				snapshot := recordSnapshot(record)
				builds = append(builds, map[string]any{
					"id":           snapshot.ID,
					"buildStatus":  snapshot.BuildStatus,
					"currentPhase": snapshot.CurrentPhase,
					"startTime":    snapshot.StartTime,
					"endTime":      snapshot.EndTime,
				})
			}
		}
		out = append(out, map[string]any{
			"logicalId":  project.LogicalID,
			"name":       project.Name,
			"image":      project.Image,
			"localImage": s.localImages[project.LogicalID],
			"sourceType": project.SourceType,
			"deviations": project.Deviations,
			"builds":     builds,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i]["logicalId"].(string) < out[j]["logicalId"].(string)
	})
	return out
}
