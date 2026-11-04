package localrunner

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cognitoidentityprovider"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/kinesis"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
	"github.com/aws/aws-sdk-go-v2/service/sns"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

const (
	// backendReadyTimeout matches the in-container preflight probe deadline:
	// an emulator gets the same 60 seconds to start answering traffic.
	backendReadyTimeout = 60 * time.Second
	// backendProbeAttemptTimeout bounds one read-only call, so an endpoint that
	// accepts a connection but never answers cannot stall the whole wait.
	backendProbeAttemptTimeout = 10 * time.Second
	backendProbePollInterval   = 250 * time.Millisecond
)

// waitForBackendReady proves a started backend answers host-side calls before
// the runner provisions resources against it. It sends a cheap read-only call
// through the published loopback port for every endpoint the profile binds to
// the backend, retrying until the deadline or the context ends. A TCP connect
// is not enough: s3proxy can accept a connection and still reset the first
// request while it starts.
func (r *Runner) waitForBackendReady(ctx context.Context, backend, image string, process backendProcess) error {
	endpoints := append([]Endpoint(nil), process.Endpoints...)
	sort.Slice(endpoints, func(i, j int) bool { return endpoints[i].Service < endpoints[j].Service })
	deadline := time.Now().Add(backendReadyTimeout)
	var lastErr error
	for {
		if err := ctx.Err(); err != nil {
			return backendReadinessError(backend, image, process.HostURL, lastErr, err)
		}
		if !time.Now().Before(deadline) {
			return backendReadinessError(backend, image, process.HostURL, lastErr, nil)
		}
		lastErr = nil
		for _, endpoint := range endpoints {
			attemptCtx, cancel := context.WithTimeout(ctx, backendProbeAttemptTimeout)
			err := probeBackendEndpoint(attemptCtx, endpoint.Service, process.HostURL)
			cancel()
			if err != nil {
				lastErr = fmt.Errorf("%s endpoint: %w", endpoint.Service, err)
				break
			}
		}
		if lastErr == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return backendReadinessError(backend, image, process.HostURL, lastErr, ctx.Err())
		case <-time.After(backendProbePollInterval):
		}
	}
}

// probeBackendEndpoint sends one read-only request native to service over the
// backend's loopback URL. A service without a native probe only has to accept
// an HTTP request; the runner cannot invent a protocol call for it.
func probeBackendEndpoint(ctx context.Context, service, hostURL string) error {
	switch strings.ToLower(strings.TrimSpace(service)) {
	case backendDynamoDB:
		_, err := newDynamoDBClient(hostURL).ListTables(ctx, &dynamodb.ListTablesInput{})
		return err
	case "kms":
		_, err := newKMSClient(hostURL).ListKeys(ctx, &kms.ListKeysInput{})
		return err
	case "sts":
		_, err := newSTSClient(hostURL).GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
		return err
	case "s3":
		_, err := newS3Client(hostURL).ListBuckets(ctx, &s3.ListBucketsInput{})
		return err
	case backendSQS:
		_, err := newSQSClient(hostURL).ListQueues(ctx, &sqs.ListQueuesInput{})
		return err
	case backendSSM:
		_, err := newSSMClient(hostURL).DescribeParameters(ctx, &ssm.DescribeParametersInput{})
		return err
	case backendSecretsManager:
		_, err := newSecretsManagerClient(hostURL).ListSecrets(ctx, &secretsmanager.ListSecretsInput{})
		return err
	case backendSNS:
		_, err := newSNSClient(hostURL).ListTopics(ctx, &sns.ListTopicsInput{})
		return err
	case backendKinesis:
		_, err := newKinesisClient(hostURL).ListStreams(ctx, &kinesis.ListStreamsInput{})
		return err
	case backendCognito:
		_, err := newCognitoClient(hostURL).ListUserPools(ctx, &cognitoidentityprovider.ListUserPoolsInput{
			MaxResults: aws.Int32(1),
		})
		return err
	default:
		return probeEndpointHTTP(ctx, hostURL)
	}
}

func probeEndpointHTTP(ctx context.Context, hostURL string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, hostURL, nil)
	if err != nil {
		return err
	}
	client := &http.Client{Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	response, err := client.Do(request) //nolint:gosec // hostURL is the loopback URL the runner published
	if err != nil {
		return err
	}
	_ = response.Body.Close() //nolint:errcheck // readiness only needs any answer
	return nil
}

func backendReadinessError(backend, image, hostURL string, lastErr, cause error) error {
	if errors.Is(cause, context.Canceled) {
		return fmt.Errorf("backend %s (%s) readiness wait canceled at %s: %w", backend, image, hostURL, cause)
	}
	if lastErr == nil {
		lastErr = errors.New("no readiness request was attempted")
	}
	if cause != nil {
		return fmt.Errorf(
			"backend %s (%s) did not become ready at %s before its context deadline: %w",
			backend,
			image,
			hostURL,
			lastErr,
		)
	}
	return fmt.Errorf(
		"backend %s (%s) did not become ready at %s within %s: %w",
		backend,
		image,
		hostURL,
		backendReadyTimeout,
		lastErr,
	)
}
