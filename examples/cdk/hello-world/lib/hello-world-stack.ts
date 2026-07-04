import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
    if (entry.isDirectory()) {
      copyDir(from, to);
      continue;
    }
    if (entry.isFile()) {
      copyFileSync(from, to);
    }
  }
}

function cleanOutputDir(outputDir: string): void {
  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });
}

function assetHashFor(paths: string[]): string {
  const hash = createHash("sha256");
  for (const inputPath of [...paths].sort()) {
    addPathToHash(hash, inputPath, inputPath);
  }
  return hash.digest("hex");
}

function addPathToHash(hash: ReturnType<typeof createHash>, root: string, current: string): void {
  const stat = statSync(current);
  const rel = path.relative(path.dirname(root), current).replaceAll(path.sep, "/");
  hash.update(rel);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(current).sort()) {
      addPathToHash(hash, root, path.join(current, entry));
    }
    return;
  }
  if (stat.isFile()) {
    hash.update(readFileSync(current));
  }
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
            assetHash: assetHashFor([path.join(__dirname, "..", "handlers", "go")]),
            bundling: {
              image: cdk.DockerImage.fromRegistry("golang:1.26"),
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
      case "ts":
        return new AppTheoryFunction(this, "Handler", {
          runtime: lambda.Runtime.NODEJS_24_X,
          handler: "handler.handler",
          code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "ts"), {
            assetHashType: cdk.AssetHashType.CUSTOM,
            assetHash: assetHashFor([
              path.join(__dirname, "..", "handlers", "ts", "app.mjs"),
              path.join(__dirname, "..", "handlers", "ts", "handler.mjs"),
              path.join(__dirname, "..", "handlers", "ts", "package.json"),
              path.join(repoRoot, "ts", "dist", "index.js"),
            ]),
            bundling: {
              image: lambda.Runtime.NODEJS_24_X.bundlingImage,
              command: ["bash", "-c", "cp -R /asset-input/* /asset-output/"],
              local: {
                tryBundle(outputDir: string) {
                  const handlerDir = path.join(__dirname, "..", "handlers", "ts");
                  cleanOutputDir(outputDir);
                  copyFileSync(path.join(handlerDir, "app.mjs"), path.join(outputDir, "app.mjs"));
                  copyFileSync(path.join(handlerDir, "handler.mjs"), path.join(outputDir, "handler.mjs"));
                  copyFileSync(path.join(handlerDir, "package.json"), path.join(outputDir, "package.json"));
                  mkdirSync(path.join(outputDir, "vendor", "apptheory"), { recursive: true });
                  copyFileSync(path.join(repoRoot, "ts", "dist", "index.js"), path.join(outputDir, "vendor", "apptheory", "index.js"));
                  return true;
                },
              },
            },
          }),
          environment: { APPTHEORY_HELLO_LANG: "ts", APPTHEORY_TIER: "p2" },
        });
      case "py":
        return new AppTheoryFunction(this, "Handler", {
          runtime: lambda.Runtime.PYTHON_3_14,
          handler: "handler.handler",
          code: lambda.Code.fromAsset(path.join(__dirname, "..", "handlers", "py"), {
            assetHashType: cdk.AssetHashType.CUSTOM,
            assetHash: assetHashFor([
              path.join(__dirname, "..", "handlers", "py", "handler.py"),
              path.join(repoRoot, "py", "src", "apptheory"),
            ]),
            bundling: {
              image: lambda.Runtime.PYTHON_3_14.bundlingImage,
              command: ["bash", "-c", "cp -R /asset-input/* /asset-output/"],
              local: {
                tryBundle(outputDir: string) {
                  const handlerDir = path.join(__dirname, "..", "handlers", "py");
                  cleanOutputDir(outputDir);
                  copyFileSync(path.join(handlerDir, "handler.py"), path.join(outputDir, "handler.py"));
                  copyDir(path.join(repoRoot, "py", "src", "apptheory"), path.join(outputDir, "apptheory"));
                  return true;
                },
              },
            },
          }),
          environment: { APPTHEORY_HELLO_LANG: "py", APPTHEORY_TIER: "p2" },
        });
    }
  }
}
