package microvm

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRealLifecycleContractValidatesAndRejectsSyntheticHooks(t *testing.T) {
	contract := DefaultRealLifecycleContract()
	require.NoError(t, ValidateRealLifecycleContract(contract))

	contract.Hooks = append(contract.Hooks, LifecycleHookSpec{
		Name:         HookStart,
		Phase:        "synthetic",
		State:        StateStarting,
		SuccessState: StateStarted,
		FailureState: StateFailed,
	})
	err := ValidateRealLifecycleContract(contract)
	require.Error(t, err)
	require.ErrorContains(t, err, "forbids synthetic")
}

func TestOperationContractValidatesRealRoutesTokensAndTenantBinding(t *testing.T) {
	contract := DefaultOperationContract()
	require.NoError(t, ValidateOperationContract(contract))

	bad := DefaultOperationContract()
	bad.Routes[0].AuthRequired = false
	err := ValidateOperationContract(bad)
	require.Error(t, err)
	var safe SafeError
	require.ErrorAs(t, err, &safe)
	require.Equal(t, ErrorCodeUnauthenticatedController, safe.Code)

	bad = DefaultOperationContract()
	bad.TokenIssuance[0].ResultFields = append(bad.TokenIssuance[0].ResultFields, "token_value")
	err = ValidateOperationContract(bad)
	require.Error(t, err)
	require.ErrorAs(t, err, &safe)
	require.Equal(t, ErrorCodeTokenSafetyViolation, safe.Code)

	bad = DefaultOperationContract()
	bad.TenantBinding[1].Allowed = true
	err = ValidateOperationContract(bad)
	require.Error(t, err)
	require.ErrorAs(t, err, &safe)
	require.Equal(t, ErrorCodeTenantBindingViolation, safe.Code)
}

func TestProviderStateMappingRequiresRealLifecycleStates(t *testing.T) {
	contract := DefaultOperationContract()
	contract.ProviderStateMappings[0].State = StateStarted
	err := ValidateOperationContract(contract)
	require.Error(t, err)
	var safe SafeError
	require.ErrorAs(t, err, &safe)
	require.Equal(t, ErrorCodeProviderStateMappingIncomplete, safe.Code)
}
