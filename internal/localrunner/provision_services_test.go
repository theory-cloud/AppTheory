package localrunner

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestProvisionSSMParametersCreatesAllTypes(t *testing.T) {
	var mu sync.Mutex
	var put map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		target := request.Header.Get("X-Amz-Target")
		if !strings.HasSuffix(target, "PutParameter") {
			t.Errorf("unexpected target %q", target)
		}
		mu.Lock()
		decodeErr := json.Unmarshal(body, &put)
		mu.Unlock()
		if decodeErr != nil {
			t.Errorf("decode PutParameter: %v", decodeErr)
		}
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		writeTestResponse(t, writer, `{"Version":1}`)
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSSM}}},
		},
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Secure", Type: typeSSMParameter,
		Properties: json.RawMessage(`{"Name":"/app/secure","Type":"SecureString","Value":"s3cret"}`),
	}}}
	if err := runner.provisionSSMParameters(context.Background(), spec); err != nil {
		t.Fatalf("provision SSM: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if put["Name"] != "/app/secure" || put["Type"] != "SecureString" || put["Value"] != "s3cret" {
		t.Fatalf("unexpected PutParameter request: %+v", put)
	}
	value := runner.resourceValues["Stack/Secure"]
	if value.Name != "/app/secure" || value.SSMType != "SecureString" || value.SSMValue != "s3cret" {
		t.Fatalf("unexpected provisioned parameter: %+v", value)
	}
	if value.ARN != "arn:aws:ssm:us-east-1:123456789012:parameter/app/secure" {
		t.Fatalf("unexpected parameter ARN: %q", value.ARN)
	}
}

func TestProvisionSecretsStoresSecretStringAndGeneratedValue(t *testing.T) {
	var mu sync.Mutex
	requests := map[string]map[string]any{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		target := request.Header.Get("X-Amz-Target")
		var payload map[string]any
		_ = json.Unmarshal(body, &payload) //nolint:errcheck // protocol fixture
		mu.Lock()
		requests[target] = payload
		mu.Unlock()
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		name, _ := payload["Name"].(string) //nolint:errcheck // protocol fixture
		writeTestResponse(t, writer, `{"ARN":"arn:aws:secretsmanager:us-east-1:123456789012:secret:`+name+`-abcdef","Name":"`+name+`"}`)
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSecretsManager}}},
		},
		resourceValues: resourceValues{},
		secretValues:   map[string]string{},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{
			Stack: "Stack", LogicalID: "Literal", Type: typeSecretsSecret,
			Properties: json.RawMessage(`{"Name":"app/literal","SecretString":"{\"token\":\"fixed\"}"}`),
		},
		{
			Stack: "Stack", LogicalID: "Generated", Type: typeSecretsSecret,
			Properties: json.RawMessage(`{"Name":"app/generated","GenerateSecretString":{` +
				`"SecretStringTemplate":"{\"username\":\"u\"}","GenerateStringKey":"password",` +
				`"PasswordLength":20,"ExcludePunctuation":true}}`),
		},
		{
			Stack: "Stack", LogicalID: "Bare", Type: typeSecretsSecret,
			Properties: json.RawMessage(`{"Name":"app/bare","GenerateSecretString":{` +
				`"PasswordLength":20,"ExcludePunctuation":true}}`),
		},
	}}
	if err := runner.provisionSecrets(context.Background(), spec); err != nil {
		t.Fatalf("provision secrets: %v", err)
	}
	literal := runner.resourceValues["Stack/Literal"]
	if literal.Name != "app/literal" || !strings.HasPrefix(literal.ARN, "arn:aws:secretsmanager:") {
		t.Fatalf("unexpected literal secret: %+v", literal)
	}
	generated := runner.resourceValues["Stack/Generated"]
	value := runner.secretValues[generated.ARN]
	if value == "" {
		t.Fatalf("generated secret value was not recorded: %+v", runner.secretValues)
	}
	var object map[string]string
	if err := json.Unmarshal([]byte(value), &object); err != nil {
		t.Fatalf("generated secret is not JSON: %v (%q)", err, value)
	}
	if object["username"] != "u" || len(object["password"]) != 20 {
		t.Fatalf("unexpected generated secret: %+v", object)
	}
	if strings.ContainsAny(object["password"], `!"#$%&'()*+,-./:;<=>?@[\]^_`+"`"+`{|}~`) {
		t.Fatalf("excluded punctuation appeared: %q", object["password"])
	}
	bare := runner.secretValues[runner.resourceValues["Stack/Bare"].ARN]
	if len(bare) != 20 {
		t.Fatalf("bare generated secret length %d != 20", len(bare))
	}
	var bareObject map[string]any
	if json.Unmarshal([]byte(bare), &bareObject) == nil {
		t.Fatalf("the bare form must store the password itself: %q", bare)
	}
	if strings.ContainsAny(bare, `!"#$%&'()*+,-./:;<=>?@[\]^_`+"`"+`{|}~`) {
		t.Fatalf("excluded punctuation appeared in the bare secret: %q", bare)
	}
	mu.Lock()
	defer mu.Unlock()
	if requests["secretsmanager.CreateSecret"] == nil {
		t.Fatalf("CreateSecret was not called: %+v", requests)
	}
}

func TestGenerateSecretValueIsDeterministicAndHonoursClasses(t *testing.T) {
	props := generateSecretString{
		SecretStringTemplate: "{}",
		GenerateStringKey:    "token",
		PasswordLength:       64,
		ExcludePunctuation:   true,
	}
	first, err := generateSecretValue(props, "Stack/Secret")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	second, err := generateSecretValue(props, "Stack/Secret")
	if err != nil || first != second {
		t.Fatalf("generation is not deterministic: %q %q %v", first, second, err)
	}
	var object map[string]string
	if err := json.Unmarshal([]byte(first), &object); err != nil {
		t.Fatalf("generated value is not JSON: %v", err)
	}
	value := object["token"]
	if len(value) != 64 {
		t.Fatalf("password length %d != 64", len(value))
	}
	var lower, upper, number bool
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z':
			lower = true
		case char >= 'A' && char <= 'Z':
			upper = true
		case char >= '0' && char <= '9':
			number = true
		}
	}
	if !lower || !upper || !number {
		t.Fatalf("RequireEachIncludedType was not honored: %q", value)
	}
	if _, err := generateSecretValue(generateSecretString{GenerateStringKey: "k", SecretStringTemplate: "{}"}, "seed"); err != nil {
		t.Fatalf("default keyed generation: %v", err)
	}
}

func TestGenerateSecretValueAcceptsTheBareForm(t *testing.T) {
	props := generateSecretString{
		PasswordLength:    32,
		ExcludeCharacters: `"@/\`,
	}
	first, err := generateSecretValue(props, "Stack/Bare")
	if err != nil {
		t.Fatalf("generate bare secret: %v", err)
	}
	second, err := generateSecretValue(props, "Stack/Bare")
	if err != nil || first != second {
		t.Fatalf("bare generation is not deterministic: %q %q %v", first, second, err)
	}
	if len(first) != 32 {
		t.Fatalf("bare secret length %d != 32", len(first))
	}
	var object map[string]any
	if json.Unmarshal([]byte(first), &object) == nil {
		t.Fatalf("the bare form must be the password itself, not a JSON object: %q", first)
	}
	if strings.ContainsAny(first, `"@/\`) {
		t.Fatalf("excluded characters appeared in the bare secret: %q", first)
	}
	// The reference makes GenerateStringKey optional and requires it together
	// with SecretStringTemplate; each half of the pair is refused.
	if _, err := generateSecretValue(generateSecretString{GenerateStringKey: "password"}, "seed"); err == nil ||
		!strings.Contains(err.Error(), "SecretStringTemplate") {
		t.Fatalf("GenerateStringKey without SecretStringTemplate must fail: %v", err)
	}
	if _, err := generateSecretValue(generateSecretString{SecretStringTemplate: `{"username":"u"}`}, "seed"); err == nil ||
		!strings.Contains(err.Error(), "GenerateStringKey") {
		t.Fatalf("SecretStringTemplate without GenerateStringKey must fail: %v", err)
	}
}

func TestProvisionedDynamicSecretUsesTheProvisionedValue(t *testing.T) {
	runner := &Runner{
		options:      Options{Stdout: io.Discard},
		secretValues: map[string]string{"arn:secret:app": `{"token":"provisioned"}`}, //nolint:gosec // a test fixture, not a credential
	}
	value, ok := runner.provisionedDynamicSecret("{{resolve:secretsmanager:arn:secret:app:SecretString:token::}}")
	if !ok || value != "provisioned" {
		t.Fatalf("provisioned dynamic secret: %q %v", value, ok)
	}
	if _, ok := runner.provisionedDynamicSecret("{{resolve:secretsmanager:arn:secret:other:SecretString:token::}}"); ok {
		t.Fatal("an unknown secret must fall back to the wave-1 placeholder")
	}
	resolved, err := runner.resolveDynamicSecret("Fn", "TOKEN", "{{resolve:secretsmanager:arn:secret:app:SecretString:token::}}")
	if err != nil || resolved != "provisioned" {
		t.Fatalf("resolveDynamicSecret: %q %v", resolved, err)
	}
}

func TestProvisionTopicsCreatesStandardAndFIFOTopics(t *testing.T) {
	var mu sync.Mutex
	topics := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		values := map[string]string{}
		for _, pair := range strings.Split(string(body), "&") {
			key, value, _ := strings.Cut(pair, "=")
			values[key] = strings.ReplaceAll(value, "+", " ")
		}
		name := values["Name"]
		mu.Lock()
		topics = append(topics, name+"|"+string(body))
		mu.Unlock()
		writer.Header().Set("content-type", "text/xml")
		writeTestResponse(t, writer, `<CreateTopicResponse><CreateTopicResult><TopicArn>arn:aws:sns:us-east-1:123456789012:`+
			name+`</TopicArn></CreateTopicResult></CreateTopicResponse>`)
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendSNS}}},
		},
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Topic", Type: typeSNSTopic,
			Properties: json.RawMessage(`{"TopicName":"local-topic"}`)},
		{Stack: "Stack", LogicalID: "Fifo", Type: typeSNSTopic,
			Properties: json.RawMessage(`{"TopicName":"local-topic.fifo","FifoTopic":true,"ContentBasedDeduplication":true}`)},
	}}
	if err := runner.provisionTopics(context.Background(), spec); err != nil {
		t.Fatalf("provision topics: %v", err)
	}
	topic := runner.resourceValues["Stack/Topic"]
	if topic.Name != "local-topic" || topic.ARN != "arn:aws:sns:us-east-1:123456789012:local-topic" {
		t.Fatalf("unexpected standard topic: %+v", topic)
	}
	fifo := runner.resourceValues["Stack/Fifo"]
	if fifo.Name != "local-topic.fifo" || !strings.Contains(fifo.ARN, "local-topic.fifo") {
		t.Fatalf("unexpected FIFO topic: %+v", fifo)
	}
	if len(topics) < 2 || !strings.Contains(topics[1], "local-topic.fifo") ||
		!strings.Contains(topics[1], "FifoTopic") || !strings.Contains(topics[1], "ContentBasedDeduplication") {
		t.Fatalf("FIFO attributes were not sent: %v", topics)
	}
	if err := runner.provisionTopics(context.Background(), &Spec{Resources: []ResourceSpec{{
		Stack: "Stack", LogicalID: "Bad", Type: typeSNSTopic,
		Properties: json.RawMessage(`{"TopicName":"no-suffix","FifoTopic":true}`),
	}}}); err == nil {
		t.Fatal("a FIFO topic without .fifo must fail")
	}
}

func TestProvisionStreamsCreatesStreamsAndRetention(t *testing.T) {
	var mu sync.Mutex
	targets := []string{}
	createInputs := map[string]map[string]any{}
	retention := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body) //nolint:errcheck // diagnostic
		target := request.Header.Get("X-Amz-Target")
		mu.Lock()
		targets = append(targets, target)
		mu.Unlock()
		var payload map[string]any
		_ = json.Unmarshal(body, &payload) //nolint:errcheck // protocol fixture
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		switch {
		case strings.HasSuffix(target, "CreateStream"):
			if name, ok := payload["StreamName"].(string); ok {
				mu.Lock()
				createInputs[name] = payload
				mu.Unlock()
			}
			writeTestResponse(t, writer, `{}`)
		case strings.HasSuffix(target, "DescribeStream"):
			name, _ := payload["StreamName"].(string) //nolint:errcheck // protocol fixture
			writeTestResponse(t, writer, `{"StreamDescription":{"StreamName":"`+name+`","StreamARN":`+
				`"arn:aws:kinesis:us-east-1:123456789012:stream/`+name+`","RetentionPeriodHours":24,`+
				`"StreamStatus":"ACTIVE"}}`)
		case strings.HasSuffix(target, "IncreaseStreamRetentionPeriod"):
			if value, ok := payload["RetentionPeriodHours"].(float64); ok {
				retention = int(value)
			}
			writeTestResponse(t, writer, `{}`)
		default:
			t.Errorf("unexpected target %q", target)
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendKinesis}}},
		},
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{
			Stack: "Stack", LogicalID: "Stream", Type: typeKinesisStream,
			Properties: json.RawMessage(`{"Name":"local-stream","ShardCount":2,"RetentionPeriodHours":48}`),
		},
		{
			Stack: "Stack", LogicalID: "OnDemand", Type: typeKinesisStream,
			Properties: json.RawMessage(`{"Name":"local-on-demand","StreamModeDetails":{"StreamMode":"ON_DEMAND"}}`),
		},
	}}
	if err := runner.provisionStreams(context.Background(), spec); err != nil {
		t.Fatalf("provision streams: %v", err)
	}
	value := runner.resourceValues["Stack/Stream"]
	if value.Name != "local-stream" || !strings.Contains(value.ARN, "stream/local-stream") {
		t.Fatalf("unexpected stream: %+v", value)
	}
	mu.Lock()
	defer mu.Unlock()
	if retention != 48 {
		t.Fatalf("retention was not increased: %d (%v)", retention, targets)
	}
	onDemand, ok := createInputs["local-on-demand"]
	if !ok {
		t.Fatalf("the on-demand stream was not created: %+v", createInputs)
	}
	mode, _ := onDemand["StreamModeDetails"].(map[string]any) //nolint:errcheck // protocol fixture
	if mode["StreamMode"] != "ON_DEMAND" {
		t.Fatalf("StreamModeDetails was not sent: %+v", onDemand)
	}
	if _, hasShardCount := onDemand["ShardCount"]; hasShardCount {
		t.Fatalf("an on-demand stream must not send ShardCount: %+v", onDemand)
	}
}

func TestProvisionCognitoCreatesPoolAndClient(t *testing.T) {
	var mu sync.Mutex
	targets := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		target := request.Header.Get("X-Amz-Target")
		mu.Lock()
		targets = append(targets, target)
		mu.Unlock()
		writer.Header().Set("content-type", "application/x-amz-json-1.1")
		switch {
		case strings.HasSuffix(target, "CreateUserPool"):
			writeTestResponse(t, writer, `{"UserPool":{"Id":"us-east-1_pool","Arn":`+
				`"arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_pool"}}`)
		case strings.HasSuffix(target, "CreateUserPoolClient"):
			writeTestResponse(t, writer, `{"UserPoolClient":{"ClientId":"client-id","ClientSecret":"client-secret"}}`)
		default:
			t.Errorf("unexpected target %q", target)
			writer.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: server.URL, Endpoints: []Endpoint{{Service: backendCognito}}},
		},
		resourceValues: resourceValues{},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Pool", Type: typeCognitoUserPool,
			Properties: json.RawMessage(`{"UserPoolName":"local-pool"}`)},
		{Stack: "Stack", LogicalID: "Client", Type: typeCognitoClient,
			Properties: json.RawMessage(`{"UserPoolId":{"Ref":"Pool"},"ClientName":"local-client","GenerateSecret":true}`)},
	}}
	if err := runner.provisionCognito(context.Background(), spec); err != nil {
		t.Fatalf("provision Cognito: %v", err)
	}
	pool := runner.resourceValues["Stack/Pool"]
	if pool.Name != "us-east-1_pool" ||
		pool.ProviderName != "cognito-idp.us-east-1.amazonaws.com/us-east-1_pool" ||
		pool.ProviderURL != "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool" {
		t.Fatalf("unexpected pool: %+v", pool)
	}
	client := runner.resourceValues["Stack/Client"]
	if client.Name != "client-id" || client.ClientSecret != "client-secret" {
		t.Fatalf("unexpected client: %+v", client)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(targets) != 2 {
		t.Fatalf("unexpected requests: %v", targets)
	}
}

func TestStartCognitoIssuerServesJWKSAndDiscovery(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/us-east-1_pool/.well-known/jwks.json" {
			t.Errorf("unexpected upstream path %q", request.URL.Path)
		}
		writer.Header().Set("content-type", "application/json")
		writeTestResponse(t, writer, `{"keys":[{"kid":"dummy","kty":"RSA"}]}`)
	}))
	defer upstream.Close()
	runner := &Runner{
		options: Options{Stdout: io.Discard},
		backends: map[string]backendProcess{
			"moto": {HostURL: upstream.URL, Endpoints: []Endpoint{{Service: backendCognito}}},
		},
		resourceValues: resourceValues{
			"Stack/Pool": {Type: typeCognitoUserPool, Name: "us-east-1_pool"},
		},
	}
	if err := runner.startCognitoIssuer(context.Background(), &Spec{}); err != nil {
		t.Fatalf("start issuer: %v", err)
	}
	defer func() {
		for _, server := range runner.servers {
			_ = server.Close() //nolint:errcheck // test shutdown
		}
	}()
	issuer := runner.resourceValues["Stack/Pool"].LocalIssuer
	if !strings.HasPrefix(issuer, "http://127.0.0.1:") || !strings.HasSuffix(issuer, "/cognito-idp/us-east-1/us-east-1_pool") {
		t.Fatalf("unexpected local issuer %q", issuer)
	}
	response, err := http.Get(issuer + "/.well-known/jwks.json") //nolint:gosec,noctx // loopback test endpoint
	if err != nil {
		t.Fatalf("get JWKS: %v", err)
	}
	defer response.Body.Close()          //nolint:errcheck // test body
	body, _ := io.ReadAll(response.Body) //nolint:errcheck // test body
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), `"kid":"dummy"`) {
		t.Fatalf("unexpected JWKS: %d %s", response.StatusCode, body)
	}
	response, err = http.Get(issuer + "/.well-known/openid-configuration") //nolint:gosec,noctx // loopback test endpoint
	if err != nil {
		t.Fatalf("get discovery: %v", err)
	}
	defer response.Body.Close() //nolint:errcheck // test body
	var discovery map[string]any
	if err := json.NewDecoder(response.Body).Decode(&discovery); err != nil {
		t.Fatalf("decode discovery: %v", err)
	}
	if discovery["issuer"] != issuer || discovery["jwks_uri"] != issuer+"/.well-known/jwks.json" {
		t.Fatalf("unexpected discovery: %+v", discovery)
	}
	if response, err := http.Get(issuer + "/unknown"); err != nil { //nolint:noctx // loopback test endpoint
		t.Fatalf("get unknown: %v", err)
	} else {
		_ = response.Body.Close() //nolint:errcheck // test body
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("unknown path status %d", response.StatusCode)
		}
	}
}

func TestDefaultEndpointEnvNamesAndLoopbackHost(t *testing.T) {
	secrets := defaultEndpointEnvNames(backendSecretsManager)
	if len(secrets) != 1 || secrets[0] != "AWS_ENDPOINT_URL_SECRETS_MANAGER" {
		t.Fatalf("secrets manager env: %v", secrets)
	}
	cognito := defaultEndpointEnvNames(backendCognito)
	if !containsStringList(cognito, "AWS_ENDPOINT_URL_COGNITO_IDP") ||
		!containsStringList(cognito, "AWS_ENDPOINT_URL_COGNITO_IDENTITY_PROVIDER") {
		t.Fatalf("cognito env: %v", cognito)
	}
	if got := defaultEndpointEnvNames("ssm"); len(got) != 1 || got[0] != "AWS_ENDPOINT_URL_SSM" {
		t.Fatalf("ssm env: %v", got)
	}
	for _, host := range []string{"127.0.0.1", "::1", "localhost"} {
		if !loopbackHost(host) {
			t.Fatalf("%s must be loopback", host)
		}
	}
	for _, host := range []string{"example.com", "10.0.0.1", "0.0.0.0"} {
		if loopbackHost(host) {
			t.Fatalf("%s must not be loopback", host)
		}
	}
}

func TestPlannedProvisionedResources(t *testing.T) {
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Parameter", Type: typeSSMParameter,
			Properties: json.RawMessage(`{"Name":"/app/param"}`)},
		{Stack: "Stack", LogicalID: "Secret", Type: typeSecretsSecret},
		{Stack: "Stack", LogicalID: "Key", Type: typeKMSKey},
		{Stack: "Stack", LogicalID: "Unrelated", Type: "AWS::IAM::Role"},
	}}
	planned := plannedProvisionedResources(spec)
	if len(planned) != 3 {
		t.Fatalf("unexpected planned resources: %+v", planned)
	}
	byID := map[string]PlannedResource{}
	for _, resource := range planned {
		byID[resource.LogicalID] = resource
	}
	if byID["Parameter"].LocalID != "/app/param" || byID["Parameter"].Generated {
		t.Fatalf("unexpected parameter plan: %+v", byID["Parameter"])
	}
	if !byID["Secret"].Generated || !strings.HasPrefix(byID["Secret"].LocalID, "local-secret-") {
		t.Fatalf("unexpected secret plan: %+v", byID["Secret"])
	}
	if !byID["Key"].Generated {
		t.Fatalf("a KMS key id must be marked generated: %+v", byID["Key"])
	}
}

func TestDeriveSNSSubscriptionsResolvesTargets(t *testing.T) {
	stack := assemblyStack{
		Name: "Stack",
		Template: template{Resources: map[string]templateResource{
			"Topic": {Type: typeSNSTopic, Properties: json.RawMessage(`{"TopicName":"topic"}`)},
			"Fn":    {Type: typeLambdaFunction, Properties: json.RawMessage(`{}`)},
			"Queue": {Type: typeSQSQueue, Properties: json.RawMessage(`{"QueueName":"queue"}`)},
			"LambdaSub": {Type: typeSNSSubscription, Properties: json.RawMessage(
				`{"TopicArn":{"Ref":"Topic"},"Protocol":"lambda","Endpoint":{"Fn::GetAtt":["Fn","Arn"]}}`)},
			"SQSSub": {Type: typeSNSSubscription, Properties: json.RawMessage(
				`{"TopicArn":{"Ref":"Topic"},"Protocol":"sqs","Endpoint":{"Fn::GetAtt":["Queue","Arn"]},` +
					`"RawMessageDelivery":true}`)},
			"HTTPSub": {Type: typeSNSSubscription, Properties: json.RawMessage(
				`{"TopicArn":{"Ref":"Topic"},"Protocol":"http","Endpoint":"https://example.com/hook"}`)},
			"LoopbackSub": {Type: typeSNSSubscription, Properties: json.RawMessage(
				`{"TopicArn":{"Ref":"Topic"},"Protocol":"http","Endpoint":"http://127.0.0.1:9393/hook",` +
					`"FilterPolicy":{"color":["red"]},"FilterPolicyScope":"MessageAttributes"}`)},
		}},
	}
	spec := &Spec{Resources: []ResourceSpec{
		{Stack: "Stack", LogicalID: "Topic", Type: typeSNSTopic},
	}}
	if err := deriveSNSSubscriptions(spec, []assemblyStack{stack}, stack); err != nil {
		t.Fatalf("derive SNS subscriptions: %v", err)
	}
	if len(spec.Subscriptions) != 3 {
		t.Fatalf("unexpected subscriptions: %+v", spec.Subscriptions)
	}
	byID := map[string]SubscriptionSpec{}
	for _, subscription := range spec.Subscriptions {
		byID[subscription.LogicalID] = subscription
	}
	if byID["LambdaSub"].Function != "Fn" || byID["SQSSub"].Queue != "Queue" || !byID["SQSSub"].RawMessageDelivery {
		t.Fatalf("targets were not resolved: %+v", byID)
	}
	if byID["LoopbackSub"].Endpoint != "http://127.0.0.1:9393/hook" ||
		byID["LoopbackSub"].FilterPolicyScope != "MessageAttributes" ||
		len(byID["LoopbackSub"].FilterPolicy) == 0 {
		t.Fatalf("loopback subscription was not resolved: %+v", byID["LoopbackSub"])
	}
	if len(spec.Skipped) != 1 || spec.Skipped[0].LogicalID != "HTTPSub" ||
		!strings.Contains(spec.Skipped[0].Reason, "not a loopback URL") {
		t.Fatalf("a non-loopback HTTP subscription must be skipped with a reason: %+v", spec.Skipped)
	}
}
