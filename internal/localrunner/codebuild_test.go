package localrunner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDeriveCodeBuildProject(t *testing.T) {
	stack := assemblyStack{
		Name: "Stack",
		Template: template{Resources: map[string]templateResource{
			"Project": {
				Type: typeCodeBuildProject,
				Properties: json.RawMessage(`{
					"Environment":{"Type":"LINUX_CONTAINER","Image":"aws/codebuild/standard:7.0","ComputeType":"BUILD_GENERAL1_SMALL",
						"EnvironmentVariables":[{"Name":"STAGE","Value":"dev","Type":"PLAINTEXT"}]},
					"Source":{"Type":"NO_SOURCE","BuildSpec":"{\"version\":\"0.2\",\"phases\":{\"build\":{\"commands\":[\"echo hi\"]}}}"},
					"Artifacts":{"Type":"NO_ARTIFACTS"},
					"Cache":{"Type":"NO_CACHE"},
					"TimeoutInMinutes":15
				}`),
			},
		}},
	}
	spec := &Spec{}
	if err := deriveCodeBuildProjects(spec, []assemblyStack{stack}, stack); err != nil {
		t.Fatal(err)
	}
	if len(spec.CodeBuildProjects) != 1 {
		t.Fatalf("projects = %+v", spec.CodeBuildProjects)
	}
	project := spec.CodeBuildProjects[0]
	if project.Name != "local-stack-project" || project.Image != "aws/codebuild/standard:7.0" || project.TimeoutMinutes != 15 {
		t.Fatalf("project = %+v", project)
	}
	if !strings.Contains(project.BuildSpec, "echo hi") {
		t.Fatalf("buildspec = %q", project.BuildSpec)
	}
	if project.EnvironmentVariables["STAGE"] != "dev" {
		t.Fatalf("environment = %v", project.EnvironmentVariables)
	}
}

func TestDeriveCodeBuildProjectResolvesEnvironmentIntrinsics(t *testing.T) {
	stack := assemblyStack{
		Name: "Stack",
		Template: template{
			Parameters: map[string]templateParameter{
				"Stage": {Default: json.RawMessage(`"dev"`)},
			},
			Resources: map[string]templateResource{
				"Jobs": {
					Type:       typeDynamoTable,
					Properties: json.RawMessage(`{"TableName":"jobs"}`),
				},
				"Ingest": {
					Type: typeS3Bucket,
				},
				"Secret": {
					Type: typeSecretsSecret,
				},
				"Project": {
					Type: typeCodeBuildProject,
					Properties: json.RawMessage(`{
						"Environment":{"Image":"aws/codebuild/standard:7.0","EnvironmentVariables":[
							{"Name":"JOBS","Value":{"Ref":"Jobs"},"Type":"PLAINTEXT"},
							{"Name":"BUCKET","Value":{"Ref":"Ingest"},"Type":"PLAINTEXT"},
							{"Name":"SECRET_ARN","Value":{"Ref":"Secret"},"Type":"PLAINTEXT"},
							{"Name":"STAGE","Value":{"Ref":"Stage"},"Type":"PLAINTEXT"},
							{"Name":"JOINED","Value":{"Fn::Join":["-",["a",{"Ref":"Stage"}]]},"Type":"PLAINTEXT"},
							{"Name":"UNRESOLVED","Value":{"Fn::ImportValue":"SharedBucket"},"Type":"PLAINTEXT"},
							{"Name":"LITERAL","Value":"plain","Type":"PLAINTEXT"}
						]},
						"Source":{"Type":"NO_SOURCE","BuildSpec":"version: 0.2"},
						"Artifacts":{"Type":"NO_ARTIFACTS"},"Cache":{"Type":"NO_CACHE"}
					}`),
				},
			},
		},
	}
	spec := &Spec{}
	if err := deriveCodeBuildProjects(spec, []assemblyStack{stack}, stack); err != nil {
		t.Fatalf("an intrinsic environment value failed the whole derivation: %v", err)
	}
	project := spec.CodeBuildProjects[0]
	want := map[string]string{
		"JOBS":    "jobs",
		"BUCKET":  "local-stack-ingest",
		"STAGE":   "dev",
		"JOINED":  "a-dev",
		"LITERAL": "plain",
	}
	for name, expected := range want {
		if got := project.EnvironmentVariables[name]; got != expected {
			t.Fatalf("%s = %q, want %q (environment %v)", name, got, expected, project.EnvironmentVariables)
		}
	}
	if !strings.HasPrefix(project.EnvironmentVariables["SECRET_ARN"], "arn:"+LocalPartition+":secretsmanager:") {
		t.Fatalf("secret ARN = %q", project.EnvironmentVariables["SECRET_ARN"])
	}
	if _, ok := project.EnvironmentVariables["UNRESOLVED"]; ok {
		t.Fatalf("an unresolvable expression was injected as %q", project.EnvironmentVariables["UNRESOLVED"])
	}
	joined := strings.Join(project.Deviations, "; ")
	if !strings.Contains(joined, "environment variable UNRESOLVED") || !strings.Contains(joined, "Fn::ImportValue") {
		t.Fatalf("deviations %q do not name the unresolved variable and its expression", joined)
	}
	if strings.Contains(joined, "environment variable JOBS") || strings.Contains(joined, "environment variable BUCKET") {
		t.Fatalf("deviations %q name a variable that resolved", joined)
	}
}

// TestExampleCodeBuildJobRunnerPlans proves the plan succeeds on the
// codebuild-job-runner example's own synthesized template, whose
// EnvironmentVariables are Refs to the jobs table, the ingest bucket and the
// secret. The assembly under testdata is that example's `npx cdk synth` output
// with the manifest trimmed to the stack artifact; regenerate it from
// examples/cdk/codebuild-job-runner when the example changes.
func TestExampleCodeBuildJobRunnerPlans(t *testing.T) {
	dir := filepath.Join("testdata", "codebuild-job-runner")
	stacks, err := loadAssembly(dir)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := deriveSpecInternal(dir, stacks)
	if err != nil {
		t.Fatalf("plan failed on the example's synthesized template: %v", err)
	}
	if len(spec.CodeBuildProjects) != 1 {
		t.Fatalf("projects = %+v", spec.CodeBuildProjects)
	}
	project := spec.CodeBuildProjects[0]
	if project.LogicalID != "RunnerProject5D2C85B4" {
		t.Fatalf("project = %+v", project)
	}
	resolved := map[string]string{
		"APPTHEORY_JOBS_TABLE_NAME": "local-apptheorycodebuildjobrunnerexample-jobstable10c8edf6",
		"INGEST_BUCKET":             "local-apptheorycodebuildjobrunnerexample-ingestbu-30e6fa032b",
	}
	for name, expected := range resolved {
		if got := project.EnvironmentVariables[name]; got != expected {
			t.Fatalf("%s = %q, want %q", name, got, expected)
		}
	}
	if !strings.HasPrefix(project.EnvironmentVariables["SECRET_ARN"], "arn:"+LocalPartition+":secretsmanager:") {
		t.Fatalf("SECRET_ARN = %q", project.EnvironmentVariables["SECRET_ARN"])
	}
	for _, deviation := range project.Deviations {
		if strings.Contains(deviation, "environment variable") {
			t.Fatalf("the example still reports an unresolved environment variable: %q", deviation)
		}
	}
}

func TestDeriveCodeBuildProjectNamesDeviations(t *testing.T) {
	stack := assemblyStack{
		Name: "Stack",
		Template: template{Resources: map[string]templateResource{
			"Project": {
				Type: typeCodeBuildProject,
				Properties: json.RawMessage(`{
					"Environment":{"Image":"aws/codebuild/standard:7.0","PrivilegedMode":true},
					"Source":{"Type":"GITHUB","BuildSpec":"version: 0.2"},
					"Artifacts":{"Type":"S3"},"Cache":{"Type":"LOCAL"},
					"VpcConfig":{"VpcId":"vpc-1"},
					"SecondarySources":[{}],
					"ReportGroups":["arn:aws:codebuild:us-east-1:123456789012:report-group/x"]
				}`),
			},
		}},
	}
	spec := &Spec{}
	if err := deriveCodeBuildProjects(spec, []assemblyStack{stack}, stack); err != nil {
		t.Fatal(err)
	}
	project := spec.CodeBuildProjects[0]
	joined := strings.Join(project.Deviations, "; ")
	for _, needle := range []string{"source type GITHUB", "privileged mode", "no VPC", "no cache", "no artifact upload", "secondary sources", "report groups"} {
		if !strings.Contains(joined, needle) {
			t.Fatalf("deviations %q do not name %q", joined, needle)
		}
	}
}

func TestProfileCodeBuildPins(t *testing.T) {
	profile := &Profile{path: "profile.json"}
	profile.CodeBuild.Agent = map[string]CodeBuildImagePin{
		"aarch64": {Tag: "public.ecr.aws/codebuild/local-builds:aarch64", Digest: "sha256:" + strings.Repeat("a", 64)},
	}
	profile.CodeBuild.Images = map[string]map[string]CodeBuildImagePin{
		"aws/codebuild/standard:7.0": {
			"aarch64": {Tag: "public.ecr.aws/codebuild/amazonlinux-aarch64-lambda-standard:nodejs24", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
	}
	if got, err := profile.CodeBuildAgent("arm64"); err != nil || !strings.Contains(got, "@sha256:") {
		t.Fatalf("agent = %q, %v", got, err)
	}
	if got, err := profile.CodeBuildImage("aarch64", "aws/codebuild/standard:7.0"); err != nil || !strings.Contains(got, "@sha256:") {
		t.Fatalf("image = %q, %v", got, err)
	}
	if _, err := profile.CodeBuildImage("x86_64", "aws/codebuild/standard:7.0"); err == nil {
		t.Fatal("an unpinned architecture did not fail closed")
	}
	if _, err := profile.CodeBuildImage("aarch64", "aws/codebuild/unknown:1.0"); err == nil {
		t.Fatal("an unmapped image class did not fail closed")
	}
	bad := &Profile{path: "profile.json"}
	bad.CodeBuild.Agent = map[string]CodeBuildImagePin{
		"aarch64": {Tag: "docker.io/example/agent:latest", Digest: "sha256:" + strings.Repeat("a", 64)},
	}
	if _, err := bad.CodeBuildAgent("aarch64"); err == nil {
		t.Fatal("a non-public.ecr.aws agent did not fail closed")
	}
}

func TestCodeBuildControlProtocol(t *testing.T) {
	service := &codeBuildService{
		projects:    map[string]CodeBuildProjectSpec{},
		localImages: map[string]string{},
		builds:      map[string]*codeBuildRecord{},
		byProject:   map[string][]string{},
		numbers:     map[string]int{},
	}
	project := CodeBuildProjectSpec{
		LogicalID: "Project", Name: "local-project", Image: "aws/codebuild/standard:7.0",
		TimeoutMinutes: 60,
	}
	service.projects[project.Name] = project
	service.projects[project.LogicalID] = project
	service.localImages[project.LogicalID] = "public.ecr.aws/codebuild/example@sha256:" + strings.Repeat("c", 64)
	server := httptest.NewServer(service)
	defer server.Close()

	call := func(operation string, payload any) (int, map[string]any) {
		body, _ := json.Marshal(payload)
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/", strings.NewReader(string(body)))
		request.Header.Set("Content-Type", "application/x-amz-json-1.1")
		request.Header.Set("X-Amz-Target", "CodeBuild_20161006."+operation)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close() //nolint:errcheck // test cleanup
		var decoded map[string]any
		if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
			t.Fatalf("%s response is not JSON: %v", operation, err)
		}
		return response.StatusCode, decoded
	}

	status, listed := call("ListProjects", map[string]any{})
	if status != 200 || len(listed["projects"].([]any)) != 1 {
		t.Fatalf("ListProjects = %d %v", status, listed)
	}
	status, missing := call("StartBuild", map[string]any{"projectName": "nope"})
	if status != 400 || missing["__type"] != "ResourceNotFoundException" {
		t.Fatalf("StartBuild unknown = %d %v", status, missing)
	}
	status, got := call("BatchGetBuilds", map[string]any{"ids": []string{"missing"}})
	if status != 200 || len(got["buildsNotFound"].([]any)) != 1 {
		t.Fatalf("BatchGetBuilds = %d %v", status, got)
	}
	status, projects := call("BatchGetProjects", map[string]any{"names": []string{project.Name}})
	if status != 200 || len(projects["projects"].([]any)) != 1 {
		t.Fatalf("BatchGetProjects = %d %v", status, projects)
	}
	status, unknown := call("Unknown", map[string]any{})
	if status != 400 || !strings.Contains(unknown["message"].(string), "does not serve") {
		t.Fatalf("unknown operation = %d %v", status, unknown)
	}
}

func TestApplyBuildLogParsesPhases(t *testing.T) {
	service := &codeBuildService{runner: &Runner{}, builds: map[string]*codeBuildRecord{}}
	record := &codeBuildRecord{ID: "build", Phases: []codeBuildPhase{{PhaseType: "SUBMITTED", PhaseStatus: "SUCCEEDED"}}}
	log := strings.Join([]string{
		"agent-1  | [Container] 2026/11/05 22:22:27.015581 Waiting for agent ping",
		"agent-1  | [Container] 2026/11/05 22:22:27.023014 Phase is DOWNLOAD_SOURCE",
		"agent-1  | [Container] 2026/11/05 22:22:27.035645 Phase complete: DOWNLOAD_SOURCE State: SUCCEEDED",
		"agent-1  | [Container] 2026/11/05 22:22:27.039475 Entering phase BUILD",
		"agent-1  | [Container] 2026/11/05 22:22:27.039803 Running command echo batch step placeholder",
		"agent-1  | batch step placeholder",
		"agent-1  | [Container] 2026/11/05 22:22:27.042289 Phase complete: BUILD State: SUCCEEDED",
	}, "\n")
	service.applyBuildLog(record, log)
	phases := map[string]codeBuildPhase{}
	for _, phase := range record.Phases {
		phases[phase.PhaseType] = phase
	}
	if phases["BUILD"].PhaseStatus != "SUCCEEDED" || phases["DOWNLOAD_SOURCE"].PhaseStatus != "SUCCEEDED" {
		t.Fatalf("phases = %+v", record.Phases)
	}
	if record.CurrentPhase != "BUILD" {
		t.Fatalf("current phase = %q", record.CurrentPhase)
	}
}

func TestCodeBuildStartRejectsUnsupportedOverrides(t *testing.T) {
	service := &codeBuildService{
		projects: map[string]CodeBuildProjectSpec{
			"local-project": {LogicalID: "Project", Name: "local-project", Image: "aws/codebuild/standard:7.0"},
		},
		localImages: map[string]string{"Project": "public.ecr.aws/codebuild/example@sha256:" + strings.Repeat("a", 64)},
		builds:      map[string]*codeBuildRecord{},
		byProject:   map[string][]string{},
		numbers:     map[string]int{},
	}
	server := httptest.NewServer(service)
	defer server.Close()
	for _, payload := range []string{
		`{"projectName":"local-project","privilegedModeOverride":true}`,
		`{"projectName":"local-project","computeTypeOverride":"BUILD_GENERAL1_LARGE"}`,
	} {
		request, _ := http.NewRequest(http.MethodPost, server.URL+"/", strings.NewReader(payload))
		request.Header.Set("X-Amz-Target", "CodeBuild_20161006.StartBuild")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close() //nolint:errcheck // test cleanup
		if response.StatusCode != 400 {
			t.Fatalf("override %s returned %d", payload, response.StatusCode)
		}
	}
}

func testCodeBuildProtocolService() (*codeBuildService, *Runner) {
	runner := &Runner{profile: &Profile{path: "test-profile"}}
	runner.profile.CodeBuild.Images = map[string]map[string]CodeBuildImagePin{
		"aws/codebuild/standard:7.0": {
			"aarch64": {Tag: "public.ecr.aws/codebuild/standard-aarch64", Digest: "sha256:" + strings.Repeat("a", 64)},
		},
	}
	project := CodeBuildProjectSpec{LogicalID: "Project", Name: "local-project", Image: "aws/codebuild/standard:7.0", TimeoutMinutes: 60}
	service := &codeBuildService{
		runner:      runner,
		hostArch:    "aarch64",
		projects:    map[string]CodeBuildProjectSpec{project.Name: project, project.LogicalID: project},
		localImages: map[string]string{"Project": "public.ecr.aws/codebuild/example@sha256:" + strings.Repeat("c", 64)},
		builds:      map[string]*codeBuildRecord{},
		byProject:   map[string][]string{},
		numbers:     map[string]int{},
	}
	return service, runner
}

func TestCodeBuildProtocolRefusesUnknownInputs(t *testing.T) {
	service, _ := testCodeBuildProtocolService()
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	service.ctx = cancelled
	server := httptest.NewServer(service)
	defer server.Close()

	call := func(method, target, payload string) (int, map[string]any) {
		t.Helper()
		request, err := http.NewRequest(method, server.URL+"/", strings.NewReader(payload))
		if err != nil {
			t.Fatal(err)
		}
		if method == http.MethodPost {
			request.Header.Set("X-Amz-Target", "CodeBuild_20161006."+target)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close() //nolint:errcheck // test cleanup
		var decoded map[string]any
		if response.StatusCode != http.StatusNotFound {
			_ = json.NewDecoder(response.Body).Decode(&decoded) //nolint:errcheck // best-effort fixture decode
		}
		return response.StatusCode, decoded
	}

	if status, _ := call(http.MethodGet, "", ""); status != http.StatusBadRequest {
		t.Fatalf("a non-log GET returned %d", status)
	}
	if status, _ := call(http.MethodPost, "StartBuild", "{"); status != http.StatusBadRequest {
		t.Fatalf("an invalid StartBuild body returned %d", status)
	}
	if status, _ := call(http.MethodPost, "BatchGetBuilds", "{"); status != http.StatusBadRequest {
		t.Fatalf("an invalid BatchGetBuilds body returned %d", status)
	}
	if status, _ := call(http.MethodPost, "ListBuildsForProject", "{"); status != http.StatusBadRequest {
		t.Fatalf("an invalid ListBuildsForProject body returned %d", status)
	}
	if status, _ := call(http.MethodPost, "BatchGetProjects", "{"); status != http.StatusBadRequest {
		t.Fatalf("an invalid BatchGetProjects body returned %d", status)
	}
	status, unknownProject := call(http.MethodPost, "ListBuildsForProject", `{"projectName":"nope"}`)
	if status != http.StatusBadRequest || unknownProject["__type"] != "ResourceNotFoundException" {
		t.Fatalf("an unknown project returned %d %v", status, unknownProject)
	}
	status, unknownImage := call(http.MethodPost, "StartBuild", `{"projectName":"local-project","imageOverride":"aws/codebuild/unsupported:1.0"}`)
	if status != http.StatusBadRequest || !strings.Contains(unknownImage["message"].(string), "does not map") {
		t.Fatalf("an unmapped image override returned %d %v", status, unknownImage)
	}
	if status, _ := call(http.MethodPost, "StartBuild", `{"projectName":"local-project","imageOverride":"aws/codebuild/standard:7.0"}`); status != http.StatusOK {
		t.Fatalf("a mapped image override returned %d", status)
	}
	status, unknownNames := call(http.MethodPost, "BatchGetProjects", `{"names":["nope"]}`)
	if status != http.StatusOK || len(unknownNames["projectsNotFound"].([]any)) != 1 {
		t.Fatalf("BatchGetProjects unknown = %d %v", status, unknownNames)
	}
	if got := callStatus(t, server.URL+"/codebuild/builds/missing/logs"); got != http.StatusNotFound {
		t.Fatalf("an unknown build log returned %d", got)
	}
}

func callStatus(t *testing.T, url string) int {
	t.Helper()
	response, err := http.Get(url) //nolint:noctx // test request
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close() //nolint:errcheck // test cleanup
	return response.StatusCode
}

func TestCodeBuildPhaseTransitionsAndSnapshots(t *testing.T) {
	service, _ := testCodeBuildProtocolService()
	now := service.runner.now()
	record := &codeBuildRecord{ID: "build", ProjectName: "local-project"}
	service.mu.Lock()
	service.startPhaseLocked(record, "BUILD", now)
	service.startPhaseLocked(record, "BUILD", now)
	service.completePhaseLocked(record, "BUILD", "SUCCEEDED", now.Add(2*time.Second))
	service.completePhaseLocked(record, "BUILD", "SUCCEEDED", now)
	service.completePhaseLocked(record, "POST_BUILD", "SUCCEEDED", now)
	service.mu.Unlock()
	if len(record.Phases) != 2 {
		t.Fatalf("phases = %+v", record.Phases)
	}
	if record.Phases[0].DurationInSeconds != 0 {
		t.Fatalf("a negative duration was recorded: %+v", record.Phases[0])
	}
	if record.Phases[1].PhaseType != "POST_BUILD" {
		t.Fatalf("a missing phase was not appended: %+v", record.Phases[1])
	}
	snapshot := recordSnapshot(record)
	snapshot.Phases[0].PhaseStatus = "FAILED"
	if record.Phases[0].PhaseStatus == "FAILED" {
		t.Fatal("the snapshot shares its phase slice with the record")
	}
}

func TestCodeBuildBuildsSnapshotAndUnmappedImage(t *testing.T) {
	var absent *codeBuildService
	if absent.CodeBuildBuilds() != nil {
		t.Fatal("a nil service returned builds")
	}
	service, _ := testCodeBuildProtocolService()
	record := &codeBuildRecord{ID: "local-project:1", BuildStatus: "SUCCEEDED", CurrentPhase: "COMPLETED"}
	service.builds[record.ID] = record
	service.byProject["Project"] = []string{record.ID, "missing"}
	builds := service.CodeBuildBuilds()
	if len(builds) != 1 {
		t.Fatalf("builds = %+v", builds)
	}
	records, ok := builds[0]["builds"].([]map[string]any)
	if !ok || len(records) != 1 || records[0]["id"] != record.ID {
		t.Fatalf("build snapshot = %+v", builds[0]["builds"])
	}

	runner := &Runner{profile: &Profile{path: "test-profile"}}
	runner.profile.CodeBuild.Agent = map[string]CodeBuildImagePin{
		"aarch64": {Tag: "public.ecr.aws/codebuild/local-builds:aarch64", Digest: "sha256:" + strings.Repeat("b", 64)},
	}
	spec := &Spec{CodeBuildProjects: []CodeBuildProjectSpec{{LogicalID: "P", Name: "p", Image: "aws/codebuild/standard:7.0"}}}
	if _, err := newCodeBuildService(runner, spec, "aarch64"); err == nil || !strings.Contains(err.Error(), "does not map") {
		t.Fatalf("an unmapped build image = %v", err)
	}
	if _, err := newCodeBuildService(runner, &Spec{}, "aarch64"); err != nil {
		t.Fatalf("an assembly with no project = %v", err)
	}
}
