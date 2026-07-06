package oauth

import "errors"

var (
	// ErrMissingBearerToken is returned when an Authorization header is missing.
	ErrMissingBearerToken = errors.New("missing bearer token")
	// ErrInvalidAuthorizationHeader is returned when the Authorization header cannot be parsed as Bearer.
	ErrInvalidAuthorizationHeader = errors.New("invalid authorization header")
	// ErrInvalidBearerToken indicates an unknown or otherwise invalid bearer token.
	ErrInvalidBearerToken = errors.New("invalid bearer token")
	// ErrBearerTokenExpired indicates an expired bearer token.
	ErrBearerTokenExpired = errors.New("bearer token expired")
	// ErrBearerTokenInvalidAudience indicates a bearer token is not bound to the required resource.
	ErrBearerTokenInvalidAudience = errors.New("bearer token invalid audience")
	// ErrBearerTokenInsufficientScope indicates a bearer token lacks a required scope.
	ErrBearerTokenInsufficientScope = errors.New("bearer token insufficient scope")
	// ErrInvalidURL is returned when a required URL is not a valid absolute URL.
	ErrInvalidURL = errors.New("invalid url")

	// ErrAuthorizationCodeNotFound indicates an unknown/consumed authorization code.
	ErrAuthorizationCodeNotFound = errors.New("authorization code not found")
	// ErrAuthorizationCodeExpired indicates an expired authorization code.
	ErrAuthorizationCodeExpired = errors.New("authorization code expired")

	// ErrRefreshTokenNotFound indicates an unknown/revoked refresh token.
	ErrRefreshTokenNotFound = errors.New("refresh token not found")
	// ErrRefreshTokenExpired indicates an expired refresh token.
	ErrRefreshTokenExpired = errors.New("refresh token expired")
)
