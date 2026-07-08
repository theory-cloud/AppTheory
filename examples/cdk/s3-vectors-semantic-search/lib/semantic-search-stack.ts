import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Dirent } from "node:fs";
import * as path from "node:path";

import { AppTheoryFunction, AppTheoryHttpApi, AppTheoryVectorIndex } from "@theory-cloud/apptheory-cdk";
import * as cdk from "aws-cdk-lib";
import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

const titanTextEmbeddingModelId = "amazon.titan-embed-text-v2:0";

function shouldSkipAssetEntry(name: string): boolean {
  return name === "__pycache__" || name.endsWith(".pyc") || name.endsWith(".pyo") || name.endsWith(".egg-info");
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

export class S3VectorsSemanticSearchStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const repoRoot = path.resolve(__dirname, "../../../..");
    const handlerDir = path.join(__dirname, "..", "handler");

    const handler = new AppTheoryFunction(this, "Handler", {
      runtime: lambda.Runtime.PROVIDED_AL2023,
      handler: "bootstrap",
      code: lambda.Code.fromAsset(handlerDir, {
        assetHashType: cdk.AssetHashType.CUSTOM,
        assetHash: assetHashFor([
          handlerDir,
          path.join(repoRoot, "pkg", "vectorstore"),
          path.join(repoRoot, "runtime"),
          path.join(repoRoot, "go.mod"),
          path.join(repoRoot, "go.sum"),
        ]),
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
                  cwd: handlerDir,
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
      environment: { APPTHEORY_TIER: "p2" },
      memorySize: 512,
      timeout: Duration.seconds(45),
    });

    const vectors = new AppTheoryVectorIndex(this, "Vectors", {
      indexName: "semantic",
      dimension: 1024,
      nonFilterableMetadataKeys: ["content"],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    vectors.bindEnvironment(handler.fn, { includeEmbedding: true, embeddingModelId: titanTextEmbeddingModelId });
    vectors.grantQuery(handler.fn);
    vectors.grantWriteVectors(handler.fn);
    vectors.grantBedrockInvokeModel(handler.fn, this.foundationModelArn(titanTextEmbeddingModelId));

    const api = new AppTheoryHttpApi(this, "Api", {
      handler: handler.fn,
      apiName: "apptheory-s3-vectors-semantic-search",
      cors: true,
      stage: {
        accessLogging: true,
        throttlingRateLimit: 5,
        throttlingBurstLimit: 10,
      },
    });

    new CfnOutput(this, "ApiUrl", { value: api.api.apiEndpoint });
    new CfnOutput(this, "VectorBucketName", { value: vectors.vectorBucketName });
    new CfnOutput(this, "VectorIndexName", { value: vectors.indexName });
    new CfnOutput(this, "SeedCommand", { value: `curl -s -X POST ${api.api.apiEndpoint}/seed` });
    new CfnOutput(this, "SearchCommand", {
      value: `curl -s '${api.api.apiEndpoint}/search?q=middleware%20ordering'`,
    });
  }

  private foundationModelArn(modelId: string): string {
    return Stack.of(this).formatArn({
      service: "bedrock",
      account: "",
      resource: "foundation-model",
      resourceName: modelId,
    });
  }
}
