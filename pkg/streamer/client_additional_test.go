package streamer

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi/types"
	"github.com/stretchr/testify/require"
)

type erroringAPI struct {
	postErr error
	getErr  error
	delErr  error

	getOut *apigatewaymanagementapi.GetConnectionOutput
}

func (f *erroringAPI) PostToConnection(
	_ context.Context,
	_ *apigatewaymanagementapi.PostToConnectionInput,
	_ ...func(*apigatewaymanagementapi.Options),
) (*apigatewaymanagementapi.PostToConnectionOutput, error) {
	return &apigatewaymanagementapi.PostToConnectionOutput{}, f.postErr
}

func (f *erroringAPI) GetConnection(
	_ context.Context,
	_ *apigatewaymanagementapi.GetConnectionInput,
	_ ...func(*apigatewaymanagementapi.Options),
) (*apigatewaymanagementapi.GetConnectionOutput, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return f.getOut, nil
}

func (f *erroringAPI) DeleteConnection(
	_ context.Context,
	_ *apigatewaymanagementapi.DeleteConnectionInput,
	_ ...func(*apigatewaymanagementapi.Options),
) (*apigatewaymanagementapi.DeleteConnectionOutput, error) {
	return &apigatewaymanagementapi.DeleteConnectionOutput{}, f.delErr
}

func TestNewClient_WithAWSConfig_BuildsClient(t *testing.T) {
	cfg := aws.Config{Region: "us-east-1", Credentials: aws.AnonymousCredentials{}}

	c, err := NewClient(context.TODO(), "wss://example.com/dev", nil, WithAWSConfig(cfg))
	require.NoError(t, err)
	require.NotNil(t, c)
}

func TestNewClient_LoadsDefaultConfig_WhenNoAWSConfigProvided(t *testing.T) {
	t.Setenv("AWS_REGION", "us-east-1")

	c, err := NewClient(context.Background(), "https://example.com/dev")
	require.NoError(t, err)
	require.NotNil(t, c)
}

func TestClient_Methods_HandleContextTODO(t *testing.T) {
	now := time.Unix(10, 0).UTC()
	fake := &erroringAPI{
		getOut: &apigatewaymanagementapi.GetConnectionOutput{
			ConnectedAt: &now,
			Identity:    &types.Identity{SourceIp: ptr("127.0.0.1")},
		},
	}
	c, err := NewClient(context.Background(), "https://example.com/dev", WithAPI(fake))
	require.NoError(t, err)

	require.NoError(t, c.PostToConnection(context.TODO(), "abc", []byte("x")))
	_, err = c.GetConnection(context.TODO(), "abc")
	require.NoError(t, err)
	require.NoError(t, c.DeleteConnection(context.TODO(), "abc"))
}

func TestClient_GetConnection_HandlesNilFieldsAndErrors(t *testing.T) {
	fake := &erroringAPI{
		getOut: &apigatewaymanagementapi.GetConnectionOutput{},
	}
	c, err := NewClient(context.Background(), "https://example.com/dev", WithAPI(fake))
	require.NoError(t, err)

	conn, err := c.GetConnection(context.Background(), "abc")
	require.NoError(t, err)
	require.True(t, conn.ConnectedAt.IsZero())
	require.True(t, conn.LastActiveAt.IsZero())
	require.Equal(t, "", conn.IdentityIP)
	require.Equal(t, "", conn.IdentityAgent)

	fake.getErr = errors.New("boom")
	_, err = c.GetConnection(context.Background(), "abc")
	require.Error(t, err)
}
