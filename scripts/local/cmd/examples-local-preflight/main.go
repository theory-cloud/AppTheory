// Command examples-local-preflight proves the environment the AppTheory example
// harness hands to every child process resolves DynamoDB to the checked-in
// local profile instead of the real AWS endpoint, and that the SDK sees nothing
// but the harness's static dummy credentials.
//
// The harness runs it after DynamoDB Local answers; a non-zero exit stops the
// run before any example starts. With -wait it also waits for the profile to
// become ready, so a single program owns both readiness and resolution.
package main

import (
	"context"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

const (
	dummyAccessKeyID     = "dummy"
	dummySecretAccessKey = "dummy"
	resolveTimeout       = 10 * time.Second
	probeTimeout         = 15 * time.Second
)

func main() {
	endpoint := flag.String("endpoint", "", "endpoint the harness expects every DynamoDB client to resolve to")
	wait := flag.Duration("wait", 0, "how long to wait for DynamoDB Local to answer ListTables")
	flag.Parse()

	if err := run(context.Background(), *endpoint, *wait); err != nil {
		fmt.Fprintf(os.Stderr, "preflight: FAIL: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, expectedEndpoint string, wait time.Duration) error {
	expected, err := normalizeEndpoint(expectedEndpoint)
	if err != nil {
		return fmt.Errorf("harness endpoint: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, resolveTimeout)
	defer cancel()

	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	if strings.TrimSpace(cfg.Region) == "" {
		return fmt.Errorf("AWS region is unresolved; the harness must set AWS_REGION")
	}

	creds, err := cfg.Credentials.Retrieve(ctx)
	if err != nil {
		return fmt.Errorf("resolve AWS credentials: %w", err)
	}
	if creds.AccessKeyID != dummyAccessKeyID || creds.SecretAccessKey != dummySecretAccessKey {
		return fmt.Errorf(
			"resolved credentials are not the harness dummy static keys (access key %q); refusing to run with credentials that could reach real AWS",
			creds.AccessKeyID,
		)
	}

	client := dynamodb.NewFromConfig(cfg)
	baseEndpoint := client.Options().BaseEndpoint
	if baseEndpoint == nil || strings.TrimSpace(*baseEndpoint) == "" {
		return fmt.Errorf("AWS DynamoDB endpoint is unresolved; refusing to run where a request could fall through to real AWS")
	}

	resolved, err := normalizeEndpoint(*baseEndpoint)
	if err != nil {
		return fmt.Errorf("resolved DynamoDB endpoint: %w", err)
	}
	if resolved != expected {
		return fmt.Errorf("DynamoDB resolves to %s, not the harness endpoint %s; refusing to run", resolved, expected)
	}
	fmt.Printf("preflight: DynamoDB resolves to %s (region %s, static dummy credentials)\n", resolved, cfg.Region)

	if err := waitForProfile(ctx, client, wait); err != nil {
		return err
	}
	fmt.Printf("preflight: DynamoDB Local answered ListTables at %s\n", resolved)
	return nil
}

// waitForProfile issues a real ListTables call. Any failure before the deadline
// is retried: a container that just started can accept TCP and then reset the
// first HTTP request, and the endpoint was already proven to be the harness's
// before this loop. On timeout the last error is reported.
func waitForProfile(ctx context.Context, client *dynamodb.Client, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	var lastErr error
	for {
		callCtx, cancel := context.WithTimeout(ctx, probeTimeout)
		_, err := client.ListTables(callCtx, &dynamodb.ListTablesInput{})
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		if time.Now().After(deadline) {
			return fmt.Errorf("DynamoDB Local ListTables failed at the harness endpoint: %w", lastErr)
		}
		time.Sleep(time.Second)
	}
}

func normalizeEndpoint(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", fmt.Errorf("empty endpoint")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", fmt.Errorf("parse %q: %w", trimmed, err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("parse %q: endpoint must be an absolute URL", trimmed)
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}
