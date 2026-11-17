package mcpfacade

import (
	"context"
	"errors"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// errFrontDoorSecretEmpty reports a parameter that exists but carries no value.
var errFrontDoorSecretEmpty = errors.New(
	"mcpfacade: the front-door secret parameter returned an empty value",
)

// FrontDoorSecretReader reads the current value of a front-door secret parameter.
//
// The default is AWS Systems Manager Parameter Store. Supply a reader on
// FacadeConfig to serve the same well-known name from another source — the local
// runner's credential-free parameter store, for example — and to keep an
// application's unit tests free of AWS calls.
type FrontDoorSecretReader func(ctx context.Context, parameterName string) (string, error)

// defaultFrontDoorSecretReader reads the parameter from Parameter Store with
// decryption enabled, so the same runtime serves a String or SecureString
// parameter. The client is created lazily on the first request inside the
// execution environment; no goroutine or timer is started.
func defaultFrontDoorSecretReader() FrontDoorSecretReader {
	reader := &ssmFrontDoorSecretReader{}
	return reader.read
}

type ssmFrontDoorSecretReader struct {
	mu     sync.Mutex
	client *ssm.Client
}

func (r *ssmFrontDoorSecretReader) read(ctx context.Context, parameterName string) (string, error) {
	client, err := r.ssmClient(ctx)
	if err != nil {
		return "", err
	}
	output, err := client.GetParameter(ctx, &ssm.GetParameterInput{
		Name:           aws.String(parameterName),
		WithDecryption: aws.Bool(true),
	})
	if err != nil {
		return "", err
	}
	if output.Parameter == nil || output.Parameter.Value == nil || *output.Parameter.Value == "" {
		return "", errFrontDoorSecretEmpty
	}
	return *output.Parameter.Value, nil
}

// ssmClient resolves the SDK configuration once per execution environment. A
// configuration failure is not cached: the next request retries, and the
// failure still fails closed in the meantime.
func (r *ssmFrontDoorSecretReader) ssmClient(ctx context.Context) (*ssm.Client, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.client != nil {
		return r.client, nil
	}
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return nil, err
	}
	r.client = ssm.NewFromConfig(cfg)
	return r.client, nil
}
