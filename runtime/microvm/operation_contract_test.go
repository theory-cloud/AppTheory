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

func TestRealLifecycleContractFailureBranches(t *testing.T) {
	cases := []LifecycleContract{
		func() LifecycleContract {
			contract := DefaultRealLifecycleContract()
			contract.Hooks[0].Phase = ""
			return contract
		}(),
		func() LifecycleContract {
			contract := DefaultRealLifecycleContract()
			contract.Hooks = contract.Hooks[:1]
			return contract
		}(),
		func() LifecycleContract {
			contract := DefaultRealLifecycleContract()
			contract.States = nil
			return contract
		}(),
		func() LifecycleContract {
			contract := DefaultRealLifecycleContract()
			contract.TerminalStates = []LifecycleState{StateTerminated}
			return contract
		}(),
		func() LifecycleContract {
			contract := DefaultRealLifecycleContract()
			contract.Transitions = nil
			return contract
		}(),
	}
	for _, contract := range cases {
		require.Error(t, ValidateRealLifecycleContract(contract))
	}
}

func TestOperationContractFailureBranches(t *testing.T) {
	cases := []OperationContract{
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.Operations = contract.Operations[:1]
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.Operations = append(contract.Operations, Operation("unsupported"))
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.Routes[0].Operation = ""
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.Routes[0].TenantBound = false
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.Routes = contract.Routes[:1]
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.Routes[0].Method = "PATCH"
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.Routes[0].ResponseFields = nil
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			for i := range contract.Routes {
				if contract.Routes[i].Operation == OperationList {
					contract.Routes[i].Recovery = false
				}
			}
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.ProviderStateMappings[0].ProviderState = ""
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.ProviderStateMappings = contract.ProviderStateMappings[:1]
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.ProviderStateMappings[0].Terminal = !contract.ProviderStateMappings[0].Terminal
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.TokenIssuance = contract.TokenIssuance[:1]
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.TokenIssuance[0].Sanitized = false
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.TokenIssuance[0].ResultFields = []string{"token_id"}
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.TokenIssuance[0].ForbiddenFields = nil
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.TenantBinding = nil
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.TenantBinding[0].Operation = ""
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.TenantBinding = contract.TenantBinding[:1]
			return contract
		}(),
		func() OperationContract {
			contract := DefaultOperationContract()
			contract.ForbiddenFields = nil
			return contract
		}(),
	}
	for _, contract := range cases {
		require.Error(t, ValidateOperationContract(contract))
	}
}
