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
