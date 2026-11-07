package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/apigatewaymanagementapi"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// The Go caller proves two compositions a real application uses.
//
// First, a function container's own TLS stack verifies the runner's
// certificate. The Lambda image reads SSL_CERT_FILE (the run's trust bundle)
// through crypto/x509, and the client below is a plain &http.Client{}, so no
// code in this file knows about the CA.
// https://pkg.go.dev/crypto/x509#SystemCertPool
//
// Second, the AWS SDK for Go v2 loads its config with a caller-supplied
// *http.Client, the shape a table mapper such as TableTheory/DynamORM uses.
// The Go container deliberately does not receive AWS_CA_BUNDLE: the SDK applies
// that bundle only through its own buildable client and fails config loading
// for any other client. https://github.com/aws/aws-sdk-go-v2/blob/config/v1.33.13/config/resolve.go

type request struct {
	URL string `json:"url"`
	// AWS asks the handler to also make the two AWS SDK calls. The rows that
	// only fetch the issuer leave it false, so one handler serves both shapes.
	AWS bool `json:"aws"`
}

type result struct {
	OK     bool   `json:"ok"`
	Issuer string `json:"issuer"`
	Keys   int    `json:"keys"`
	// Tables is the DynamoDB Local table count the caller-supplied client read.
	Tables int `json:"tables"`
	// Management is the status the @connections management API answered a
	// PostToConnection for an unknown connection id. 410 GONE is the documented
	// answer, and reaching it proves the SDK verified the run's TLS endpoint.
	Management int `json:"management"`
}

func getJSON(client *http.Client, url string, target any) error {
	response, err := client.Get(url) //nolint:gosec // the caller passes the app's own local URL
	if err != nil {
		return fmt.Errorf("GET %s: %w", url, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: status %d", url, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read %s: %w", url, err)
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("decode %s: %w", url, err)
	}
	return nil
}

// exerciseAWS loads the SDK config over a caller-supplied client and makes one
// call to each runner-served endpoint the container was given.
func exerciseAWS(ctx context.Context) (result, error) {
	var out result
	client := &http.Client{Timeout: 10 * time.Second}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithHTTPClient(client))
	if err != nil {
		return out, fmt.Errorf("load the AWS config with a caller-supplied http.Client: %w", err)
	}
	tables, err := dynamodb.NewFromConfig(cfg).ListTables(ctx, &dynamodb.ListTablesInput{})
	if err != nil {
		return out, fmt.Errorf("DynamoDB ListTables over the caller-supplied client: %w", err)
	}
	out.Tables = len(tables.TableNames)

	management := apigatewaymanagementapi.NewFromConfig(cfg)
	_, err = management.PostToConnection(ctx, &apigatewaymanagementapi.PostToConnectionInput{
		ConnectionId: aws.String("apptheory-local-tls-probe"),
		Data:         []byte("probe"),
	})
	// The runner answers an unknown connection with the documented 410 GONE.
	// The local body is not the modeled error shape, so the SDK reports the
	// HTTP status through its response error rather than a GoneException;
	// either way the status is what proves the call reached the TLS endpoint.
	var responseErr interface{ HTTPStatusCode() int }
	if !errors.As(err, &responseErr) || responseErr.HTTPStatusCode() != http.StatusGone {
		return out, fmt.Errorf("the @connections call did not reach the run's TLS endpoint: %w", err)
	}
	out.Management = http.StatusGone
	return out, nil
}

func handler(ctx context.Context, event request) (result, error) {
	if event.URL == "" {
		return result{}, fmt.Errorf("url is required")
	}
	out := result{}
	client := &http.Client{Timeout: 10 * time.Second}
	var discovery struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := getJSON(client, event.URL+"/.well-known/openid-configuration", &discovery); err != nil {
		return result{}, err
	}
	if discovery.Issuer != event.URL {
		return result{}, fmt.Errorf("issuer %q does not equal %q", discovery.Issuer, event.URL)
	}
	var jwks struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := getJSON(client, discovery.JWKSURI, &jwks); err != nil {
		return result{}, err
	}
	if len(jwks.Keys) == 0 {
		return result{}, fmt.Errorf("jwks has no keys")
	}
	out.OK, out.Issuer, out.Keys = true, discovery.Issuer, len(jwks.Keys)
	if event.AWS {
		awsResult, err := exerciseAWS(ctx)
		if err != nil {
			return result{}, err
		}
		out.Tables, out.Management = awsResult.Tables, awsResult.Management
	}
	return out, nil
}

func main() {
	lambda.Start(handler)
}
