package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// The Go side of the local IAM example.
//
// A function whose environment names APPTHEORY_LOCAL_IAM_ROLE is a caller: it
// signs one execute-api request with the AWS SDK for Go v2's SigV4 signer, using
// the credentials the local runner issued to its container, and optionally
// assumes a role through the run's STS endpoint first. Every other function is
// the identity echo: it reports the principal the gateway resolved and put into
// the event's identity fields.
//
// The SDK resolves its endpoint from AWS_ENDPOINT_URL_STS and its credentials
// from AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN:
// https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html
// https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html

// callerRequest is one caller invocation's payload.
type callerRequest struct {
	URL             string `json:"url"`
	Method          string `json:"method"`
	AssumeRoleARN   string `json:"assumeRoleArn"`
	RoleSessionName string `json:"roleSessionName"`
	Unsigned        bool   `json:"unsigned"`
	TamperSignature bool   `json:"tamperSignature"`
	// ReturnCredentials reports the credentials the call used, which is how a
	// row that must sign from outside the container gets the session an
	// AssumeRole minted.
	ReturnCredentials bool `json:"returnCredentials"`
}

// callerResult is what a caller reports.
type callerResult struct {
	Status      int    `json:"status"`
	Body        string `json:"body"`
	AccessKeyID string `json:"accessKeyId,omitempty"`
	Principal   string `json:"principalArn,omitempty"`
	Signed      bool   `json:"signed"`
	Role        string `json:"role"`
	// Credentials is present only when the caller was asked for them.
	Credentials *reportedCredentials `json:"credentials,omitempty"`
}

func main() {
	lambda.Start(handle)
}

func handle(ctx context.Context, event json.RawMessage) (any, error) {
	role := os.Getenv("APPTHEORY_LOCAL_IAM_ROLE")
	if role == "" {
		return identity(event)
	}
	return caller(ctx, role, event)
}

// identity echoes the identity the gateway resolved for the call.
//
// https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html
func identity(event json.RawMessage) (any, error) {
	var payload struct {
		RequestContext struct {
			Identity struct {
				Caller    string `json:"caller"`
				UserARN   string `json:"userArn"`
				AccountID string `json:"accountId"`
				AccessKey string `json:"accessKey"`
			} `json:"identity"`
			Authorizer struct {
				IAM struct {
					CallerID  string `json:"callerId"`
					UserARN   string `json:"userArn"`
					AccountID string `json:"accountId"`
					AccessKey string `json:"accessKey"`
				} `json:"iam"`
			} `json:"authorizer"`
			AccountID  string `json:"accountId"`
			RouteKey   string `json:"routeKey"`
			HTTPMethod string `json:"httpMethod"`
		} `json:"requestContext"`
	}
	if err := json.Unmarshal(event, &payload); err != nil {
		return nil, fmt.Errorf("the identity handler needs a gateway event: %w", err)
	}
	context := payload.RequestContext
	caller := context.Identity.Caller
	userARN := context.Identity.UserARN
	accountID := context.Identity.AccountID
	accessKey := context.Identity.AccessKey
	if context.Authorizer.IAM.UserARN != "" {
		// A Function URL and an HTTP API v2 event carry authorizer.iam; a REST
		// v1 event carries requestContext.identity. Both are populated for an
		// AWS_IAM call so a handler reads one place per surface.
		caller = context.Authorizer.IAM.CallerID
		userARN = context.Authorizer.IAM.UserARN
		accountID = context.Authorizer.IAM.AccountID
		accessKey = context.Authorizer.IAM.AccessKey
	}
	route := context.RouteKey
	if route == "" {
		route = context.HTTPMethod
	}
	if route == "" {
		route = "function-url"
	}
	body, err := json.Marshal(map[string]any{
		"route":     route,
		"caller":    caller,
		"userArn":   userARN,
		"accountId": accountID,
		"accessKey": accessKey,
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"statusCode": 200,
		"headers":    map[string]string{"content-type": "application/json"},
		"body":       string(body),
	}, nil
}

// caller signs one request with the container's credentials, or with a session
// it assumes first, and reports the gateway's answer.
func caller(ctx context.Context, role string, event json.RawMessage) (any, error) {
	var payload callerRequest
	if err := json.Unmarshal(event, &payload); err != nil {
		return nil, err
	}
	if payload.URL == "" {
		return nil, fmt.Errorf("the caller needs a url")
	}
	method := payload.Method
	if method == "" {
		method = http.MethodGet
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion("us-east-1"))
	if err != nil {
		return nil, fmt.Errorf("load the SDK config: %w", err)
	}
	credentials, err := cfg.Credentials.Retrieve(ctx)
	if err != nil {
		return nil, fmt.Errorf("retrieve the container credentials: %w", err)
	}
	outcome := callerResult{Role: role, AccessKeyID: credentials.AccessKeyID}
	if payload.AssumeRoleARN != "" {
		sessionName := payload.RoleSessionName
		if sessionName == "" {
			sessionName = "local-iam-row"
		}
		assumed, assumeErr := sts.NewFromConfig(cfg).AssumeRole(ctx, &sts.AssumeRoleInput{
			RoleArn:         aws.String(payload.AssumeRoleARN),
			RoleSessionName: aws.String(sessionName),
		})
		if assumeErr != nil {
			outcome.Status = http.StatusForbidden
			outcome.Body = assumeErr.Error()
			return respond(outcome), nil
		}
		credentials = aws.Credentials{
			AccessKeyID:     aws.ToString(assumed.Credentials.AccessKeyId),
			SecretAccessKey: aws.ToString(assumed.Credentials.SecretAccessKey),
			SessionToken:    aws.ToString(assumed.Credentials.SessionToken),
		}
		outcome.AccessKeyID = credentials.AccessKeyID
		outcome.Principal = aws.ToString(assumed.AssumedRoleUser.Arn)
	}
	if payload.ReturnCredentials {
		outcome.Credentials = &reportedCredentials{
			AccessKeyID:     credentials.AccessKeyID,
			SecretAccessKey: credentials.SecretAccessKey,
			SessionToken:    credentials.SessionToken,
		}
	}
	target, err := localTargetURL(payload.URL)
	if err != nil {
		return nil, err
	}
	httpRequest, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(nil))
	if err != nil {
		return nil, err
	}
	if !payload.Unsigned {
		if signErr := v4.NewSigner().SignHTTP(ctx, credentials, httpRequest, sigV4EmptyPayloadHash(), "execute-api", "us-east-1", time.Now()); signErr != nil {
			return nil, fmt.Errorf("sign the request: %w", signErr)
		}
		outcome.Signed = true
		if payload.TamperSignature {
			tamperSignature(httpRequest)
		}
	}
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(httpRequest)
	if err != nil {
		if payload.ReturnCredentials {
			// A row that asked for the credentials still gets them when the
			// call itself cannot be made.
			outcome.Status = http.StatusForbidden
			outcome.Body = err.Error()
			return respond(outcome), nil
		}
		return nil, fmt.Errorf("call %s: %w", payload.URL, err)
	}
	defer func() { _ = response.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	outcome.Status = response.StatusCode
	outcome.Body = string(body)
	return respond(outcome), nil
}

// localTargetURL returns the URL to sign and call, or refuses a URL that does
// not name one of the run's loopback listeners. A row hands the caller a URL to
// sign; only these fixed prefixes are acceptable, so the example can never be
// turned into a proxy for another host.
func localTargetURL(raw string) (string, error) {
	switch {
	case strings.HasPrefix(raw, "http://127.0.0.1:"),
		strings.HasPrefix(raw, "https://127.0.0.1:"),
		strings.HasPrefix(raw, "http://localhost:"),
		strings.HasPrefix(raw, "https://localhost:"),
		strings.HasPrefix(raw, "http://host.docker.internal:"),
		strings.HasPrefix(raw, "https://host.docker.internal:"):
		return raw, nil
	}
	return "", fmt.Errorf("the caller's url is not a local runner listener")
}

// reportedCredentials is a credential the caller used, reported on request.
type reportedCredentials struct {
	AccessKeyID     string `json:"accessKeyId"`
	SecretAccessKey string `json:"secretAccessKey"`
	SessionToken    string `json:"sessionToken,omitempty"`
}

// tamperSignature flips the signature's last hexadecimal digit, which is what a
// tampered request looks like to the verifier.
func tamperSignature(request *http.Request) {
	authorization := request.Header.Get("Authorization")
	index := strings.LastIndex(authorization, "Signature=")
	if index < 0 {
		return
	}
	prefix := authorization[:index+len("Signature=")]
	signature := []byte(authorization[index+len("Signature="):])
	if len(signature) == 0 {
		return
	}
	if signature[len(signature)-1] == '0' {
		signature[len(signature)-1] = '1'
	} else {
		signature[len(signature)-1] = '0'
	}
	request.Header.Set("Authorization", prefix+string(signature))
}

// respond wraps a caller result in a proxy response.
func respond(outcome callerResult) any {
	encoded, err := json.Marshal(outcome)
	if err != nil {
		return map[string]any{"statusCode": 500, "body": err.Error()}
	}
	return map[string]any{
		"statusCode": 200,
		"headers":    map[string]string{"content-type": "application/json"},
		"body":       string(encoded),
	}
}

// sigV4EmptyPayloadHash is the SHA-256 of an empty body, which is what a GET
// with no payload signs.
func sigV4EmptyPayloadHash() string {
	sum := sha256.Sum256(nil)
	return hex.EncodeToString(sum[:])
}
