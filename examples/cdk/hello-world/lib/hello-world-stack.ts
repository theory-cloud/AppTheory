import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";

import { AppTheoryFunction, AppTheoryHttpApi } from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

export type HelloWorldLanguage = "go" | "ts" | "py";

export interface HelloWorldStackProps extends StackProps {
  readonly lang: HelloWorldLanguage;
}

export function normalizeHelloWorldLanguage(input: unknown): HelloWorldLanguage {
  const value = String(input ?? "").trim().toLowerCase();
  switch (value) {
    case "go":
    case "golang":
      return "go";
    case "ts":
    case "typescript":
    case "node":
    case "nodejs":
      return "ts";
    case "py":
    case "python":
      return "py";
    default:
      throw new Error("AppTheory hello-world lang must be one of: go, ts, py");
  }
}

function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (shouldSkipAssetEntry(entry.name)) {
      continue;
    }
    if (entry.isDirectory()) {
      copyDir(from, to);
      continue;
    }
    if (entry.isFile()) {
      copyFileSync(from, to);
    }
  }
}

function shouldSkipAssetEntry(name: string): boolean {
  return (
    name === "__pycache__" ||
    name.endsWith("_test.go") ||
    name.endsWith(".pyc") ||
    name.endsWith(".pyo") ||
    name.endsWith(".egg-info")
  );
}

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

function cleanOutputDir(outputDir: string): void {
  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });
}

/**
 * Stage the deployment package the Python function ships: the handler at the archive root and the
 * AppTheory runtime beside it.
 *
 * Lambda imports the entry module from the archive root, so an asset that carries `handlers/py`
 * alone cannot start — `from apptheory import ...` would have nothing to import. The package is
 * built by `examples/cdk/_shared/python-package-asset.mjs`, which holds both trees to an explicit
 * allow-list of the files that ship; this stack only names the example. No patterns filter the
 * asset afterwards, because a pattern list is a list of things to skip: it can only exclude the
 * residue someone anticipated, and a `.env`, a local test tree or a `.pytest_cache` nobody
 * anticipated would still reach the archive.
 */
function stagePythonPackage(exampleDir: string): string {
  const script = path.join(exampleDir, "..", "_shared", "python-package-asset.mjs");
  return execFileSync(process.execPath, [script, exampleDir], { encoding: "utf8" }).trim();
}

function resetAssetStage(exampleDir: string, name: string): string {
  const stageDir = path.join(exampleDir, ".cdk-asset-stage", name);
  cleanOutputDir(stageDir);
  return stageDir;
}

function stageHandlerFiles(handlersDir: string, stageDir: string, files: string[]): void {
  for (const file of files) {
    copyFileSync(path.join(handlersDir, file), path.join(stageDir, file));
  }
}

// The vendored AppTheory runtime imports its declared dependencies, including
// @theory-cloud/tabletheory-ts, when the barrel entry loads. A Lambda asset
// that carries only ts/dist therefore fails at init in a clean runtime. Stage
// the runtime's production dependency closure next to the vendored dist so the
// asset is self-contained.
function stageNodeDependencies(runtimeDir: string, stageDir: string): void {
  const runtimeNodeModules = path.join(runtimeDir, "node_modules");
  const marker = path.join(runtimeNodeModules, "@theory-cloud", "tabletheory-ts", "package.json");
  if (!existsSync(marker)) {
    throw new Error(
      `missing ${marker}; run 'cd ts && npm ci --ignore-scripts' before synthesizing the TypeScript asset`,
    );
  }
  const listed = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
    cwd: runtimeDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `${runtimeNodeModules}${path.sep}`;
  const destination = path.join(stageDir, "node_modules");
  for (const line of listed.split("\n")) {
    const dependency = line.trim();
    if (!dependency.startsWith(prefix)) {
      continue;
    }
    copyDir(dependency, path.join(destination, dependency.slice(prefix.length)));
  }
}

function assetHashFor(paths: string[]): string {
  const hash = createHash("sha256");
  for (const inputPath of [...paths].sort()) {
    addPathToHash(hash, inputPath, inputPath);
  }
  return hash.digest("hex");
}

function addPathToHash(hash: ReturnType<typeof createHash>, root: string, current: string, entry?: Dirent): void {
  const name = entry?.name ?? path.basename(current);
  if (shouldSkipAssetEntry(name)) {
    return;
  }
  const rel = path.relative(path.dirname(root), current).replaceAll(path.sep, "/");
  hash.update(rel);
  if (!entry) {
    let children: Dirent[];
    try {
      children = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
        hash.update(readFileSync(current));
        return;
      }
      throw error;
    }
    addDirectoryEntriesToHash(hash, root, current, children);
    return;
  }
  if (entry.isDirectory()) {
    addDirectoryEntriesToHash(hash, root, current, readdirSync(current, { withFileTypes: true }));
    return;
  }
  if (entry.isFile()) {
    hash.update(readFileSync(current));
  }
}

function addDirectoryEntriesToHash(
  hash: ReturnType<typeof createHash>,
  root: string,
  current: string,
  children: Dirent[],
): void {
  for (const child of children.sort(compareDirentNames)) {
    addPathToHash(hash, root, path.join(current, child.name), child);
  }
}

function compareDirentNames(left: Dirent, right: Dirent): number {
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
}

export class HelloWorldStack extends Stack {
  constructor(scope: Construct, id: string, props: HelloWorldStackProps) {
    super(scope, id, props);

    const repoRoot = path.resolve(__dirname, "../../../..");
    const lang = props.lang;
    const handler = this.createHandler(lang, repoRoot);
    const api = new AppTheoryHttpApi(this, "Api", {
      handler: handler.fn,
      apiName: `apptheory-hello-world-${lang}`,
      cors: true,
    });

    // R8 stage-shape proof: an HTTP API with a named (non-$default) stage. The
    // runner serves both the root URL and /{stage}/... and the handler sees the
    // documented v2 fields (rawPath with the stage, requestContext.stage).
    const stageEchoFn = new lambda.Function(this, "StageEchoFn", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "stage-echo")),
      description: "HTTP API v2 named-stage event-shape probe",
    });
    new AppTheoryHttpApi(this, "StageEchoApi", {
      apiName: "apptheory-hello-world-stage-echo",
      handler: stageEchoFn,
      stage: { stageName: "dev" },
    });

    new CfnOutput(this, "Language", { value: lang });
    new CfnOutput(this, "ApiUrl", { value: api.api.apiEndpoint });
    new CfnOutput(this, "Curl", { value: `curl ${api.api.apiEndpoint}/hello/AppTheory` });
  }

  private createHandler(lang: HelloWorldLanguage, repoRoot: string): AppTheoryFunction {
    switch (lang) {
      case "go":
        return new AppTheoryFunction(this, "Handler", {
          runtime: lambda.Runtime.PROVIDED_AL2023,
          handler: "bootstrap",
          code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "go"), {
            assetHashType: cdk.AssetHashType.CUSTOM,
            assetHash: assetHashFor([
              path.join(__dirname, "..", "handlers", "go"),
              path.join(repoRoot, "runtime"),
              path.join(repoRoot, "go.mod"),
              path.join(repoRoot, "go.sum"),
            ]),
            bundling: {
              image: cdk.DockerImage.fromRegistry("golang:1.27"),
              command: [
                "bash",
                "-c",
                [
                  "set -euo pipefail",
                  "cd /asset-input",
                  "GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /asset-output/bootstrap .",
                ].join(" && "),
              ],
              local: {
                tryBundle(outputDir: string) {
                  cleanOutputDir(outputDir);
                  execSync(
                    `go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o ${path.join(outputDir, "bootstrap")} .`,
                    {
                      cwd: path.join(__dirname, "..", "handlers", "go"),
                      stdio: "inherit",
                      env: {
                        ...process.env,
                        GOOS: "linux",
                        GOARCH: "arm64",
                        CGO_ENABLED: "0",
                      },
                    },
                  );
                  return true;
                },
              },
            },
          }),
          environment: { APPTHEORY_HELLO_LANG: "go", APPTHEORY_TIER: "p2" },
        });
      case "ts": {
        const handlerDir = path.join(__dirname, "..", "handlers", "ts");
        const stageDir = resetAssetStage(path.join(__dirname, ".."), "ts");
        stageHandlerFiles(handlerDir, stageDir, ["app.mjs", "handler.mjs", "package.json"]);
        copyDir(path.join(repoRoot, "ts", "dist"), path.join(stageDir, "vendor", "apptheory"));
        stageNodeDependencies(path.join(repoRoot, "ts"), stageDir);
        return new AppTheoryFunction(this, "Handler", {
          runtime: lambda.Runtime.NODEJS_24_X,
          handler: "handler.handler",
          code: lambda.Code.fromAsset(stageDir, {
            exclude: assetExclude,
            bundling: {
              image: lambda.Runtime.NODEJS_24_X.bundlingImage,
              command: ["bash", "-c", "set -euo pipefail && cp -R /asset-input/. /asset-output/"],
              local: {
                tryBundle(outputDir: string) {
                  cleanOutputDir(outputDir);
                  copyDir(stageDir, outputDir);
                  return true;
                },
              },
            },
          }),
          environment: { APPTHEORY_HELLO_LANG: "ts", APPTHEORY_TIER: "p2" },
        });
      }
      case "py": {
        const stageDir = stagePythonPackage(path.join(__dirname, ".."));
        return new AppTheoryFunction(this, "Handler", {
          runtime: lambda.Runtime.PYTHON_3_14,
          handler: "handler.handler",
          code: lambda.Code.fromAsset(stageDir),
          environment: { APPTHEORY_HELLO_LANG: "py", APPTHEORY_TIER: "p2" },
        });
      }
    }
  }
}
