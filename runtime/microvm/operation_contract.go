package microvm

import (
	"fmt"
	"strings"
)

const (
	// ContractVersionM16 is the corrective real Lambda MicroVM contract version.
	ContractVersionM16 = "m16.microvm/v1"

	// ErrorCodeOperationContractIncomplete reports an incomplete real MicroVM operation contract.
	ErrorCodeOperationContractIncomplete = "m16.microvm.operation_contract_incomplete"
	// ErrorCodeRouteContractIncomplete reports an incomplete or unsafe real MicroVM HTTP route contract.
	ErrorCodeRouteContractIncomplete = "m16.microvm.route_contract_incomplete"
	// ErrorCodeProviderStateMappingIncomplete reports an incomplete provider-state mapping contract.
	ErrorCodeProviderStateMappingIncomplete = "m16.microvm.provider_state_mapping_incomplete"
	// ErrorCodeTokenSafetyViolation reports an unsafe MicroVM token issuance surface.
	ErrorCodeTokenSafetyViolation = "m16.microvm.token_safety_violation" //nolint:gosec // Contract error code, not a credential.
	// ErrorCodeTenantBindingViolation reports a cross-tenant MicroVM access contract violation.
	ErrorCodeTenantBindingViolation = "m16.microvm.tenant_binding_violation"
	// ErrorCodeRealLifecycleIncomplete reports an incomplete real MicroVM lifecycle contract.
	ErrorCodeRealLifecycleIncomplete = "m16.microvm.lifecycle_incomplete"
)

// Operation names a real AWS Lambda MicroVM control-plane operation.
type Operation string

const (
	OperationRun       Operation = "run"
	OperationGet       Operation = "get"
	OperationList      Operation = "list"
	OperationSuspend   Operation = "suspend"
	OperationResume    Operation = "resume"
	OperationTerminate Operation = "terminate"
	OperationInvoke    Operation = "invoke"
	OperationAuthToken Operation = "auth-token"
	// OperationShellAuthToken is the canonical shell token issuance operation.
	OperationShellAuthToken Operation = "shell-auth-token" //nolint:gosec // Contract operation name, not a credential.
	// OperationShellToken is a compatibility alias for the canonical shell-auth-token operation.
	OperationShellToken Operation = OperationShellAuthToken
	// OperationLegacyShellToken is accepted only as a compatibility input alias.
	OperationLegacyShellToken Operation = "shell-token"
)

const (
	// HookValidate validates a requested MicroVM before provider run.
	HookValidate LifecycleHook = "validate"
	// HookRun tracks a provider run operation.
	HookRun LifecycleHook = "run"
	// HookReady tracks a provider readiness observation.
	HookReady LifecycleHook = "ready"
	// HookSuspend tracks a provider suspend operation.
	HookSuspend LifecycleHook = "suspend"
	// HookResume tracks a provider resume operation.
	HookResume LifecycleHook = "resume"
	// HookTerminate tracks a provider terminate operation.
	HookTerminate LifecycleHook = "terminate"
)

const (
	StateValidating  LifecycleState = "validating"
	StateValidated   LifecycleState = "validated"
	StateRunning     LifecycleState = "running"
	StateSuspending  LifecycleState = "suspending"
	StateSuspended   LifecycleState = "suspended"
	StateResuming    LifecycleState = "resuming"
	StateTerminating LifecycleState = "terminating"
)

// OperationHTTPRouteContract pins the canonical HTTP route for one MicroVM operation.
type OperationHTTPRouteContract struct {
	Operation       Operation `json:"operation"`
	Method          string    `json:"method"`
	Path            string    `json:"path"`
	AuthRequired    bool      `json:"auth_required"`
	DefaultAuth     string    `json:"default_auth"`
	TenantBound     bool      `json:"tenant_bound"`
	Recovery        bool      `json:"recovery,omitempty"`
	RequestFields   []string  `json:"request_fields"`
	ResponseFields  []string  `json:"response_fields"`
	ForbiddenFields []string  `json:"forbidden_fields,omitempty"`
}

// ProviderStateMapping maps a provider state into the AppTheory lifecycle contract.
type ProviderStateMapping struct {
	ProviderState string         `json:"provider_state"`
	State         LifecycleState `json:"state"`
	Terminal      bool           `json:"terminal"`
}

// TokenIssuanceContract describes the only safe token issuance result shape.
type TokenIssuanceContract struct {
	Operation       Operation `json:"operation"`
	ResultFields    []string  `json:"result_fields"`
	ForbiddenFields []string  `json:"forbidden_fields"`
	Sanitized       bool      `json:"sanitized"`
	TenantBound     bool      `json:"tenant_bound"`
	SessionBound    bool      `json:"session_bound"`
	MaxTTLSeconds   int       `json:"max_ttl_seconds"`
}

// TenantBindingRule pins whether one MicroVM access attempt is allowed for a tenant/namespace binding.
type TenantBindingRule struct {
	Operation        Operation `json:"operation"`
	RequestTenantID  string    `json:"request_tenant_id"`
	RequestNamespace string    `json:"request_namespace"`
	RecordTenantID   string    `json:"record_tenant_id"`
	RecordNamespace  string    `json:"record_namespace"`
	Recovery         bool      `json:"recovery,omitempty"`
	Allowed          bool      `json:"allowed"`
}

// OperationContract is the real MicroVM operation, route, lifecycle mapping, token, and tenant-binding contract.
type OperationContract struct {
	Operations            []Operation                  `json:"operations"`
	Routes                []OperationHTTPRouteContract `json:"routes"`
	ProviderStateMappings []ProviderStateMapping       `json:"provider_state_mappings"`
	TokenIssuance         []TokenIssuanceContract      `json:"token_issuance"`
	TenantBinding         []TenantBindingRule          `json:"tenant_binding"`
	ForbiddenFields       []string                     `json:"forbidden_fields"`
}

// DefaultRealLifecycleContract returns the M16 real MicroVM lifecycle vocabulary.
func DefaultRealLifecycleContract() LifecycleContract {
	return LifecycleContract{
		Hooks: []LifecycleHookSpec{
			{Name: HookValidate, Phase: "validation", State: StateValidating, SuccessState: StateValidated, FailureState: StateFailed},
			{Name: HookRun, Phase: "provider_run", State: StateRunning, SuccessState: StateRunning, FailureState: StateFailed},
			{Name: HookReady, Phase: "provider_ready", State: StateReady, SuccessState: StateReady, FailureState: StateFailed},
			{Name: HookSuspend, Phase: "provider_suspend", State: StateSuspending, SuccessState: StateSuspended, FailureState: StateFailed},
			{Name: HookResume, Phase: "provider_resume", State: StateResuming, SuccessState: StateReady, FailureState: StateFailed},
			{Name: HookTerminate, Phase: "provider_terminate", State: StateTerminating, SuccessState: StateTerminated, FailureState: StateFailed},
			{Name: HookFailure, Phase: "failure", State: StateFailed, SuccessState: StateFailed, FailureState: StateFailed},
		},
		States: []LifecycleState{
			StateRequested,
			StateValidating,
			StateValidated,
			StateRunning,
			StateReady,
			StateSuspending,
			StateSuspended,
			StateResuming,
			StateTerminating,
			StateTerminated,
			StateFailed,
		},
		TerminalStates: []LifecycleState{StateTerminated, StateFailed},
		Transitions: []LifecycleTransition{
			{From: StateRequested, Hook: HookValidate, To: StateValidating},
			{From: StateValidating, Hook: HookValidate, To: StateValidated},
			{From: StateValidated, Hook: HookRun, To: StateRunning},
			{From: StateRunning, Hook: HookRun, To: StateRunning},
			{From: StateRunning, Hook: HookReady, To: StateReady},
			{From: StateReady, Hook: HookReady, To: StateReady},
			{From: StateReady, Hook: HookSuspend, To: StateSuspending},
			{From: StateSuspending, Hook: HookSuspend, To: StateSuspended},
			{From: StateSuspended, Hook: HookResume, To: StateResuming},
			{From: StateResuming, Hook: HookResume, To: StateReady},
			{From: StateReady, Hook: HookTerminate, To: StateTerminating},
			{From: StateSuspended, Hook: HookTerminate, To: StateTerminating},
			{From: StateTerminating, Hook: HookTerminate, To: StateTerminated},
			{From: StateValidating, Hook: HookFailure, To: StateFailed},
			{From: StateRunning, Hook: HookFailure, To: StateFailed},
			{From: StateReady, Hook: HookFailure, To: StateFailed},
			{From: StateSuspending, Hook: HookFailure, To: StateFailed},
			{From: StateSuspended, Hook: HookFailure, To: StateFailed},
			{From: StateResuming, Hook: HookFailure, To: StateFailed},
			{From: StateTerminating, Hook: HookFailure, To: StateFailed},
		},
	}
}

// DefaultOperationContract returns the M16 real MicroVM operation contract.
func DefaultOperationContract() OperationContract {
	return OperationContract{
		Operations: RequiredOperations(),
		Routes: []OperationHTTPRouteContract{
			requiredOperationRoute(OperationRun),
			requiredOperationRoute(OperationGet),
			requiredOperationRoute(OperationList),
			requiredOperationRoute(OperationSuspend),
			requiredOperationRoute(OperationResume),
			requiredOperationRoute(OperationTerminate),
			requiredOperationRoute(OperationInvoke),
			requiredOperationRoute(OperationAuthToken),
			requiredOperationRoute(OperationShellToken),
		},
		ProviderStateMappings: DefaultProviderStateMappings(),
		TokenIssuance: []TokenIssuanceContract{
			requiredTokenIssuance(OperationAuthToken),
			requiredTokenIssuance(OperationShellToken),
		},
		TenantBinding: []TenantBindingRule{
			{Operation: OperationList, RequestTenantID: "tenant-a", RequestNamespace: "namespace-a", RecordTenantID: "tenant-a", RecordNamespace: "namespace-a", Recovery: true, Allowed: true},
			{Operation: OperationList, RequestTenantID: "tenant-a", RequestNamespace: "namespace-a", RecordTenantID: "tenant-b", RecordNamespace: "namespace-a", Recovery: true, Allowed: false},
			{Operation: OperationGet, RequestTenantID: "tenant-a", RequestNamespace: "namespace-a", RecordTenantID: "tenant-b", RecordNamespace: "namespace-a", Allowed: false},
		},
		ForbiddenFields: RequiredForbiddenOperationFields(),
	}
}

// RequiredOperations returns the complete M16 real MicroVM operation vocabulary.
func RequiredOperations() []Operation {
	return []Operation{
		OperationRun,
		OperationGet,
		OperationList,
		OperationSuspend,
		OperationResume,
		OperationTerminate,
		OperationInvoke,
		OperationAuthToken,
		OperationShellAuthToken,
	}
}

// DefaultProviderStateMappings returns the minimum provider state mapping required by M16.
func DefaultProviderStateMappings() []ProviderStateMapping {
	return []ProviderStateMapping{
		{ProviderState: "pending", State: StateValidating},
		{ProviderState: "running", State: StateRunning},
		{ProviderState: "ready", State: StateReady},
		{ProviderState: "suspending", State: StateSuspending},
		{ProviderState: "suspended", State: StateSuspended},
		{ProviderState: "resuming", State: StateResuming},
		{ProviderState: "terminating", State: StateTerminating},
		{ProviderState: "terminated", State: StateTerminated, Terminal: true},
		{ProviderState: "failed", State: StateFailed, Terminal: true},
	}
}

// RequiredForbiddenOperationFields returns field names that must never be accepted or emitted by MicroVM contracts.
func RequiredForbiddenOperationFields() []string {
	return []string{
		"authorization",
		"aws_access_key_id",
		"aws_secret_access_key",
		"aws_session_token",
		"bearer_token",
		"plaintext_token",
		"provider_secret",
		"raw_aws_credentials",
		"raw_lifecycle_hook_payload",
		"raw_sdk_client",
		"session_token_plaintext",
		"token_value",
		"x-amz-security-token",
	}
}

// ValidateRealLifecycleContract validates the M16 real lifecycle vocabulary without accepting synthetic start/stop hooks.
func ValidateRealLifecycleContract(contract LifecycleContract) error {
	hooks, err := validateRealLifecycleHookSpecs(contract.Hooks)
	if err != nil {
		return err
	}
	if err := validateRealLifecycleStateLists(contract); err != nil {
		return err
	}
	return validateRealLifecycleTransitionSet(hooks, transitionSet(contract.Transitions))
}

// ValidateOperationContract validates the real MicroVM operation, route, token, provider-state, and tenant contract.
func ValidateOperationContract(contract OperationContract) error {
	if err := validateOperationVocabulary(contract.Operations); err != nil {
		return err
	}
	if err := validateOperationRoutes(contract.Routes); err != nil {
		return err
	}
	if err := validateProviderStateMappings(contract.ProviderStateMappings); err != nil {
		return err
	}
	if err := validateTokenIssuanceContracts(contract.TokenIssuance); err != nil {
		return err
	}
	if err := validateTenantBindingRules(contract.TenantBinding); err != nil {
		return err
	}
	return validateForbiddenFieldCatalog(contract.ForbiddenFields)
}

func validateRealLifecycleHookSpecs(hooks []LifecycleHookSpec) (map[LifecycleHook]LifecycleHookSpec, error) {
	out := map[LifecycleHook]LifecycleHookSpec{}
	for _, hook := range hooks {
		name := normalizeLifecycleHook(hook.Name)
		if name == HookStart || name == HookStop || name == HookPrepareImage || name == HookTeardown {
			return nil, safeError(ErrorCodeRealLifecycleIncomplete, "apptheory: microvm real lifecycle forbids synthetic lifecycle hooks", "")
		}
		if name == "" || strings.TrimSpace(hook.Phase) == "" || hook.State == "" || hook.SuccessState == "" || hook.FailureState == "" {
			return nil, safeError(ErrorCodeRealLifecycleIncomplete, "apptheory: microvm real lifecycle hooks must name phase, active state, success state, and failure state", "")
		}
		hook.Name = name
		out[name] = hook
	}
	if missing := missingLifecycleHooks(requiredRealLifecycleHooks(), out); len(missing) > 0 {
		return nil, safeError(ErrorCodeRealLifecycleIncomplete, "apptheory: microvm real lifecycle missing hooks: "+strings.Join(missing, ","), "")
	}
	return out, nil
}

func validateRealLifecycleStateLists(contract LifecycleContract) error {
	if missing := missingLifecycleStates(requiredRealLifecycleStates(), lifecycleStateSet(contract.States)); len(missing) > 0 {
		return safeError(ErrorCodeRealLifecycleIncomplete, "apptheory: microvm real lifecycle missing states: "+strings.Join(missing, ","), "")
	}
	if missing := missingLifecycleStates([]LifecycleState{StateTerminated, StateFailed}, lifecycleStateSet(contract.TerminalStates)); len(missing) > 0 {
		return safeError(ErrorCodeRealLifecycleIncomplete, "apptheory: microvm real lifecycle missing terminal states: "+strings.Join(missing, ","), "")
	}
	return nil
}

func validateRealLifecycleTransitionSet(hookSpecs map[LifecycleHook]LifecycleHookSpec, transitions lifecycleTransitionSet) error {
	for _, spec := range hookSpecs {
		if spec.Name == HookFailure {
			continue
		}
		for _, required := range requiredRealTransitionsForHook(spec.Name, spec.State, spec.SuccessState) {
			if !transitions.has(required.From, required.Hook, required.To) {
				return safeError(ErrorCodeRealLifecycleIncomplete, fmt.Sprintf("apptheory: microvm real lifecycle missing transition %s/%s/%s", required.From, required.Hook, required.To), "")
			}
		}
	}
	for _, state := range []LifecycleState{StateValidating, StateRunning, StateReady, StateSuspending, StateSuspended, StateResuming, StateTerminating} {
		if !transitions.has(state, HookFailure, StateFailed) {
			return safeError(ErrorCodeRealLifecycleIncomplete, fmt.Sprintf("apptheory: microvm real lifecycle missing failure transition from %s", state), "")
		}
	}
	return nil
}

func requiredRealTransitionsForHook(hook LifecycleHook, active LifecycleState, success LifecycleState) []LifecycleTransition {
	switch hook {
	case HookValidate:
		return []LifecycleTransition{{From: StateRequested, Hook: hook, To: active}, {From: active, Hook: hook, To: success}}
	case HookRun:
		return []LifecycleTransition{{From: StateValidated, Hook: hook, To: active}, {From: active, Hook: hook, To: success}}
	case HookReady:
		return []LifecycleTransition{{From: StateRunning, Hook: hook, To: active}, {From: active, Hook: hook, To: success}}
	case HookSuspend:
		return []LifecycleTransition{{From: StateReady, Hook: hook, To: active}, {From: active, Hook: hook, To: success}}
	case HookResume:
		return []LifecycleTransition{{From: StateSuspended, Hook: hook, To: active}, {From: active, Hook: hook, To: success}}
	case HookTerminate:
		return []LifecycleTransition{{From: StateReady, Hook: hook, To: active}, {From: StateSuspended, Hook: hook, To: active}, {From: active, Hook: hook, To: success}}
	default:
		return nil
	}
}

func validateOperationVocabulary(operations []Operation) error {
	seen := map[Operation]struct{}{}
	for _, operation := range operations {
		operation = normalizeOperation(operation)
		if operation != "" {
			seen[operation] = struct{}{}
		}
	}
	missing := make([]string, 0)
	for _, operation := range RequiredOperations() {
		if _, ok := seen[operation]; !ok {
			missing = append(missing, string(operation))
		}
	}
	if len(missing) > 0 {
		return safeError(ErrorCodeOperationContractIncomplete, "apptheory: microvm operation contract missing operations: "+strings.Join(missing, ","), "")
	}
	for operation := range seen {
		if !requiredOperation(operation) {
			return safeError(ErrorCodeOperationContractIncomplete, "apptheory: microvm operation contract includes unsupported operation: "+string(operation), "")
		}
	}
	return nil
}

func validateOperationRoutes(routes []OperationHTTPRouteContract) error {
	seen := map[Operation]OperationHTTPRouteContract{}
	for _, route := range routes {
		normalized, err := validateOperationRouteBasics(route)
		if err != nil {
			return err
		}
		seen[normalized.Operation] = normalized
	}
	for _, operation := range RequiredOperations() {
		if err := validateRequiredOperationRoute(seen, operation); err != nil {
			return err
		}
	}
	if !seen[OperationList].Recovery {
		return safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm list route must encode tenant-bound recovery semantics", "")
	}
	return nil
}

func validateOperationRouteBasics(route OperationHTTPRouteContract) (OperationHTTPRouteContract, error) {
	route.Operation = normalizeOperation(route.Operation)
	route.Method = strings.TrimSpace(route.Method)
	route.Path = strings.TrimSpace(route.Path)
	if route.Operation == "" || route.Method == "" || route.Path == "" {
		return OperationHTTPRouteContract{}, safeError(ErrorCodeRouteContractIncomplete, "apptheory: microvm operation routes must define operation, method, and path", "")
	}
	if !route.AuthRequired || !strings.EqualFold(strings.TrimSpace(route.DefaultAuth), ControllerAuthDefaultDeny) {
		return OperationHTTPRouteContract{}, safeError(ErrorCodeUnauthenticatedController, "apptheory: microvm operation routes must default to authenticated deny", "")
	}
	if !route.TenantBound {
		return OperationHTTPRouteContract{}, safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm operation route is not tenant-bound", "")
	}
	if err := validateSafeResultFields(route.ResponseFields, ""); err != nil {
		return OperationHTTPRouteContract{}, err
	}
	return route, nil
}

func validateRequiredOperationRoute(seen map[Operation]OperationHTTPRouteContract, operation Operation) error {
	route, ok := seen[operation]
	if !ok {
		return safeError(ErrorCodeRouteContractIncomplete, "apptheory: microvm operation contract missing route: "+string(operation), "")
	}
	expected := requiredOperationRoute(operation)
	if !strings.EqualFold(route.Method, expected.Method) || route.Path != expected.Path {
		return safeError(ErrorCodeRouteContractIncomplete, "apptheory: microvm operation route mismatch: "+string(operation), "")
	}
	if len(missingStrings(expected.RequestFields, route.RequestFields)) > 0 || len(missingStrings(expected.ResponseFields, route.ResponseFields)) > 0 {
		return safeError(ErrorCodeRouteContractIncomplete, "apptheory: microvm operation route fields incomplete: "+string(operation), "")
	}
	return nil
}

func validateProviderStateMappings(mappings []ProviderStateMapping) error {
	seen := map[string]ProviderStateMapping{}
	for _, mapping := range mappings {
		mapping.ProviderState = normalizeProviderState(mapping.ProviderState)
		mapping.State = LifecycleState(strings.TrimSpace(string(mapping.State)))
		if mapping.ProviderState == "" || mapping.State == "" {
			return safeError(ErrorCodeProviderStateMappingIncomplete, "apptheory: microvm provider state mapping is incomplete", "")
		}
		if !validRealLifecycleState(mapping.State) {
			return safeError(ErrorCodeProviderStateMappingIncomplete, "apptheory: microvm provider state maps to unsupported lifecycle state", "")
		}
		seen[mapping.ProviderState] = mapping
	}
	for _, required := range DefaultProviderStateMappings() {
		got, ok := seen[required.ProviderState]
		if !ok {
			return safeError(ErrorCodeProviderStateMappingIncomplete, "apptheory: microvm provider state mapping missing: "+required.ProviderState, "")
		}
		if got.State != required.State || got.Terminal != required.Terminal {
			return safeError(ErrorCodeProviderStateMappingIncomplete, "apptheory: microvm provider state mapping mismatch: "+required.ProviderState, "")
		}
	}
	return nil
}

func validateTokenIssuanceContracts(tokens []TokenIssuanceContract) error {
	seen := map[Operation]TokenIssuanceContract{}
	for _, token := range tokens {
		token.Operation = normalizeOperation(token.Operation)
		if token.Operation == OperationAuthToken || token.Operation == OperationShellAuthToken {
			seen[token.Operation] = token
		}
	}
	for _, operation := range []Operation{OperationAuthToken, OperationShellAuthToken} {
		token, ok := seen[operation]
		if !ok {
			return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm token issuance missing operation: "+string(operation), "")
		}
		if !token.Sanitized || !token.TenantBound || !token.SessionBound || token.MaxTTLSeconds <= 0 {
			return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm token issuance must be sanitized, tenant-bound, session-bound, and ttl-limited", "")
		}
		if err := validateSafeResultFields(token.ResultFields, ""); err != nil {
			return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm token issuance exposes unsafe result field", "")
		}
		if missing := missingStrings([]string{"token_id", "token_type", "expires_at", "scope"}, token.ResultFields); len(missing) > 0 {
			return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm token issuance missing safe result fields: "+strings.Join(missing, ","), "")
		}
		if missing := missingStrings(RequiredForbiddenOperationFields(), token.ForbiddenFields); len(missing) > 0 {
			return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm token issuance missing forbidden fields: "+strings.Join(missing, ","), "")
		}
	}
	return nil
}

func validateTenantBindingRules(rules []TenantBindingRule) error {
	if len(rules) == 0 {
		return safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm tenant binding rules are required", "")
	}
	hasListRecoveryDeny := false
	hasGetDeny := false
	for _, rule := range rules {
		normalized, sameBinding, err := validateTenantBindingRule(rule)
		if err != nil {
			return err
		}
		if normalized.Allowed != sameBinding {
			return safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm tenant binding rule allows cross-tenant access", "")
		}
		if !normalized.Allowed && normalized.Operation == OperationList && normalized.Recovery {
			hasListRecoveryDeny = true
		}
		if !normalized.Allowed && normalized.Operation == OperationGet {
			hasGetDeny = true
		}
	}
	if !hasListRecoveryDeny || !hasGetDeny {
		return safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm tenant binding must deny cross-tenant list/recovery and get", "")
	}
	return nil
}

func validateTenantBindingRule(rule TenantBindingRule) (TenantBindingRule, bool, error) {
	rule.Operation = normalizeOperation(rule.Operation)
	rule.RequestTenantID = strings.TrimSpace(rule.RequestTenantID)
	rule.RequestNamespace = strings.TrimSpace(rule.RequestNamespace)
	rule.RecordTenantID = strings.TrimSpace(rule.RecordTenantID)
	rule.RecordNamespace = strings.TrimSpace(rule.RecordNamespace)
	if rule.Operation == "" || rule.RequestTenantID == "" || rule.RequestNamespace == "" || rule.RecordTenantID == "" || rule.RecordNamespace == "" {
		return TenantBindingRule{}, false, safeError(ErrorCodeTenantBindingViolation, "apptheory: microvm tenant binding rule is incomplete", "")
	}
	sameBinding := rule.RequestTenantID == rule.RecordTenantID && rule.RequestNamespace == rule.RecordNamespace
	return rule, sameBinding, nil
}

func validateForbiddenFieldCatalog(fields []string) error {
	missing := missingStrings(RequiredForbiddenOperationFields(), fields)
	if len(missing) > 0 {
		return safeError(ErrorCodeTokenSafetyViolation, "apptheory: microvm forbidden field catalog missing fields: "+strings.Join(missing, ","), "")
	}
	return nil
}

func validateSafeResultFields(fields []string, requestID string) error {
	for _, field := range fields {
		if forbiddenFieldName(field) {
			return safeError(ErrorCodeForbiddenField, "apptheory: microvm contract exposes forbidden field", requestID)
		}
	}
	return nil
}

func requiredRealLifecycleHooks() []LifecycleHook {
	return []LifecycleHook{HookValidate, HookRun, HookReady, HookSuspend, HookResume, HookTerminate, HookFailure}
}

func requiredRealLifecycleStates() []LifecycleState {
	return []LifecycleState{
		StateRequested,
		StateValidating,
		StateValidated,
		StateRunning,
		StateReady,
		StateSuspending,
		StateSuspended,
		StateResuming,
		StateTerminating,
		StateTerminated,
		StateFailed,
	}
}

func validRealLifecycleState(state LifecycleState) bool {
	state = LifecycleState(strings.TrimSpace(string(state)))
	for _, valid := range requiredRealLifecycleStates() {
		if state == valid {
			return true
		}
	}
	return false
}

func normalizeOperation(operation Operation) Operation {
	normalized := Operation(strings.TrimSpace(string(operation)))
	if normalized == OperationLegacyShellToken {
		return OperationShellAuthToken
	}
	return normalized
}

func normalizeProviderState(state string) string {
	return strings.ToLower(strings.TrimSpace(state))
}

func requiredOperation(operation Operation) bool {
	operation = normalizeOperation(operation)
	for _, valid := range RequiredOperations() {
		if operation == valid {
			return true
		}
	}
	return false
}

func requiredOperationRoute(operation Operation) OperationHTTPRouteContract {
	switch operation {
	case OperationRun:
		return operationRoute(operation, "POST", "/microvms", []string{"tenant_id", "namespace", "image_ref", "network_connector_ref", "session_spec"}, []string{"session_id", "provider_microvm_id", "state", "provider_state", "registry_version"}, false)
	case OperationList:
		return operationRoute(operation, "GET", "/microvms", []string{"tenant_id", "namespace"}, []string{"sessions", "recovery_cursor"}, true)
	case OperationGet:
		return operationRoute(operation, "GET", "/microvms/{session_id}", []string{"tenant_id", "namespace", "session_id"}, []string{"session_id", "provider_microvm_id", "state", "provider_state", "registry_version"}, false)
	case OperationSuspend:
		return operationRoute(operation, "POST", "/microvms/{session_id}/suspend", []string{"tenant_id", "namespace", "session_id"}, []string{"session_id", "state", "provider_state", "registry_version"}, false)
	case OperationResume:
		return operationRoute(operation, "POST", "/microvms/{session_id}/resume", []string{"tenant_id", "namespace", "session_id"}, []string{"session_id", "state", "provider_state", "registry_version"}, false)
	case OperationTerminate:
		return operationRoute(operation, "DELETE", "/microvms/{session_id}", []string{"tenant_id", "namespace", "session_id"}, []string{"session_id", "state", "provider_state", "registry_version"}, false)
	case OperationInvoke:
		return operationRoute(operation, "ANY", "/microvms/{session_id}/invoke/{proxy+}", []string{"tenant_id", "namespace", "session_id", "method", "path", "port"}, []string{"status", "headers", "body"}, false)
	case OperationAuthToken:
		return operationRoute(operation, "POST", "/microvms/{session_id}/auth-token", []string{"tenant_id", "namespace", "session_id"}, []string{"token_id", "token_type", "expires_at", "scope"}, false)
	case OperationShellAuthToken:
		return operationRoute(operation, "POST", "/microvms/{session_id}/shell-auth-token", []string{"tenant_id", "namespace", "session_id"}, []string{"token_id", "token_type", "expires_at", "scope"}, false)
	default:
		return OperationHTTPRouteContract{}
	}
}

func operationRoute(operation Operation, method string, path string, requestFields []string, responseFields []string, recovery bool) OperationHTTPRouteContract {
	return OperationHTTPRouteContract{
		Operation:       operation,
		Method:          method,
		Path:            path,
		AuthRequired:    true,
		DefaultAuth:     ControllerAuthDefaultDeny,
		TenantBound:     true,
		Recovery:        recovery,
		RequestFields:   requestFields,
		ResponseFields:  responseFields,
		ForbiddenFields: RequiredForbiddenOperationFields(),
	}
}

func requiredTokenIssuance(operation Operation) TokenIssuanceContract {
	return TokenIssuanceContract{
		Operation:       operation,
		ResultFields:    []string{"token_id", "token_type", "expires_at", "scope"},
		ForbiddenFields: RequiredForbiddenOperationFields(),
		Sanitized:       true,
		TenantBound:     true,
		SessionBound:    true,
		MaxTTLSeconds:   900,
	}
}
