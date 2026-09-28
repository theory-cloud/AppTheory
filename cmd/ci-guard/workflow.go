package main

import (
	"flag"
	"fmt"
	"io"
	"os"
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

type workflowFile struct {
	path           string
	pushBranches   []string
	hasPush        bool
	hasPullRequest bool
	jobs           []workflowJob
}

type workflowJob struct {
	id     string
	name   string
	ifText string
	hasIf  bool
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

func runWorkflowTriggers(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("workflow-triggers", flag.ContinueOnError)
	flags.SetOutput(stderr)
	root := flags.String("root", ".", "repository root")
	workflowPath := flags.String("workflow", filepath.Join(".github", "workflows", "ci.yml"), "workflow file relative to root")
	if err := flags.Parse(args); err != nil {
		return exitBlocked
	}

	workflow, err := loadWorkflow(filepath.Join(*root, filepath.FromSlash(*workflowPath)))
	if err != nil {
		writeString(stderr, fmt.Sprintf("ci-trigger-parity: FAIL (%v)\n", err))
		return exitFail
	}
	failures, err := evaluateWorkflow(workflow)
	if err != nil {
		writeString(stderr, fmt.Sprintf("ci-trigger-parity: FAIL (%v)\n", err))
		return exitFail
	}
	if len(failures) > 0 {
		writeString(stderr, "ci-trigger-parity: FAIL\n")
		for _, failure := range failures {
			writeString(stderr, fmt.Sprintf("- %s\n", failure))
		}
		return exitFail
	}
	writeString(stdout, fmt.Sprintf("ci-trigger-parity: PASS (%s: %d jobs classified by effective triggers)\n", *workflowPath, len(workflow.jobs)))
	return exitPass
}

func loadWorkflow(path string) (*workflowFile, error) {
	//nolint:gosec // the path is the repository workflow under guard, not user input.
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) != 1 {
		return nil, fmt.Errorf("%s: expected exactly one YAML document", path)
	}
	root := document.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s: workflow root must be a mapping", path)
	}
	if err := rejectUnmodeledNodes(root, path); err != nil {
		return nil, err
	}

	workflow := &workflowFile{path: path}
	onNode, ok := mapLookup(root, "on")
	if !ok {
		return nil, fmt.Errorf("%s: workflow must declare an on: trigger block", path)
	}
	if err := workflow.parseTriggers(onNode); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	jobsNode, ok := mapLookup(root, "jobs")
	if !ok {
		return nil, fmt.Errorf("%s: workflow must declare jobs", path)
	}
	if jobsNode.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s: jobs must be a mapping", path)
	}
	for i := 0; i+1 < len(jobsNode.Content); i += 2 {
		job, err := parseWorkflowJob(jobsNode.Content[i], jobsNode.Content[i+1])
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		workflow.jobs = append(workflow.jobs, job)
	}
	if len(workflow.jobs) == 0 {
		return nil, fmt.Errorf("%s: workflow declares no jobs", path)
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
		switch key.Value {
		case "push":
			wf.hasPush = true
			branches, err := parsePushTrigger(value)
			if err != nil {
				return err
			}
			wf.pushBranches = branches
		case "pull_request":
			wf.hasPullRequest = true
			if err := parsePullRequestTrigger(value); err != nil {
				return err
			}
		case "workflow_dispatch":
			if err := parseDispatchTrigger(value); err != nil {
				return err
			}
		default:
			return fmt.Errorf("on: trigger %q is not modeled by the parity classifier", key.Value)
		}
	}
	return nil
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

func parseWorkflowJob(idNode, body *yaml.Node) (workflowJob, error) {
	if idNode.Kind != yaml.ScalarNode {
		return workflowJob{}, fmt.Errorf("job ids must be scalars")
	}
	job := workflowJob{id: idNode.Value, name: idNode.Value}
	if body.Kind != yaml.MappingNode {
		return workflowJob{}, fmt.Errorf("job %q must be a mapping", job.id)
	}
	for i := 0; i+1 < len(body.Content); i += 2 {
		key, value := body.Content[i].Value, body.Content[i+1]
		switch key {
		case "name":
			if value.Kind == yaml.ScalarNode {
				job.name = value.Value
			}
		case "if":
			if value.Kind != yaml.ScalarNode {
				return workflowJob{}, fmt.Errorf("job %q if: must be a scalar expression", job.id)
			}
			if value.Style == yaml.LiteralStyle || value.Style == yaml.FoldedStyle {
				return workflowJob{}, fmt.Errorf("job %q uses a %s if: block; continuation forms are not modeled", job.id, styleName(value.Style))
			}
			job.ifText = value.Value
			job.hasIf = true
		}
	}
	return job, nil
}

func rejectUnmodeledNodes(node *yaml.Node, path string) error {
	if node.Kind == yaml.AliasNode {
		return fmt.Errorf("%s: YAML aliases are not modeled; spell every job out", path)
	}
	if node.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i+1 < len(node.Content); i += 2 {
			key := node.Content[i]
			if key.Kind != yaml.ScalarNode {
				continue
			}
			if key.Value == "<<" {
				return fmt.Errorf("%s: YAML merge keys are not modeled", path)
			}
			if seen[key.Value] {
				return fmt.Errorf("%s: duplicate mapping key %q is not modeled", path, key.Value)
			}
			seen[key.Value] = true
		}
	}
	for _, child := range node.Content {
		if err := rejectUnmodeledNodes(child, path); err != nil {
			return err
		}
	}
	return nil
}

func evaluateWorkflow(wf *workflowFile) ([]string, error) {
	var failures []string
	if !wf.hasPullRequest {
		failures = append(failures, "workflow must trigger on pull_request")
	}
	if !wf.hasPush {
		failures = append(failures, "workflow must trigger on push")
	}

	classes := map[string]*jobClass{}
	order := make([]string, 0, len(wf.jobs))
	for _, job := range wf.jobs {
		class, err := classifyJob(wf, job)
		if err != nil {
			return nil, err
		}
		classes[job.id] = class
		order = append(order, job.id)
	}

	failures = append(failures, checkExactConditions(classes)...)
	failures = append(failures, checkPushParity(order, classes)...)
	failures = append(failures, checkPromotionParity(order, classes)...)
	failures = append(failures, checkExemptionsAreLive(classes)...)
	failures = append(failures, checkCanary(classes)...)
	return failures, nil
}

func classifyJob(wf *workflowFile, job workflowJob) (*jobClass, error) {
	class := &jobClass{id: job.id, name: job.name, hasIf: job.hasIf, ifText: job.ifText, prBases: map[string]bool{}}
	if !job.hasIf {
		class.pushRefs = append([]string{}, wf.pushBranches...)
		for _, base := range baseDomain {
			class.prBases[base] = true
		}
		class.prAny = true
		class.dispatch = true
		return class, nil
	}

	condition, err := parseCondition(job.ifText)
	if err != nil {
		return nil, fmt.Errorf("job %q: %w", job.id, err)
	}
	if class.pushRefs, err = classifyPush(condition, wf.pushBranches, job.id); err != nil {
		return nil, err
	}
	if err := classifyPullRequest(condition, class, job.id); err != nil {
		return nil, err
	}
	if err := classifyDispatch(condition, class, job); err != nil {
		return nil, err
	}
	return class, nil
}

func classifyPush(condition expr, pushBranches []string, jobID string) ([]string, error) {
	refs := map[string]bool{}
	for _, branch := range uniqueStrings(append(append([]string{}, pushBranches...), protectedBranches...)) {
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

func checkExactConditions(classes map[string]*jobClass) []string {
	var failures []string
	for _, jobID := range []string{"rubric", "builds"} {
		allowed := rubricCondition
		if jobID == "builds" {
			allowed = buildsCondition
		}
		class, ok := classes[jobID]
		if !ok {
			failures = append(failures, fmt.Sprintf("workflow must define the %q job", jobID))
			continue
		}
		if !class.hasIf || normalizeExpression(class.ifText) != normalizeExpression(allowed) {
			failures = append(failures, fmt.Sprintf(
				"job %q must be staging-pull-request-only; its if: must equal %q exactly (got %q)",
				jobID, normalizeExpression(allowed), normalizeExpression(class.ifText)))
		}
	}
	return failures
}

func checkPushParity(order []string, classes map[string]*jobClass) []string {
	var failures []string
	for _, id := range order {
		class := classes[id]
		if len(class.pushRefs) > 0 && !class.prBases[stagingBranch] {
			failures = append(failures, fmt.Sprintf(
				"job %q (%s) can run on a push (%s) but not on a pull request to staging (R-F1 push parity)",
				id, class.name, strings.Join(class.pushRefs, ", ")))
		}
	}
	return failures
}

func checkPromotionParity(order []string, classes map[string]*jobClass) []string {
	var failures []string
	for _, id := range order {
		class := classes[id]
		if !isPromotionOnly(class) {
			continue
		}
		if exemption := findPromotionExemption(id); exemption != nil {
			continue
		}
		failures = append(failures, fmt.Sprintf(
			"job %q (%s) runs only on promotion pull requests (%s) with no pull-request-to-staging equivalent; add one or record a justified exception",
			id, class.name, strings.Join(promotionBases(class), ", ")))
	}
	return failures
}

func checkExemptionsAreLive(classes map[string]*jobClass) []string {
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

func checkCanary(classes map[string]*jobClass) []string {
	canary, ok := classes[prereleaseID]
	if !ok {
		return []string{fmt.Sprintf("workflow must define the promotion-edge job %q; the parity check is vacuous without it", prereleaseID)}
	}
	if !isPromotionOnly(canary) {
		return []string{fmt.Sprintf("job %q is no longer a promotion-only job; the R-F1 parity check is vacuous", prereleaseID)}
	}
	return nil
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
