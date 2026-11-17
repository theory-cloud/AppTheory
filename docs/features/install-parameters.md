---
title: Namespace Install Parameters
---

# Namespace Install Parameters

`AppTheoryInstallParameters` is the single CloudFormation parameter contract for a governed Theory Cloud namespace
install. It emits the complete required surface and exposes each value as a typed string token for the rest of the
stack. Per-install account, namespace, tenant, DNS, stage, and Autheory identity therefore enter only as stack
parameters; the synthesized template stays account-agnostic.

```ts
const install = new AppTheoryInstallParameters(this, "InstallParameters");

// These names belong to this application, not to AppTheoryMcpServer.
handler.addEnvironment("APP_AUTHORIZATION_SERVER_ORIGIN", install.authorizationServerOrigin);
handler.addEnvironment("APP_AUTHEORY_JWKS_URL", install.autheoryJwksUrl);

new AppTheoryMcpServer(this, "McpServer", {
  handler,
});
```

Application code reads those app-owned values into `mcpfacade.FacadeConfig.IssuerURL` and `.JWKSURI`. The MCP
construct does not consume issuer/JWKS props or emit their retired environment variables. The v3.1.x prop flow is
deprecated and inert; see the [MCP server redesign](mcp-server-construct.md) and the
[UPGRADING migration note](../../UPGRADING.md#mcp-server-facade-redesign-and-a6-deprecation).

`AppTheoryInstallParameters` has no literal-value props and no alternate configuration path. The deployment runner
supplies all ten parameters when it creates or updates the stack.

## Governed surface

Every parameter is required, has CloudFormation type `String`, and has no default.

| Parameter | CloudFormation constraint |
| --- | --- |
| `TargetAccountId` | `^[0-9]{12}$` |
| `NamespaceSlug` | `^[a-z0-9][a-z0-9-]{1,62}$` |
| `AccountClass` | allowed value `namespace_dedicated` |
| `TargetApplicationId` | `^app-[a-z0-9][a-z0-9-]{0,62}$` |
| `TenantId` | `^[A-Za-z0-9_.:-]{3,160}$` |
| `DnsHost` | `^[a-z0-9][a-z0-9.-]{2,252}\.theorycloud\.app$` |
| `Stage` | allowed values `lab`, `live` |
| `PublicHostedZoneId` | `^[A-Z0-9]{8,32}$` |
| `AuthorizationServerOrigin` | `^https://[A-Za-z0-9.-]+$` |
| `AutheoryJwksUrl` | `^https://[A-Za-z0-9.-]+/[^?#]+$` |

The accessors are `targetAccountId`, `namespaceSlug`, `accountClass`, `targetApplicationId`, `tenantId`, `dnsHost`,
`stage`, `publicHostedZoneId`, `authorizationServerOrigin`, and `autheoryJwksUrl`. Each resolves to the corresponding
parameter `Ref`; AppTheory does not derive service-specific names, table names, origins, or other values from them.

## Validation boundary

`TargetAccountMatchesCaller` is emitted as a CloudFormation Rule. Its assertion is
`Fn::Equals(TargetAccountId, AWS::AccountId)`, with the failure message
`TargetAccountId must equal the AWS account evaluating this stack`.

Allowed patterns and allowed values are CloudFormation constraints, not synthesis-time validators. An invalid install
value can synthesize because it is not present during synthesis; CloudFormation rejects it while evaluating the stack.
Structural errors remain fail-closed in the CDK construct tree, including duplicate construct or parameter child IDs.
Do not add redundant literal validation in a consumer or bypass the governed parameter injection path.

CloudFormation Rules cannot use `Fn::Join`, so the construct cannot express the relational assertion
`DnsHost == cloud-keeper.<NamespaceSlug>.theorycloud.app`. The governed install-profile validator remains responsible
for that equality. The `DnsHost` parameter pattern independently rejects hosts outside `theorycloud.app` during stack
evaluation.

## Well-known front-door parameters for `FRONTED`

A `FRONTED` MCP origin declares its front-door secret as `secretParameterName` instead of `secretValue`, so no literal
lives in the application's source. The parameter is application-owned and stage-qualified; AppTheory never creates it
and does not ship an installer. The reference name shape is

```text
/<namespace-slug>/<application>/<stage>/fronted/origin-token
```

It must be fully qualified from `/`, at most 1011 characters and fifteen levels, use only `[A-Za-z0-9_.-/]` (the
alphabet a CloudFormation dynamic reference accepts), stay out of the reserved `aws` and `ssm` hierarchies, and have
type **`String`**. `AWS::CloudFront::Distribution` `OriginCustomHeaders` does not support the `ssm-secure` dynamic
reference — AWS lists the properties that do, exhaustively, and CloudFront is not one of them — so a `SecureString`
parameter cannot feed the origin header. Treat the value as defense-in-depth against direct origin access, not as a
confidentiality control: anyone with `ssm:GetParameter` or `cloudfront:GetDistributionConfig` can read it.

**Create if absent, never overwrite.** The application's installer ensures the parameter exists with a generated value
of 32 to 128 characters of `[A-Za-z0-9._~-]`. Reference shape for a shell installer:

```bash
#!/usr/bin/env bash
set -euo pipefail

parameter_name="/${NAMESPACE_SLUG}/${APPLICATION}/${STAGE}/fronted/origin-token"

# get-parameter fails when the name is absent; put-parameter without --overwrite
# fails when it exists. The pair therefore never replaces a live value.
if ! existing="$(aws ssm get-parameter \
      --name "${parameter_name}" \
      --with-decryption \
      --query 'Parameter.Value' \
      --output text 2>/dev/null)"; then
  generated="$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')"
  aws ssm put-parameter \
    --name "${parameter_name}" \
    --type String \
    --value "${generated}" \
    --no-overwrite
fi
```

An installer written against an AWS SDK follows the same two steps: read the name, and on a not-found error create it
without an overwrite flag. `openssl rand -base64 48` produces 64 characters; translating `+` to `-` and `/` to `_` and
dropping the padding stays inside the documented alphabet.

**Grants.** Two different principals read the parameter:

- The deploying principal resolves the distribution header: CloudFormation performs that read with the caller's
  permissions, so it needs `ssm:GetParameters` for the name.
- The runtime function reads the value lazily: it needs `ssm:GetParameter` on exactly
  `arn:aws:ssm:<region>:<account>:parameter/<name-without-leading-slash>`. `AppTheoryMcpServer` adds that statement to
  `handler` when it declares `secretParameterName`, and adds `kms:Decrypt` on a declared `secretParameterKmsKey`. A
  `String` parameter needs no KMS permission.

**Rotation.** Write a new value (a new parameter version), then update the stack: CloudFormation resolves the latest
version on each create or update and does not re-resolve on drift detection, so the parameter change alone does not move
the distribution. The runtime picks the new value up on the first mismatching request or within its TTL, so requests
fail closed only for the interval between the two.
