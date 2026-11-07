# local-tls

An example app whose whole purpose is the local runner's HTTPS opt-in: every
public listener the runner serves, plus a WebAuthn page and an OIDC issuer.

One Node function is the issuer and the CloudFront page. It serves:

- `/.well-known/openid-configuration`, with `issuer` equal to the exact
  `https://` URL the request was served at;
- `/jwks`, an RSA JWK set;
- `/`, the page the browser row loads; its `window.__apptheoryRegister()`
  registers and asserts a WebAuthn credential with `rp.id = location.hostname`.

Three callers (Go, Node and Python) fetch the discovery document and JWKS from
their own container, so each runtime's TLS stack verifies the runner's
certificate through the trust bundle the runner mounts. The stack also declares
a REST API v1, a WebSocket API and a Lambda Function URL behind a CloudFront
distribution, so one app covers every public listener the runner serves.

```bash
npm install
npx cdk synth

# From the repository root: serve everything over https at app.localhost.
go run ./cmd/apptheory-local run --app examples/cdk/local-tls \
  --profile scripts/local/examples-local.json --tls --name-prefix local-tls
```

The runner prints the CA and trust-bundle paths. Call a listener with the CA:

```bash
curl --cacert <data-dir-or-scratch>/tls/ca.pem https://app.localhost:<port>/health
```

The example's own scripts are the harness rows' entrypoints; the harness row
(`make examples-local`) starts a session, invokes each caller with the app's
public URL, drives discovery and JWKS from the host and from a container, loads
the CloudFront page in headless Chromium, and issues an auxiliary service
certificate with `apptheory-local tls leaf`. See
[Local HTTPS, OIDC issuers and passkeys](../../../docs/examples/local-runner.md#local-https-oidc-issuers-and-passkeys).
