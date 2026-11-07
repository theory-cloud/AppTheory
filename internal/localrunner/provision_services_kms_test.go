package localrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestProvisionSecretsResolvesTheKmsKeyIdIntrinsic(t *testing.T) {
	var mu sync.Mutex
	requests := map[string]map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		var payload map[string]any
		_ = json.Unmarshal(body, &payload)  //nolint:errcheck // protocol fixture
		name, _ := payload["Name"].(string) //nolint:errcheck // protocol fixture
		mu.Lock()
		requests[name] = payload
		mu.Unlock()
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		writeTestResponse(t, writer, `{"ARN":"arn:aws:secretsmanager:us-east-1:123456789012:secret:`+name+`-abcdef","Name":"`+name+`"}`)
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSecretsManager}}},
		},
		resourceValues: resourceValues{
			"Stack/Key": {
				Type:  typeKMSKey,
				Name:  "key-id",
				KeyID: "key-id",
				ARN:   "arn:aws:kms:us-east-1:123456789012:key/key-id",
			},
		},
		secretValues: map[string]string{},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{
			Stack: "Stack", LogicalID: "Key", Type: typeKMSKey,
			Properties: json.RawMessage(`{}`),
		},
		{
			Stack: "Stack", LogicalID: "Keyed", Type: typeSecretsSecret,
			Properties: json.RawMessage(`{"Name":"app/keyed","SecretString":"{}","KmsKeyId":{"Fn::GetAtt":["Key","Arn"]}}`),
		},
		{
			Stack: "Stack", LogicalID: "Literal", Type: typeSecretsSecret,
			Properties: json.RawMessage(`{"Name":"app/literal","SecretString":"{}","KmsKeyId":"alias/aws/secretsmanager"}`),
		},
	}}
	if err := runner.provisionSecrets(context.Background(), spec); err != nil {
		t.Fatalf("provision secrets: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if got := requests["app/keyed"]["KmsKeyId"]; got != "arn:aws:kms:us-east-1:123456789012:key/key-id" {
		t.Fatalf("Fn::GetAtt KmsKeyId was not resolved: %+v", requests["app/keyed"])
	}
	if got := requests["app/literal"]["KmsKeyId"]; got != "alias/aws/secretsmanager" {
		t.Fatalf("literal KmsKeyId changed: %+v", requests["app/literal"])
	}
}
