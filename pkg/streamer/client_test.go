package streamer

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi/types"
	"github.com/stretchr/testify/require"
)

type fakeAPI struct {
	post []*apigatewaymanagementapi.PostToConnectionInput
	get  []*apigatewaymanagementapi.GetConnectionInput
	del  []*apigatewaymanagementapi.DeleteConnectionInput
}

func (f *fakeAPI) PostToConnection(
	_ context.Context,
	params *apigatewaymanagementapi.PostToConnectionInput,
	_ ...func(*apigatewaymanagementapi.Options),
) (*apigatewaymanagementapi.PostToConnectionOutput, error) {
	f.post = append(f.post, params)
	return &apigatewaymanagementapi.PostToConnectionOutput{}, nil
}

func (f *fakeAPI) GetConnection(
	_ context.Context,
	params *apigatewaymanagementapi.GetConnectionInput,
	_ ...func(*apigatewaymanagementapi.Options),
) (*apigatewaymanagementapi.GetConnectionOutput, error) {
	f.get = append(f.get, params)
	now := time.Unix(100, 0).UTC()
	active := time.Unix(200, 0).UTC()
	return &apigatewaymanagementapi.GetConnectionOutput{
		ConnectedAt:  &now,
		LastActiveAt: &active,
		Identity:     &types.Identity{SourceIp: ptr("127.0.0.1"), UserAgent: ptr("test")},
	}, nil
}

func (f *fakeAPI) DeleteConnection(
	_ context.Context,
	params *apigatewaymanagementapi.DeleteConnectionInput,
	_ ...func(*apigatewaymanagementapi.Options),
) (*apigatewaymanagementapi.DeleteConnectionOutput, error) {
	f.del = append(f.del, params)
	return &apigatewaymanagementapi.DeleteConnectionOutput{}, nil
}

func ptr(s string) *string { return &s }

func TestNewClient_ValidatesEndpoint(t *testing.T) {
	_, err := NewClient(context.Background(), "")
	require.Error(t, err)
}

func TestClient_ValidatesConnectionID(t *testing.T) {
	fake := &fakeAPI{}
	c, err := NewClient(context.Background(), "https://example.com/dev", WithAPI(fake))
	require.NoError(t, err)

	require.Error(t, c.PostToConnection(context.Background(), "", []byte("x")))
	require.Error(t, c.DeleteConnection(context.Background(), "  "))
	_, err = c.GetConnection(context.Background(), "\n")
	require.Error(t, err)

	require.Empty(t, fake.post)
	require.Empty(t, fake.get)
	require.Empty(t, fake.del)
}

func TestClient_PostToConnection(t *testing.T) {
	fake := &fakeAPI{}
	c, err := NewClient(context.Background(), "https://example.com/dev", WithAPI(fake))
	require.NoError(t, err)

	require.NoError(t, c.PostToConnection(context.Background(), "abc", []byte("hello")))
	require.Len(t, fake.post, 1)
	require.Equal(t, "abc", *fake.post[0].ConnectionId)
	require.Equal(t, []byte("hello"), fake.post[0].Data)
}

func TestClient_GetConnection(t *testing.T) {
	fake := &fakeAPI{}
	c, err := NewClient(context.Background(), "https://example.com/dev", WithAPI(fake))
	require.NoError(t, err)

	conn, err := c.GetConnection(context.Background(), "abc")
	require.NoError(t, err)
	require.Equal(t, time.Unix(100, 0).UTC(), conn.ConnectedAt)
	require.Equal(t, time.Unix(200, 0).UTC(), conn.LastActiveAt)
	require.Equal(t, "127.0.0.1", conn.IdentityIP)
	require.Equal(t, "test", conn.IdentityAgent)
}

func TestClient_DeleteConnection(t *testing.T) {
	fake := &fakeAPI{}
	c, err := NewClient(context.Background(), "https://example.com/dev", WithAPI(fake))
	require.NoError(t, err)

	require.NoError(t, c.DeleteConnection(context.Background(), "abc"))
	require.Len(t, fake.del, 1)
	require.Equal(t, "abc", *fake.del[0].ConnectionId)
}

func TestNormalizeEndpoint(t *testing.T) {
	require.Equal(t, "", normalizeEndpoint(""))
	require.Equal(t, "https://example.com", normalizeEndpoint("example.com"))
	require.Equal(t, "https://example.com", normalizeEndpoint("https://example.com"))
	require.Equal(t, "https://example.com", normalizeEndpoint("wss://example.com"))
	require.Equal(t, "http://example.com", normalizeEndpoint("ws://example.com"))
}

func TestClient_NilClient(t *testing.T) {
	var nilClient *client
	require.EqualError(t, nilClient.DeleteConnection(context.Background(), "abc"), "streamer: client is nil")
}
