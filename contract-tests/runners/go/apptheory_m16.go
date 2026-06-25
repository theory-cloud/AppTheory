package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"

	runtimemicrovm "github.com/theory-cloud/apptheory/runtime/microvm"
)

const (
	microVMContractVersionM16 = "m16.microvm/v1"
	microVMKindOperation      = "operation"
)

type microVMContractFixtureM16 struct {
	Contract          string                           `json:"contract"`
	Version           string                           `json:"version"`
	Kind              string                           `json:"kind"`
	EscapeHatches     microVMEscapeHatches             `json:"escape_hatches"`
	Lifecycle         microVMLifecycleContract         `json:"lifecycle"`
	OperationContract runtimemicrovm.OperationContract `json:"operation_contract"`
}

func runFixtureM16(f Fixture) error {
	actual := validateMicroVMContractFixtureM16(f.Setup.MicroVMContract)
	expected := f.Expect.MicroVMContractValidation
	if expected == nil {
		return fmt.Errorf("fixture missing expect.microvm_contract_validation")
	}
	if !reflect.DeepEqual(*expected, actual) {
		return fmt.Errorf("microvm_contract_validation mismatch: expected %+v, got %+v", *expected, actual)
	}
	return nil
}

func validateMicroVMContractFixtureM16(raw json.RawMessage) FixtureMicroVMContractValidation {
	if len(raw) == 0 {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract fixture missing")
	}

	var contract microVMContractFixtureM16
	if err := json.Unmarshal(raw, &contract); err != nil {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract fixture is not parseable")
	}

	actual := FixtureMicroVMContractValidation{
		Valid:   true,
		Kind:    strings.TrimSpace(contract.Kind),
		Version: strings.TrimSpace(contract.Version),
	}
	if strings.TrimSpace(contract.Contract) != microVMContractName || actual.Version != microVMContractVersionM16 {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract must be named and versioned")
	}
	if actual.Kind != microVMKindLifecycle && actual.Kind != microVMKindOperation {
		return invalidMicroVMContract(microVMErrInvalidContract, "apptheory: microvm contract kind is unsupported")
	}
	if invalid := validateMicroVMEscapeHatches(actual, contract.EscapeHatches); invalid != nil {
		return *invalid
	}

	switch actual.Kind {
	case microVMKindLifecycle:
		if err := runtimemicrovm.ValidateRealLifecycleContract(runtimeLifecycleContract(contract.Lifecycle)); err != nil {
			return microVMContractValidationFromError(actual, runtimemicrovm.ErrorCodeRealLifecycleIncomplete, err)
		}
	case microVMKindOperation:
		if err := runtimemicrovm.ValidateOperationContract(contract.OperationContract); err != nil {
			return microVMContractValidationFromError(actual, runtimemicrovm.ErrorCodeOperationContractIncomplete, err)
		}
	}
	return actual
}

func microVMContractValidationFromError(
	actual FixtureMicroVMContractValidation,
	defaultCode string,
	err error,
) FixtureMicroVMContractValidation {
	var safe runtimemicrovm.SafeError
	if errors.As(err, &safe) {
		return FixtureMicroVMContractValidation{
			Valid:        false,
			Kind:         actual.Kind,
			Version:      actual.Version,
			ErrorCode:    safe.Code,
			ErrorMessage: safe.Message,
		}
	}
	return FixtureMicroVMContractValidation{
		Valid:        false,
		Kind:         actual.Kind,
		Version:      actual.Version,
		ErrorCode:    defaultCode,
		ErrorMessage: err.Error(),
	}
}
