package streamer

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
)

// Client is an API Gateway Management API client.
type Client interface {
	PostToConnection(ctx context.Context, connectionID string, data []byte) error
	GetConnection(ctx context.Context, connectionID string) (Connection, error)
	DeleteConnection(ctx context.Context, connectionID string) error
}

type Connection struct {
	ConnectedAt   time.Time
	LastActiveAt  time.Time
	IdentityIP    string
	IdentityAgent string
}

type apiGatewayManagementAPI interface {
	PostToConnection(
		ctx context.Context,
		params *apigatewaymanagementapi.PostToConnectionInput,
		optFns ...func(*apigatewaymanagementapi.Options),
	) (*apigatewaymanagementapi.PostToConnectionOutput, error)
	GetConnection(
		ctx context.Context,
		params *apigatewaymanagementapi.GetConnectionInput,
		optFns ...func(*apigatewaymanagementapi.Options),
	) (*apigatewaymanagementapi.GetConnectionOutput, error)
	DeleteConnection(
		ctx context.Context,
		params *apigatewaymanagementapi.DeleteConnectionInput,
		optFns ...func(*apigatewaymanagementapi.Options),
	) (*apigatewaymanagementapi.DeleteConnectionOutput, error)
}

type client struct {
	api apiGatewayManagementAPI
}

type clientOptions struct {
	api    apiGatewayManagementAPI
	awsCfg *aws.Config
}

type Option func(*clientOptions)

func WithAWSConfig(cfg aws.Config) Option {
	return func(opts *clientOptions) {
		cfgCopy := cfg
		opts.awsCfg = &cfgCopy
	}
}

func WithAPI(api apiGatewayManagementAPI) Option {
	return func(opts *clientOptions) {
		opts.api = api
	}
}

func NewClient(ctx context.Context, endpoint string, options ...Option) (Client, error) {
	if ctx == nil {
		ctx = context.Background()
	}

	opts := &clientOptions{}
	for _, opt := range options {
		if opt == nil {
			continue
		}
		opt(opts)
	}

	endpoint = normalizeEndpoint(endpoint)
	if endpoint == "" {
		return nil, errors.New("streamer: endpoint is empty")
	}

	if opts.api != nil {
		return &client{api: opts.api}, nil
	}

	var cfg aws.Config
	if opts.awsCfg != nil {
		cfg = *opts.awsCfg
	} else {
		loaded, err := awsconfig.LoadDefaultConfig(ctx)
		if err != nil {
			return nil, err
		}
		cfg = loaded
	}

	svc := apigatewaymanagementapi.NewFromConfig(cfg, func(o *apigatewaymanagementapi.Options) {
		o.BaseEndpoint = aws.String(endpoint)
	})
	return &client{api: svc}, nil
}

func normalizeEndpoint(endpoint string) string {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return ""
	}
	if strings.HasPrefix(endpoint, "wss://") {
		return "https://" + strings.TrimPrefix(endpoint, "wss://")
	}
	if strings.HasPrefix(endpoint, "ws://") {
		return "http://" + strings.TrimPrefix(endpoint, "ws://")
	}
	if strings.HasPrefix(endpoint, "http://") || strings.HasPrefix(endpoint, "https://") {
		return endpoint
	}
	return "https://" + endpoint
}

func (c *client) PostToConnection(ctx context.Context, connectionID string, data []byte) error {
	if c == nil || c.api == nil {
		return errors.New("streamer: client is nil")
	}
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return errors.New("streamer: connection id is empty")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	_, err := c.api.PostToConnection(ctx, &apigatewaymanagementapi.PostToConnectionInput{
		ConnectionId: aws.String(connectionID),
		Data:         data,
	})
	return err
}

func (c *client) GetConnection(ctx context.Context, connectionID string) (Connection, error) {
	if c == nil || c.api == nil {
		return Connection{}, errors.New("streamer: client is nil")
	}
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return Connection{}, errors.New("streamer: connection id is empty")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	out, err := c.api.GetConnection(ctx, &apigatewaymanagementapi.GetConnectionInput{
		ConnectionId: aws.String(connectionID),
	})
	if err != nil {
		return Connection{}, err
	}

	resp := Connection{}
	if out.ConnectedAt != nil {
		resp.ConnectedAt = *out.ConnectedAt
	}
	if out.LastActiveAt != nil {
		resp.LastActiveAt = *out.LastActiveAt
	}
	if out.Identity != nil {
		resp.IdentityIP = aws.ToString(out.Identity.SourceIp)
		resp.IdentityAgent = aws.ToString(out.Identity.UserAgent)
	}
	return resp, nil
}

func (c *client) DeleteConnection(ctx context.Context, connectionID string) error {
	if c == nil || c.api == nil {
		return errors.New("streamer: client is nil")
	}
	connectionID = strings.TrimSpace(connectionID)
	if connectionID == "" {
		return errors.New("streamer: connection id is empty")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	_, err := c.api.DeleteConnection(ctx, &apigatewaymanagementapi.DeleteConnectionInput{
		ConnectionId: aws.String(connectionID),
	})
	return err
}
