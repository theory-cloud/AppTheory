package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	apptheory "github.com/theory-cloud/apptheory/v2/runtime"
)

func isOpenAPIContractFixture(f Fixture) bool {
	return len(f.Setup.OpenAPI) > 0
}

func runFixtureOpenAPI(f Fixture) error {
	var spec apptheory.OpenAPISpec
	if err := json.Unmarshal(f.Setup.OpenAPI, &spec); err != nil {
		return fmt.Errorf("parse setup.openapi: %w", err)
	}
	actual, err := apptheory.GenerateOpenAPIJSON(spec)
	if f.Expect.Error != nil {
		if len(f.Expect.Output) != 0 {
			return fmt.Errorf("fixture expect cannot set both error and output_json")
		}
		if err == nil {
			return fmt.Errorf("expected openapi error, got nil")
		}
		expected := strings.TrimSpace(f.Expect.Error.Message)
		if expected != "" && strings.TrimSpace(err.Error()) != expected {
			return fmt.Errorf("openapi error message mismatch: expected %q, got %q", expected, err.Error())
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("generate openapi: %w", err)
	}
	expected, err := expectedOpenAPIJSON(f)
	if err != nil {
		return err
	}
	if string(actual) != expected {
		return fmt.Errorf("openapi canonical json mismatch")
	}
	return nil
}

func expectedOpenAPIJSON(f Fixture) (string, error) {
	if len(f.Expect.Output) == 0 {
		return "", fmt.Errorf("fixture missing expect.output_json")
	}
	var expected string
	if err := json.Unmarshal(f.Expect.Output, &expected); err != nil {
		return "", fmt.Errorf("parse expected openapi output_json string: %w", err)
	}
	return expected, nil
}

func printFailureOpenAPI(f Fixture) {
	var spec apptheory.OpenAPISpec
	if err := json.Unmarshal(f.Setup.OpenAPI, &spec); err != nil {
		fmt.Fprintf(os.Stderr, "  got.openapi_json: <unavailable>\n")
		return
	}
	actual, err := apptheory.GenerateOpenAPIJSON(spec)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  got.openapi_json: <error: %s>\n", err)
		return
	}
	expected, err := expectedOpenAPIJSON(f)
	if err != nil {
		fmt.Fprintf(os.Stderr, "  expected.openapi_json: <error: %s>\n", err)
	} else {
		fmt.Fprintf(os.Stderr, "  expected.openapi_json: %s\n", expected)
	}
	fmt.Fprintf(os.Stderr, "  got.openapi_json: %s\n", strings.TrimSpace(string(actual)))
}
