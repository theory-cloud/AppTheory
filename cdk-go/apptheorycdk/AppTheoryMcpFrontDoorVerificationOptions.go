package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awskms"
)

// Front-door verification for `originReachability: FRONTED`.
//
// Attach mode means the front door is application-owned, so the construct
// cannot inject the header itself and cannot observe the distribution. The
// declaration therefore carries three independently wired copies that must come
// from one application-owned constant: this prop, the distribution's origin
// custom-header configuration, and the runtime's front-door verification
// config. The construct proves only its own copy.
//
// Supply exactly one of `secretValue` and `secretParameterName`:
//
//   - `secretValue` is the v7.3 literal form. It is consumed at synthesis for
//     validation and the recorded SHA-256 digest only, and it never lands in the
//     construct's own synthesized template.
//   - `secretParameterName` names a well-known, stage-qualified Parameter Store
//     parameter that the application's installer creates if absent. The value
//     never enters the application source: the construct renders the header value
//     as a CloudFormation `ssm` dynamic reference and records the parameter name
//     instead of a digest.
type AppTheoryMcpFrontDoorVerificationOptions struct {
	// The assertion that the runtime verifies the front-door header on every derived route.
	//
	// The construct cannot attach that verification to an application-owned front
	// door or a runtime it does not own, so it refuses to synthesize until the
	// caller records that the verification exists. Must be `true`.
	Asserted *bool `field:"required" json:"asserted" yaml:"asserted"`
	// The origin request header the front door injects on every request it sends to the origin.
	//
	// 1 to 64 characters of `[A-Za-z0-9-]`, and never a request header that
	// rewrites the origin contract (`Host`, `Authorization`, `Cookie`,
	// `Content-Length`, `Transfer-Encoding`, `Connection`, `WWW-Authenticate`,
	// `X-Forwarded-For`), any `x-amz-*`/`x-amzn-*`/`cloudfront-*` name, or a
	// hop-by-hop name.
	HeaderName *string `field:"required" json:"headerName" yaml:"headerName"`
	// The customer managed key that encrypts the parameter when it is a SecureString.
	//
	// FRONTED cannot use a SecureString for the distribution header (see
	// `secretParameterName`), so this is only meaningful when the same well-known
	// name is also read for a purpose other than the origin header. When it is
	// set the construct grants `kms:Decrypt` on the key to `handler`. Leave it
	// unset for a String parameter: Parameter Store needs no KMS permission for
	// plaintext values.
	// Default: undefined.
	//
	SecretParameterKmsKey awskms.IKey `field:"optional" json:"secretParameterKmsKey" yaml:"secretParameterKmsKey"`
	// The well-known, stage-qualified Parameter Store parameter that holds the front-door secret.
	//
	// A fully qualified name from `/`, at most 1011 characters and fifteen
	// levels, in the `[A-Za-z0-9_.\-/]` alphabet a CloudFormation `ssm` dynamic
	// reference accepts, and never in the reserved `aws`/`ssm` hierarchy.
	//
	// The parameter must be type **String**, not SecureString: CloudFront's
	// `OriginCustomHeaders` supports the plaintext `ssm` reference only, and AWS
	// lists the properties that support `ssm-secure` exhaustively (CloudFront is
	// not one of them). The value is therefore defense-in-depth against direct
	// origin access, not a confidentiality control — the same posture as the
	// literal form, which CloudFront already exposes through
	// `GetDistributionConfig`.
	//
	// `frontDoorOriginHeader` renders the dynamic reference for the distribution
	// the app wires, e.g. `{{resolve:ssm:/theorycloud/tms/lab/fronted-token}}`,
	// and the construct grants `ssm:GetParameter` on exactly this parameter to
	// `handler`. A stack update re-resolves the latest parameter version; drift
	// detection does not see dynamic references.
	//
	// Mutually exclusive with `secretValue`.
	// Default: undefined.
	//
	SecretParameterName *string `field:"optional" json:"secretParameterName" yaml:"secretParameterName"`
	// The literal secret injected as the front-door header value.
	//
	// 32 to 128 characters of `[A-Za-z0-9._~-]`: a header-value-safe alphabet
	// with no whitespace and no control characters. The value is consumed at
	// synthesis for validation and the recorded SHA-256 digest only — the literal
	// never lands in the construct's synthesized template or in CloudFormation.
	// It is not a credential store; rotation means changing the value and
	// redeploying, and it must not be (or contain) a secret that protects
	// anything else.
	//
	// Mutually exclusive with `secretParameterName`. Prefer the parameter form:
	// a committed literal is exactly what the parameter form removes.
	// Default: undefined.
	//
	SecretValue *string `field:"optional" json:"secretValue" yaml:"secretValue"`
}
