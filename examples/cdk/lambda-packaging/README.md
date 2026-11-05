# Lambda Packaging Example

This example demonstrates Lambda layers and container-image functions as the
AppTheory local runner serves them.

## Features Demonstrated

- **Node layer**: a `LayerVersion` whose `nodejs/node_modules` holds an
  importable package and whose `bin/` holds an executable. The function imports
  the package and runs the executable from `PATH`.
- **Python layer**: the same layer shape for a Python runtime, imported from
  `/opt/python` with the executable from `/opt/bin`.
- **Container images**: Go (provided runtime), Node and Python functions built
  from a Dockerfile. Each Dockerfile writes `IMAGE_VALUE`, a build argument, into
  the image, and the handler returns it.

## Structure

```
lambda-packaging/
├── bin/app.ts                       # CDK app entry point
├── lib/lambda-packaging-stack.ts    # Layers, image functions and the HTTP API
├── handlers/node/app.js             # Uses the Node layer
├── handlers/python/app.py           # Uses the Python layer
├── layers/node/                     # nodejs/node_modules and bin/
├── layers/python/                   # python/ and bin/
├── images/go/                       # Provided-runtime Dockerfile and bootstrap
├── images/node/                     # Node Dockerfile
├── images/python/                   # Python Dockerfile
├── cdk.json
├── package.json
└── tsconfig.json
```

## Deploy

```bash
npm install
npx cdk deploy
```

## Run locally

```bash
apptheory-local run --app examples/cdk/lambda-packaging --profile scripts/local/examples-local.json
```

The run builds the three images with `docker build` before it serves the API.
The first build pulls the base image and takes roughly 10-60 seconds; later runs
reuse Docker's layer cache.
