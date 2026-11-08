import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";

import { AppTheoryHttpApi } from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import { CfnOutput, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

/**
 * The local MCP auth-facade example: one Go Lambda that mounts the framework's
 * MCP auth facade with its brokered route refresh and an in-process local
 * authorization server, served by an HTTP API.
 *
 * The public base URL is deployment configuration: a real deployment passes its
 * own HTTPS origin, and the local runner's row passes the run's pinned HTTPS
 * host and port through CDK context. The default is only what a plain
 * `cdk synth` records in the pinned template.
 */
export interface LocalMcpAuthFacadeStackProps extends StackProps {
  readonly publicBaseUrl?: string;
  readonly handleTTL?: string;
  readonly graceWindow?: string;
  readonly accessTTL?: string;
}

const defaultPublicBaseUrl = "https://mcp.localhost:8240";

export class LocalMcpAuthFacadeStack extends Stack {
  public readonly function: lambda.Function;

  constructor(scope: Construct, id: string, props: LocalMcpAuthFacadeStackProps = {}) {
    super(scope, id, props);

    const repoRoot = path.resolve(__dirname, "../../../..");
    const handlerDir = path.join(__dirname, "..", "handlers", "go");
    const publicBaseUrl = String(props.publicBaseUrl ?? defaultPublicBaseUrl).replace(/\/+$/, "");

    this.function = new lambda.Function(this, "FacadeHandler", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      architecture: lambda.Architecture.ARM_64,
      handler: "bootstrap",
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      description: "MCP auth facade with brokered route refresh, on the local runner",
      environment: {
        MCP_EXAMPLE_PUBLIC_BASE_URL: publicBaseUrl,
        MCP_EXAMPLE_UPSTREAM_CLIENT_ID: "apptheory-local-facade",
        MCP_EXAMPLE_SUBJECT: "example-person",
        MCP_EXAMPLE_HANDLE_TTL: String(props.handleTTL ?? "24h"),
        MCP_EXAMPLE_GRACE_WINDOW: String(props.graceWindow ?? "1s"),
        MCP_EXAMPLE_ACCESS_TTL: String(props.accessTTL ?? "900s"),
      },
      code: lambda.Code.fromAsset(handlerDir, {
        // The asset hash covers the handler and the runtime sources it builds,
        // so a runtime change moves the asset (and the pinned template) even
        // when this example's own source does not.
        assetHashType: cdk.AssetHashType.CUSTOM,
        assetHash: assetHashFor([
          handlerDir,
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
              execSync(
                `go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o ${JSON.stringify(path.join(outputDir, "bootstrap"))} .`,
                {
                  cwd: handlerDir,
                  stdio: "inherit",
                  env: { ...process.env, GOOS: "linux", GOARCH: "arm64", CGO_ENABLED: "0" },
                },
              );
              return true;
            },
          },
        },
      }),
    });

    new AppTheoryHttpApi(this, "Api", {
      handler: this.function,
      apiName: "local-mcp-auth-facade",
    });

    new CfnOutput(this, "PublicBaseUrl", { value: publicBaseUrl });
    new CfnOutput(this, "McpUrl", { value: `${publicBaseUrl}/acme/mcp` });
  }
}

function shouldSkipAssetEntry(name: string): boolean {
  return name === "__pycache__" || name.endsWith("_test.go");
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
