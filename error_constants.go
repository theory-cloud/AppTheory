package apptheory

const (
	errorCodeBadRequest       = "app.bad_request"
	errorCodeValidationFailed = "app.validation_failed"
	errorCodeUnauthorized     = "app.unauthorized"
	errorCodeForbidden        = "app.forbidden"
	errorCodeNotFound         = "app.not_found"
	errorCodeMethodNotAllowed = "app.method_not_allowed"
	errorCodeConflict         = "app.conflict"
	errorCodeTooLarge         = "app.too_large"
	errorCodeRateLimited      = "app.rate_limited"
	errorCodeOverloaded       = "app.overloaded"
	errorCodeInternal         = "app.internal"
)

const (
	errorMessageInvalidJSON        = "invalid json"
	errorMessageInvalidQueryString = "invalid query string"
	errorMessageUnauthorized       = "unauthorized"
	errorMessageForbidden          = "forbidden"
	errorMessageNotFound           = "not found"
	errorMessageMethodNotAllowed   = "method not allowed"
	errorMessageRequestTooLarge    = "request too large"
	errorMessageResponseTooLarge   = "response too large"
	errorMessageRateLimited        = "rate limited"
	errorMessageOverloaded         = "overloaded"
	errorMessageInternal           = "internal error"
)
