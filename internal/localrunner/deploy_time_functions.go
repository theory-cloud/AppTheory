package localrunner

import (
	"encoding/json"
	"sort"
)

// Deploy-time function closure.
//
// A provider-framework custom resource does not call its user function itself:
// the CDK Provider construct creates an onEvent handler and points it at the
// user function through the handler's environment (`USER_ON_EVENT_FUNCTION_ARN`
// is the field the framework reads). The custom resource's properties name only
// the service token, so a run that starts the service token alone leaves the
// provider's real invocation with nothing to call and the custom resource never
// answers.
//
// The closure adds every Lambda function reachable from a served custom
// resource through those environment edges, transitively, so a run's
// `--target` selection can never narrow away a function the template itself
// invokes at deploy time. Functions whose code the assembly does not carry are
// left out (the invocation then fails by name, as it did before).
//
// https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.custom_resources.Provider.html

// functionStartable reports whether the assembly carries the function's code,
// so a container can load its handler.
func functionStartable(function FunctionSpec) bool {
	return function.AssetDir != "" || function.InlineCode != "" || function.ImageAsset != nil
}

// deployTimeFunction is one Lambda function the closure can walk through: its
// stack (for qualification) and its template properties (for Environment).
type deployTimeFunction struct {
	stack      assemblyStack
	properties json.RawMessage
}

// deployTimeFunctionIndex maps every qualified Lambda function logical id in
// the assembly to the template properties the closure reads.
func deployTimeFunctionIndex(stacks []assemblyStack) map[string]deployTimeFunction {
	index := map[string]deployTimeFunction{}
	for _, stack := range stacks {
		for id, resourceType := range stack.resourceTypes() {
			if resourceType != typeLambdaFunction {
				continue
			}
			resource, ok := stack.Template.Resources[id]
			if !ok {
				continue
			}
			index[qualify(stacks, stack.Name, id)] = deployTimeFunction{stack: stack, properties: resource.Properties}
		}
	}
	return index
}

// lambdaFunctionRefs returns the qualified Lambda functions a template
// expression names through Ref or Fn::GetAtt.
func lambdaFunctionRefs(raw json.RawMessage, stack assemblyStack, stacks []assemblyStack) []string {
	var out []string
	for _, ref := range refsIn(raw) {
		resource, ok := stack.Template.Resources[ref.ID]
		if !ok || resource.Type != typeLambdaFunction {
			continue
		}
		out = append(out, qualify(stacks, stack.Name, ref.ID))
	}
	return out
}

// environmentFunctionRefs returns the Lambda functions one function's
// Environment.Variables name. That is where a provider framework records the
// function its handler invokes at deploy time.
func environmentFunctionRefs(properties json.RawMessage, stack assemblyStack, stacks []assemblyStack) []string {
	if len(properties) == 0 {
		return nil
	}
	var document struct {
		Environment struct {
			Variables map[string]json.RawMessage `json:"Variables"`
		} `json:"Environment"`
	}
	if err := json.Unmarshal(properties, &document); err != nil {
		return nil
	}
	var out []string
	for _, name := range sortedKeys(document.Environment.Variables) {
		out = append(out, lambdaFunctionRefs(document.Environment.Variables[name], stack, stacks)...)
	}
	return out
}

// deployTimeClosure walks the environment edges from the seeds and returns
// every reachable function, in a deterministic order.
func deployTimeClosure(stacks []assemblyStack, seeds []string) []string {
	index := deployTimeFunctionIndex(stacks)
	seen := map[string]struct{}{}
	queue := make([]string, 0, len(seeds))
	add := func(id string) {
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		if _, ok := index[id]; !ok {
			return
		}
		seen[id] = struct{}{}
		queue = append(queue, id)
	}
	for _, seed := range seeds {
		add(seed)
	}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		function := index[current]
		for _, next := range environmentFunctionRefs(function.properties, function.stack, stacks) {
			add(next)
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
