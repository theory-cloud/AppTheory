package localrunner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// LOCAL-W3-M1 validation, seventh pass: the Fn::Sub grammar, more statement
// shapes, and the CA creation error paths.

func TestResolveJSONSubBranches(t *testing.T) {
	runner := &Runner{}
	spec := jsonSpec()
	runner.spec = spec
	cases := []struct {
		document string
		want     string
	}{
		{`{"Fn::Sub": 7}`, "must be a string or [string, variables]"},
		{`{"Fn::Sub": ["a"]}`, "must be a string or [string, variables]"},
		{`{"Fn::Sub": [7, {}]}`, "template must be a string"},
		{`{"Fn::Sub": ["${A}", 7]}`, "variables must be an object"},
		{`{"Fn::Sub": "unterminated ${A"}`, "unterminated"},
		{`{"Fn::Sub": ["${A}", {"A": {"Fn::Split": ["-", "a-b"]}}]}`, "is not a scalar"},
		{`{"Fn::Sub": "${Missing}"}`, "names no parameter or resource"},
	}
	for _, tc := range cases {
		var value any
		if err := json.Unmarshal([]byte(tc.document), &value); err != nil {
			t.Fatalf("decode: %v", err)
		}
		_, err := runner.resolveJSONValue(spec, "Stack", value)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s = %v, want %q", tc.document, err, tc.want)
		}
	}

	ok := []struct {
		document string
		want     string
	}{
		{`{"Fn::Sub": "${AWS::Region}"}`, LocalRegion},
		{`{"Fn::Sub": "lit ${!NotAVariable}"}`, "lit NotAVariable"},
		{`{"Fn::Sub": ["${A}-${B}", {"A": "one", "B": 2}]}`, "one-2"},
		{`{"Fn::Sub": "${Api}"}`, localPhysicalID("api", "Api")},
		{`{"Fn::Sub": "${Worker.Arn}"}`, "arn:aws:lambda:us-east-1:787107040121:function:worker"},
		{`{"Fn::Sub": "no references"}`, "no references"},
	}
	for _, tc := range ok {
		value := resolveDocument(t, runner, spec, tc.document)
		if text, isString := value.(string); !isString || text != tc.want {
			t.Fatalf("%s = %v, want %q", tc.document, value, tc.want)
		}
	}
}

func TestShapeStatementForMoreShapes(t *testing.T) {
	cases := []struct {
		name   string
		raw    string
		trust  bool
		fnURL  bool
		effect string
		check  func(t *testing.T, shape statementShape)
	}{
		{
			name: "an irrelevant action beside a relevant one is dropped",
			raw: `{"Effect":"Allow","Action":["s3:GetObject","execute-api:Invoke"],` +
				`"Resource":"execute-api:/lab/GET/items","Principal":{"AWS":"arn:aws:iam::1:root"}}`,
			effect: iamEffectAllow,
			check: func(t *testing.T, shape statementShape) {
				t.Helper()
				if len(shape.actions) != 1 || shape.actions[0] != "execute-api:Invoke" {
					t.Fatalf("only the relevant action is kept: %+v", shape.actions)
				}
			},
		},
		{
			name:   "a trust statement with an account root",
			raw:    `{"Effect":"Allow","Action":"sts:AssumeRole","Principal":{"AWS":"arn:aws:iam::1:root"}}`,
			trust:  true,
			effect: iamEffectAllow,
			check: func(t *testing.T, shape statementShape) {
				t.Helper()
				if len(shape.principalRoots) != 1 {
					t.Fatalf("the root principal is kept: %+v", shape)
				}
			},
		},
		{
			name: "a function URL statement keeps both actions",
			raw: `{"Effect":"Allow","Action":["lambda:InvokeFunctionUrl","lambda:InvokeFunction"],` +
				`"Resource":"arn:aws:lambda:us-east-1:1:function:f","Principal":{"AWS":"arn:aws:iam::1:root"},` +
				`"Condition":{"StringEquals":{"lambda:FunctionUrlAuthType":"AWS_IAM"}}}`,
			fnURL:  true,
			effect: iamEffectAllow,
			check: func(t *testing.T, shape statementShape) {
				t.Helper()
				if len(shape.actions) != 2 || shape.functionURLType != authorizationTypeIAM {
					t.Fatalf("the Function URL shape is %+v", shape)
				}
			},
		},
		{
			name:   "a deny statement keeps its effect",
			raw:    `{"Effect":"Deny","Action":"execute-api:Invoke","Resource":"execute-api:/lab/GET/items","Principal":{"AWS":"arn:aws:iam::1:root"}}`,
			effect: iamEffectDeny,
			check: func(t *testing.T, shape statementShape) {
				t.Helper()
				if shape.effect != iamEffectDeny {
					t.Fatalf("the effect is %q", shape.effect)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var statement iamPolicyStatement
			if err := json.Unmarshal([]byte(tc.raw), &statement); err != nil {
				t.Fatalf("decode: %v", err)
			}
			shape, err := shapeStatementFor(statement, tc.trust, tc.fnURL)
			if err != nil {
				t.Fatalf("shapeStatementFor: %v", err)
			}
			if shape.effect != tc.effect {
				t.Fatalf("effect = %q, want %q", shape.effect, tc.effect)
			}
			tc.check(t, shape)
		})
	}
}

func TestNewLocalCASignerRefusesAnUnusableDirectory(t *testing.T) {
	// A directory path that is a regular file is not a CA directory.
	file := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := newLocalCASigner(filepath.Join(file, "tls")); err == nil {
		t.Fatal("a path below a regular file must be refused")
	}

	// A CA certificate with no private key beside it fails closed.
	dir := t.TempDir()
	first, err := newLocalCASigner(dir)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := os.Remove(first.caPath[:len(first.caPath)-len(tlsCACertFile)] + tlsCAKeyFile); err != nil {
		t.Fatalf("remove the key: %v", err)
	}
	if _, err := newLocalCASigner(dir); err == nil {
		t.Fatal("a missing CA key must be refused rather than regenerated")
	}
}
