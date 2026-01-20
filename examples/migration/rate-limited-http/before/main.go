//go:build ignore

package main

import (
	"log"
	"net/http"
	"time"

	"github.com/pay-theory/dynamorm/pkg/core"
	"github.com/pay-theory/limited"
	limitedmw "github.com/pay-theory/limited/middleware"
	"go.uber.org/zap"
)

func main() {
	db, err := core.NewDB(core.Config{
		Region:    "us-east-1",
		TableName: "rate-limits",
	})
	if err != nil {
		log.Fatal(err)
	}

	strategy := limited.NewFixedWindowStrategy(time.Minute, 60)
	limiter := limited.NewDynamoRateLimiter(db, nil, strategy, zap.NewNop())

	rateLimit := limitedmw.Middleware(limitedmw.Options{
		Limiter: limiter,
	})

	http.HandleFunc("/hello", rateLimit(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))

	log.Fatal(http.ListenAndServe(":8080", nil))
}
