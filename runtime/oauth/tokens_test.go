package oauth

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestMemoryAuthorizationCodeStore_Consume(t *testing.T) {
	store := NewMemoryAuthorizationCodeStore()
	err := store.Put(context.Background(), &AuthorizationCodeRecord{
		Code:      "code1",
		ClientID:  "client",
		ExpiresAt: time.Now().Add(time.Minute).UTC(),
	})
	require.NoError(t, err)

	rec, err := store.Consume(context.Background(), "code1")
	require.NoError(t, err)
	require.Equal(t, "client", rec.ClientID)

	_, err = store.Consume(context.Background(), "code1")
	require.ErrorIs(t, err, ErrAuthorizationCodeNotFound)
}

func TestMemoryRefreshTokenStore_Consume(t *testing.T) {
	store := NewMemoryRefreshTokenStore()
	err := store.Put(context.Background(), &RefreshTokenRecord{
		Token:     "rt1",
		ClientID:  "client",
		ExpiresAt: time.Now().Add(time.Minute).UTC(),
	})
	require.NoError(t, err)

	rec, err := store.Get(context.Background(), "rt1")
	require.NoError(t, err)
	require.Equal(t, "client", rec.ClientID)

	rec, err = store.Consume(context.Background(), "rt1")
	require.NoError(t, err)
	require.Equal(t, "client", rec.ClientID)

	_, err = store.Get(context.Background(), "rt1")
	require.ErrorIs(t, err, ErrRefreshTokenNotFound)
}
