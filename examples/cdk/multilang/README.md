# AppTheory CDK Multi-language Demo (Go + Node + Python)

This example deploys the **same AppTheory HTTP app** implemented in:

- Go (compiled from this repo)
- Node.js 24 (using the AppTheory TypeScript SDK)
- Python 3.14 (using the AppTheory Python SDK)

Each language is deployed as its own Lambda + HTTP API so you can compare behavior side-by-side.

It also wires up the same non-HTTP event sources to each Lambda:

- SQS → Lambda (partial batch failure enabled)
- EventBridge rule → Lambda for a product-neutral domain event
- EventBridge schedule → Lambda for periodic work
- DynamoDB Streams → Lambda (partial batch failure enabled)
- WebSocket API → Lambda (`$connect`/`$disconnect`/`$default`, with management API send)

The Go, Node, and Python handlers use the AppTheory event workload helpers for
all non-HTTP examples:

- EventBridge rule intake returns the normalized workload envelope.
- EventBridge scheduled intake returns the scheduled workload summary.
- DynamoDB Streams handling derives the safe stream record summary and does not
  copy `Keys`, `NewImage`, or `OldImage` values into the handler result.

## Prerequisites

- Node.js `>=24` + `npm`
- Go `1.27.2` (for local bundling of the Go Lambda)
- Python `3.14`
- AWS credentials configured (for deploy; synth does not require AWS access)

## Synth

```bash
cd examples/cdk/multilang
npm ci
npx cdk synth
```

## Deploy

```bash
cd examples/cdk/multilang
npx cdk deploy --all
```

## Packaging

The Python handler ships as an allow-list, not as "everything under `handlers/py` minus a list of names":
`examples/cdk/_shared/python-package-asset.mjs` stages `handlers/py/handler.py` at the archive root and the AppTheory
runtime beside it under `apptheory/`, and it stages exactly the files it names. Residue that Python cannot import — a
`.env`, a `.pytest_cache`, an editor swap file, a note — stays out of the CDK asset without being listed anywhere, so
the pinned template hash does not move because of what a local run left in the tree. Two shapes are refused by name
instead: an importable unit the list does not declare, and an entry that is not a regular file or a regular directory
(a symbolic link, a socket, a fifo). The rules follow from that: this example's Python test lives in
`tests/handler_test.py`, outside the packaged tree, and the WebSocket authorizer's asset is its one declared module
rather than a directory template over `handlers/`. The same script packages every Python asset under `examples/cdk/`: `hello-world`, `web-function-python`, this
example, both of `lambda-packaging`'s (its Python function and its Python layer), and the `local-iam` and
`local-tls` Python callers.

## Configuration

The CDK stack injects a shared configuration story across languages:

- `APPTHEORY_TIER` (defaults to `p2`)
- `APPTHEORY_DEMO_NAME` (defaults to `apptheory-multilang`)
- `APPTHEORY_DEMO_QUEUE_NAME`
- `APPTHEORY_DEMO_EVENT_SOURCE` (defaults to `apptheory.example`)
- `APPTHEORY_DEMO_EVENT_DETAIL_TYPE` (defaults to `example.item.changed`)
- `APPTHEORY_DEMO_EVENT_RULE_NAME`
- `APPTHEORY_DEMO_SCHEDULE_RULE_NAME`
- `APPTHEORY_DEMO_TABLE_NAME`

You can override these via CDK context:

```bash
npx cdk synth -c tier=p2 -c name=demo
```
