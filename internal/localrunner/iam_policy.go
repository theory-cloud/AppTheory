package localrunner

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// The narrow IAM path (docs/127 W3-D1, as amended).
//
// Every call between the applications the local runner serves is authorized by
// IAM and signed with Signature Version 4. The runner verifies the signature,
// resolves the caller principal, evaluates exactly the three policy kinds the
// local stacks synthesize — the API's resource policy, the caller's identity
// policies and an STS role's trust policy — and fails closed with a named error
// for anything outside the enumerated statement shapes. It is a narrow, fully
// specified evaluation under docs/125 D2, not a partial IAM evaluator.
//
// AWS pages this file follows, cited so a reader can verify every rule:
//   - policy evaluation logic (combination, explicit deny, cross-account):
//     https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html
//   - global condition context keys (aws:PrincipalArn):
//     https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html
//   - execute-api ARN format and IAM authorization for API Gateway:
//     https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html
//   - Signature Version 4 for API requests:
//     https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html
//   - temporary credentials and the session token:
//     https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_use-resources.html

const (
	// iamActionInvoke is the only action an invoke-policy statement may name.
	iamActionInvoke = "execute-api:Invoke"
	// iamActionAssumeRole is the only action a trust-policy statement may name.
	iamActionAssumeRole = "sts:AssumeRole"
	// iamActionInvokeFunctionURL and iamActionInvokeFunction are the two actions
	// a Function URL's AWS_IAM authorization evaluates. Lambda documents that a
	// caller needs both.
	// https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
	iamActionInvokeFunctionURL = "lambda:InvokeFunctionUrl"
	iamActionInvokeFunction    = "lambda:InvokeFunction"
	// iamFunctionURLTypeKey is the condition key a Function URL resource policy
	// may pin its auth type with.
	iamFunctionURLTypeKey = "lambda:FunctionUrlAuthType"
	// iamEffectAllow and iamEffectDeny are the two effects.
	iamEffectAllow = "Allow"
	iamEffectDeny  = "Deny"
	// iamPrincipalARNKey is the one condition key the subset evaluates.
	iamPrincipalARNKey = "aws:PrincipalArn"
	// iamStringEquals is the one condition operator the subset evaluates.
	iamStringEquals = "StringEquals"
	// iamExecuteAPIService is the SigV4 service name of an execute-api call.
	iamExecuteAPIService = "execute-api"
	// iamSignatureWindow is AWS's tolerance between a request's X-Amz-Date and
	// the service clock.
	// https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
	iamSignatureWindow = 15 * time.Minute
)

// iamRoleSpec is one IAM role the assembly declares: the ARN a caller has, the
// trust policy that decides AssumeRole, and the identity policies attached to
// it. The documents stay raw; the evaluator resolves them against the assembly
// when a call is evaluated, so a document that references a resource resolves
// to the same local value every other resolver produces.
type iamRoleSpec struct {
	ARN      string            `json:"arn"`
	Account  string            `json:"account"`
	Name     string            `json:"name"`
	Stack    string            `json:"stack"`
	Logical  string            `json:"logicalId"`
	Trust    json.RawMessage   `json:"trust,omitempty"`
	Identity []json.RawMessage `json:"identity,omitempty"`
}

// iamPolicyDocument is a resolved policy document.
type iamPolicyDocument struct {
	Version   string               `json:"Version"`
	Statement []iamPolicyStatement `json:"Statement"`
}

// iamPolicyStatement is one resolved statement. Principal stays a raw value
// because a resource policy serializes it as a string, an object or a list.
type iamPolicyStatement struct {
	Effect       string          `json:"Effect"`
	Action       json.RawMessage `json:"Action,omitempty"`
	Resource     json.RawMessage `json:"Resource,omitempty"`
	Principal    json.RawMessage `json:"Principal,omitempty"`
	Condition    json.RawMessage `json:"Condition,omitempty"`
	NotAction    json.RawMessage `json:"NotAction,omitempty"`
	NotResource  json.RawMessage `json:"NotResource,omitempty"`
	NotPrincipal json.RawMessage `json:"NotPrincipal,omitempty"`
}

// statementShape is the enumerated form of one statement.
type statementShape struct {
	effect     string
	actions    []string
	resources  []string
	principals []string
	// principalIsRoot marks the account-root form `arn:aws:iam::<account>:root`.
	principalRoots []string
	// principalNamed is false when the statement names a wildcard principal.
	principalNamed bool
	// principalAbsent is true when the statement carries no Principal element,
	// which is what an identity-policy statement looks like: it applies to the
	// policy's subject.
	principalAbsent bool
	// conditions holds the aws:PrincipalArn values a StringEquals requires.
	conditions []string
	// trust is true when the statement came from a trust policy, where the
	// action must be sts:AssumeRole.
	trust bool
	// functionURL is true when the statement authorizes a Function URL call,
	// where the actions are lambda:InvokeFunctionUrl and lambda:InvokeFunction
	// and the resource is the function ARN.
	functionURL bool
	// functionURLType is the lambda:FunctionUrlAuthType value the statement
	// pins, when it pins one.
	functionURLType string
}

// wantedAction returns the action one statement kind must name.
func wantedAction(trust, functionURL bool) string {
	switch {
	case trust:
		return iamActionAssumeRole
	case functionURL:
		return iamActionInvokeFunctionURL
	default:
		return iamActionInvoke
	}
}

// outOfSubsetError is the named refusal an out-of-subset statement produces.
type outOfSubsetError struct{ reason string }

func (e *outOfSubsetError) Error() string { return e.reason }

// unsupportedStatement is the error an out-of-subset statement returns.
func unsupportedStatement(format string, args ...any) error {
	return &outOfSubsetError{reason: fmt.Sprintf(format, args...)}
}

// iamPrincipal is the resolved caller.
type iamPrincipal struct {
	// ARN is the caller's ARN: a role ARN for issued credentials, or the
	// assumed-role ARN for a session.
	ARN string
	// Account is the account the caller belongs to.
	Account string
	// BaseARN is the base role or user ARN the caller's credentials belong to.
	// aws:PrincipalArn is compared against it, never the session ARN.
	BaseARN string
	// Session marks assumed-role credentials.
	Session bool
	// AccessKeyID is the access key the request was signed with.
	AccessKeyID string
	// UserID is the unique id IAM reports for the principal; the event identity
	// carries it as the user id.
	UserID string
}

// iamDecision is one evaluation.
type iamDecision struct {
	Allowed bool
	// Reason names why a call was refused.
	Reason string
}

// deriveIAMRoles records every IAM role the assembly declares with its trust
// and identity documents.
//
//nolint:gocognit // one branch per role and policy resource.
func deriveIAMRoles(spec *Spec, stacks []assemblyStack) { //nolint:gocyclo // one branch per role and policy resource.
	roles := map[string]int{}
	for _, stack := range stacks {
		for _, id := range sortedKeys(stack.Template.Resources) {
			resource := stack.Template.Resources[id]
			if resource.Type != typeIAMRole {
				continue
			}
			var props iamRoleProperties
			if len(resource.Properties) > 0 {
				if err := json.Unmarshal(resource.Properties, &props); err != nil {
					spec.Skipped = append(spec.Skipped, Skipped{
						LogicalID: id,
						Kind:      typeIAMRole,
						Reason:    "the role's properties are not a JSON object: " + err.Error(),
					})
					continue
				}
			}
			name, err := resourceName(ResourceSpec{Stack: stack.Name, LogicalID: id, Type: typeIAMRole, Properties: resource.Properties})
			if err != nil {
				name = sanitizeName(id)
			}
			role := iamRoleSpec{
				ARN:     "arn:" + LocalPartition + ":iam::" + stackAccountFor(spec, stack.Name) + ":role/" + name,
				Account: stackAccountFor(spec, stack.Name),
				Name:    name,
				Stack:   stack.Name,
				Logical: id,
				Trust:   props.AssumeRolePolicyDocument,
			}
			for _, policy := range props.Policies {
				if len(policy.PolicyDocument) > 0 {
					role.Identity = append(role.Identity, policy.PolicyDocument)
				}
			}
			roles[role.ARN] = len(spec.IAMRoles)
			spec.IAMRoles = append(spec.IAMRoles, role)
		}
	}
	// A policy resource attaches its document to the roles it names. A managed
	// policy attaches the same way.
	for _, stack := range stacks {
		types := stack.resourceTypes()
		for _, id := range sortedKeys(stack.Template.Resources) {
			resource := stack.Template.Resources[id]
			if resource.Type != typeIAMPolicy && resource.Type != typeIAMManagedPolicy {
				continue
			}
			var props iamPolicyProperties
			if len(resource.Properties) > 0 {
				if err := json.Unmarshal(resource.Properties, &props); err != nil {
					continue
				}
			}
			if len(props.PolicyDocument) == 0 {
				continue
			}
			for _, raw := range props.Roles {
				roleID, ok := directRefID(raw)
				if !ok || types[roleID] != typeIAMRole {
					continue
				}
				role, ok := roleSpecByID(spec, stack.Name, roleID)
				if !ok {
					continue
				}
				index := roles[role.ARN]
				spec.IAMRoles[index].Identity = append(spec.IAMRoles[index].Identity, props.PolicyDocument)
			}
		}
	}
	sort.SliceStable(spec.IAMRoles, func(i, j int) bool { return spec.IAMRoles[i].ARN < spec.IAMRoles[j].ARN })
}

// iamRoleProperties is the part of an IAM role the derivation reads.
type iamRoleProperties struct {
	RoleName                 string          `json:"RoleName"`
	AssumeRolePolicyDocument json.RawMessage `json:"AssumeRolePolicyDocument"`
	Policies                 []struct {
		PolicyDocument json.RawMessage `json:"PolicyDocument"`
	} `json:"Policies"`
}

// iamPolicyProperties is the part of an IAM policy resource the derivation
// reads.
type iamPolicyProperties struct {
	PolicyDocument json.RawMessage   `json:"PolicyDocument"`
	Roles          []json.RawMessage `json:"Roles"`
}

// roleSpecByID finds a role spec by stack and logical id.
func roleSpecByID(spec *Spec, stack, logicalID string) (iamRoleSpec, bool) {
	for _, role := range spec.IAMRoles {
		if role.Stack == stack && role.Logical == logicalID {
			return role, true
		}
	}
	return iamRoleSpec{}, false
}

// functionRoleARN returns the role ARN a function runs as, from its Role
// property.
func (s *Spec) functionRoleARN(function FunctionSpec) string {
	resource, ok := s.resource(function.Stack, baseLogicalID(function))
	if !ok {
		return ""
	}
	var props struct {
		Role json.RawMessage `json:"Role"`
	}
	if len(resource.Properties) > 0 {
		if err := json.Unmarshal(resource.Properties, &props); err != nil {
			return ""
		}
	}
	types := make(map[string]string, len(s.Resources))
	for _, candidate := range s.Resources {
		if candidate.Stack == function.Stack {
			types[candidate.LogicalID] = candidate.Type
		}
	}
	roleID, ok := findRefByType(props.Role, types, typeIAMRole, "Arn")
	if !ok {
		return ""
	}
	roleResource, ok := s.resource(function.Stack, roleID)
	if !ok {
		return ""
	}
	return localRoleARN(s, function.Stack, roleResource)
}

// parsePolicyDocument decodes one resolved policy document. A document with no
// statement is empty, not invalid.
func parsePolicyDocument(raw []byte) (iamPolicyDocument, error) {
	var document iamPolicyDocument
	if len(raw) == 0 {
		return document, nil
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		return document, fmt.Errorf("the policy document is not JSON: %w", err)
	}
	return document, nil
}

// shapeStatement turns one statement into the enumerated shape, or fails closed
// with a named error when the statement is outside the subset.
func shapeStatement(statement iamPolicyStatement, trust bool) (statementShape, error) {
	return shapeStatementFor(statement, trust, false)
}

// statementScope is the part of a statement that decides whether it could apply
// to a call: its effect, its actions and its resource patterns. A statement
// outside the subset here fails closed immediately, because an unreadable
// action or effect could grant or deny anything.
type statementScope struct {
	effect      string
	actions     []string
	resources   []string
	trust       bool
	functionURL bool
}

// shapeStatementScope reads the effect, actions and resources of one statement.
//
//nolint:gocyclo // one branch per enumerated element.
func shapeStatementScope(statement iamPolicyStatement, trust, functionURL bool) (statementScope, error) {
	scope := statementScope{trust: trust, functionURL: functionURL}
	if statement.NotAction != nil || statement.NotResource != nil || statement.NotPrincipal != nil {
		return scope, unsupportedStatement(
			"a NotAction, NotResource or NotPrincipal statement is outside the local IAM subset (docs/127 W3-D1)")
	}
	switch statement.Effect {
	case iamEffectAllow:
		scope.effect = iamEffectAllow
	case iamEffectDeny:
		scope.effect = iamEffectDeny
	default:
		return scope, unsupportedStatement("an Effect of %q is outside the local IAM subset", statement.Effect)
	}
	actions, err := stringList(statement.Action)
	if err != nil {
		return scope, err
	}
	if len(actions) == 0 {
		return scope, unsupportedStatement("a statement with no Action is outside the local IAM subset")
	}
	wanted := wantedAction(trust, functionURL)
	accepted := []string{wanted}
	if functionURL {
		// Lambda requires both actions for a Function URL call.
		accepted = []string{iamActionInvokeFunctionURL, iamActionInvokeFunction}
	}
	for _, action := range actions {
		matched := false
		for _, candidate := range accepted {
			if action == candidate {
				matched = true
				break
			}
		}
		if matched {
			scope.actions = append(scope.actions, action)
			continue
		}
		for _, candidate := range accepted {
			if actionCouldMatch(action, candidate) {
				return scope, unsupportedStatement(
					"an Action of %q is outside the local IAM subset; only %s is evaluated (docs/127 W3-D1)",
					action, strings.Join(accepted, " and "))
			}
		}
	}
	if len(scope.actions) == 0 {
		// The statement cannot authorize or deny this kind of call. Nothing
		// about its other elements can change this call.
		return statementScope{}, errStatementIrrelevant
	}
	resources, err := stringList(statement.Resource)
	if err != nil {
		return scope, err
	}
	if len(resources) == 0 && !trust {
		return scope, unsupportedStatement("a statement with no Resource is outside the local IAM subset")
	}
	scope.resources = resources
	return scope, nil
}

// applicability validates the elements of a statement that already matched a
// call: its Principal and its Condition. A statement whose scope does not match
// the call is never checked, so an out-of-subset condition on another resource
// does not poison this one.
func applicability(statement iamPolicyStatement, scope statementScope) (statementShape, error) {
	shape := statementShape{effect: scope.effect, trust: scope.trust, functionURL: scope.functionURL, actions: scope.actions, resources: scope.resources}
	if !scope.trust {
		principals, roots, named, err := shapePrincipals(statement.Principal, true)
		if err != nil {
			return shape, err
		}
		shape.principals, shape.principalRoots, shape.principalNamed = principals, roots, named
		shape.principalAbsent = len(statement.Principal) == 0
	} else {
		principals, roots, named, err := shapePrincipals(statement.Principal, false)
		if err != nil {
			return shape, err
		}
		if len(principals) == 0 && len(roots) == 0 {
			return shape, unsupportedStatement("a trust statement with no Principal is outside the local IAM subset")
		}
		shape.principals, shape.principalRoots, shape.principalNamed = principals, roots, named
	}
	extraKey := ""
	if shape.functionURL {
		extraKey = iamFunctionURLTypeKey
	}
	conditions, err := shapeConditions(statement.Condition, extraKey)
	if err != nil {
		return shape, err
	}
	shape.conditions = conditions
	if shape.functionURL {
		authType, err := shapeFunctionURLType(statement.Condition)
		if err != nil {
			return shape, err
		}
		shape.functionURLType = authType
	}
	return shape, nil
}

// shapeStatementFor turns one statement into the enumerated shape for a policy
// kind: an invoke policy, a trust policy or a Function URL policy.
//
//nolint:gocognit // one branch per enumerated element.
func shapeStatementFor(statement iamPolicyStatement, trust, functionURL bool) (statementShape, error) { //nolint:gocyclo // one branch per enumerated element.
	shape := statementShape{effect: statement.Effect, trust: trust, functionURL: functionURL}
	if statement.NotAction != nil || statement.NotResource != nil || statement.NotPrincipal != nil {
		return shape, unsupportedStatement(
			"a NotAction, NotResource or NotPrincipal statement is outside the local IAM subset (docs/127 W3-D1)")
	}
	switch statement.Effect {
	case iamEffectAllow:
		shape.effect = iamEffectAllow
	case iamEffectDeny:
		shape.effect = iamEffectDeny
	default:
		return shape, unsupportedStatement("an Effect of %q is outside the local IAM subset", statement.Effect)
	}
	actions, err := stringList(statement.Action)
	if err != nil {
		return shape, err
	}
	if len(actions) == 0 {
		return shape, unsupportedStatement("a statement with no Action is outside the local IAM subset")
	}
	wanted := wantedAction(trust, functionURL)
	accepted := []string{wanted}
	if functionURL {
		// Lambda requires both actions for a Function URL call.
		accepted = []string{iamActionInvokeFunctionURL, iamActionInvokeFunction}
	}
	for _, action := range actions {
		matched := false
		for _, candidate := range accepted {
			if action == candidate {
				matched = true
				break
			}
		}
		if matched {
			shape.actions = append(shape.actions, action)
			continue
		}
		for _, candidate := range accepted {
			if actionCouldMatch(action, candidate) {
				return shape, unsupportedStatement(
					"an Action of %q is outside the local IAM subset; only %s is evaluated (docs/127 W3-D1)",
					action, strings.Join(accepted, " and "))
			}
		}
	}
	if len(shape.actions) == 0 {
		// The statement cannot authorize or deny this kind of call, so it is
		// not part of this evaluation.
		return statementShape{}, errStatementIrrelevant
	}
	resources, err := stringList(statement.Resource)
	if err != nil {
		return shape, err
	}
	if len(resources) == 0 && !trust {
		// A trust policy's statement names no Resource: the role itself is the
		// resource, and AWS's trust-policy form omits the element.
		// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic-cross-account.html
		return shape, unsupportedStatement("a statement with no Resource is outside the local IAM subset")
	}
	for _, resource := range resources {
		if strings.ContainsAny(resource, "?") {
			return shape, unsupportedStatement(
				"a Resource of %q uses a wildcard the execute-api ARN format does not define; only a stage segment or a trailing path segment may be a wildcard (docs/127 W3-D1)",
				resource)
		}
	}
	shape.resources = resources
	if !trust {
		principals, roots, named, principalErr := shapePrincipals(statement.Principal, true)
		if principalErr != nil {
			return shape, principalErr
		}
		shape.principals, shape.principalRoots, shape.principalNamed = principals, roots, named
		shape.principalAbsent = len(statement.Principal) == 0
	} else {
		principals, roots, named, principalErr := shapePrincipals(statement.Principal, false)
		if principalErr != nil {
			return shape, principalErr
		}
		if len(principals) == 0 && len(roots) == 0 {
			return shape, unsupportedStatement("a trust statement with no Principal is outside the local IAM subset")
		}
		shape.principals, shape.principalRoots, shape.principalNamed = principals, roots, named
	}
	extraKey := ""
	if shape.functionURL {
		extraKey = iamFunctionURLTypeKey
	}
	conditions, err := shapeConditions(statement.Condition, extraKey)
	if err != nil {
		return shape, err
	}
	shape.conditions = conditions
	if shape.functionURL {
		authType, err := shapeFunctionURLType(statement.Condition)
		if err != nil {
			return shape, err
		}
		shape.functionURLType = authType
	}
	return shape, nil
}

// shapeFunctionURLType reads the lambda:FunctionUrlAuthType condition a Function
// URL resource policy may carry. It is enumerated: only StringEquals on that one
// key, with the value the URL declares.
func shapeFunctionURLType(raw json.RawMessage) (string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var decoded map[string]map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return "", unsupportedStatement("a Condition outside the local IAM subset fails closed (docs/127 W3-D1)")
	}
	for operator, keys := range decoded {
		if operator != iamStringEquals {
			return "", unsupportedStatement(
				"a Condition operator of %q is outside the local IAM subset; only StringEquals is evaluated (docs/127 W3-D1)", operator)
		}
		for key, value := range keys {
			if key != iamFunctionURLTypeKey {
				return "", unsupportedStatement(
					"a Condition key of %q is outside the local IAM subset; a Function URL policy may pin %s (docs/127 W3-D1)",
					key, iamFunctionURLTypeKey)
			}
			text, ok := value.(string)
			if !ok {
				return "", unsupportedStatement("a %s condition must be a string", iamFunctionURLTypeKey)
			}
			return text, nil
		}
	}
	return "", nil
}

// errStatementIrrelevant marks a statement the evaluation skips because its
// action cannot match the call. It is not a failure: an `s3:GetObject` grant
// provably cannot authorize or deny an execute-api call.
var errStatementIrrelevant = errors.New("statement does not apply to this call")

// actionCouldMatch reports whether an action pattern could match the wanted
// action, which is what decides whether an out-of-subset action fails closed.
func actionCouldMatch(pattern, wanted string) bool {
	if pattern == "*" || pattern == wanted {
		return true
	}
	if !strings.Contains(pattern, "*") {
		return false
	}
	prefix, _, _ := strings.Cut(pattern, "*")
	return strings.HasPrefix(wanted, prefix)
}

// shapePrincipals reads a Principal element into exact ARNs and account roots.
// requiresExactRole is true for an identity policy, where a Principal element
// is invalid IAM.
func shapePrincipals(raw json.RawMessage, identityPolicy bool) ([]string, []string, bool, error) {
	if len(raw) == 0 {
		if identityPolicy {
			return nil, nil, true, nil
		}
		return nil, nil, true, nil
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, nil, false, unsupportedStatement("the Principal element is not JSON")
	}
	values := []string{}
	collectPrincipalValues(decoded, &values)
	var arns, roots []string
	for _, value := range values {
		value = strings.TrimSpace(value)
		switch {
		case value == "":
			continue
		case value == "*":
			return nil, nil, false, unsupportedStatement(
				"a wildcard Principal is outside the local IAM subset; an exact role, user or account-root ARN is accepted (docs/127 W3-D1)")
		case strings.Contains(value, "*"):
			return nil, nil, false, unsupportedStatement(
				"a Principal of %q uses a wildcard, which is outside the local IAM subset (docs/127 W3-D1)", value)
		case strings.HasSuffix(value, ":root"):
			roots = append(roots, value)
		case strings.HasPrefix(value, "arn:") && strings.Contains(value, ":iam::"):
			arns = append(arns, value)
		default:
			return nil, nil, false, unsupportedStatement(
				"a Principal of %q is outside the local IAM subset; an exact role or user ARN, or an account-root ARN, is accepted (docs/127 W3-D1)", value)
		}
	}
	return arns, roots, true, nil
}

// collectPrincipalValues walks the Principal element's documented forms: a
// string, an object whose values are strings or lists, or a list.
func collectPrincipalValues(value any, out *[]string) {
	switch typed := value.(type) {
	case string:
		*out = append(*out, typed)
	case []any:
		for _, item := range typed {
			collectPrincipalValues(item, out)
		}
	case map[string]any:
		for _, item := range typed {
			collectPrincipalValues(item, out)
		}
	}
}

// shapeConditions reads the one condition form the subset evaluates.
//
//nolint:gocyclo // one branch per accepted condition element.
func shapeConditions(raw json.RawMessage, extraKey string) ([]string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var decoded map[string]map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		var generic map[string]any
		if len(raw) > 0 && json.Unmarshal(raw, &generic) == nil && len(generic) == 0 {
			return nil, nil
		}
		return nil, unsupportedStatement("a Condition outside the local IAM subset fails closed (docs/127 W3-D1)")
	}
	var values []string
	for operator, keys := range decoded {
		if operator != iamStringEquals {
			return nil, unsupportedStatement(
				"a Condition operator of %q is outside the local IAM subset; only StringEquals on %s is evaluated (docs/127 W3-D1)",
				operator, iamPrincipalARNKey)
		}
		for key, value := range keys {
			if key == extraKey {
				// The caller-shaped check for this key is separate: a Function
				// URL policy may pin lambda:FunctionUrlAuthType, which is not a
				// principal comparison.
				continue
			}
			if key != iamPrincipalARNKey {
				return nil, unsupportedStatement(
					"a Condition key of %q is outside the local IAM subset; only %s is evaluated (docs/127 W3-D1)",
					key, iamPrincipalARNKey)
			}
			list, err := conditionStringList(value)
			if err != nil {
				return nil, err
			}
			for _, candidate := range list {
				if strings.Contains(candidate, "*") || strings.Contains(candidate, "?") {
					return nil, unsupportedStatement(
						"a %s value of %q uses a wildcard, which is outside the local IAM subset (docs/127 W3-D1)",
						iamPrincipalARNKey, candidate)
				}
				values = append(values, candidate)
			}
		}
	}
	return values, nil
}

// conditionStringList reads a condition value that is a string or a list.
func conditionStringList(value any) ([]string, error) {
	switch typed := value.(type) {
	case string:
		return []string{typed}, nil
	case []any:
		out := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, unsupportedStatement("a condition value that is not a string is outside the local IAM subset")
			}
			out = append(out, text)
		}
		return out, nil
	default:
		return nil, unsupportedStatement("a condition value that is not a string or a list is outside the local IAM subset")
	}
}

// stringList reads a string or a list of strings.
func stringList(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		return []string{single}, nil
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	return nil, unsupportedStatement("an element that is neither a string nor a list of strings is outside the local IAM subset")
}
