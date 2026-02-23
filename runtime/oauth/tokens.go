package oauth

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"time"
)

// NewOpaqueToken generates a URL-safe opaque token suitable for authorization codes
// and refresh tokens.
func NewOpaqueToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("token: rand: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:]), nil
}

// AuthorizationCodeRecord stores the data needed to redeem an authorization code.
type AuthorizationCodeRecord struct {
	Code                string
	ClientID            string
	RedirectURI         string
	Resource            string
	CodeChallenge       string
	CodeChallengeMethod string
	ExpiresAt           time.Time
}

// AuthorizationCodeStore stores short-lived authorization codes.
type AuthorizationCodeStore interface {
	Put(ctx context.Context, rec *AuthorizationCodeRecord) error
	Consume(ctx context.Context, code string) (*AuthorizationCodeRecord, error)
}

// MemoryAuthorizationCodeStore is an in-memory AuthorizationCodeStore.
type MemoryAuthorizationCodeStore struct {
	mu    sync.Mutex
	codes map[string]*AuthorizationCodeRecord
}

func NewMemoryAuthorizationCodeStore() *MemoryAuthorizationCodeStore {
	return &MemoryAuthorizationCodeStore{codes: map[string]*AuthorizationCodeRecord{}}
}

func consumeStoreRecord[T any](
	mu *sync.Mutex,
	records map[string]*T,
	key string,
	notFound error,
	expired error,
	expiresAt func(*T) time.Time,
) (*T, error) {
	if strings.TrimSpace(key) == "" {
		return nil, notFound
	}

	now := time.Now().UTC()

	mu.Lock()
	defer mu.Unlock()

	rec := records[key]
	if rec == nil {
		return nil, notFound
	}
	delete(records, key)

	if expiresAt != nil {
		if exp := expiresAt(rec); !exp.IsZero() && now.After(exp) {
			return nil, expired
		}
	}

	return rec, nil
}

func (s *MemoryAuthorizationCodeStore) Put(_ context.Context, rec *AuthorizationCodeRecord) error {
	if rec == nil || rec.Code == "" {
		return fmt.Errorf("authcode: missing code")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.codes[rec.Code] = rec
	return nil
}

func (s *MemoryAuthorizationCodeStore) Consume(_ context.Context, code string) (*AuthorizationCodeRecord, error) {
	return consumeStoreRecord(&s.mu, s.codes, code, ErrAuthorizationCodeNotFound, ErrAuthorizationCodeExpired, func(r *AuthorizationCodeRecord) time.Time {
		return r.ExpiresAt
	})
}

// RefreshTokenRecord stores long-lived refresh token state.
type RefreshTokenRecord struct {
	Token     string
	ClientID  string
	Subject   string
	Resource  string
	ExpiresAt time.Time
}

// RefreshTokenStore stores refresh tokens. Implementations should support
// rotation by Consume+Put.
type RefreshTokenStore interface {
	Put(ctx context.Context, rec *RefreshTokenRecord) error
	Get(ctx context.Context, token string) (*RefreshTokenRecord, error)
	Consume(ctx context.Context, token string) (*RefreshTokenRecord, error)
	Delete(ctx context.Context, token string) error
}

// MemoryRefreshTokenStore is an in-memory RefreshTokenStore.
type MemoryRefreshTokenStore struct {
	mu     sync.Mutex
	tokens map[string]*RefreshTokenRecord
}

func NewMemoryRefreshTokenStore() *MemoryRefreshTokenStore {
	return &MemoryRefreshTokenStore{tokens: map[string]*RefreshTokenRecord{}}
}

func (s *MemoryRefreshTokenStore) Put(_ context.Context, rec *RefreshTokenRecord) error {
	if rec == nil || rec.Token == "" {
		return fmt.Errorf("refresh: missing token")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens[rec.Token] = rec
	return nil
}

func (s *MemoryRefreshTokenStore) Get(_ context.Context, token string) (*RefreshTokenRecord, error) {
	if strings.TrimSpace(token) == "" {
		return nil, ErrRefreshTokenNotFound
	}
	now := time.Now().UTC()

	s.mu.Lock()
	defer s.mu.Unlock()
	rec := s.tokens[token]
	if rec == nil {
		return nil, ErrRefreshTokenNotFound
	}
	if !rec.ExpiresAt.IsZero() && now.After(rec.ExpiresAt) {
		return nil, ErrRefreshTokenExpired
	}
	return rec, nil
}

func (s *MemoryRefreshTokenStore) Consume(_ context.Context, token string) (*RefreshTokenRecord, error) {
	return consumeStoreRecord(&s.mu, s.tokens, token, ErrRefreshTokenNotFound, ErrRefreshTokenExpired, func(r *RefreshTokenRecord) time.Time {
		return r.ExpiresAt
	})
}

func (s *MemoryRefreshTokenStore) Delete(_ context.Context, token string) error {
	if strings.TrimSpace(token) == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tokens, token)
	return nil
}
