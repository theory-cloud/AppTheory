package apptheory_test

import (
	"testing"

	"github.com/theory-cloud/apptheory"
)

func TestNew(t *testing.T) {
	if apptheory.New() == nil {
		t.Fatal("expected New() to return a non-nil App")
	}
}

