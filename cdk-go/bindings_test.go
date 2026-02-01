package cdkgo_test

import (
	"testing"

	"github.com/theory-cloud/apptheory/cdk-go/apptheorycdk"
)

func TestBindingsIncludeNewConstructs(t *testing.T) {
	t.Helper()

	_ = apptheorycdk.NewAppTheoryLambdaRole
	_ = apptheorycdk.NewAppTheoryMediaCdn
	_ = apptheorycdk.NewAppTheoryPathRoutedFrontend
	_ = apptheorycdk.NewAppTheoryQueue
	_ = apptheorycdk.NewAppTheoryQueueConsumer
	_ = apptheorycdk.NewAppTheoryRestApiRouter
}
