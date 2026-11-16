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

	"gopkg.in/yaml.v3"
)

// evidenceInvocation matches the verify-only CI entry point, the gate id, and
// the tracked proof profile. The profile may be a literal or a matrix
// reference; both are resolved against the tracked registry and the job's
// explicit matrix cells.
var evidenceInvocation = regexp.MustCompile(`scripts/evidence/verify-gate\.sh[ \t]+--gate[ \t]+([a-z0-9-]+)(?:[ \t]+--profile[ \t]+("[^"]*"|'[^']*'|[^ \t"']+))?`)

// forcedRunInvocation matches the one recorded execution path: the generated
// release delta smoke runs the registered commands for generated content that
// does not exist before release-please produces it.
var forcedRunInvocation = regexp.MustCompile(`validation_evidence\.py[ \t]+run[ \t]+--gate[ \t]+([a-z0-9-]+)[^\n]*--forced`)

var matrixProfileReference = regexp.MustCompile(`^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$`)

// evidenceWiringRequirement names the jobs whose evidence wiring is part of the
// operator-authorized execution policy. A job that loses its evidence entry
// point would silently re-execute the full workload; a job that gains one where
// it must always execute would silently turn a required safety gate into a
// claim.
type evidenceWiringRequirement struct {
	workflow string
	job      string
	gates    []string
	// forced means the job is an artifact-production smoke that always executes
	// on generated content and must therefore name the registered gate through
	// `run --forced`. Every other job must verify a tracked record instead, so a
	// given tested environment is proven once locally rather than executed in CI.
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
	{workflow: ciWorkflowPath, job: "runtime-floor-matrix", gates: []string{"ts", "py", "contract-tests"}},
	{workflow: ciWorkflowPath, job: "cdk-floor-matrix", gates: []string{"cdk-go-drift"}},
	{workflow: ".github/workflows/examples-local.yml", job: "examples-local", gates: []string{"examples-local"}},
}

// alwaysExecutingJobs must never carry an evidence entry point: they are the
// cheap release/security invariants whose whole value is running on the new
// commit, independent of any reusable proof.
var alwaysExecutingJobs = []string{"release-security-gates"}

// evidenceEntryPoint is the single verify-only entry point every evidence-aware
// CI job must use.
const evidenceEntryPoint = "scripts/evidence/verify-gate.sh"

type evidenceProfile struct {
	Environment struct {
		Go       string `json:"go"`
		Node     string `json:"node"`
		Python   string `json:"python"`
		Platform struct {
			OS   string `json:"os"`
			Arch string `json:"arch"`
		} `json:"platform"`
	} `json:"environment"`
}

type evidenceGate struct {
	Kind     string   `json:"kind"`
	Profiles []string `json:"profiles"`
	Commands []struct {
		ID   string   `json:"id"`
		Argv []string `json:"argv"`
	} `json:"commands"`
}

type evidenceRegistry struct {
	SchemaVersion     int    `json:"schemaVersion"`
	EvidenceDirectory string `json:"evidenceDirectory"`
	LocalLogDirectory string `json:"localLogDirectory"`
	// ProofProfiles is deliberately strict: every gate profile must resolve to a
	// tracked declaration whose environment the collector probes.
	ProofProfiles   map[string]evidenceProfile `json:"proofProfiles"`
	Gates           map[string]evidenceGate    `json:"gates"`
	ExecutionMatrix []struct {
		ID string `json:"id"`
	} `json:"executionMatrix"`
}

func (g evidenceGate) supportedProfiles() []string {
	if len(g.Profiles) == 0 {
		return []string{"default"}
	}
	return g.Profiles
}

func (g evidenceGate) supportsProfile(profile string) bool {
	for _, item := range g.supportedProfiles() {
		if item == profile {
			return true
		}
	}
	return false
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
	failures = append(failures, checkEvidenceWorkflowWiring(root, registry)...)
	failures = append(failures, checkAlwaysExecutingWiring(root)...)
	failures = append(failures, checkNoWorkflowGateExecution(root, registry)...)
	return failures
}

func checkEvidenceRegistry(registry *evidenceRegistry) []string {
	failures := checkRegistryDirectories(registry)
	failures = append(failures, checkRegistryGates(registry)...)
	failures = append(failures, checkRegistryProfiles(registry)...)
	failures = append(failures, checkRegistryCommands(registry)...)
	return failures
}

func checkRegistryDirectories(registry *evidenceRegistry) []string {
	var failures []string
	if got, want := registry.EvidenceDirectory, "gov-infra/evidence/proportionate"; got != want {
		failures = append(failures, fmt.Sprintf("evidence directory must stay %q, got %q", want, got))
	}
	if !strings.HasPrefix(registry.LocalLogDirectory+"/", registry.EvidenceDirectory+"/") {
		failures = append(failures, "local evidence logs must live under the dedicated evidence directory")
	}
	return failures
}

func checkRegistryGates(registry *evidenceRegistry) []string {
	var failures []string
	for _, gate := range []string{"rubric", "deterministic-builds", "go", "ts", "py", "contract-tests", "cdk-go-drift", "examples-local", "security-refresh", "release-delta"} {
		if _, ok := registry.Gates[gate]; !ok {
			failures = append(failures, fmt.Sprintf("tracked gate registry is missing %q", gate))
		}
	}
	if len(registry.ProofProfiles) == 0 {
		failures = append(failures, "tracked gate registry must declare proof profiles")
	}
	return failures
}

func checkRegistryProfiles(registry *evidenceRegistry) []string {
	var failures []string
	for profile, declaration := range registry.ProofProfiles {
		environment := declaration.Environment
		if environment.Go == "" || environment.Node == "" || environment.Python == "" ||
			environment.Platform.OS == "" || environment.Platform.Arch == "" {
			failures = append(failures, fmt.Sprintf("proof profile %q must declare go, node, python and platform", profile))
		}
	}
	for gateID, gate := range registry.Gates {
		for _, profile := range gate.supportedProfiles() {
			if _, ok := registry.ProofProfiles[profile]; !ok {
				failures = append(failures, fmt.Sprintf("gate %q supports undeclared proof profile %q", gateID, profile))
			}
		}
	}
	return failures
}

func checkRegistryCommands(registry *evidenceRegistry) []string {
	var failures []string
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

func checkEvidenceWorkflowWiring(root string, registry *evidenceRegistry) []string {
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
		failures = append(failures, checkJobEvidenceWiring(requirement, job, registry)...)
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

func checkJobEvidenceWiring(requirement evidenceWiringRequirement, job workflowJob, registry *evidenceRegistry) []string {
	var failures []string
	found := map[string]bool{}
	for _, step := range job.steps {
		if requirement.forced {
			failures = append(failures, checkForcedRunStep(requirement, step, registry, found)...)
			continue
		}
		if forcedRunInvocation.MatchString(step.run) {
			failures = append(failures, fmt.Sprintf(
				"job %q step %q executes a gate instead of verifying its record; only the generated release delta smoke may execute",
				requirement.job, step.name))
		}
		for _, match := range evidenceInvocation.FindAllStringSubmatch(step.run, -1) {
			gate := match[1]
			found[gate] = true
			gateDefinition, ok := registry.Gates[gate]
			if !ok {
				failures = append(failures, fmt.Sprintf(
					"job %q invokes unknown gate %q", requirement.job, gate))
				continue
			}
			profile := ""
			if len(match) > 2 {
				profile = match[2]
			}
			if profile == "" {
				failures = append(failures, fmt.Sprintf(
					"job %q step %q must name a tracked proof profile for gate %q (--profile)",
					requirement.job, step.name, gate))
				continue
			}
			failures = append(failures, checkProfileReference(requirement, job, gate, gateDefinition, profile, registry)...)
		}
	}
	for _, gate := range requirement.gates {
		if !found[gate] {
			failures = append(failures, fmt.Sprintf(
				"%s job %q must invoke %s for gate %s",
				requirement.workflow, requirement.job, evidenceEntryPoint, gate))
		}
	}
	return failures
}

// checkForcedRunStep pins the single execution path: a generated-delta smoke
// must run the registered gate through `validation_evidence.py run --forced`,
// which executes the approved command set and refuses nested proof. It must not
// route through the verification entry point, and it must not name a proof
// profile, because a generated-delta claim is never reusable evidence.
func checkForcedRunStep(
	requirement evidenceWiringRequirement,
	step workflowStep,
	registry *evidenceRegistry,
	found map[string]bool,
) []string {
	var failures []string
	if evidenceInvocation.MatchString(step.run) {
		failures = append(failures, fmt.Sprintf(
			"job %q step %q verifies evidence for gate %q; this is an artifact-production smoke that must execute",
			requirement.job, step.name, requirement.gates[0]))
	}
	for _, match := range forcedRunInvocation.FindAllStringSubmatch(step.run, -1) {
		gate := match[1]
		if _, ok := registry.Gates[gate]; !ok {
			failures = append(failures, fmt.Sprintf("job %q invokes unknown gate %q", requirement.job, gate))
			continue
		}
		for _, want := range requirement.gates {
			if gate == want {
				found[gate] = true
			}
		}
	}
	return failures
}

// checkProfileReference resolves a literal or matrix-driven profile against the
// tracked registry and the job's explicit matrix cells. A profile that is not
// declared, not supported by the gate, or not covered by every matrix cell
// fails closed, so a required context cannot silently degrade into a wildcard.
func checkProfileReference(
	requirement evidenceWiringRequirement,
	job workflowJob,
	gate string,
	gateDefinition evidenceGate,
	raw string,
	registry *evidenceRegistry,
) []string {
	var failures []string
	value := strings.Trim(raw, `"'`)
	if match := matrixProfileReference.FindStringSubmatch(value); match != nil {
		key := match[1]
		if len(job.matrixInclude) == 0 {
			failures = append(failures, fmt.Sprintf(
				"job %q references matrix.%s for gate %q but declares no explicit matrix.include cells",
				requirement.job, key, gate))
			return failures
		}
		for _, cell := range job.matrixInclude {
			profile, ok := cell[key]
			if !ok || profile == "" {
				failures = append(failures, fmt.Sprintf(
					"job %q matrix cell %v does not bind %q for gate %q", requirement.job, cell, key, gate))
				continue
			}
			failures = append(failures, checkLiteralProfile(requirement, gate, gateDefinition, profile, registry)...)
		}
		return failures
	}
	return append(failures, checkLiteralProfile(requirement, gate, gateDefinition, value, registry)...)
}

func checkLiteralProfile(
	requirement evidenceWiringRequirement,
	gate string,
	gateDefinition evidenceGate,
	profile string,
	registry *evidenceRegistry,
) []string {
	var failures []string
	if _, ok := registry.ProofProfiles[profile]; !ok {
		failures = append(failures, fmt.Sprintf(
			"job %q gate %q names undeclared proof profile %q", requirement.job, gate, profile))
	}
	if !gateDefinition.supportsProfile(profile) {
		failures = append(failures, fmt.Sprintf(
			"job %q gate %q names proof profile %q it does not support", requirement.job, gate, profile))
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

// registeredCommand is one approved command a tracked gate executes locally.
type registeredCommand struct {
	gate string
	text string
}

// checkNoWorkflowGateExecution fails closed when a workflow executes a
// registered gate command directly. A gate is verified once from a locally
// produced record; the only execution path in CI is the generated release delta
// smoke, which runs generated content that does not exist locally. A workflow
// that starts executing a gate again would restore the cost and the
// post-merge re-execution this policy removes, and the recorded force switch
// would turn verification back into an escape hatch.
func checkNoWorkflowGateExecution(root string, registry *evidenceRegistry) []string {
	files, err := listWorkflowFiles(root, defaultWorkflowsDir)
	if err != nil {
		return []string{err.Error()}
	}
	commands := registeredCommandTexts(registry)
	var failures []string
	for _, rel := range files {
		failures = append(failures,
			checkWorkflowTextForExecution(filepath.Join(root, filepath.FromSlash(rel)), rel, commands)...)
	}
	return failures
}

func registeredCommandTexts(registry *evidenceRegistry) []registeredCommand {
	var commands []registeredCommand
	for gateID, gate := range registry.Gates {
		for _, command := range gate.Commands {
			text := strings.Join(command.Argv, " ")
			if text == "" {
				continue
			}
			commands = append(commands, registeredCommand{gate: gateID, text: text})
		}
	}
	sort.Slice(commands, func(i, j int) bool { return commands[i].text < commands[j].text })
	return commands
}

func checkWorkflowTextForExecution(fullPath, rel string, commands []registeredCommand) []string {
	//nolint:gosec // the path is a repository workflow enumerated from the workflow directory.
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return []string{fmt.Sprintf("%s: %v", rel, err)}
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return []string{fmt.Sprintf("%s: %v", rel, err)}
	}
	var failures []string
	for _, text := range scalarTexts(&document) {
		if strings.Contains(text, "EVIDENCE_FORCE_EXECUTE") {
			failures = append(failures, fmt.Sprintf(
				"%s must not force gate execution through EVIDENCE_FORCE_EXECUTE; CI verifies a recorded result", rel))
		}
		if forcedRunInvocation.MatchString(text) {
			continue
		}
		for _, command := range commands {
			if strings.Contains(text, command.text) {
				failures = append(failures, fmt.Sprintf(
					"%s executes the %q gate command directly (%q); CI must verify the gate's record through %s instead",
					rel, command.gate, command.text, evidenceEntryPoint))
			}
		}
	}
	return failures
}

// scalarTexts collects every scalar string in a workflow document. Comments are
// not part of the node tree, so a documented example can never trip the check.
func scalarTexts(node *yaml.Node) []string {
	if node == nil {
		return nil
	}
	if node.Kind == yaml.ScalarNode {
		return []string{node.Value}
	}
	var texts []string
	for _, child := range node.Content {
		texts = append(texts, scalarTexts(child)...)
	}
	return texts
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
