package apptheorycdk

import (
	"testing"
)

func TestBindingsIncludeNewConstructs(t *testing.T) {
	t.Helper()

	_ = NewAppTheoryCodeBuildJobRunner
	_ = NewAppTheoryEventBridgeRuleTarget
	_ = NewAppTheoryJobsTable
	_ = NewAppTheoryLambdaRole
	_ = NewAppTheoryMediaCdn
	_ = NewAppTheoryMcpProtectedResource
	_ = NewAppTheoryPathRoutedFrontend
	_ = NewAppTheoryQueue
	_ = NewAppTheoryQueueConsumer
	_ = NewAppTheoryRestApiRouter
	_ = NewAppTheoryS3Ingest
}
