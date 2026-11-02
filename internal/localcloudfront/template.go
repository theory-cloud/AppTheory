// Package localcloudfront derives a local delivery gateway from the
// AWS::CloudFront::Distribution resources in a synthesized cloud assembly.
//
// The distribution, its cache behaviors, origins and the AWS::CloudFront::*
// resources it references are the only routing definition. The package runs the
// exact CloudFront Function code the template declares, applies the origin
// request and response headers policies, and hands origin requests to an Origin
// implementation. It is not a CloudFront emulator: there is no cache, no edge
// network and no TLS.
package localcloudfront

import (
	"encoding/json"
	"fmt"
)

// Template is one CloudFormation stack template the topology reader scans. The
// runner passes the same stacks it derived the Lambda surface from, so the
// distribution is read from the app's own cloud assembly rather than from a
// second hand-written route table.
type Template struct {
	Stack     string
	Resources map[string]Resource
}

// Resource is one template resource: its CloudFormation type and Properties.
type Resource struct {
	Type       string
	Properties json.RawMessage
}

// ParseTemplates reads every CloudFront distribution, function and referenced
// policy in the templates. A malformed template is an error; a valid template
// using a feature the gateway does not implement becomes a refusal on the
// distribution, reported by the caller instead of being ignored.
func ParseTemplates(templates []Template) (*Topology, error) {
	topology := &Topology{
		functionsByID: make(map[string]*Function),
		policiesByID:  make(map[string]*Policy),
	}
	index := newResourceIndex(templates)
	for _, tpl := range templates {
		if err := topology.parseStack(tpl, index); err != nil {
			return nil, err
		}
	}
	topology.sort()
	return topology, nil
}

// Topology is everything the gateway derived from the cloud assembly.
type Topology struct {
	Distributions        []*Distribution        `json:"distributions"`
	Functions            []*Function            `json:"functions,omitempty"`
	Policies             []*Policy              `json:"policies,omitempty"`
	OriginAccessControls []*OriginAccessControl `json:"originAccessControls,omitempty"`

	functionsByID map[string]*Function
	policiesByID  map[string]*Policy
}

// Distribution returns one distribution by qualified logical id.
func (t *Topology) Distribution(logicalID string) (*Distribution, bool) {
	for _, distribution := range t.Distributions {
		if distribution.LogicalID == logicalID {
			return distribution, true
		}
	}
	return nil, false
}

// Function returns one CloudFront Function by qualified logical id.
func (t *Topology) Function(logicalID string) (*Function, bool) {
	function, ok := t.functionsByID[logicalID]
	return function, ok
}

func (t *Topology) sort() {
	sortDistributions(t.Distributions)
	sortFunctions(t.Functions)
	sortPolicies(t.Policies)
	sortOACs(t.OriginAccessControls)
}

// resourceIndex resolves a logical id inside one stack.
type resourceIndex struct {
	stacks     []Template
	byStack    map[string]map[string]Resource
	stackNames []string
}

func newResourceIndex(templates []Template) *resourceIndex {
	index := &resourceIndex{
		stacks:  templates,
		byStack: make(map[string]map[string]Resource, len(templates)),
	}
	for _, tpl := range templates {
		index.byStack[tpl.Stack] = tpl.Resources
		index.stackNames = append(index.stackNames, tpl.Stack)
	}
	return index
}

// lookup resolves a logical id in the stack that references it. A
// multi-stack assembly qualifies every id with its stack name so the runner's
// spec stays unambiguous.
func (i *resourceIndex) lookup(stack, logicalID string) (Resource, bool) {
	resources, ok := i.byStack[stack]
	if !ok {
		return Resource{}, false
	}
	resource, ok := resources[logicalID]
	return resource, ok
}

func (i *resourceIndex) qualified(stack, logicalID string) string {
	if len(i.stackNames) <= 1 {
		return logicalID
	}
	return stack + "/" + logicalID
}

// parseStack reads one stack in a stable order: functions and policies first,
// because distributions reference them; then origin access controls; then the
// distributions themselves.
func (t *Topology) parseStack(tpl Template, index *resourceIndex) error {
	ids := sortedKeys(tpl.Resources)
	for _, id := range ids {
		resource := tpl.Resources[id]
		if resource.Type == typeCloudFrontFunction {
			function, err := parseFunction(tpl.Stack, id, resource, index)
			if err != nil {
				return err
			}
			t.Functions = append(t.Functions, function)
			t.functionsByID[function.LogicalID] = function
		}
	}
	for _, id := range ids {
		resource := tpl.Resources[id]
		kind, ok := policyKindForType(resource.Type)
		if !ok {
			continue
		}
		policy, err := parsePolicy(tpl.Stack, id, kind, resource, index)
		if err != nil {
			return err
		}
		t.Policies = append(t.Policies, policy)
		t.policiesByID[policy.LogicalID] = policy
	}
	for _, id := range ids {
		resource := tpl.Resources[id]
		if resource.Type != typeOriginAccessControl {
			continue
		}
		oac, err := parseOriginAccessControl(tpl.Stack, id, resource, index)
		if err != nil {
			return err
		}
		t.OriginAccessControls = append(t.OriginAccessControls, oac)
	}
	for _, id := range ids {
		resource := tpl.Resources[id]
		if resource.Type != typeCloudFrontDistribution {
			continue
		}
		distribution, err := parseDistribution(tpl.Stack, id, resource, index, t)
		if err != nil {
			return err
		}
		t.Distributions = append(t.Distributions, distribution)
	}
	return nil
}

func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sortStrings(keys)
	return keys
}

func decodeProperties(resource Resource) (map[string]json.RawMessage, error) {
	var properties map[string]json.RawMessage
	if len(resource.Properties) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	if err := json.Unmarshal(resource.Properties, &properties); err != nil {
		return nil, fmt.Errorf("properties are not an object: %w", err)
	}
	return properties, nil
}
