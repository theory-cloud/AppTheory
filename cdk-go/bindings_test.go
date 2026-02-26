package cdkgo_test

import (
	"testing"

	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk"
)

func TestBindingsIncludeNewConstructs(t *testing.T) {
	t.Helper()

	_ = apptheorycdk.NewAppTheoryCodeBuildJobRunner
	_ = apptheorycdk.NewAppTheoryEventBridgeRuleTarget
	_ = apptheorycdk.NewAppTheoryJobsTable
	_ = apptheorycdk.NewAppTheoryLambdaRole
	_ = apptheorycdk.NewAppTheoryMediaCdn
	_ = apptheorycdk.NewAppTheoryMcpProtectedResource
	_ = apptheorycdk.NewAppTheoryPathRoutedFrontend
	_ = apptheorycdk.NewAppTheoryQueue
	_ = apptheorycdk.NewAppTheoryQueueConsumer
	_ = apptheorycdk.NewAppTheoryRestApiRouter
	_ = apptheorycdk.NewAppTheoryS3Ingest
}
