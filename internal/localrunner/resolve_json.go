package localrunner

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// JSON document resolution.
//
// A custom resource's ResourceProperties and an IAM policy document are JSON
// documents that carry CloudFormation expressions. Environment resolution
// (environment.go) produces strings for one variable at a time; these documents
// need their shapes preserved (a boolean, a number, a list, a nested object),
// so this resolver walks the document and resolves only the expressions it can
// prove, failing closed on anything else by name.

// resolveJSONValue resolves every CloudFormation expression in a JSON document
// against one stack.
func (r *Runner) resolveJSONValue(spec *Spec, stack string, value any) (any, error) {
	switch typed := value.(type) {
	case nil, bool, float64, string:
		return typed, nil
	case []any:
		out := make([]any, 0, len(typed))
		for index, item := range typed {
			resolved, err := r.resolveJSONValue(spec, stack, item)
			if err != nil {
				return nil, fmt.Errorf("item %d: %w", index, err)
			}
			out = append(out, resolved)
		}
		return out, nil
	case map[string]any:
		if intrinsic, ok := jsonIntrinsic(typed); ok {
			return r.resolveJSONIntrinsic(spec, stack, intrinsic, typed)
		}
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			resolved, err := r.resolveJSONValue(spec, stack, item)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", key, err)
			}
			out[key] = resolved
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unsupported value type %T", value)
	}
}

// jsonIntrinsic returns the single intrinsic key of an expression object. A
// plain object with more than one key is not an expression.
func jsonIntrinsic(object map[string]any) (string, bool) {
	for _, key := range []string{intrinsicRef, "Fn::GetAtt", "Fn::Join", "Fn::If", "Fn::Select", "Fn::Split", "Fn::FindInMap", "Fn::Sub", "Fn::ImportValue"} {
		if _, ok := object[key]; ok {
			return key, true
		}
	}
	return "", false
}

// resolveJSONIntrinsic resolves one intrinsic key of an expression object.
//
//nolint:gocyclo,gocognit // one branch per intrinsic the resolver understands.
func (r *Runner) resolveJSONIntrinsic(spec *Spec, stack, intrinsic string, object map[string]any) (any, error) {
	switch intrinsic {
	case intrinsicRef:
		name, ok := object[intrinsicRef].(string)
		if !ok || name == "" {
			return nil, errors.New("a Ref must name a parameter or resource")
		}
		return r.resolveJSONRef(spec, stack, name)
	case "Fn::GetAtt":
		name, attribute, err := parseGetAtt(object["Fn::GetAtt"])
		if err != nil {
			return nil, err
		}
		return r.resolveJSONGetAtt(spec, stack, name, attribute)
	case "Fn::Join":
		resolved, err := r.resolveJSONValue(spec, stack, object["Fn::Join"])
		if err != nil {
			return nil, err
		}
		parts, ok := resolved.([]any)
		if !ok || len(parts) != 2 {
			return nil, errors.New("Fn::Join must be [delimiter, values]")
		}
		delimiter, ok := parts[0].(string)
		if !ok {
			return nil, errors.New("Fn::Join delimiter must be a string")
		}
		values, ok := parts[1].([]any)
		if !ok {
			return nil, errors.New("Fn::Join values must be an array")
		}
		texts := make([]string, 0, len(values))
		for index, value := range values {
			text, ok := jsonScalarString(value)
			if !ok {
				return nil, fmt.Errorf("Fn::Join value %d is not a scalar", index)
			}
			texts = append(texts, text)
		}
		return strings.Join(texts, delimiter), nil
	case "Fn::If":
		parts, ok := object["Fn::If"].([]any)
		if !ok || len(parts) != 3 {
			return nil, errors.New("Fn::If must be [condition, true value, false value]")
		}
		name, ok := parts[0].(string)
		if !ok || name == "" {
			return nil, errors.New("Fn::If condition must be a condition name")
		}
		template := spec.Templates[stack]
		condition, err := template.condition(name)
		if err != nil {
			return nil, err
		}
		if condition {
			return r.resolveJSONValue(spec, stack, parts[1])
		}
		return r.resolveJSONValue(spec, stack, parts[2])
	case "Fn::Select":
		parts, ok := object["Fn::Select"].([]any)
		if !ok || len(parts) != 2 {
			return nil, errors.New("Fn::Select must be [index, values]")
		}
		indexValue, err := r.resolveJSONValue(spec, stack, parts[0])
		if err != nil {
			return nil, err
		}
		index, err := jsonIndex(indexValue)
		if err != nil {
			return nil, err
		}
		values, err := r.resolveJSONValue(spec, stack, parts[1])
		if err != nil {
			return nil, err
		}
		list, ok := values.([]any)
		if !ok {
			return nil, errors.New("Fn::Select values must be an array")
		}
		if index < 0 || index >= len(list) {
			return nil, fmt.Errorf("Fn::Select index %d is outside a list of %d values", index, len(list))
		}
		return list[index], nil
	case "Fn::Split":
		parts, ok := object["Fn::Split"].([]any)
		if !ok || len(parts) != 2 {
			return nil, errors.New("Fn::Split must be [delimiter, value]")
		}
		delimiter, ok := parts[0].(string)
		if !ok || delimiter == "" {
			return nil, errors.New("Fn::Split delimiter must be a non-empty string")
		}
		value, err := r.resolveJSONValue(spec, stack, parts[1])
		if err != nil {
			return nil, err
		}
		text, ok := jsonScalarString(value)
		if !ok {
			return nil, errors.New("Fn::Split value is not a scalar")
		}
		segments := strings.Split(text, delimiter)
		out := make([]any, 0, len(segments))
		for _, segment := range segments {
			out = append(out, segment)
		}
		return out, nil
	case "Fn::FindInMap":
		resolved, err := spec.Templates[stack].findInMap(object["Fn::FindInMap"])
		if err != nil {
			return nil, err
		}
		return resolved, nil
	case "Fn::Sub":
		return r.resolveJSONSub(spec, stack, object["Fn::Sub"])
	case "Fn::ImportValue":
		return nil, errors.New("Fn::ImportValue names a deployed stack's export, which has no local value")
	default:
		return nil, fmt.Errorf("unsupported CloudFormation expression %q", intrinsic)
	}
}

// resolveJSONRef resolves one Ref inside a JSON document. The resource forms a
// policy document or a custom-resource property names have local values the
// environment resolver does not produce, notably a REST API's physical id.
//
//nolint:gocyclo // one branch per resource form a document can name.
func (r *Runner) resolveJSONRef(spec *Spec, stack, name string) (any, error) {
	switch name {
	case pseudoPartition:
		return LocalPartition, nil
	case pseudoRegion:
		return stackRegion(spec, stack), nil
	case pseudoAccountID:
		return r.stackAccount(spec, stack), nil
	case "AWS::StackName":
		return stack, nil
	case "AWS::URLSuffix":
		return "amazonaws.com", nil
	case pseudoNoValue:
		return nil, nil
	}
	if template, ok := spec.Templates[stack]; ok {
		if _, isParameter := template.Parameters[name]; isParameter {
			value, err := template.refValue(name)
			if err != nil {
				return nil, err
			}
			return value, nil
		}
	}
	resource, ok := spec.resource(stack, name)
	if !ok {
		return nil, fmt.Errorf("a Ref to %s names no parameter or resource in stack %s", name, stack)
	}
	switch resource.Type {
	case typeRESTAPI, typeHTTPAPI:
		// A deployed API's id is assigned by API Gateway; the local transport
		// serves the same id everywhere it builds an execute-api ARN.
		return localPhysicalID("api", name), nil
	case typeIAMRole:
		return localRoleARN(spec, stack, resource), nil
	case typeLambdaFunction:
		return functionARNFor(spec, stack, resource), nil
	case "AWS::Lambda::Version":
		var props struct {
			FunctionName json.RawMessage `json:"FunctionName"`
		}
		if len(resource.Properties) > 0 {
			if err := json.Unmarshal(resource.Properties, &props); err != nil {
				return nil, fmt.Errorf("parse version %s properties: %w", name, err)
			}
		}
		types := make(map[string]string, len(spec.Resources))
		for _, candidate := range spec.Resources {
			if candidate.Stack == stack {
				types[candidate.LogicalID] = candidate.Type
			}
		}
		target, ok := findRefByType(props.FunctionName, types, typeLambdaFunction, "Arn")
		if !ok {
			return nil, fmt.Errorf("version %s does not name a Lambda function", name)
		}
		function, ok := spec.resource(stack, target)
		if !ok {
			return nil, fmt.Errorf("version %s names unknown function %s", name, target)
		}
		// A version's Ref is its ARN; the local run invokes the function the
		// version points at.
		return functionARNFor(spec, stack, function), nil
	}
	value, err := r.localResourceValue(resource, r.resourceValues)
	if err != nil {
		return nil, err
	}
	text, err := refString(resource, value)
	if err != nil {
		return nil, err
	}
	return text, nil
}

// resolveJSONGetAtt resolves one Fn::GetAtt inside a JSON document.
func (r *Runner) resolveJSONGetAtt(spec *Spec, stack, name, attribute string) (any, error) {
	key := stack + "/" + name
	if r.customResourceData != nil {
		if attributes, ok := r.customResourceData[key]; ok {
			if value, ok := attributes[attribute]; ok {
				return value, nil
			}
			return nil, fmt.Errorf("Fn::GetAtt %s.%s names no Data attribute the handler reported", name, attribute)
		}
	}
	resource, ok := spec.resource(stack, name)
	if !ok {
		return nil, fmt.Errorf("Fn::GetAtt %s names no resource in stack %s", name, stack)
	}
	switch resource.Type {
	case typeIAMRole:
		if attribute == attrArn || attribute == "RoleId" {
			return localRoleARN(spec, stack, resource), nil
		}
	case typeLambdaFunction:
		if attribute == attrArn {
			return functionARNFor(spec, stack, resource), nil
		}
	case typeRESTAPI:
		if attribute == "RootResourceId" {
			return localPhysicalID("resource", name), nil
		}
	case typeCloudFormationCustomResource, "Custom::Trigger":
		return nil, fmt.Errorf("Fn::GetAtt %s.%s reads a custom resource's Data, which the handler has not reported yet", name, attribute)
	}
	return r.resolveGetAtt(name, attribute, stack, r.resourceIndex(), r.resourceValues)
}

// resolveJSONSub resolves the `Fn::Sub` form with a string and an optional
// variable map.
//
//nolint:gocyclo // the substitution grammar has one branch per reference form.
func (r *Runner) resolveJSONSub(spec *Spec, stack string, raw any) (any, error) {
	var text string
	variables := map[string]any{}
	switch typed := raw.(type) {
	case string:
		text = typed
	case []any:
		if len(typed) != 2 {
			return nil, errors.New("Fn::Sub must be a string or [string, variables]")
		}
		value, ok := typed[0].(string)
		if !ok {
			return nil, errors.New("Fn::Sub template must be a string")
		}
		text = value
		mapping, ok := typed[1].(map[string]any)
		if !ok {
			return nil, errors.New("Fn::Sub variables must be an object")
		}
		variables = mapping
	default:
		return nil, errors.New("Fn::Sub must be a string or [string, variables]")
	}
	var out strings.Builder
	for index := 0; index < len(text); index++ {
		if text[index] != '$' || index+1 >= len(text) || text[index+1] != '{' {
			out.WriteByte(text[index])
			continue
		}
		end := strings.IndexByte(text[index+2:], '}')
		if end < 0 {
			return nil, errors.New("Fn::Sub has an unterminated ${...} reference")
		}
		name := text[index+2 : index+2+end]
		index += 2 + end
		if strings.HasPrefix(name, "!") {
			out.WriteString(name[1:])
			continue
		}
		var value any
		if mapped, ok := variables[name]; ok {
			resolved, err := r.resolveJSONValue(spec, stack, mapped)
			if err != nil {
				return nil, err
			}
			value = resolved
		} else if strings.Contains(name, ".") {
			parts := strings.SplitN(name, ".", 2)
			resolved, err := r.resolveJSONGetAtt(spec, stack, parts[0], parts[1])
			if err != nil {
				return nil, err
			}
			value = resolved
		} else {
			resolved, err := r.resolveJSONRef(spec, stack, name)
			if err != nil {
				return nil, err
			}
			value = resolved
		}
		text, ok := jsonScalarString(value)
		if !ok {
			return nil, fmt.Errorf("Fn::Sub variable %q is not a scalar", name)
		}
		out.WriteString(text)
	}
	return out.String(), nil
}

// jsonScalarString renders a resolved scalar for concatenation.
func jsonScalarString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case float64:
		if typed == float64(int64(typed)) {
			return fmt.Sprint(int64(typed)), true
		}
		return fmt.Sprint(typed), true
	case bool:
		return fmt.Sprint(typed), true
	default:
		return "", false
	}
}

// jsonIndex reads a list index from a resolved value.
func jsonIndex(value any) (int, error) {
	switch typed := value.(type) {
	case float64:
		return int(typed), nil
	case string:
		var index int
		if _, err := fmt.Sscanf(typed, "%d", &index); err != nil {
			return 0, fmt.Errorf("Fn::Select index %q is not a number", typed)
		}
		return index, nil
	default:
		return 0, fmt.Errorf("Fn::Select index is not a number (%T)", value)
	}
}

// stackAccount returns the AWS account a stack deploys into: the assembly
// environment's account, or the runner's local identity when the environment is
// unresolved.
func (r *Runner) stackAccount(spec *Spec, stack string) string {
	if spec != nil && spec.accounts != nil {
		if account := spec.accounts[stack]; account != "" {
			return account
		}
	}
	return LocalAccountID
}

// stackRegion returns the AWS region a stack deploys into.
func stackRegion(spec *Spec, stack string) string {
	if spec != nil && spec.regions != nil {
		if region := spec.regions[stack]; region != "" {
			return region
		}
	}
	return LocalRegion
}

// resource returns one template resource by stack and logical id.
func (s *Spec) resource(stack, logicalID string) (ResourceSpec, bool) {
	for _, resource := range s.Resources {
		if resource.Stack == stack && resource.LogicalID == logicalID {
			return resource, true
		}
	}
	return ResourceSpec{}, false
}

// resourceIndex groups the assembly's resources by stack for the environment
// resolver.
func (r *Runner) resourceIndex() map[string]map[string]ResourceSpec {
	index := map[string]map[string]ResourceSpec{}
	spec := r.CurrentSpec()
	if spec == nil {
		return index
	}
	for _, resource := range spec.Resources {
		if index[resource.Stack] == nil {
			index[resource.Stack] = map[string]ResourceSpec{}
		}
		index[resource.Stack][resource.LogicalID] = resource
	}
	return index
}

// localRoleARN is the ARN a role has in the stack's account. A role that names
// no RoleName gets the runner's deterministic local name, exactly like every
// other locally resolved resource.
func localRoleARN(spec *Spec, stack string, resource ResourceSpec) string {
	name, err := resourceName(resource)
	if err != nil {
		name = sanitizeName(resource.LogicalID)
	}
	return "arn:" + LocalPartition + ":iam::" + stackAccountFor(spec, stack) + ":role/" + name
}

// localFunctionARN is the ARN a function has in the stack's account. The name
// is the same deterministic local name every other resolved function reference
// produces, so `Fn::GetAtt [Fn, Arn]`, a policy resource and the Lambda invoke
// endpoint all agree.
func functionARNFor(spec *Spec, stack string, resource ResourceSpec) string {
	name, err := resourceName(resource)
	if err != nil {
		name = sanitizeName(resource.LogicalID)
	}
	return "arn:" + LocalPartition + ":lambda:" + stackRegion(spec, stack) + ":" + stackAccountFor(spec, stack) +
		":function:" + name
}

// stackAccountFor is the runner-free form of stackAccount.
func stackAccountFor(spec *Spec, stack string) string {
	if spec != nil && spec.accounts != nil {
		if account := spec.accounts[stack]; account != "" {
			return account
		}
	}
	return LocalAccountID
}

// functionARN is the local ARN of a qualified function id.
func (r *Runner) functionARN(spec *Spec, qualified string) string {
	for _, function := range spec.Functions {
		if function.LogicalID != qualified {
			continue
		}
		resource, ok := spec.resource(function.Stack, baseLogicalID(function))
		if !ok {
			return ""
		}
		return functionARNFor(spec, function.Stack, resource)
	}
	return ""
}

// baseLogicalID returns the template logical id of a function spec. A
// single-stack assembly does not qualify it; a multi-stack one stores
// `<stack>/<logical id>`.
func baseLogicalID(function FunctionSpec) string {
	if function.Stack == "" {
		return function.LogicalID
	}
	return strings.TrimPrefix(function.LogicalID, function.Stack+"/")
}
