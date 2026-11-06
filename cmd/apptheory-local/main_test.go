package main

import (
	"testing"

	"github.com/theory-cloud/apptheory/v6/internal/localrunner"
)

func TestMemoryCellReportsUnresolvedLimits(t *testing.T) {
	cases := []struct {
		name     string
		function localrunner.FunctionSpec
		want     string
	}{
		{
			name:     "literal limit",
			function: localrunner.FunctionSpec{MemoryMB: 256},
			want:     " 256 MB",
		},
		{
			name: "Ref",
			function: localrunner.FunctionSpec{
				MemoryMB:             128,
				UnresolvedMemorySize: true,
				MemorySizeExpression: "Ref",
			},
			want: "unresolved (Ref)",
		},
		{
			name: "unrecognized expression",
			function: localrunner.FunctionSpec{
				MemoryMB:             128,
				UnresolvedMemorySize: true,
			},
			want: "unresolved",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := memoryCell(testCase.function); got != testCase.want {
				t.Fatalf("memoryCell(%+v) = %q, want %q", testCase.function, got, testCase.want)
			}
		})
	}
}
