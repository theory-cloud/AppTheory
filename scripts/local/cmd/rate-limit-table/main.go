// Command rate-limit-table provisions the DynamoDB table the
// examples/migration/rate-limited-http example writes to, using the real
// pkg/limited model so the harness creates the same keys and TTL the example
// expects.
//
// It is idempotent: AutoMigrate checks for the table first. The harness runs it
// against the checked-in DynamoDB Local profile before starting the server.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"

	"github.com/theory-cloud/tabletheory/v6"
	"github.com/theory-cloud/tabletheory/v6/pkg/session"

	"github.com/theory-cloud/apptheory/v6/pkg/limited"
)

const provisionTimeout = 60 * time.Second

func main() {
	table := flag.String("table", "", "table name to provision")
	region := flag.String("region", "", "AWS region (defaults to AWS_REGION)")
	flag.Parse()

	if err := run(*table, *region); err != nil {
		fmt.Fprintf(os.Stderr, "rate-limit-table: FAIL: %v\n", err)
		os.Exit(1)
	}
}

func run(table, region string) error {
	table = strings.TrimSpace(table)
	if table == "" {
		table = strings.TrimSpace(os.Getenv("APPTHEORY_RATE_LIMIT_TABLE_NAME"))
	}
	if table == "" {
		return fmt.Errorf("no table name: pass -table or set APPTHEORY_RATE_LIMIT_TABLE_NAME")
	}
	if region = strings.TrimSpace(region); region == "" {
		region = strings.TrimSpace(os.Getenv("AWS_REGION"))
	}
	if region == "" {
		region = "us-east-1"
	}

	// The model reads the table name from the same environment the example
	// uses, so set it explicitly before creating anything.
	if err := os.Setenv("APPTHEORY_RATE_LIMIT_TABLE_NAME", table); err != nil {
		return fmt.Errorf("set table name: %w", err)
	}

	db, err := tabletheory.NewBasic(session.Config{
		Region:   region,
		Endpoint: strings.TrimSpace(os.Getenv("DDB_ENDPOINT")),
		AWSConfigOptions: []func(*config.LoadOptions) error{
			config.WithRegion(region),
			config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("dummy", "dummy", "")),
		},
	})
	if err != nil {
		return fmt.Errorf("init TableTheory: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), provisionTimeout)
	defer cancel()

	if err := db.WithContext(ctx).AutoMigrate(&limited.RateLimitEntry{}); err != nil {
		return fmt.Errorf("provision %q: %w", table, err)
	}
	fmt.Printf("rate-limit table %s: ready\n", table)
	return nil
}
