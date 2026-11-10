package localrunner

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Policy evaluation.
//
// The runner evaluates exactly the three policy kinds the local stacks
// synthesize, over the statement shapes docs/127 W3-D1 enumerates, and combines
// them with AWS's published rule:
//
//   - an explicit Deny in any evaluated statement refuses the call;
//   - within one account, one Allow in either the caller's identity policy or
//     the resource policy grants the call;
//   - across accounts, the identity policy and the resource policy must each
//     accept;
//   - otherwise the call fails closed.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html
//
// A statement outside the enumerated shapes fails closed with a named error, so
// nothing is guessed.

// iamCall is one call the evaluator decides.
type iamCall struct {
	// API is the surface being called.
	API APISpec
	// Stack is the stack the API belongs to.
	Stack string
	// Method and Path are the request's method and its path without the stage
	// prefix.
	Method string
	Path   string
	// Stage is the stage the call is served under: the API's stage, or the
	// stage segment the caller used.
	Stage string
	// Caller is the resolved principal.
	Caller iamPrincipal
}

// arnFor returns the full execute-api ARN a call names.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html
func (r *Runner) arnFor(spec *Spec, call iamCall) string {
	apiID := localPhysicalID("api", call.API.LogicalID)
	account := stackAccountFor(spec, call.Stack)
	region := stackRegion(spec, call.Stack)
	return "arn:" + LocalPartition + ":execute-api:" + region + ":" + account + ":" + apiID + "/" +
		call.Stage + "/" + strings.ToUpper(call.Method) + "/" + strings.TrimPrefix(call.Path, "/")
}

// iamResourceAccount returns the account the API being called belongs to.
func (r *Runner) iamResourceAccount(spec *Spec, call iamCall) string {
	return stackAccountFor(spec, call.Stack)
}

// iamAllowsInvoke evaluates one AWS_IAM call and returns the decision. A
// Function URL surface evaluates lambda:InvokeFunctionUrl and
// lambda:InvokeFunction against the function's resource policy instead of an
// API's execute-api policy.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html
// https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
func (r *Runner) iamAllowsInvoke(spec *Spec, call iamCall) iamDecision {
	if call.API.Class == APIFunctionURL {
		return r.iamAllowsFunctionURL(spec, call)
	}
	if call.Caller.ARN == "" {
		return iamDecision{Reason: "the caller principal could not be resolved"}
	}
	resourceAccount := r.iamResourceAccount(spec, call)
	// A resource policy's Principal is matched against the caller's account and
	// base ARN, so the statement shapes are resolved once with that context.
	resourceAllowed, resourceDeny, err := r.evaluateResourcePolicy(spec, call)
	if err != nil {
		return iamDecision{Reason: err.Error()}
	}
	identityAllowed, identityDeny, err := r.evaluateIdentityPolicies(spec, call)
	if err != nil {
		return iamDecision{Reason: err.Error()}
	}
	switch {
	case resourceDeny || identityDeny:
		return iamDecision{Reason: "an explicit Deny statement refuses the call (IAM policy evaluation logic)"}
	case call.Caller.Account == resourceAccount:
		// Same account: one Allow in either policy grants the call.
		if resourceAllowed || identityAllowed {
			return iamDecision{Allowed: true}
		}
		return iamDecision{Reason: fmt.Sprintf(
			"no identity policy on %s and no resource policy on %s allows %s (same-account union rule)",
			call.Caller.BaseARN, call.API.LogicalID, r.arnFor(spec, call))}
	default:
		// Cross account: both must allow.
		if resourceAllowed && identityAllowed {
			return iamDecision{Allowed: true}
		}
		var missing []string
		if !resourceAllowed {
			missing = append(missing, "the API's resource policy")
		}
		if !identityAllowed {
			missing = append(missing, "an identity policy on "+call.Caller.BaseARN)
		}
		return iamDecision{Reason: fmt.Sprintf(
			"a cross-account call needs both policies to allow %s; %s does not (cross-account intersection rule)",
			r.arnFor(spec, call), strings.Join(missing, " and "))}
	}
}

// evaluateResourcePolicy evaluates the API's resource policy.
func (r *Runner) evaluateResourcePolicy(spec *Spec, call iamCall) (bool, bool, error) {
	if len(call.API.ResourcePolicy) == 0 {
		return false, false, nil
	}
	document, err := r.resolvePolicyDocument(spec, call.Stack, call.API.ResourcePolicy)
	if err != nil {
		return false, false, fmt.Errorf("the API's resource policy cannot be resolved: %w", err)
	}
	target, err := r.policyTarget(spec, call)
	if err != nil {
		return false, false, err
	}
	var allowed, denied bool
	for _, statement := range document.Statement {
		shape, applies, shapeErr := statementAppliesToInvoke(statement, target)
		if shapeErr != nil {
			return false, false, fmt.Errorf("the API's resource policy has a statement outside the local subset: %w", shapeErr)
		}
		if !applies || !principalMatches(shape, call.Caller) || !conditionsMatch(shape, call.Caller) {
			continue
		}
		switch shape.effect {
		case iamEffectAllow:
			allowed = true
		case iamEffectDeny:
			denied = true
		}
	}
	return allowed, denied, nil
}

// statementAppliesToInvoke decides whether one execute-api statement could
// apply to the call, and returns its enumerated shape when it does. A statement
// outside the subset fails closed only when its scope reaches this call, so an
// out-of-subset statement on another route does not refuse every request.
func statementAppliesToInvoke(statement iamPolicyStatement, target policyTarget) (statementShape, bool, error) {
	scope, err := shapeStatementScope(statement, false, false)
	if errors.Is(err, errStatementIrrelevant) {
		return statementShape{}, false, nil
	}
	if err != nil {
		return statementShape{}, false, err
	}
	matched, matchErr := matchAnyResource(scope.resources, target)
	if matchErr != nil {
		return statementShape{}, false, matchErr
	}
	if !matched {
		return statementShape{}, false, nil
	}
	shape, err := applicability(statement, scope)
	if err != nil {
		return statementShape{}, false, err
	}
	return shape, true, nil
}

// matchAnyResource reports whether any pattern names the call.
func matchAnyResource(resources []string, target policyTarget) (bool, error) {
	for _, resource := range resources {
		matched, err := executeAPIResourceMatches(resource, target)
		if err != nil {
			return false, err
		}
		if matched {
			return true, nil
		}
	}
	return false, nil
}

// evaluateIdentityPolicies evaluates every identity policy attached to the
// caller's base role.
//
//nolint:gocyclo // one branch per policy kind and statement shape.
func (r *Runner) evaluateIdentityPolicies(spec *Spec, call iamCall) (bool, bool, error) {
	role, ok := r.iamRole(spec, call.Caller.BaseARN)
	if !ok {
		// A caller whose role this run cannot see has no identity policy it can
		// evaluate; a cross-account call then fails closed and a same-account
		// one needs the resource policy.
		return false, false, nil
	}
	target, err := r.policyTarget(spec, call)
	if err != nil {
		return false, false, err
	}
	var allowed, denied bool
	for _, raw := range role.Identity {
		document, docErr := r.resolvePolicyDocument(spec, role.Stack, raw)
		if docErr != nil {
			return false, false, fmt.Errorf("an identity policy on %s cannot be resolved: %w", role.ARN, docErr)
		}
		for _, statement := range document.Statement {
			shape, applies, shapeErr := statementAppliesToInvoke(statement, target)
			if shapeErr != nil {
				return false, false, fmt.Errorf("an identity policy on %s has a statement outside the local subset: %w", role.ARN, shapeErr)
			}
			if !applies {
				continue
			}
			if len(shape.principals) > 0 || len(shape.principalRoots) > 0 || !shape.principalNamed {
				// A Principal element in an identity policy is invalid IAM.
				return false, false, fmt.Errorf(
					"an identity policy on %s names a Principal, which is outside the local subset (docs/127 W3-D1)", role.ARN)
			}
			if !conditionsMatch(shape, call.Caller) {
				continue
			}
			switch shape.effect {
			case iamEffectAllow:
				allowed = true
			case iamEffectDeny:
				denied = true
			}
		}
	}
	return allowed, denied, nil
}

// iamAllowsAssumeRole decides AssumeRole by the role's trust policy alone.
//
// Locally the trust policy is the only decision, which is the named divergence
// docs/127 W3-D1 records: deployed AWS also requires an identity-side
// sts:AssumeRole grant on the caller.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic-cross-account.html
func (r *Runner) iamAllowsAssumeRole(spec *Spec, role iamRoleSpec, caller iamPrincipal) (bool, string) {
	if len(role.Trust) == 0 {
		return false, fmt.Sprintf("role %s declares no trust policy", role.ARN)
	}
	document, err := r.resolvePolicyDocument(spec, role.Stack, role.Trust)
	if err != nil {
		return false, fmt.Sprintf("role %s's trust policy cannot be resolved: %v", role.ARN, err)
	}
	var denied bool
	for _, statement := range document.Statement {
		scope, scopeErr := shapeStatementScope(statement, true, false)
		if errors.Is(scopeErr, errStatementIrrelevant) {
			continue
		}
		if scopeErr != nil {
			return false, fmt.Sprintf("role %s's trust policy has a statement outside the local subset: %v", role.ARN, scopeErr)
		}
		shape, shapeErr := applicability(statement, scope)
		if shapeErr != nil {
			return false, fmt.Sprintf("role %s's trust policy has a statement outside the local subset: %v", role.ARN, shapeErr)
		}
		if !principalMatches(shape, caller) {
			continue
		}
		if !conditionsMatch(shape, caller) {
			continue
		}
		switch shape.effect {
		case iamEffectAllow:
			return true, ""
		case iamEffectDeny:
			denied = true
		}
	}
	if denied {
		return false, fmt.Sprintf(
			"role %s's trust policy has an explicit Deny for %s (IAM policy evaluation logic)", role.ARN, caller.BaseARN)
	}
	return false, fmt.Sprintf(
		"role %s's trust policy does not name %s (or its account root); AssumeRole is decided by the trust policy alone locally (docs/127 W3-D1)",
		role.ARN, caller.BaseARN)
}

// principalMatches reports whether a statement's Principal accepts the caller.
// A statement with no Principal element applies to the policy's subject, which
// is every statement in an identity policy.
func principalMatches(shape statementShape, caller iamPrincipal) bool {
	if shape.principalAbsent {
		return true
	}
	for _, root := range shape.principalRoots {
		if accountRootAccount(root) == caller.Account {
			return true
		}
	}
	for _, arn := range shape.principals {
		if arn == caller.BaseARN || arn == caller.ARN {
			return true
		}
	}
	return false
}

// accountRootAccount extracts the account from `arn:<partition>:iam::<account>:root`.
func accountRootAccount(arn string) string {
	parts := strings.Split(arn, ":")
	if len(parts) < 5 {
		return ""
	}
	return parts[4]
}

// conditionsMatch reports whether the statement's condition, if any, accepts the
// caller. aws:PrincipalArn is compared against the base role ARN, never the
// assumed-role session ARN.
//
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html
func conditionsMatch(shape statementShape, caller iamPrincipal) bool {
	if len(shape.conditions) == 0 {
		return true
	}
	for _, candidate := range shape.conditions {
		if candidate == caller.BaseARN {
			return true
		}
	}
	return false
}

// policyTarget is the resolved form of the call's execute-api ARN.
type policyTarget struct {
	apiID   string
	account string
	region  string
	stage   string
	method  string
	path    string
}

// policyTarget resolves the call's ARN parts.
func (r *Runner) policyTarget(spec *Spec, call iamCall) (policyTarget, error) {
	apiID := localPhysicalID("api", call.API.LogicalID)
	return policyTarget{
		apiID:   apiID,
		account: stackAccountFor(spec, call.Stack),
		region:  stackRegion(spec, call.Stack),
		stage:   call.Stage,
		method:  strings.ToUpper(call.Method),
		path:    strings.TrimPrefix(call.Path, "/"),
	}, nil
}

// executeAPIResourceMatches matches one resource pattern against the target.
// Only the stage segment and a trailing path segment may be a wildcard; any
// other wildcard placement is out of subset.
//
//nolint:gocognit // one branch per accepted resource form.
func executeAPIResourceMatches(resource string, target policyTarget) (bool, error) { //nolint:gocyclo // one branch per accepted form.
	remainder := ""
	fragment := false
	switch {
	case strings.HasPrefix(resource, "execute-api:/"):
		remainder = strings.TrimPrefix(resource, "execute-api:/")
		fragment = true
	case strings.HasPrefix(resource, "arn:"):
		parts := strings.SplitN(resource, ":", 6)
		if len(parts) != 6 {
			return false, unsupportedStatement("the Resource %q is not a valid execute-api ARN", resource)
		}
		if parts[0] != "arn" || parts[2] != "execute-api" {
			return false, nil
		}
		if parts[3] != "" && parts[3] != "*" && parts[3] != target.region {
			return false, nil
		}
		if parts[4] != target.account {
			return false, nil
		}
		if parts[5] == "" {
			return false, nil
		}
		slash := strings.Index(parts[5], "/")
		if slash < 0 {
			return false, nil
		}
		apiID := parts[5][:slash]
		if apiID != target.apiID {
			return false, nil
		}
		remainder = parts[5][slash+1:]
	default:
		// A resource outside the execute-api service cannot name this call.
		return false, nil
	}
	_ = fragment
	segments := strings.Split(remainder, "/")
	pattern := strings.Split(target.stage+"/"+target.method+"/"+target.path, "/")
	if len(segments) < 3 {
		return false, unsupportedStatement("the Resource %q does not name a stage, a method and a path", resource)
	}
	for index, segment := range segments {
		if segment == "*" && index == len(segments)-1 && index >= 3 {
			// A trailing path wildcard matches this segment and everything
			// after it. The target must name at least one more segment: the
			// wildcard matches characters after a slash, not the slash itself.
			return len(pattern) > index, nil
		}
		if index == 0 && segment == "*" {
			// A stage-segment wildcard matches any stage.
			continue
		}
		if strings.ContainsAny(segment, "*?") {
			// A wildcard anywhere but the stage segment or the trailing path
			// segment is out of subset. It is only an error once the pattern
			// reaches this call: the literal prefix already agreed.
			return false, unsupportedStatement(
				"the Resource %q places a wildcard outside the stage segment or a trailing path segment, which the local subset does not honor (docs/127 W3-D1)",
				resource)
		}
		if index >= len(pattern) || pattern[index] != segment {
			return false, nil
		}
	}
	return len(pattern) == len(segments), nil
}

// resolvePolicyDocument resolves one raw policy document against the assembly.
func (r *Runner) resolvePolicyDocument(spec *Spec, stack string, raw json.RawMessage) (iamPolicyDocument, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return iamPolicyDocument{}, fmt.Errorf("the policy document is not JSON: %w", err)
	}
	resolved, err := r.resolveJSONValue(spec, stack, value)
	if err != nil {
		return iamPolicyDocument{}, err
	}
	encoded, err := json.Marshal(resolved)
	if err != nil {
		return iamPolicyDocument{}, fmt.Errorf("re-encode the resolved policy document: %w", err)
	}
	return parsePolicyDocument(encoded)
}

// iamAllowsFunctionURL evaluates an AWS_IAM Function URL call. Lambda requires
// both lambda:InvokeFunctionUrl and lambda:InvokeFunction; the function's
// resource-based policy and the caller's identity policy combine with the same
// rule as an execute-api call.
//
// https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
//
//nolint:gocyclo // one branch per combination rule.
func (r *Runner) iamAllowsFunctionURL(spec *Spec, call iamCall) iamDecision {
	if call.Caller.ARN == "" {
		return iamDecision{Reason: "the caller principal could not be resolved"}
	}
	functionARN := r.functionARN(spec, call.API.Routes[0].Function)
	if functionARN == "" {
		return iamDecision{Reason: "the Function URL's function has no local ARN"}
	}
	resourceAccount := stackAccountFor(spec, call.Stack)
	var url *FunctionURLSpec
	for index := range spec.FunctionURLs {
		if spec.FunctionURLs[index].LogicalID == call.API.LogicalID {
			url = &spec.FunctionURLs[index]
			break
		}
	}
	if url == nil {
		return iamDecision{Reason: "the Function URL is not in the derived surface"}
	}
	resourceAllowedURL, resourceDeniedURL, err := r.evaluateFunctionURLPolicy(spec, call, *url, functionARN, iamActionInvokeFunctionURL)
	if err != nil {
		return iamDecision{Reason: err.Error()}
	}
	resourceAllowedInvoke, resourceDeniedInvoke, err := r.evaluateFunctionURLPolicy(spec, call, *url, functionARN, iamActionInvokeFunction)
	if err != nil {
		return iamDecision{Reason: err.Error()}
	}
	identityAllowed, identityDeny, err := r.evaluateIdentityPoliciesForActions(spec, call, functionARN,
		[]string{iamActionInvokeFunctionURL, iamActionInvokeFunction}, true)
	if err != nil {
		return iamDecision{Reason: err.Error()}
	}
	resourceAllowed := resourceAllowedURL && resourceAllowedInvoke
	if resourceDeniedURL || resourceDeniedInvoke || identityDeny {
		return iamDecision{Reason: "an explicit Deny statement refuses the call (IAM policy evaluation logic)"}
	}
	if call.Caller.Account == resourceAccount {
		if resourceAllowed || identityAllowed {
			return iamDecision{Allowed: true}
		}
		return iamDecision{Reason: fmt.Sprintf(
			"no identity policy on %s and no resource policy on %s allows %s (same-account union rule)",
			call.Caller.BaseARN, functionARN, functionARN)}
	}
	if resourceAllowed && identityAllowed {
		return iamDecision{Allowed: true}
	}
	var missing []string
	if !resourceAllowed {
		missing = append(missing, "the function's resource policy")
	}
	if !identityAllowed {
		missing = append(missing, "an identity policy on "+call.Caller.BaseARN)
	}
	return iamDecision{Reason: fmt.Sprintf(
		"a cross-account Function URL call needs both policies to allow %s; %s does not (cross-account intersection rule)",
		functionARN, strings.Join(missing, " and "))}
}

// evaluateFunctionURLPolicy evaluates the function's resource policy for one of
// the two Lambda actions a Function URL call needs.
//
//nolint:gocyclo // one branch per statement shape.
func (r *Runner) evaluateFunctionURLPolicy(
	spec *Spec,
	call iamCall,
	url FunctionURLSpec,
	functionARN string,
	action string,
) (bool, bool, error) {
	if len(url.FunctionPolicy) == 0 {
		return false, false, nil
	}
	document, err := r.resolvePolicyDocument(spec, call.Stack, url.FunctionPolicy)
	if err != nil {
		return false, false, fmt.Errorf("the function's resource policy cannot be resolved: %w", err)
	}
	var allowed, denied bool
	for _, statement := range document.Statement {
		shape, applies, shapeErr := statementAppliesToFunctionURL(statement, functionARN)
		if shapeErr != nil {
			return false, false, fmt.Errorf("the function's resource policy has a statement outside the local subset: %w", shapeErr)
		}
		if !applies || !containsStringList(shape.actions, action) {
			continue
		}
		if shape.functionURLType != "" && shape.functionURLType != authorizationTypeIAM {
			continue
		}
		if !principalMatches(shape, call.Caller) || !conditionsMatch(shape, call.Caller) {
			continue
		}
		switch shape.effect {
		case iamEffectAllow:
			allowed = true
		case iamEffectDeny:
			denied = true
		}
	}
	return allowed, denied, nil
}

// evaluateIdentityPoliciesForActions evaluates the caller's identity policies
// for one set of actions and one resource. Function URL calls use it with the
// two Lambda actions; every action must be allowed for the identity side to
// accept.
//
//nolint:gocognit // one branch per policy kind and statement shape.
func (r *Runner) evaluateIdentityPoliciesForActions( //nolint:gocyclo // one branch per statement shape.
	spec *Spec,
	call iamCall,
	resource string,
	actions []string,
	requireAll bool,
) (bool, bool, error) {
	role, ok := r.iamRole(spec, call.Caller.BaseARN)
	if !ok {
		return false, false, nil
	}
	allowed := map[string]bool{}
	var denied bool
	for _, raw := range role.Identity {
		document, err := r.resolvePolicyDocument(spec, role.Stack, raw)
		if err != nil {
			return false, false, fmt.Errorf("an identity policy on %s cannot be resolved: %w", role.ARN, err)
		}
		for _, statement := range document.Statement {
			shape, applies, shapeErr := statementAppliesToFunctionURL(statement, resource)
			if shapeErr != nil {
				return false, false, fmt.Errorf("an identity policy on %s has a statement outside the local subset: %w", role.ARN, shapeErr)
			}
			if !applies {
				continue
			}
			if len(shape.principals) > 0 || len(shape.principalRoots) > 0 || !shape.principalNamed {
				return false, false, fmt.Errorf(
					"an identity policy on %s names a Principal, which is outside the local subset (docs/127 W3-D1)", role.ARN)
			}
			if !conditionsMatch(shape, call.Caller) {
				continue
			}
			switch shape.effect {
			case iamEffectAllow:
				for _, action := range shape.actions {
					allowed[action] = true
				}
			case iamEffectDeny:
				denied = true
			}
		}
	}
	if requireAll {
		for _, action := range actions {
			if !allowed[action] {
				return false, denied, nil
			}
		}
		return true, denied, nil
	}
	for _, action := range actions {
		if allowed[action] {
			return true, denied, nil
		}
	}
	return false, denied, nil
}

// statementAppliesToFunctionURL decides whether one Function URL statement
// could apply to a call on a function ARN, and returns its enumerated shape.
func statementAppliesToFunctionURL(statement iamPolicyStatement, functionARN string) (statementShape, bool, error) {
	scope, err := shapeStatementScope(statement, false, true)
	if errors.Is(err, errStatementIrrelevant) {
		return statementShape{}, false, nil
	}
	if err != nil {
		return statementShape{}, false, err
	}
	matched := false
	for _, resource := range scope.resources {
		if resource == functionARN {
			matched = true
			break
		}
		if strings.ContainsAny(resource, "*?") && strings.HasPrefix(functionARN, strings.TrimRight(resource, "*?")) {
			return statementShape{}, false, unsupportedStatement(
				"a Resource of %q uses a wildcard the local subset does not evaluate for a function URL; the exact function ARN is accepted (docs/127 W3-D1)",
				resource)
		}
	}
	if !matched {
		return statementShape{}, false, nil
	}
	shape, err := applicability(statement, scope)
	if err != nil {
		return statementShape{}, false, err
	}
	return shape, true, nil
}
