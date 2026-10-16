package apptheory_test

import (
	"testing"
	"time"

	tabletheory "github.com/theory-cloud/tabletheory/v6"
	tablecore "github.com/theory-cloud/tabletheory/v6/pkg/core"

	"github.com/theory-cloud/apptheory/v6/pkg/limited"
	"github.com/theory-cloud/apptheory/v6/pkg/services"
	mcpruntime "github.com/theory-cloud/apptheory/v6/runtime/mcp"
)

// A TableTheory v6 *LambdaDB must satisfy core.ExtendedDB. In v5 the declared
// WithLambdaTimeout returned *LambdaDB and shadowed the promoted interface
// method, so the LambdaInit handle consumers hold failed this assertion at
// Lambda cold start.
var _ tablecore.ExtendedDB = (*tabletheory.LambdaDB)(nil)

// TestLambdaInitHandleFlowsIntoEveryDynamoSeam is the compile proof for the
// consumer migration: the v6 handle a consumer gets from tabletheory.LambdaInit
// passes unchanged into every DynamoDB-backed AppTheory seam, and it is usable
// as both the base interface those seams take and the extended interface that
// carries the transaction and schema methods.
func TestLambdaInitHandleFlowsIntoEveryDynamoSeam(t *testing.T) {
	db, err := tabletheory.LambdaInit()
	if err != nil {
		t.Fatalf("tabletheory.LambdaInit: %v", err)
	}

	var extended tablecore.ExtendedDB = db
	_ = extended

	_ = services.NewDynamoDBEventBus(db, services.DefaultEventBusConfig())
	_ = limited.NewDynamoRateLimiter(db, limited.DefaultConfig(), limited.NewFixedWindowStrategy(time.Minute, 10))
	_ = mcpruntime.NewDynamoSessionStore(db)
	_ = mcpruntime.NewDynamoStreamStore(db)
	_ = mcpruntime.NewDynamoTaskStore(db)
}
