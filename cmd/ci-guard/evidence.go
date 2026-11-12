package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// evidenceInvocation matches the stable CI entry point and captures the gate id.
var evidenceInvocation = regexp.MustCompile(`scripts/evidence/verify-or-execute\.sh[ \t]+--gate[ \t]+([a-z0-9-]+)`)

// evidenceWiringRequirement names the jobs whose evidence wiring is part of the
// operator-authorized execution policy. A job that loses its evidence entry
// point would silently re-execute the full workload; a job that gains one where
// it must always execute would silently turn a required safety gate into a
// claim.
type evidenceWiringRequirement struct {
	workflow string
	job      string
	gates    []string
	// forced means every invocation of a listed gate in this job must set
	// EVIDENCE_FORCE_EXECUTE: "true": the job's environment is itself under test
	// (a runtime floor) or it is the generated-delta smoke, so it must never
	// reuse another environment's proof.
	forced bool
}

var evidenceWiring = []evidenceWiringRequirement{
	{workflow: ciWorkflowPath, job: "rubric", gates: []string{"rubric"}},
	{workflow: ciWorkflowPath, job: "builds", gates: []string{"deterministic-builds"}},
	{workflow: ciWorkflowPath, job: "go", gates: []string{"go"}},
	{workflow: ciWorkflowPath, job: "ts", gates: []string{"ts"}},
	{workflow: ciWorkflowPath, job: "py", gates: []string{"py"}},
	{workflow: ciWorkflowPath, job: "contract-tests", gates: []string{"contract-tests"}},
	{workflow: ciWorkflowPath, job: "cdk-go-drift", gates: []string{"cdk-go-drift"}},
	{workflow: ciWorkflowPath, job: "security-refresh", gates: []string{"security-refresh"}},
	{workflow: ciWorkflowPath, job: "release-delta", gates: []string{"release-delta"}, forced: true},
	{workflow: ciWorkflowPath, job: "runtime-floor-matrix", gates: []string{"ts", "py", "contract-tests"}, forced: true},
	{workflow: ciWorkflowPath, job: "cdk-floor-matrix", gates: []string{"cdk-go-drift"}, forced: true},
	{workflow: ".github/workflows/examples-local.yml", job: "examples-local", gates: []string{"examples-local"}},
}

// alwaysExecutingJobs must never carry an evidence entry point: they are the
// cheap release/security invariants whose whole value is running on the new
// commit, independent of any reusable proof.
var alwaysExecutingJobs = []string{"release-security-gates"}

type evidenceRegistry struct {
	SchemaVersion     int    `json:"schemaVersion"`
	EvidenceDirectory string `json:"evidenceDirectory"`
	LocalLogDirectory string `json:"localLogDirectory"`
	Gates             map[string]struct {
		Kind     string `json:"kind"`
		Commands []struct {
			ID   string   `json:"id"`
			Argv []string `json:"argv"`
		} `json:"commands"`
	} `json:"gates"`
	ExecutionMatrix []struct {
		ID string `json:"id"`
	} `json:"executionMatrix"`
}

func runEvidenceWiring(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("evidence-wiring", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "repository root")
	if err := flags.Parse(args); err != nil {
		return exitBlocked
	}
	failures := checkEvidenceWiring(*root)
	if len(failures) > 0 {
		writeString(stderr, "ci-evidence-wiring: FAIL\n")
		for _, failure := range failures {
			writeString(stderr, fmt.Sprintf("- %s\n", failure))
		}
		return exitFail
	}
	writeString(stdout, fmt.Sprintf("ci-evidence-wiring: PASS (%d evidence-aware jobs, %d always-executing jobs)\n",
		len(evidenceWiring), len(alwaysExecutingJobs)))
	return exitPass
}

func checkEvidenceWiring(root string) []string {
	registry, err := loadEvidenceRegistry(root)
	if err != nil {
		return []string{err.Error()}
	}
	failures := checkEvidenceRegistry(registry)
	failures = append(failures, checkEvidenceWorkflowWiring(root)...)
	failures = append(failures, checkAlwaysExecutingWiring(root)...)
	return failures
}

func checkEvidenceRegistry(registry *evidenceRegistry) []string {
	var failures []string
	if got, want := registry.EvidenceDirectory, "gov-infra/evidence/proportionate"; got != want {
		failures = append(failures, fmt.Sprintf("evidence directory must stay %q, got %q", want, got))
	}
	if !strings.HasPrefix(registry.LocalLogDirectory+"/", registry.EvidenceDirectory+"/") {
		failures = append(failures, "local evidence logs must live under the dedicated evidence directory")
	}
	for _, gate := range []string{"rubric", "deterministic-builds", "go", "ts", "py", "contract-tests", "cdk-go-drift", "examples-local", "security-refresh", "release-delta"} {
		if _, ok := registry.Gates[gate]; !ok {
			failures = append(failures, fmt.Sprintf("tracked gate registry is missing %q", gate))
		}
	}
	if commands := registry.Gates["rubric"].Commands; len(commands) != 1 || strings.Join(commands[0].Argv, " ") != "make rubric" {
		failures = append(failures, "rubric gate must keep the approved `make rubric` command")
	}
	if commands := registry.Gates["deterministic-builds"].Commands; len(commands) != 1 || strings.Join(commands[0].Argv, " ") != "bash scripts/verify-builds.sh" {
		failures = append(failures, "deterministic-builds gate must keep the approved verify-builds command")
	}
	for _, command := range registry.Gates["release-delta"].Commands {
		argv := strings.Join(command.Argv, " ")
		for _, forbidden := range []string{"make rubric", "verify-contract-tests.sh", "examples-local", "verify-go.sh"} {
			if strings.Contains(argv, forbidden) {
				failures = append(failures, fmt.Sprintf("release-delta must not repeat the source suite; found %q in %q", forbidden, argv))
			}
		}
	}
	return failures
}

func checkEvidenceWorkflowWiring(root string) []string {
	var failures []string
	workflows := map[string]*workflowFile{}
	for _, requirement := range evidenceWiring {
		if _, ok := workflows[requirement.workflow]; !ok {
			workflow, err := loadWorkflow(filepath.Join(root, filepath.FromSlash(requirement.workflow)), requirement.workflow)
			if err != nil {
				failures = append(failures, err.Error())
				continue
			}
			workflows[requirement.workflow] = workflow
		}
		workflow := workflows[requirement.workflow]
		job, ok := findJob(workflow, requirement.job)
		if !ok {
			failures = append(failures, fmt.Sprintf("%s must define job %q", requirement.workflow, requirement.job))
			continue
		}
		failures = append(failures, checkJobEvidenceWiring(requirement, job)...)
	}
	return failures
}

func checkAlwaysExecutingWiring(root string) []string {
	var failures []string
	workflow, err := loadWorkflow(filepath.Join(root, filepath.FromSlash(ciWorkflowPath)), ciWorkflowPath)
	if err != nil {
		return []string{err.Error()}
	}
	for _, jobID := range alwaysExecutingJobs {
		job, ok := findJob(workflow, jobID)
		if !ok {
			failures = append(failures, fmt.Sprintf("%s must define job %q", ciWorkflowPath, jobID))
			continue
		}
		for _, step := range job.steps {
			if evidenceInvocation.MatchString(step.run) {
				failures = append(failures, fmt.Sprintf("job %q must always execute its release/security invariants, but step %q reuses evidence", jobID, step.name))
			}
		}
	}
	return failures
}

func checkJobEvidenceWiring(requirement evidenceWiringRequirement, job workflowJob) []string {
	var failures []string
	found := map[string]bool{}
	for _, step := range job.steps {
		for _, match := range evidenceInvocation.FindAllStringSubmatch(step.run, -1) {
			gate := match[1]
			found[gate] = true
			if requirement.forced && step.env["EVIDENCE_FORCE_EXECUTE"] != literalTrue {
				failures = append(failures, fmt.Sprintf(
					"job %q step %q must set EVIDENCE_FORCE_EXECUTE: \"true\" for gate %q; this environment is itself under test",
					requirement.job, step.name, gate))
			}
		}
	}
	for _, gate := range requirement.gates {
		if !found[gate] {
			failures = append(failures, fmt.Sprintf(
				"%s job %q must invoke scripts/evidence/verify-or-execute.sh --gate %s",
				requirement.workflow, requirement.job, gate))
		}
	}
	return failures
}

func findJob(workflow *workflowFile, id string) (workflowJob, bool) {
	for _, job := range workflow.jobs {
		if job.id == id {
			return job, true
		}
	}
	return workflowJob{}, false
}

func loadEvidenceRegistry(root string) (*evidenceRegistry, error) {
	path := filepath.Join(root, "scripts", "evidence", "validation-gates.json")
	//nolint:gosec // repository-tracked policy file under the given root.
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read evidence policy %s: %w", path, err)
	}
	var registry evidenceRegistry
	if err := json.Unmarshal(data, &registry); err != nil {
		return nil, fmt.Errorf("evidence policy %s is not valid JSON: %w", path, err)
	}
	if registry.SchemaVersion != 1 {
		return nil, fmt.Errorf("evidence policy %s schemaVersion must be 1", path)
	}
	if len(registry.Gates) == 0 {
		return nil, fmt.Errorf("evidence policy %s declares no gates", path)
	}
	legs := make([]string, 0, len(registry.ExecutionMatrix))
	for _, leg := range registry.ExecutionMatrix {
		if leg.ID == "" {
			return nil, fmt.Errorf("evidence policy %s has an execution leg without an id", path)
		}
		legs = append(legs, leg.ID)
	}
	sort.Strings(legs)
	if len(legs) < 11 {
		return nil, fmt.Errorf("evidence policy %s must cover every release-train event leg", path)
	}
	return &registry, nil
}
