import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

function usage() {
  // eslint-disable-next-line no-console
  console.error(
    [
      "Usage:",
      "  node scripts/generate-assets-manifest.mjs [--assets-dir assets] [--out assets/manifest.json]",
      "",
      "Notes:",
      "  - Walks the assets directory recursively.",
      "  - Produces deterministic output (sorted paths, stable JSON).",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const out = { assetsDir: "assets", outFile: "assets/manifest.json" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--assets-dir") {
      out.assetsDir = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (arg === "--out") {
      out.outFile = String(argv[i + 1] ?? "");
      i += 1;
      continue;
    }
  }
  return out;
}

function toPosixPath(p) {
  return p.split(path.sep).join("/");
}

async function walkFiles(rootDir, dir, out, ignoreRelPaths) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(rootDir, abs, out, ignoreRelPaths);
      continue;
    }
    if (!entry.isFile()) continue;

    const rel = toPosixPath(path.relative(rootDir, abs));
    if (ignoreRelPaths.has(rel)) continue;

    const data = await fs.readFile(abs);
    const sha256 = createHash("sha256").update(data).digest("hex");
    out.push({ path: rel, sha256, bytes: data.length });
  }
}

async function main() {
  const { assetsDir, outFile } = parseArgs(process.argv.slice(2));
  const absAssetsDir = path.resolve(process.cwd(), assetsDir);
  const absOutFile = path.resolve(process.cwd(), outFile);

  const stats = await fs.stat(absAssetsDir).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    // eslint-disable-next-line no-console
    console.error(`assets dir not found: ${absAssetsDir}`);
    process.exit(1);
  }

  const ignore = new Set();
  if (absOutFile.startsWith(absAssetsDir + path.sep)) {
    ignore.add(toPosixPath(path.relative(absAssetsDir, absOutFile)));
  }

  const files = [];
  await walkFiles(absAssetsDir, absAssetsDir, files, ignore);
  files.sort((a, b) => String(a.path).localeCompare(String(b.path)));

  const manifest = { version: 1, files };
  await fs.mkdir(path.dirname(absOutFile), { recursive: true });
  await fs.writeFile(absOutFile, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  // eslint-disable-next-line no-console
  console.log(`wrote ${files.length} entries to ${outFile}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  process.exit(1);
});
