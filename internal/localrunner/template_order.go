package localrunner

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Template dependency order.
//
// A deployment creates resources in the order their dependencies require:
// CloudFormation honors an explicit `DependsOn` and the implicit edges a `Ref`
// or `Fn::GetAtt` creates, and only orders otherwise-independent resources by
// logical id. The runner invokes the template's deploy-time resources in the
// same order, so a handler that requires another handler's effect (an SES rule
// set that must exist before it is activated, for example) observes the
// template's own ordering instead of an alphabetical accident.
//
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-dependson.html
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-ref.html
// https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference-getatt.html

// templateTopologicalOrder returns each template resource's position in its
// stack's dependency order. The order is deterministic: independent resources
// are emitted in logical-id order, which is the tie-break the assignment of
// positions uses.
//
// A cycle that leaves a deploy-time resource (a custom resource) without a
// position fails closed with a named error: the runner cannot know which of
// them CloudFormation would create first. A cycle among resources the runner
// does not order is tolerated, because such a template still deploys — CDK
// reports it as a warning — and refusing it would break a caller that never
// depended on the order. Those resources take positions after the ordered ones.
//
//nolint:gocyclo,gocognit // one branch per edge kind and one per cycle outcome.
func templateTopologicalOrder(stack assemblyStack) (map[string]int, error) {
	resources := stack.Template.Resources
	ids := sortedKeys(resources)
	order := make(map[string]int, len(ids))
	if len(ids) == 0 {
		return order, nil
	}

	// predecessors[id] are the resources that must precede id; dependents is
	// its inverse. A dependency that names no resource in this stack (a
	// parameter, a pseudo parameter, a typo CloudFormation would reject) is not
	// an edge.
	predecessors := make(map[string]map[string]struct{}, len(ids))
	dependents := make(map[string][]string, len(ids))
	for _, id := range ids {
		resource := resources[id]
		seen := map[string]struct{}{}
		add := func(dep string) {
			if dep == "" || dep == id {
				return
			}
			if _, ok := resources[dep]; !ok {
				return
			}
			if _, ok := seen[dep]; ok {
				return
			}
			seen[dep] = struct{}{}
			if predecessors[id] == nil {
				predecessors[id] = map[string]struct{}{}
			}
			predecessors[id][dep] = struct{}{}
			dependents[dep] = append(dependents[dep], id)
		}
		for _, dep := range templateDependsOn(resource.DependsOn) {
			add(dep)
		}
		for _, ref := range refsIn(resource.Properties) {
			add(ref.ID)
		}
	}

	indegree := make(map[string]int, len(ids))
	ready := make([]string, 0, len(ids))
	for _, id := range ids {
		indegree[id] = len(predecessors[id])
		if indegree[id] == 0 {
			ready = append(ready, id)
		}
	}
	sort.Strings(ready)

	position := 0
	for len(ready) > 0 {
		id := ready[0]
		ready = ready[1:]
		order[id] = position
		position++
		for _, dependent := range dependents[id] {
			indegree[dependent]--
			if indegree[dependent] == 0 {
				insertSorted(&ready, dependent)
			}
		}
	}
	if position != len(ids) {
		// Only a cycle that leaves a custom resource unordered changes what the
		// runner invokes. A template whose cycle sits among resources the runner
		// does not order (CDK warns about it) still deploys, so those resources
		// take positions after the ordered ones and the derivation continues.
		unplaced := make([]string, 0, len(ids)-position)
		for _, id := range ids {
			if _, placed := order[id]; placed {
				continue
			}
			if customResourceType(resources[id].Type) {
				return nil, fmt.Errorf(
					"the template dependency graph of stack %s has a cycle: %s",
					stack.Name, templateCycle(resources, predecessors, indegree))
			}
			unplaced = append(unplaced, id)
		}
		for _, id := range unplaced {
			order[id] = position
			position++
		}
	}
	return order, nil
}

// templateDependsOn reads CloudFormation's DependsOn, which is a string or a
// list of strings.
func templateDependsOn(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		if single == "" {
			return nil
		}
		return []string{single}
	}
	var many []string
	if err := json.Unmarshal(raw, &many); err != nil {
		return nil
	}
	return many
}

// templateCycle names one cycle among the resources the topological sort could
// not place: it walks predecessors from the first unplaced logical id until a
// logical id repeats.
func templateCycle(resources map[string]templateResource, predecessors map[string]map[string]struct{}, indegree map[string]int) string {
	start := ""
	for id := range resources {
		if indegree[id] == 0 {
			continue
		}
		if start == "" || id < start {
			start = id
		}
	}
	path := []string{}
	position := map[string]int{}
	current := start
	for current != "" {
		if at, ok := position[current]; ok {
			cycle := append(append([]string{}, path[at:]...), current)
			return strings.Join(cycle, " -> ")
		}
		position[current] = len(path)
		path = append(path, current)
		next := ""
		for predecessor := range predecessors[current] {
			if indegree[predecessor] == 0 {
				continue
			}
			if next == "" || predecessor < next {
				next = predecessor
			}
		}
		current = next
	}
	return strings.Join(path, " -> ")
}

// insertSorted keeps the ready set in logical-id order, so the emitted order
// does not depend on Go's map iteration.
func insertSorted(values *[]string, value string) {
	at := sort.SearchStrings(*values, value)
	*values = append(*values, "")
	copy((*values)[at+1:], (*values)[at:])
	(*values)[at] = value
}
