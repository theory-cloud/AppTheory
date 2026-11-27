import { execFileSync } from "node:child_process";
import * as path from "node:path";

import { AppTheoryPythonInterface, AppTheoryWebFunction } from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

/**
 * One Python application, deployed twice: once as an ASGI app and once as a WSGI app.
 *
 * A Python Web Function is not a request/response handler. Lambda manages the HTTP server and
 * passes each request to the application through the interface its entry point declares, so the
 * composition names the module, the callable and the interface — and `AppTheoryWebFunction` writes
 * the entry point. Nothing here sets `AWS_LAMBDA_PYTHON_ENTRYPOINT`, and nothing has to read
 * `AWS_LAMBDA_HTTP_ENDPOINT`: a Python application never learns where to listen.
 *
 * Both revisions run `python3.15`, which upstream publishes as a public preview: not covered by the
 * Lambda SLA or Technical Support, and not for production. It is the only Python Web Function
 * runtime, so the example labels that where an operator will see it.
 */
/**
 * Byte-code caches and build residue are not part of the deployment package. The staged package is
 * rebuilt from source on every synthesis (see `scripts/stage-asset.mjs`) and already skips caches,
 * and these patterns are the second lock on the same door.
 */
const assetExclude = [
  "__pycache__",
  "**/__pycache__",
  "*.pyc",
  "**/*.pyc",
  "*.pyo",
  "**/*.pyo",
  "*.egg-info",
  "**/*.egg-info",
];

/**
 * Build the package both revisions stage: `app/` at the archive root with the AppTheory runtime
 * beside it.
 *
 * Lambda imports the entry module from the archive root, so an asset that carries `app/` alone
 * cannot start — the entry module's `from apptheory import ASGIApp` has nothing to import. Staging
 * through the example's own script instead of pointing the asset at `app/` is what keeps the
 * synthesized package and the running package the same thing.
 */
function stagePythonPackage(): string {
  const script = path.join(__dirname, "..", "scripts", "stage-asset.mjs");
  return execFileSync(process.execPath, [script], { encoding: "utf8" }).trim();
}

export class WebFunctionPythonStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const code = lambda.WebFunctionCode.fromAssetToManagedBucket(stagePythonPackage(), {
      exclude: assetExclude,
    });
    const runtime = lambda.WebFunctionRuntime.of("python3.15");

    // The default interface for a Python Web Function: one event loop, concurrent requests. The
    // application is `main:app`, and the entry point carries `asgi:` so the runtime never has to
    // detect which interface the callable speaks.
    const asgiFunction = new AppTheoryWebFunction(this, "Asgi", {
      code,
      runtime,
      pythonApp: { module: "main", interface: AppTheoryPythonInterface.ASGI },
      description: "AppTheory Python Web Function example, ASGI application (python3.15 public preview)",
      endpoint: {
        endpointName: "asgi",
        description: "ASGI endpoint: one event loop, concurrent requests",
      },
    });

    // The other interface upstream documents: a pool of worker threads, one request per thread. The
    // same application, served through the same AppTheory runtime, is the WSGI callable in
    // `main_wsgi.py`.
    const wsgiFunction = new AppTheoryWebFunction(this, "Wsgi", {
      code,
      runtime,
      pythonApp: {
        module: "main_wsgi",
        callable: "application",
        interface: AppTheoryPythonInterface.WSGI,
      },
      description: "AppTheory Python Web Function example, WSGI application (python3.15 public preview)",
      endpoint: {
        endpointName: "wsgi",
        description: "WSGI endpoint: a pool of worker threads, one request per thread",
      },
    });

    new CfnOutput(this, "AsgiDomainName", { value: asgiFunction.domainName });
    new CfnOutput(this, "AsgiRevisionId", { value: asgiFunction.revisionId });
    new CfnOutput(this, "AsgiEndpointAuthType", { value: asgiFunction.endpoint.authType });
    new CfnOutput(this, "WsgiDomainName", { value: wsgiFunction.domainName });
    new CfnOutput(this, "WsgiRevisionId", { value: wsgiFunction.revisionId });
    new CfnOutput(this, "WsgiEndpointAuthType", { value: wsgiFunction.endpoint.authType });
  }
}
