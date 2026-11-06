package main

import (
	"log"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"

	"github.com/theory-cloud/tabletheory/v6"
	"github.com/theory-cloud/tabletheory/v6/pkg/session"

	"github.com/theory-cloud/apptheory/v6/pkg/limited"
	limitedmw "github.com/theory-cloud/apptheory/v6/pkg/limited/middleware"
)

func resolveRegion(getenv func(string) string) string {
	if getenv == nil {
		return "us-east-1"
	}

	region := getenv("AWS_REGION")
	if region == "" {
		region = getenv("AWS_DEFAULT_REGION")
	}
	if region == "" {
		region = "us-east-1"
	}
	return region
}

// resolveListenAddr returns the address the demo listens on. The local example
// harness sets LISTEN_ADDR so its slots never collide with another session;
// the default keeps the documented :8080 behavior for manual runs.
func resolveListenAddr(getenv func(string) string) string {
	if getenv == nil {
		return ":8080"
	}
	if addr := getenv("LISTEN_ADDR"); addr != "" {
		return addr
	}
	return ":8080"
}

func main() {
	region := resolveRegion(os.Getenv)

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

	listenAddr := resolveListenAddr(os.Getenv)
	log.Printf("listening on %s", listenAddr)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}
