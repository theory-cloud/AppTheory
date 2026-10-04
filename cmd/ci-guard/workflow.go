package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	// rubricCondition and buildsCondition are the only job conditions the
	// operator ruling of 2026-09-28 allows: the full rubric and the
	// deterministic-build job run for pull requests targeting staging plus the
	// opt-in manual dispatch, and nowhere else.
	rubricCondition = "(github.event_name == 'workflow_dispatch' && (inputs.run_full_rubric == true || inputs.run_full_rubric == 'true')) || (github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging')"
	buildsCondition = "github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging'"

	// eligibilityCondition is the staging release-eligibility gate: it must keep
	// the push-to-staging leg as well as the pull-request-to-staging leg,
	// because the merged staging SHA is a path that can promote code (R-F1).
	eligibilityCondition = "(github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'staging') || (github.event_name == 'push' && github.ref == 'refs/heads/staging')"

	stagingBranch = "staging"
	premainBranch = "premain"
	mainBranch    = "main"
	otherBaseRef  = "other-base"
	otherHeadRef  = "other-head"

	prMergeRef     = "refs/pull/1/merge"
	pushRefPrefix  = "refs/heads/"
	dispatchRef    = "refs/heads/dispatch-unknown"
	prereleaseID   = "prerelease-readiness"
	eligibilityID  = "staging-release-eligibility"
	maxDispatchIns = 3

	// ciWorkflowPath is the workflow the repository gates on; it carries the
	// staging rubric and deterministic-build jobs whose conditions are pinned.
	ciWorkflowPath = ".github/workflows/ci.yml"

	// defaultWorkflowsDir is the directory scanned for every workflow file, so a
	// new workflow with a push/pull_request trigger cannot gate silently: it
	// must be classified, or be one of the justified non-gating publishers.
	defaultWorkflowsDir = ".github/workflows"

	// maxCalleeDepth bounds reusable-workflow (`uses: ./...`) nesting so a
	// cyclic or runaway chain fails closed instead of recursing forever.
	maxCalleeDepth = 4
)

var protectedBranches = []string{stagingBranch, premainBranch, mainBranch}

// baseDomain and headDomain enumerate the pull_request shapes the classifier
// distinguishes: the protected branches, the generated release-please source
// branches, and one catch-all value per context.
var baseDomain = []string{stagingBranch, premainBranch, mainBranch, otherBaseRef}

var headDomain = []string{
	stagingBranch,
	premainBranch,
	mainBranch,
	"release-please--branches--premain",
	"release-please--branches--main",
	otherHeadRef,
}

// publisherExemption records a workflow that runs on a push but gates nothing
// (it publishes or deploys), so it needs no pull-request-to-staging equivalent.
// An exemption is only valid while the workflow keeps a publisher trigger set:
// the moment it declares a pull_request trigger it gates PRs and must be
// classified like every other workflow.
type publisherExemption struct {
	path   string
	reason string
}

var publisherExemptions = []publisherExemption{
	{
		path:   ".github/workflows/pages.yml",
		reason: "GitHub Pages docs build + deploy; a failure publishes nothing and gates no merge or promotion",
	},
	{
		path:   ".github/workflows/theorycloud-apptheory-subtree-publish.yml",
		reason: "publishes the docs subtree to the TheoryCloud docs repo; deploy-only, gates no merge or promotion",
	},
	{
		path:   ".github/workflows/prerelease.yml",
		reason: "release-please prerelease publisher; the pre-merge half of its checks runs on PRs to staging",
	},
	{
		path:   ".github/workflows/release.yml",
		reason: "release-please stable publisher; the pre-merge half of its checks runs on PRs to staging",
	},
	{
		path:   ".github/workflows/prerelease-pr.yml",
		reason: "generated release-candidate PR producer; cannot gate the hand-authored PR lane it serves",
	},
	{
		path:   ".github/workflows/release-pr.yml",
		reason: "generated stable PR producer; cannot gate the hand-authored PR lane it serves",
	},
}

// publisherTriggers are the triggers an exempt non-gating publisher may
// declare. Anything else fails closed: an unmodeled trigger could hide a
// gating path behind an exemption.
var publisherTriggers = map[string]bool{
	"push":              true,
	"workflow_dispatch": true,
	"workflow_call":     true,
}

type triggerContext struct {
	hasPush        bool
	pushBranches   []string
	hasPullRequest bool
	hasDispatch    bool
}

type workflowFile struct {
	path            string
	triggers        []string
	ctx             triggerContext
	hasWorkflowCall bool
	jobs            []workflowJob
}

type workflowStep struct {
	name   string
	hasIf  bool
	ifText string
	run    string
	env    map[string]string
	line   int
}

type workflowJob struct {
	id     string
	name   string
	ifText string
	hasIf  bool
	needs  []string
	uses   string
	steps  []workflowStep
}

type jobClass struct {
	id       string
	name     string
	hasIf    bool
	ifText   string
	pushRefs []string
	prBases  map[string]bool
	prAny    bool
	dispatch bool
}

type classifiedJob struct {
	id    string
	class *jobClass
	def   workflowJob
}

func runWorkflowTriggers(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("workflow-triggers", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "repository root")
	workflowsDir := flags.String("workflows-dir", defaultWorkflowsDir, "workflow directory relative to root")
	if err := flags.Parse(args); err != nil {
		return exitBlocked
	}

	result, err := evaluateWorkflowDirectory(*root, *workflowsDir)
	if err != nil {
		writeString(stderr, fmt.Sprintf("ci-trigger-parity: FAIL (%v)\n", err))
		return exitFail
	}
	if len(result.failures) > 0 {
		writeString(stderr, "ci-trigger-parity: FAIL\n")
		for _, failure := range result.failures {
			writeString(stderr, fmt.Sprintf("- %s\n", failure))
		}
		return exitFail
	}
	writeString(stdout, fmt.Sprintf("ci-trigger-parity: PASS (%d workflow files scanned, %d classified, %d jobs classified by effective triggers)\n",
		result.scanned, result.classified, result.jobs))
	return exitPass
}

type directoryResult struct {
	failures   []string
	scanned    int
	classified int
	jobs       int
}

func evaluateWorkflowDirectory(root, workflowsDir string) (directoryResult, error) {
	files, err := listWorkflowFiles(root, workflowsDir)
	if err != nil {
		return directoryResult{}, err
	}
	result := directoryResult{scanned: len(files)}
	seen := map[string]bool{}
	ciSeen := false
	for _, rel := range files {
		seen[rel] = true
		file := evaluateWorkflowFile(root, rel)
		result.failures = append(result.failures, file.failures...)
		result.classified += file.classified
		result.jobs += file.jobs
		ciSeen = ciSeen || file.isCI
	}
	if !ciSeen {
		result.failures = append(result.failures, fmt.Sprintf("the workflow directory must contain %s; the pinned rubric/builds/eligibility conditions are checked there", ciWorkflowPath))
	}
	result.failures = append(result.failures, checkPublisherExemptionsExist(seen)...)
	return result, nil
}

func listWorkflowFiles(root, workflowsDir string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(workflowsDir)))
	if err != nil {
		return nil, fmt.Errorf("cannot read workflow directory %s: %w", workflowsDir, err)
	}
	var files []string
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".yml") && !strings.HasSuffix(name, ".yaml") {
			continue
		}
		files = append(files, path.Join(workflowsDir, name))
	}
	sort.Strings(files)
	if len(files) == 0 {
		return nil, fmt.Errorf("no workflow files found in %s", workflowsDir)
	}
	return files, nil
}

type fileResult struct {
	failures   []string
	classified int
	jobs       int
	isCI       bool
}

// evaluateWorkflowFile accounts for one workflow file: an explicit non-gating
// publisher exemption is validated but not classified, a reusable-only workflow
// is validated and classified where it is called, and anything else is
// classified like ci.yml.
func evaluateWorkflowFile(root, rel string) fileResult {
	full := filepath.Join(root, filepath.FromSlash(rel))
	if exemption, ok := findPublisherExemption(rel); ok {
		if err := checkPublisherWorkflow(full, rel, exemption); err != nil {
			return fileResult{failures: []string{err.Error()}}
		}
		return fileResult{}
	}
	wf, err := loadWorkflow(full, rel)
	if err != nil {
		return fileResult{failures: []string{err.Error()}}
	}
	if isReusableOnly(wf) {
		return fileResult{}
	}
	jobs, err := classifyWorkflow(root, wf, wf.ctx, "", 0)
	if err != nil {
		return fileResult{failures: []string{err.Error()}}
	}
	result := fileResult{classified: 1, jobs: len(jobs), isCI: rel == ciWorkflowPath}
	result.failures = append(result.failures, checkParity(jobs)...)
	if result.isCI {
		result.failures = append(result.failures, checkExactConditions(jobs)...)
		result.failures = append(result.failures, checkBackmergeExemption(jobs)...)
		result.failures = append(result.failures, checkExemptionsAreLive(jobs)...)
		result.failures = append(result.failures, checkCanary(jobs)...)
		result.failures = append(result.failures, checkUnconditionalSteps(jobs)...)
	}
	return result
}

func checkPublisherExemptionsExist(seen map[string]bool) []string {
	var failures []string
	for _, exemption := range publisherExemptions {
		if !seen[exemption.path] {
			failures = append(failures, fmt.Sprintf("publisher exemption for %q is stale: the workflow no longer exists", exemption.path))
		}
	}
	return failures
}

func isReusableOnly(wf *workflowFile) bool {
	return wf.hasWorkflowCall && !wf.ctx.hasPush && !wf.ctx.hasPullRequest && !wf.ctx.hasDispatch
}

func findPublisherExemption(rel string) (*publisherExemption, bool) {
	for i := range publisherExemptions {
		if publisherExemptions[i].path == rel {
			return &publisherExemptions[i], true
		}
	}
	return nil, false
}

// checkPublisherWorkflow parses an exempt non-gating publisher and fails closed
// when it stops looking like one: a pull_request trigger makes it a gate on the
// PR lane, and an unmodeled trigger could hide one.
func checkPublisherWorkflow(fullPath, rel string, exemption *publisherExemption) error {
	//nolint:gosec // the path is a repository workflow enumerated from the workflow directory.
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return fmt.Errorf("%s: %w", rel, err)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return fmt.Errorf("%s: %w", rel, err)
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) != 1 {
		return fmt.Errorf("%s: expected exactly one YAML document", rel)
	}
	rootNode := document.Content[0]
	if rootNode.Kind != yaml.MappingNode {
		return fmt.Errorf("%s: workflow root must be a mapping", rel)
	}
	if err := rejectUnmodeledNodes(rootNode, rel); err != nil {
		return err
	}
	onNode, ok := mapLookup(rootNode, "on")
	if !ok {
		return fmt.Errorf("%s: publisher workflow must declare an on: trigger block", rel)
	}
	if onNode.Kind != yaml.MappingNode {
		return fmt.Errorf("%s: on: must be a mapping for a publisher workflow", rel)
	}
	for i := 0; i+1 < len(onNode.Content); i += 2 {
		key := onNode.Content[i]
		if key.Kind != yaml.ScalarNode {
			return fmt.Errorf("%s: on: trigger names must be scalars", rel)
		}
		if key.Value == "pull_request" || key.Value == "pull_request_target" {
			return fmt.Errorf("%s is a non-gating publisher exemption (%s) but declares a %s trigger; a workflow that gates pull requests must be classified, not exempted",
				rel, exemption.reason, key.Value)
		}
		if !publisherTriggers[key.Value] {
			return fmt.Errorf("%s: on: trigger %q is not modeled for a non-gating publisher exemption", rel, key.Value)
		}
	}
	return nil
}

func loadWorkflow(fullPath, rel string) (*workflowFile, error) {
	//nolint:gosec // the path is the repository workflow under guard, not user input.
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", rel, err)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("%s: %w", rel, err)
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) != 1 {
		return nil, fmt.Errorf("%s: expected exactly one YAML document", rel)
	}
	rootNode := document.Content[0]
	if rootNode.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s: workflow root must be a mapping", rel)
	}
	if err := rejectUnmodeledNodes(rootNode, rel); err != nil {
		return nil, err
	}

	workflow := &workflowFile{path: rel}
	onNode, ok := mapLookup(rootNode, "on")
	if !ok {
		return nil, fmt.Errorf("%s: workflow must declare an on: trigger block", rel)
	}
	if err := workflow.parseTriggers(onNode); err != nil {
		return nil, fmt.Errorf("%s: %w", rel, err)
	}
	jobsNode, ok := mapLookup(rootNode, "jobs")
	if !ok {
		return nil, fmt.Errorf("%s: workflow must declare jobs", rel)
	}
	if jobsNode.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s: jobs must be a mapping", rel)
	}
	for i := 0; i+1 < len(jobsNode.Content); i += 2 {
		job, err := parseWorkflowJob(jobsNode.Content[i], jobsNode.Content[i+1])
		if err != nil {
			return nil, fmt.Errorf("%s: %w", rel, err)
		}
		workflow.jobs = append(workflow.jobs, job)
	}
	if len(workflow.jobs) == 0 {
		return nil, fmt.Errorf("%s: workflow declares no jobs", rel)
	}
	return workflow, nil
}

func (wf *workflowFile) parseTriggers(node *yaml.Node) error {
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("on: must be a mapping of triggers this classifier models")
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key, value := node.Content[i], node.Content[i+1]
		if key.Kind != yaml.ScalarNode {
			return fmt.Errorf("on: trigger names must be scalars")
		}
		wf.triggers = append(wf.triggers, key.Value)
		if err := wf.parseTrigger(key.Value, value); err != nil {
			return err
		}
	}
	if !wf.ctx.hasPush && !wf.ctx.hasPullRequest && !wf.ctx.hasDispatch && !wf.hasWorkflowCall {
		return fmt.Errorf("on: declares no modeled trigger")
	}
	return nil
}

// parseTrigger records one `on:` entry. Every trigger the classifier does not
// model is an error, so an unmodelled trigger fails closed rather than being
// ignored.
func (wf *workflowFile) parseTrigger(name string, value *yaml.Node) error {
	switch name {
	case "push":
		wf.ctx.hasPush = true
		branches, err := parsePushTrigger(value)
		if err != nil {
			return err
		}
		wf.ctx.pushBranches = branches
		return nil
	case "pull_request":
		wf.ctx.hasPullRequest = true
		return parsePullRequestTrigger(value)
	case "workflow_dispatch":
		wf.ctx.hasDispatch = true
		return parseDispatchTrigger(value)
	case "workflow_call":
		wf.hasWorkflowCall = true
		return parseWorkflowCallTrigger(value)
	default:
		return fmt.Errorf("on: trigger %q is not modeled by the parity classifier", name)
	}
}

func parsePushTrigger(node *yaml.Node) ([]string, error) {
	if isNullNode(node) {
		return nil, fmt.Errorf("push: trigger must enumerate the branches it runs on")
	}
	if node.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("push: trigger must be a mapping")
	}
	var branches []string
	for i := 0; i+1 < len(node.Content); i += 2 {
		key := node.Content[i].Value
		if key != "branches" {
			return nil, fmt.Errorf("push: key %q is not modeled; a filter there could hide a protected branch", key)
		}
		values, err := scalarSequence(node.Content[i+1])
		if err != nil {
			return nil, fmt.Errorf("push: branches %w", err)
		}
		branches = values
	}
	if len(branches) == 0 {
		return nil, fmt.Errorf("push: trigger must enumerate the branches it runs on")
	}
	for _, branch := range protectedBranches {
		if !containsString(branches, branch) {
			return nil, fmt.Errorf("push: trigger must include the protected branch %q", branch)
		}
	}
	return branches, nil
}

func parsePullRequestTrigger(node *yaml.Node) error {
	if isNullNode(node) {
		return nil
	}
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("pull_request: trigger must be a mapping")
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key := node.Content[i].Value
		if key != "types" {
			return fmt.Errorf("pull_request: key %q is not modeled; a filter there could hide the staging pull request", key)
		}
		values, err := scalarSequence(node.Content[i+1])
		if err != nil {
			return fmt.Errorf("pull_request: types %w", err)
		}
		for _, required := range []string{"opened", "synchronize"} {
			if !containsString(values, required) {
				return fmt.Errorf("pull_request: types must include %q so a staging pull request is re-checked", required)
			}
		}
	}
	return nil
}

func parseDispatchTrigger(node *yaml.Node) error {
	if isNullNode(node) {
		return nil
	}
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("workflow_dispatch: trigger must be a mapping")
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key := node.Content[i].Value
		if key != "inputs" {
			return fmt.Errorf("workflow_dispatch: key %q is not modeled", key)
		}
	}
	return nil
}

func parseWorkflowCallTrigger(node *yaml.Node) error {
	if isNullNode(node) {
		return nil
	}
	if node.Kind != yaml.MappingNode {
		return fmt.Errorf("workflow_call: trigger must be a mapping")
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key := node.Content[i].Value
		if key != "inputs" && key != "secrets" && key != "outputs" {
			return fmt.Errorf("workflow_call: key %q is not modeled", key)
		}
	}
	return nil
}

func parseWorkflowJob(idNode, body *yaml.Node) (workflowJob, error) {
	if idNode.Kind != yaml.ScalarNode {
		return workflowJob{}, fmt.Errorf("job ids must be scalars")
	}
	job := workflowJob{id: idNode.Value, name: idNode.Value}
	if body.Kind != yaml.MappingNode {
		return workflowJob{}, fmt.Errorf("job %q must be a mapping", job.id)
	}
	for i := 0; i+1 < len(body.Content); i += 2 {
		if err := applyJobField(&job, body.Content[i].Value, body.Content[i+1]); err != nil {
			return workflowJob{}, err
		}
	}
	return job, nil
}

func applyJobField(job *workflowJob, key string, value *yaml.Node) error {
	switch key {
	case "name":
		if value.Kind == yaml.ScalarNode {
			job.name = value.Value
		}
	case "if":
		condition, err := parseJobCondition(value, job.id)
		if err != nil {
			return err
		}
		job.ifText = condition
		job.hasIf = true
	case "needs":
		needs, err := scalarList(value)
		if err != nil {
			return fmt.Errorf("job %q needs: %w", job.id, err)
		}
		job.needs = needs
	case "uses":
		if value.Kind != yaml.ScalarNode {
			return fmt.Errorf("job %q uses: must be a scalar", job.id)
		}
		job.uses = value.Value
	case "steps":
		steps, err := parseSteps(value)
		if err != nil {
			return fmt.Errorf("job %q: %w", job.id, err)
		}
		job.steps = steps
	}
	return nil
}

// parseJobCondition reads a job-level if:. A literal or folded block scalar is
// rejected: its continuation form is not modeled and could hide a clause.
func parseJobCondition(value *yaml.Node, jobID string) (string, error) {
	if value.Kind != yaml.ScalarNode {
		return "", fmt.Errorf("job %q if: must be a scalar expression", jobID)
	}
	if value.Style == yaml.LiteralStyle || value.Style == yaml.FoldedStyle {
		return "", fmt.Errorf("job %q uses a %s if: block; continuation forms are not modeled", jobID, styleName(value.Style))
	}
	return value.Value, nil
}

func parseSteps(node *yaml.Node) ([]workflowStep, error) {
	if isNullNode(node) {
		return nil, nil
	}
	if node.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("steps must be a sequence")
	}
	var steps []workflowStep
	for _, item := range node.Content {
		if item.Kind != yaml.MappingNode {
			return nil, fmt.Errorf("every step must be a mapping")
		}
		step := workflowStep{line: item.Line}
		for i := 0; i+1 < len(item.Content); i += 2 {
			if err := applyStepField(&step, item.Content[i].Value, item.Content[i+1]); err != nil {
				return nil, err
			}
		}
		if step.name == "" {
			step.name = fmt.Sprintf("step at line %d", item.Line)
		}
		steps = append(steps, step)
	}
	return steps, nil
}

// applyStepField records one step field the guard models, mirroring
// applyJobField. An unmodeled field is ignored; a modeled field in a form the
// guard cannot read fails closed rather than being skipped.
func applyStepField(step *workflowStep, key string, value *yaml.Node) error {
	switch key {
	case "name":
		if value.Kind == yaml.ScalarNode {
			step.name = value.Value
		}
	case "if":
		if value.Kind != yaml.ScalarNode {
			return fmt.Errorf("step if: must be a scalar expression")
		}
		if value.Style == yaml.LiteralStyle || value.Style == yaml.FoldedStyle {
			return fmt.Errorf("step if: uses a %s block; continuation forms are not modeled", styleName(value.Style))
		}
		step.ifText = value.Value
		step.hasIf = true
	case "run":
		if value.Kind != yaml.ScalarNode {
			return fmt.Errorf("step run: must be a scalar script")
		}
		step.run = value.Value
	case "env":
		env, err := parseStepEnv(value)
		if err != nil {
			return err
		}
		step.env = env
	}
	return nil
}

// parseStepEnv reads a step env: block into a name -> value map. A non-scalar
// value fails closed: only a literal binding is modeled, so an expression the
// guard cannot read can never be mistaken for a pinned one.
func parseStepEnv(node *yaml.Node) (map[string]string, error) {
	if isNullNode(node) {
		return nil, nil
	}
	if node.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("step env: must be a mapping")
	}
	env := map[string]string{}
	for i := 0; i+1 < len(node.Content); i += 2 {
		key := node.Content[i]
		if key.Kind != yaml.ScalarNode {
			return nil, fmt.Errorf("step env: names must be scalars")
		}
		value := node.Content[i+1]
		if value.Kind != yaml.ScalarNode {
			return nil, fmt.Errorf("step env: %q must bind a scalar value", key.Value)
		}
		env[key.Value] = value.Value
	}
	return env, nil
}

func scalarList(node *yaml.Node) ([]string, error) {
	if node.Kind == yaml.ScalarNode {
		if node.Value == "" {
			return nil, fmt.Errorf("must name at least one job")
		}
		return []string{node.Value}, nil
	}
	values, err := scalarSequence(node)
	if err != nil {
		return nil, err
	}
	if len(values) == 0 {
		return nil, fmt.Errorf("must name at least one job")
	}
	return values, nil
}

func rejectUnmodeledNodes(node *yaml.Node, rel string) error {
	if node.Kind == yaml.AliasNode {
		return fmt.Errorf("%s: YAML aliases are not modeled; spell every job out", rel)
	}
	if node.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i+1 < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Kind != yaml.ScalarNode {
				continue
			}
			if key.Value == "<<" {
				return fmt.Errorf("%s: YAML merge keys are not modeled", rel)
			}
			if seen[key.Value] {
				return fmt.Errorf("%s: duplicate mapping key %q is not modeled", rel, key.Value)
			}
			seen[key.Value] = true
		}
	}
	for _, child := range node.Content {
		if err := rejectUnmodeledNodes(child, rel); err != nil {
			return err
		}
	}
	return nil
}

// classifyWorkflow classifies every job of a workflow in the trigger context it
// actually runs in. For a reusable workflow reached through `uses:`, that
// context is the caller's, so a promotion-only job inside a callee cannot hide
// behind the callee file's own (absent) triggers.
func classifyWorkflow(root string, wf *workflowFile, ctx triggerContext, prefix string, depth int) ([]classifiedJob, error) {
	if depth > maxCalleeDepth {
		return nil, fmt.Errorf("%s: reusable-workflow nesting exceeds %d levels", wf.path, maxCalleeDepth)
	}
	if err := validateNeedsTargets(wf); err != nil {
		return nil, err
	}
	own, err := resolveJobClasses(ctx, wf, prefix)
	if err != nil {
		return nil, err
	}
	nested, err := classifyCallees(root, wf, ctx, prefix, depth)
	if err != nil {
		return nil, err
	}
	return append(own, nested...), nil
}

func validateNeedsTargets(wf *workflowFile) error {
	ids := map[string]bool{}
	for _, job := range wf.jobs {
		ids[job.id] = true
	}
	for _, job := range wf.jobs {
		for _, need := range job.needs {
			if !ids[need] {
				return fmt.Errorf("%s: job %q needs %q, which is not a job in this workflow", wf.path, job.id, need)
			}
		}
	}
	return nil
}

// jobResolver classifies a workflow's own jobs, resolving `needs:` in
// dependency order: a job is held back until every job it needs has a class,
// and a pass that makes no progress is a `needs:` cycle.
type jobResolver struct {
	ctx      triggerContext
	wf       *workflowFile
	prefix   string
	resolved map[string]*jobClass
	out      []classifiedJob
}

func resolveJobClasses(ctx triggerContext, wf *workflowFile, prefix string) ([]classifiedJob, error) {
	resolver := &jobResolver{ctx: ctx, wf: wf, prefix: prefix, resolved: map[string]*jobClass{}}
	remaining := wf.jobs
	for len(remaining) > 0 {
		deferred, progressed, err := resolver.resolvePass(remaining)
		if err != nil {
			return nil, err
		}
		if !progressed {
			return nil, fmt.Errorf("%s: needs: cycle among %s", wf.path, strings.Join(jobIDs(remaining), ", "))
		}
		remaining = deferred
	}
	return resolver.out, nil
}

func (r *jobResolver) resolvePass(jobs []workflowJob) ([]workflowJob, bool, error) {
	var deferred []workflowJob
	progressed := false
	for _, job := range jobs {
		if !r.needsResolved(job) {
			deferred = append(deferred, job)
			continue
		}
		class, err := r.classify(job)
		if err != nil {
			return nil, false, err
		}
		r.resolved[job.id] = class
		r.out = append(r.out, classifiedJob{id: r.prefix + job.id, class: class, def: job})
		progressed = true
	}
	return deferred, progressed, nil
}

func (r *jobResolver) needsResolved(job workflowJob) bool {
	for _, need := range job.needs {
		if _, ok := r.resolved[need]; !ok {
			return false
		}
	}
	return true
}

func (r *jobResolver) classify(job workflowJob) (*jobClass, error) {
	class, hasAlways, err := classifyJob(r.ctx, job)
	if err != nil {
		return nil, err
	}
	if len(job.needs) == 0 || hasAlways {
		return class, nil
	}
	for _, need := range job.needs {
		class = intersectClasses(class, r.resolved[need])
	}
	return class, nil
}

func classifyCallees(root string, wf *workflowFile, ctx triggerContext, prefix string, depth int) ([]classifiedJob, error) {
	var out []classifiedJob
	for _, job := range wf.jobs {
		if job.uses == "" {
			continue
		}
		nested, err := classifyCallee(root, wf, ctx, prefix, depth, job)
		if err != nil {
			return nil, err
		}
		out = append(out, nested...)
	}
	return out, nil
}

func classifyCallee(root string, wf *workflowFile, ctx triggerContext, prefix string, depth int, job workflowJob) ([]classifiedJob, error) {
	calleeRel, ok := localCalleePath(job.uses)
	if !ok {
		return nil, fmt.Errorf("%s: job %q uses %q; only a local reusable workflow (./.github/workflows/<name>.yml) can be classified, so a remote reusable workflow is not modeled", wf.path, job.id, job.uses)
	}
	callee, err := loadWorkflow(filepath.Join(root, filepath.FromSlash(calleeRel)), calleeRel)
	if err != nil {
		return nil, err
	}
	if !callee.hasWorkflowCall {
		return nil, fmt.Errorf("%s: job %q calls %s, which does not declare on: workflow_call", wf.path, job.id, calleeRel)
	}
	return classifyWorkflow(root, callee, ctx, prefix+path.Base(calleeRel)+":", depth+1)
}

func jobIDs(jobs []workflowJob) []string {
	ids := make([]string, 0, len(jobs))
	for _, job := range jobs {
		ids = append(ids, job.id)
	}
	return ids
}

func localCalleePath(uses string) (string, bool) {
	if !strings.HasPrefix(uses, "./.github/workflows/") {
		return "", false
	}
	rest := strings.TrimPrefix(uses, "./")
	if rest == "" || strings.Contains(rest, "@") || strings.Contains(rest, "..") {
		return "", false
	}
	if !strings.HasSuffix(rest, ".yml") && !strings.HasSuffix(rest, ".yaml") {
		return "", false
	}
	return rest, true
}

func classifyJob(ctx triggerContext, job workflowJob) (*jobClass, bool, error) {
	class := &jobClass{id: job.id, name: job.name, hasIf: job.hasIf, ifText: job.ifText, prBases: map[string]bool{}}
	if !job.hasIf {
		if ctx.hasPush {
			class.pushRefs = append([]string{}, ctx.pushBranches...)
		}
		if ctx.hasPullRequest {
			for _, base := range baseDomain {
				class.prBases[base] = true
			}
			class.prAny = true
		}
		class.dispatch = ctx.hasDispatch
		return class, false, nil
	}

	condition, err := parseCondition(job.ifText)
	if err != nil {
		return nil, false, fmt.Errorf("job %q: %w", job.id, err)
	}
	hasAlways := containsAlways(condition)
	if ctx.hasPush {
		if class.pushRefs, err = classifyPush(condition, ctx.pushBranches, job.id); err != nil {
			return nil, false, err
		}
	}
	if ctx.hasPullRequest {
		if err := classifyPullRequest(condition, class, job.id); err != nil {
			return nil, false, err
		}
	}
	if ctx.hasDispatch {
		if err := classifyDispatch(condition, class, job); err != nil {
			return nil, false, err
		}
	}
	return class, hasAlways, nil
}

func classifyPush(condition expr, pushBranches []string, jobID string) ([]string, error) {
	refs := map[string]bool{}
	for _, branch := range uniqueStrings(pushBranches) {
		ok, err := condition.eval(state{event: "push", ref: pushRefPrefix + branch})
		if err != nil {
			return nil, fmt.Errorf("job %q: %w", jobID, err)
		}
		if ok {
			refs[branch] = true
		}
	}
	return sortedKeys(refs), nil
}

func classifyPullRequest(condition expr, class *jobClass, jobID string) error {
	for _, base := range baseDomain {
		for _, head := range headDomain {
			if head == base {
				// A same-repository pull request cannot originate from the
				// branch it targets, so the classifier does not invent that
				// state: a job gated only on `head.ref == '<branch>'` must not
				// read as running on a pull request to that branch.
				continue
			}
			for _, draft := range []string{"false", "true"} {
				ok, err := condition.eval(state{event: "pull_request", ref: prMergeRef, base: base, head: head, draft: draft})
				if err != nil {
					return fmt.Errorf("job %q: %w", jobID, err)
				}
				if ok {
					class.prBases[base] = true
					class.prAny = true
				}
			}
		}
	}
	return nil
}

func classifyDispatch(condition expr, class *jobClass, job workflowJob) error {
	combinations, err := inputCombinations(referencedInputs(job.ifText))
	if err != nil {
		return fmt.Errorf("job %q: %w", job.id, err)
	}
	for _, inputs := range combinations {
		ok, err := condition.eval(state{event: "workflow_dispatch", ref: dispatchRef, inputs: inputs})
		if err != nil {
			return fmt.Errorf("job %q: %w", job.id, err)
		}
		if ok {
			class.dispatch = true
		}
	}
	return nil
}

// intersectClasses narrows a job's effective triggers to the states in which a
// job it needs can run: with a `needs:` edge, a job whose dependency is
// promotion-only can only ever run on the promotion lane, whatever its own
// condition says (the SAN-AT1073-R1-F2 bypass). `if: always()` is the one
// spelling that makes the dependent independent of its needs' outcomes.
func intersectClasses(class, needed *jobClass) *jobClass {
	merged := &jobClass{
		id:      class.id,
		name:    class.name,
		hasIf:   class.hasIf,
		ifText:  class.ifText,
		prBases: map[string]bool{},
	}
	neededRefs := map[string]bool{}
	for _, ref := range needed.pushRefs {
		neededRefs[ref] = true
	}
	for _, ref := range class.pushRefs {
		if neededRefs[ref] {
			merged.pushRefs = append(merged.pushRefs, ref)
		}
	}
	for base, ok := range class.prBases {
		if ok && needed.prBases[base] {
			merged.prBases[base] = true
		}
	}
	merged.prAny = class.prAny && needed.prAny
	merged.dispatch = class.dispatch && needed.dispatch
	return merged
}

func checkParity(jobs []classifiedJob) []string {
	failures := checkPushParity(jobs)
	failures = append(failures, checkPromotionParity(jobs)...)
	return failures
}

func checkPushParity(jobs []classifiedJob) []string {
	var failures []string
	for _, job := range jobs {
		class := job.class
		if len(class.pushRefs) > 0 && !class.prBases[stagingBranch] {
			failures = append(failures, fmt.Sprintf(
				"job %q (%s) can run on a push (%s) but not on a pull request to staging (R-F1 push parity)",
				job.id, class.name, strings.Join(class.pushRefs, ", ")))
		}
	}
	return failures
}

func checkPromotionParity(jobs []classifiedJob) []string {
	var failures []string
	for _, job := range jobs {
		class := job.class
		if !isPromotionOnly(class) {
			continue
		}
		if exemption := findPromotionExemption(class.id); exemption != nil {
			continue
		}
		failures = append(failures, fmt.Sprintf(
			"job %q (%s) runs only on promotion pull requests (%s) with no pull-request-to-staging equivalent; add one or record a justified exception",
			job.id, class.name, strings.Join(promotionBases(class), ", ")))
	}
	return failures
}

// parityExemption records a promotion-only job whose pull-request-to-staging
// equivalent is a different job. Every entry must carry a reason and keep a
// live counterpart; a stale entry fails the guard.
type parityExemption struct {
	job         string
	counterpart string
	reason      string
}

var promotionParityExemptions = []parityExemption{
	{
		job:         prereleaseID,
		counterpart: eligibilityID,
		reason:      "promotion-edge release-eligibility gate; the staging lane runs the same predicate through " + eligibilityID,
	},
}

func checkExemptionsAreLive(jobs []classifiedJob) []string {
	classes := classIndex(jobs)
	var failures []string
	for _, exemption := range promotionParityExemptions {
		class, ok := classes[exemption.job]
		if !ok {
			failures = append(failures, fmt.Sprintf("parity exemption for %q is stale: the job is gone", exemption.job))
			continue
		}
		if !isPromotionOnly(class) {
			failures = append(failures, fmt.Sprintf("parity exemption for %q is stale: the job no longer runs only on promotion pull requests", exemption.job))
			continue
		}
		counterpart, ok := classes[exemption.counterpart]
		if !ok {
			failures = append(failures, fmt.Sprintf("job %q is exempt from R-F1 parity but its counterpart %q is missing", exemption.job, exemption.counterpart))
			continue
		}
		if !counterpart.prBases[stagingBranch] {
			failures = append(failures, fmt.Sprintf("job %q is exempt from R-F1 parity but its counterpart %q does not run on pull requests to staging", exemption.job, exemption.counterpart))
		}
	}
	return failures
}

// checkExactConditions pins the conditions of the jobs whose trigger set the
// operator ruling fixes: the rubric and deterministic builds are staging-
// pull-request-only, and the staging release-eligibility gate must keep both
// its pull-request-to-staging and push-to-staging legs (ADV-1073-R1-01: a
// semantically weaker push-leg removal must not pass).
func checkExactConditions(jobs []classifiedJob) []string {
	classes := classIndex(jobs)
	expected := []struct {
		id          string
		condition   string
		description string
	}{
		{"rubric", rubricCondition, "staging-pull-request-only"},
		{"builds", buildsCondition, "staging-pull-request-only"},
		{eligibilityID, eligibilityCondition, "pull-request-to-staging-plus-push-to-staging"},
	}
	var failures []string
	for _, want := range expected {
		class, ok := classes[want.id]
		if !ok {
			failures = append(failures, fmt.Sprintf("workflow must define the %q job", want.id))
			continue
		}
		if !class.hasIf || normalizeExpression(class.ifText) != normalizeExpression(want.condition) {
			failures = append(failures, fmt.Sprintf(
				"job %q must be %s; its if: must equal %q exactly (got %q)",
				want.id, want.description, normalizeExpression(want.condition), normalizeExpression(class.ifText)))
		}
	}
	return failures
}

// backmergeOptInFlag is the flag the staging eligibility step passes to
// scripts/verify-release-eligibility.sh to enable the post-release main
// back-merge exemption. That exemption is the only path that can pass a range
// holding no release-driving commit, so the guard pins exactly how it is wired.
const backmergeOptInFlag = "--allow-main-backmerge"

// eligibilityStepEnv pins the env bindings the eligibility step must use to feed
// the exemption its narrow inputs: the pull-request head ref, the pull-request
// head repository, and this repository. Binding the head repository is what
// keeps a fork's own branch named `main` from taking the exemption.
var eligibilityStepEnv = []struct {
	name       string
	expression string
}{
	{name: "PR_HEAD_REF", expression: "github.event.pull_request.head.ref"},
	{name: "PR_HEAD_REPOSITORY", expression: "github.event.pull_request.head.repo.full_name"},
	{name: "GITHUB_REPOSITORY", expression: "github.repository"},
}

// backmergeExemptionArgs are the shared-predicate arguments the eligibility step
// must pass alongside the opt-in, so the exemption stays limited to this
// repository's own main branch.
var backmergeExemptionArgs = []string{"--head-ref", "--head-repo", "--repository"}

// checkBackmergeExemption pins the post-release main back-merge exemption: the
// staging eligibility step must opt in with the narrow pull-request head
// bindings, and the promotion lane's readiness job must never opt in at all. A
// promotion range that took the exemption would ship main's release chores as if
// they were fresh release content, which is exactly the release-driver check the
// promotion lane exists to make.
func checkBackmergeExemption(jobs []classifiedJob) []string {
	var failures []string
	for _, job := range jobs {
		switch job.id {
		case eligibilityID:
			failures = append(failures, checkEligibilityBackmergeStep(job)...)
		case prereleaseID:
			failures = append(failures, checkPromotionLaneBackmergeStep(job)...)
		}
	}
	return failures
}

func checkEligibilityBackmergeStep(job classifiedJob) []string {
	step := findStepRunning(job, "verify-release-eligibility.sh")
	if step == nil {
		return []string{fmt.Sprintf(
			"job %q must run scripts/verify-release-eligibility.sh from a step the guard can inspect", job.id)}
	}
	var failures []string
	if !strings.Contains(step.run, backmergeOptInFlag) {
		failures = append(failures, fmt.Sprintf(
			"job %q step %q must opt in to the post-release main back-merge exemption with %s; without it the returned main back-merge cannot pass the promotion range",
			job.id, step.name, backmergeOptInFlag))
	}
	for _, arg := range backmergeExemptionArgs {
		if !strings.Contains(step.run, arg) {
			failures = append(failures, fmt.Sprintf(
				"job %q step %q must pass %s so the post-release main back-merge exemption stays limited to this repository's main branch",
				job.id, step.name, arg))
		}
	}
	for _, binding := range eligibilityStepEnv {
		got, ok := step.env[binding.name]
		if !ok {
			failures = append(failures, fmt.Sprintf(
				"job %q step %q must bind env %s: %q for the post-release main back-merge exemption",
				job.id, step.name, binding.name, binding.expression))
			continue
		}
		if normalizeExpression(got) != binding.expression {
			failures = append(failures, fmt.Sprintf(
				"job %q step %q must bind env %s to %q, got %q",
				job.id, step.name, binding.name, binding.expression, got))
		}
	}
	return failures
}

func checkPromotionLaneBackmergeStep(job classifiedJob) []string {
	var failures []string
	for _, step := range job.def.steps {
		if !strings.Contains(step.run, backmergeOptInFlag) {
			continue
		}
		failures = append(failures, fmt.Sprintf(
			"job %q step %q must not opt in to the post-release main back-merge exemption (%s): the promotion lane promotes released content and must keep requiring a release-eligible commit",
			job.id, step.name, backmergeOptInFlag))
	}
	return failures
}

func findStepRunning(job classifiedJob, needle string) *workflowStep {
	for i := range job.def.steps {
		if strings.Contains(job.def.steps[i].run, needle) {
			return &job.def.steps[i]
		}
	}
	return nil
}

// checkUnconditionalSteps forbids a step-level condition that depends on the
// triggering event inside the rubric/builds jobs: the job-level condition
// already selects the lane, so an event-dependent step `if:` can vacate the
// gate while the job name still reports green on a staging pull request
// (ADV-1073-R1-03(b)). Status-only step conditions such as `if: always()` do
// not depend on the event and stay allowed.
func checkUnconditionalSteps(jobs []classifiedJob) []string {
	var failures []string
	for _, job := range jobs {
		if job.id != "rubric" && job.id != "builds" {
			continue
		}
		for _, step := range job.def.steps {
			if !step.hasIf || !referencesTriggerContext(step.ifText) {
				continue
			}
			failures = append(failures, fmt.Sprintf(
				"job %q step %q has an event-dependent step-level if: (%q); the job's steps must run unconditionally on its staging-pull-request trigger",
				job.id, step.name, step.ifText))
		}
	}
	return failures
}

func referencesTriggerContext(text string) bool {
	return strings.Contains(text, "github.") || strings.Contains(text, "inputs.")
}

func checkCanary(jobs []classifiedJob) []string {
	classes := classIndex(jobs)
	canary, ok := classes[prereleaseID]
	if !ok {
		return []string{fmt.Sprintf("workflow must define the promotion-edge job %q; the parity check is vacuous without it", prereleaseID)}
	}
	if !isPromotionOnly(canary) {
		return []string{fmt.Sprintf("job %q is no longer a promotion-only job; the R-F1 parity check is vacuous", prereleaseID)}
	}
	return nil
}

func classIndex(jobs []classifiedJob) map[string]*jobClass {
	classes := map[string]*jobClass{}
	for _, job := range jobs {
		classes[job.id] = job.class
	}
	return classes
}

func isPromotionOnly(class *jobClass) bool {
	if class.prBases[stagingBranch] {
		return false
	}
	return class.prBases[premainBranch] || class.prBases[mainBranch]
}

func promotionBases(class *jobClass) []string {
	var bases []string
	for _, branch := range []string{premainBranch, mainBranch} {
		if class.prBases[branch] {
			bases = append(bases, branch)
		}
	}
	return bases
}

func findPromotionExemption(jobID string) *parityExemption {
	for i := range promotionParityExemptions {
		if promotionParityExemptions[i].job == jobID {
			return &promotionParityExemptions[i]
		}
	}
	return nil
}

func inputCombinations(names []string) ([]map[string]string, error) {
	if len(names) > maxDispatchIns {
		return nil, fmt.Errorf("expression reads %d workflow_dispatch inputs; the classifier models at most %d", len(names), maxDispatchIns)
	}
	values := []string{"true", "false", ""}
	combinations := []map[string]string{{}}
	for _, name := range names {
		var next []map[string]string
		for _, existing := range combinations {
			for _, value := range values {
				combo := map[string]string{}
				for key, existingValue := range existing {
					combo[key] = existingValue
				}
				combo[name] = value
				next = append(next, combo)
			}
		}
		combinations = next
	}
	return combinations, nil
}

func normalizeExpression(text string) string {
	trimmed := strings.TrimSpace(text)
	if inner, ok := unwrapExpressionInterpolation(trimmed); ok {
		trimmed = inner
	}
	return strings.Join(strings.Fields(trimmed), " ")
}

func mapLookup(node *yaml.Node, key string) (*yaml.Node, bool) {
	if node.Kind != yaml.MappingNode {
		return nil, false
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Kind == yaml.ScalarNode && node.Content[i].Value == key {
			return node.Content[i+1], true
		}
	}
	return nil, false
}

func scalarSequence(node *yaml.Node) ([]string, error) {
	if node.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("must be a sequence of scalars")
	}
	values := make([]string, 0, len(node.Content))
	for _, item := range node.Content {
		if item.Kind != yaml.ScalarNode {
			return nil, fmt.Errorf("must be a sequence of scalars")
		}
		values = append(values, item.Value)
	}
	return values, nil
}

func isNullNode(node *yaml.Node) bool {
	return node.Kind == yaml.ScalarNode && (node.Tag == "!!null" || node.Value == "" || node.Value == "~")
}

func styleName(style yaml.Style) string {
	if style == yaml.LiteralStyle {
		return "literal"
	}
	return "folded"
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	var unique []string
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		unique = append(unique, value)
	}
	return unique
}

func sortedKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
