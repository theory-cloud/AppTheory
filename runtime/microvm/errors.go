package microvm

import (
	"errors"
	"strings"
)

const (
	// ErrorCodeInvalidContract reports an unsupported or malformed MicroVM contract.
	ErrorCodeInvalidContract = "m15.microvm.invalid_contract"
	// ErrorCodeRawSDKEscapeHatch reports a forbidden raw AWS SDK escape hatch.
	ErrorCodeRawSDKEscapeHatch = "m15.microvm.raw_sdk_escape_hatch"
	// ErrorCodeLifecycleBypass reports a forbidden raw lifecycle hook bypass.
	ErrorCodeLifecycleBypass = "m15.microvm.lifecycle_bypass" //nolint:gosec // Contract error code, not a credential.
	// ErrorCodeLifecycleIncomplete reports an incomplete lifecycle contract.
	ErrorCodeLifecycleIncomplete = "m15.microvm.lifecycle_incomplete"
	// ErrorCodeForbiddenField reports a field that AppTheory refuses to persist or echo.
	ErrorCodeForbiddenField = "m15.microvm.forbidden_field"
	// ErrorCodeInvalidLifecycleEvent reports a malformed lifecycle event.
	ErrorCodeInvalidLifecycleEvent = "m15.microvm.invalid_lifecycle_event"
	// ErrorCodeLifecycleHookFailed reports a lifecycle hook handler failure.
	ErrorCodeLifecycleHookFailed = "m15.microvm.lifecycle_hook_failed"
)

// SafeError is the MicroVM-safe error envelope exposed by lifecycle and controller adapters.
// It carries only code, message, and request_id so callers cannot leak raw provider errors,
// bearer tokens, AWS credentials, or lifecycle payloads through AppTheory primitives.
type SafeError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

func (e SafeError) Error() string {
	if strings.TrimSpace(e.Message) != "" {
		return e.Message
	}
	return e.Code
}

func safeError(code, message, requestID string) SafeError {
	return SafeError{
		Code:      strings.TrimSpace(code),
		Message:   strings.TrimSpace(message),
		RequestID: strings.TrimSpace(requestID),
	}
}

func invalidContractError(code, message string) error {
	err := safeError(code, message, "")
	return err
}

func asSafeError(err error, requestID string) SafeError {
	if err == nil {
		return SafeError{}
	}
	var safe SafeError
	if errors.As(err, &safe) {
		if safe.RequestID == "" {
			safe.RequestID = strings.TrimSpace(requestID)
		}
		return safe
	}
	return safeError(ErrorCodeControllerCommandFailed, "apptheory: microvm controller command failed", requestID)
}
