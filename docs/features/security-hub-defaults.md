---
title: Security Hub Defaults
---

# Security Hub defaults

AWS Security Hub evaluates Theory Cloud accounts against the AWS Foundational Security Best Practices standard
(FSBP v1.0.0) and the CIS AWS Foundations Benchmark v5.0.0. A builder should get infrastructure that passes those
controls without being a cloud security specialist, so AppTheory fixes each applicable default once in the construct
library rather than in every application.

Each default below names the Security Hub control it answers and links the AWS control reference that states what the
control evaluates and which values pass. Where a control cannot be satisfied by construction, this page says so instead
of implying coverage.

## When the defaults apply

The defaults are selected by the resource-naming context, the same mechanism the standard logging profile uses, and the
context's **naming profile** decides which side of the migration a consumer is on.

| Consumer | Synthesis |
|---|---|
| No naming context | Unchanged. Byte-identical to the template before this contract existed. |
| `namingProfile: legacy` (a pinned live stage) | Unchanged. The AT-N3 migration property still holds: adopting the contract with pins changes nothing. |
| `namingProfile: derived` (the lab path) | The defaults below apply. |

That is what "live stays byte-identical until it moves accounts" means in practice: a live stage stays on the legacy
profile and its template does not move; a stage that moves to a derived context (lab, or a live stage after an account
move) picks the defaults up with no application change, because nothing comes from an environment variable.

An application that needs a different setting overrides it with the explicit prop named in the table. Every default has
one.

## Security Hub mapping

DynamoDB controls: [DynamoDB.2](https://docs.aws.amazon.com/securityhub/latest/userguide/dynamodb-controls.html),
[DynamoDB.6](https://docs.aws.amazon.com/securityhub/latest/userguide/dynamodb-controls.html). API Gateway controls:
[APIGateway.11](https://docs.aws.amazon.com/securityhub/latest/userguide/apigateway-controls.html). CloudFront controls:
[CloudFront.1](https://docs.aws.amazon.com/securityhub/latest/userguide/cloudfront-controls.html),
[CloudFront.15](https://docs.aws.amazon.com/securityhub/latest/userguide/cloudfront-controls.html). EventBridge:
[EventBridge.3](https://docs.aws.amazon.com/securityhub/latest/userguide/eventbridge-controls.html). S3:
[S3.5](https://docs.aws.amazon.com/securityhub/latest/userguide/s3-controls.html),
[S3.9](https://docs.aws.amazon.com/securityhub/latest/userguide/s3-controls.html).

| Control | Construct | Default under a derived context | Opt out or override |
|---|---|---|---|
| DynamoDB.2 | `AppTheoryDynamoTable`, `AppTheoryJobsTable`, `AppTheoryEventBusTable`, `AppTheoryApp` database and rate-limit tables, `AppTheoryWebSocketApi` connection table, `AppTheoryMcpServer` session table, `AppTheoryMicrovmController` session table | Point-in-time recovery on | `enablePointInTimeRecovery: false`, `connectionTableEnablePointInTimeRecovery: false`, `enableSessionTablePointInTimeRecovery: false` |
| DynamoDB.6 | the same tables | Deletion protection on when the resolved removal policy is `RETAIN` | `deletionProtection: false`, `connectionTableDeletionProtection`, `sessionState.deletionProtection`, `sessionTableDeletionProtection`; a `DESTROY` removal policy also leaves protection off so the stack still tears down |
| APIGateway.11 | `AppTheoryRestApiRouter`, `AppTheoryRemoteMcpServer` REST domains | `SecurityPolicy_TLS13_1_2_PFS_PQ_2025_09` for a regional or private domain, `SecurityPolicy_TLS12_PFS_2025_EDGE` for an edge domain, with `endpointAccessMode: STRICT` | `domain.securityPolicy` and `domain.endpointAccessMode` |
| APIGateway.11 | `AppTheoryHttpApi`, `AppTheoryApiDomain`, `AppTheoryHttpIngestionEndpoint`, `AppTheoryMcpServer` owned domain | `TLS_1_2`, the strongest policy API Gateway v2 offers (see the limitation below) | `securityPolicy` on the domain options |
| CloudFront.15 | `AppTheorySsrSite`, `AppTheoryPathRoutedFrontend`, `AppTheoryMediaCdn`, `AppTheoryRestV1ChallengeRestoration` | `TLSv1.2_2025` on a distribution that serves a custom certificate | `minimumProtocolVersion` |
| CloudFront.1 | `AppTheorySsrSite` in `ssg-isr` mode, `AppTheoryMediaCdn` | `index.html` where `/` already reaches the S3 default behavior | `defaultRootObject` |
| EventBridge.3 | `AppTheoryEventBridgeBus` | A resource policy granting the owning account `events:*` on that bus, so same-account principals keep exactly the IAM access they already had and no other account is admitted | `owningAccountResourcePolicy: false` |
| S3.5 | every bucket AppTheory creates | `enforceSSL` on, which adds the `aws:SecureTransport` deny policy | `enforceSSL: false` |
| S3.9 | the data buckets `AppTheorySsrSite` and `AppTheoryMediaCdn` create | **Off.** Server access logging is opt-in because the log target and its storage cost money | `serverAccessLogsBucket` and `serverAccessLogsPrefix` |

Details behind the table:

- **CloudFront.15 evaluates only a distribution with a custom certificate.** Without a certificate CloudFront serves
  its fixed default certificate, so AppTheory sets no minimum protocol version and the control does not evaluate the
  distribution.
- **CloudFront.1 evaluates a distribution that carries S3 origins.** The control page says it "checks whether an
  Amazon CloudFront distribution with S3 origins is configured to return a specific object that is the default root
  object" and fails a distribution that uses S3 origins without one; a distribution that carries custom origins only is
  not evaluated. AppTheory sets a default root object only where the control's root object rewrite (`/` →
  `/<object>`) cannot change which origin serves `/`: the `ssg-isr` root behavior is the S3 HTML store, and the media
  CDN's default behavior is the S3 media bucket over OAC. `ssr-only` (whose `/` must reach the function URL) and
  `AppTheoryPathRoutedFrontend` (whose `/` must reach the API origin whenever SPA prefixes add S3 origins) keep no
  default and are documented residuals below. `AppTheoryRestV1ChallengeRestoration` carries no S3 origin, so the
  control does not evaluate it.
- **The S3.9 log target consumes no naming entry.** Resource-naming contract section 4 keeps a construct's logging
  resources out of the naming entries, so the bucket you supply here is yours and never needs a `s3_bucket` entry.

### CloudFront.1 residuals

The control page for CloudFront.1 is
[CloudFront.1](https://docs.aws.amazon.com/securityhub/latest/userguide/cloudfront-controls.html). AppTheory sets a
default root object where `/` already reaches the S3 default behavior, because the control's rewrite (`/` →
`/<object>`) must not change where `/` goes:

| Distribution | S3 origin | Default behavior | Root object | Why |
|---|---|---|---|---|
| `AppTheorySsrSite` in `ssg-isr` mode | the HTML store | the S3 HTML store with the Lambda fallback | `index.html` | `/` already reaches the S3 store |
| `AppTheoryMediaCdn` | the media bucket | the S3 bucket over OAC | `index.html` | `/` already reaches the S3 bucket |
| `AppTheorySsrSite` in `ssr-only` mode | the asset bucket | the Lambda function URL | none (residual) | `/` must reach the Lambda origin |
| `AppTheoryPathRoutedFrontend` with SPA origins | the SPA buckets | the API origin | none (residual) | `/` must reach the API origin |
| `AppTheoryRestV1ChallengeRestoration` | none | the REST API origin | not evaluated | no S3 origin, so the control does not apply |

A finding on the two residual rows is expected, and it is the correct trade: a default root object there would move `/`
to a different origin, which changes what the distribution serves. Both constructs keep the explicit prop for an app
that knows its own routing is safe.

## Controls the framework deliberately does not address

Factory disabled these controls for the platform because they do not apply to it. AppTheory does not design for them.

| Control | Why it is not addressed |
|---|---|
| GuardDuty runtime monitoring controls | Managed at the organization and account level, not by an application construct |
| IAM password policy controls | Account-level identity configuration; AppTheory creates no human identities |
| VPC endpoint controls | Network posture belongs to the account and network layer, not to an application construct |
| CloudFront.4 (origin failover) | An AppTheory distribution fronts a single origin by design; the platform does not buy the second origin |
| CloudFront.5 (access logging) | The control only evaluates legacy S3 standard logging. Under the standard logging profile AppTheory delivers CloudFront access logs to the contract log group through CloudWatch Logs vended delivery, so the control still reports a finding and Factory suppresses it rather than AppTheory downgrading the platform to S3 legacy logging to satisfy a check |
| CloudFront.17 (trusted key groups) | Only `AppTheoryMediaCdn` supports signed access, and only when private media is configured |

Two more limits a reader should know:

- **APIGateway.11 cannot pass for an HTTP API custom domain.** The control reference states that it generates a FAILED
  finding for custom domain names attached to HTTP APIs, so AppTheory sets the strongest policy API Gateway v2 offers
  (`TLS_1_2`) and does not claim the control for HTTP API domains. An app that must pass APIGateway.11 uses a REST API
  custom domain.
- **S3.9 is opt-in, not default.** Enabling server access logging on every bucket would add a log target and storage
  cost that the platform has not budgeted, so AppTheory exposes the prop and leaves the decision to the app.

## What this packet does not change

AppTheory already met several controls before these defaults, and this packet leaves them alone: viewer protocol
redirect to HTTPS (CloudFront.3), origin access control on S3 origins (CloudFront.13), block public access on every
bucket AppTheory creates (S3.2, S3.3, S3.8 at the bucket level), OAC-based CloudFront origins, and REST TLS 1.2. The
packet also makes no claim about S3.14 (versioning), S3.15 (Object Lock) or S3.17 (KMS encryption): those are data
durability, retention and key-management choices that belong to the application, not to a framework default.
