package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"

	"github.com/theory-cloud/tabletheory"
	"github.com/theory-cloud/tabletheory/pkg/session"

	"github.com/theory-cloud/apptheory/pkg/limited"
	limitedmw "github.com/theory-cloud/apptheory/pkg/limited/middleware"
)

func main() {
	region := os.Getenv("AWS_REGION")
	if region == "" {
		region = os.Getenv("AWS_DEFAULT_REGION")
	}
	if region == "" {
		region = "us-east-1"
	}

	endpoint := os.Getenv("DDB_ENDPOINT")

	db, err := tabletheory.NewBasic(session.Config{
		Region:   region,
		Endpoint: endpoint,
		AWSConfigOptions: []func(*config.LoadOptions) error{
			config.WithRegion(region),
			// DynamoDB Local requires credentials even though they are not used.
			config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider("dummy", "dummy", "")),
		},
	})
	if err != nil {
		log.Fatalf("init TableTheory: %v", err)
	}

	// Fixed window: 60 requests per minute per identifier/resource/method.
	strategy := limited.NewFixedWindowStrategy(time.Minute, 60)
	limiter := limited.NewDynamoRateLimiter(db, nil, strategy)

	rateLimit := limitedmw.Middleware(limitedmw.Options{
		Limiter: limiter,
	})

	http.HandleFunc("/hello", rateLimit(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))

	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

