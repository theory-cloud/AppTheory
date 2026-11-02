package localrunner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testDigest = "sha256:2dc0f1f26731018b369932201d1dac295edd1730d1280f194486ae093ac39798"

func writeProfile(t *testing.T, document map[string]any) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "examples-local.json")
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func validProfileDocument() map[string]any {
	return map[string]any{
		"version": 1,
		"profile": map[string]any{
			"lambda": map[string]any{
				"images": map[string]any{
					"go": map[string]any{"tag": "public.ecr.aws/lambda/provided:al2023", "digest": testDigest, "pinned": "2026-11-01"},
				},
			},
			"endpoints": map[string]any{
				"dynamodb": map[string]any{
					"container": "dynamodb-local",
					"env":       []any{"AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_DYNAMODB", "DYNAMODB_ENDPOINT"},
				},
			},
		},
	}
}

func TestLoadProfileReadsTheHarnessDocument(t *testing.T) {
	profile, err := LoadProfile(writeProfile(t, validProfileDocument()))
	if err != nil {
		t.Fatalf("load profile: %v", err)
	}
	image, err := profile.ImageFor("provided.al2023")
	if err != nil {
		t.Fatalf("resolve image: %v", err)
	}
	if image != "public.ecr.aws/lambda/provided:al2023@"+testDigest {
		t.Fatalf("unexpected image: %s", image)
	}
	names := profile.EndpointEnvNames("dynamodb")
	if strings.Join(names, ",") != "AWS_ENDPOINT_URL,AWS_ENDPOINT_URL_DYNAMODB,DYNAMODB_ENDPOINT" {
		t.Fatalf("unexpected endpoint env names: %v", names)
	}
	if names := profile.EndpointEnvNames("sqs"); len(names) != 1 || names[0] != "AWS_ENDPOINT_URL_SQS" {
		t.Fatalf("unexpected default endpoint env names: %v", names)
	}
}

func TestLoadProfileAlsoAcceptsAStandaloneProfile(t *testing.T) {
	document, ok := validProfileDocument()["profile"].(map[string]any)
	if !ok {
		t.Fatal("test profile document has no profile object")
	}
	profile, err := LoadProfile(writeProfile(t, document))
	if err != nil {
		t.Fatalf("load standalone profile: %v", err)
	}
	if _, err := profile.ImageFor("provided.al2023"); err != nil {
		t.Fatalf("standalone profile did not resolve its image: %v", err)
	}
}

func TestProfileRejectsUnpinnedOrMismatchedImages(t *testing.T) {
	cases := map[string]map[string]any{
		"tag only":  {"tag": "public.ecr.aws/lambda/provided:al2023", "digest": ""},
		"wrong tag": {"tag": "public.ecr.aws/lambda/nodejs:24", "digest": testDigest},
	}
	for name, pin := range cases {
		t.Run(name, func(t *testing.T) {
			document := validProfileDocument()
			profileDocument, ok := document["profile"].(map[string]any)
			if !ok {
				t.Fatal("test profile document has no profile object")
			}
			lambdaSection, ok := profileDocument["lambda"].(map[string]any)
			if !ok {
				t.Fatal("test profile document has no lambda section")
			}
			images, ok := lambdaSection["images"].(map[string]any)
			if !ok {
				t.Fatal("test profile document has no image pins")
			}
			images["go"] = pin
			profile, err := LoadProfile(writeProfile(t, document))
			if err != nil {
				t.Fatalf("load profile: %v", err)
			}
			if _, err := profile.ImageFor("provided.al2023"); err == nil {
				t.Fatalf("%s must fail closed", name)
			}
		})
	}
}

func TestRuntimeClass(t *testing.T) {
	cases := map[string]string{
		"provided.al2023": imageClassGo,
		"provided.al2":    imageClassGo,
		"nodejs24.x":      imageClassNode,
		"nodejs22.x":      imageClassNode,
		"python3.14":      imageClassPython,
	}
	for runtime, expected := range cases {
		actual, err := RuntimeClass(runtime)
		if err != nil || actual != expected {
			t.Fatalf("RuntimeClass(%q) = %q, %v; want %q", runtime, actual, err, expected)
		}
	}
	if _, err := RuntimeClass("java21"); err == nil {
		t.Fatal("unsupported runtimes must fail")
	}
}

func TestProfileImageForWithoutProfile(t *testing.T) {
	var profile *Profile
	if _, err := profile.ImageFor("nodejs24.x"); err == nil {
		t.Fatal("a missing profile must fail closed")
	}
}
