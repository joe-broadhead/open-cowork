import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../../..");
const cliRoot = path.join(root, "packages", "cli");
const dist = path.join(cliRoot, "dist");
const rootPackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const execFileAsync = promisify(execFile);

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });

await build({
  entryPoints: [path.join(cliRoot, "src", "main.ts")],
  outfile: path.join(dist, "openwiki.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.22",
  sourcemap: true,
  sourcesContent: false,
  legalComments: "none",
});

await fs.chmod(path.join(dist, "openwiki.js"), 0o755);
const binaryPath = path.join(dist, "openwiki.js");
const binary = await fs.readFile(binaryPath, "utf8");
await fs.writeFile(binaryPath, binary.replace(/^#!\/usr\/bin\/env node/, "#!/usr/bin/env -S node --no-warnings"));
await fs.chmod(binaryPath, 0o755);
await copyPackagedWebAssets(path.join(root, "packages", "web", "assets"), path.join(dist, "assets"));
await fs.cp(path.join(root, "integrations", "opencode"), path.join(dist, "integrations", "opencode"), { recursive: true });
await fs.cp(path.join(root, "schemas"), path.join(dist, "schemas"), { recursive: true });
await fs.cp(path.join(root, "templates"), path.join(dist, "templates"), { recursive: true });
await fs.cp(path.join(root, "docs", "reference"), path.join(dist, "reference"), { recursive: true });
await fs.copyFile(path.join(root, "LICENSE"), path.join(dist, "LICENSE"));

const gitCommit = await execFileAsync("git", ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=user", "rev-parse", "HEAD"], {
  cwd: root,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
})
  .then(({ stdout }) => stdout.trim())
  .catch(() => undefined);
const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH === undefined ? undefined : Number(process.env.SOURCE_DATE_EPOCH);
const builtAt = sourceDateEpoch === undefined || !Number.isFinite(sourceDateEpoch)
  ? new Date().toISOString()
  : new Date(Math.trunc(sourceDateEpoch) * 1000).toISOString();
await fs.writeFile(
  path.join(dist, "build-metadata.json"),
  JSON.stringify(
    {
      package: "@openwiki/cli",
      version: rootPackage.version,
      built_at: builtAt,
      node_target: "node22.22",
      source: "generated-cli",
      ...(gitCommit === undefined || gitCommit.length === 0 ? {} : { git_commit: gitCommit }),
    },
    null,
    2,
  ) + "\n",
);

await fs.writeFile(path.join(dist, "openwiki.d.ts"), "export {};\n");
await fs.writeFile(
  path.join(dist, "README.md"),
  [
    "# @openwiki/cli",
    "",
    "Installable OpenWiki command-line interface for local wikis, MCP stdio, setup, diagnostics, and deployment preflight checks.",
    "",
    "```sh",
    `npm install -g @openwiki/cli@${rootPackage.version}`,
    "openwiki --version",
    "openwiki doctor",
    "openwiki setup personal ./wiki --agent opencode --tools proposal",
    "```",
    "",
  ].join("\n"),
);

await fs.writeFile(
  path.join(dist, "package.json"),
  JSON.stringify(
    {
      name: "@openwiki/cli",
      version: rootPackage.version,
      description: "OpenWiki CLI for versioned, permissioned knowledge bases and MCP agent access.",
      type: "module",
      license: rootPackage.license,
      homepage: rootPackage.homepage,
      repository: rootPackage.repository,
      bugs: rootPackage.bugs,
      keywords: ["openwiki", "wiki", "mcp", "agents", "knowledge-base"],
      bin: {
        openwiki: "./openwiki.js",
        "cowork-wiki": "./openwiki.js",
      },
      types: "./openwiki.d.ts",
      files: [
        "openwiki.js",
        "openwiki.js.map",
        "openwiki.d.ts",
        "README.md",
        "LICENSE",
        "build-metadata.json",
        "assets",
        "integrations",
        "schemas",
        "templates",
        "reference",
        "package.json",
      ],
      engines: rootPackage.engines,
      publishConfig: {
        provenance: true,
        access: "public",
      },
    },
    null,
    2,
  ) + "\n",
);

console.log(`Built @openwiki/cli package at ${dist}`);

async function copyPackagedWebAssets(sourceDir, targetDir) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await copyPackagedWebAssetsOnce(sourceDir, targetDir);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

async function copyPackagedWebAssetsOnce(sourceDir, targetDir) {
  const manifest = await readPackagedWebAssetManifest(sourceDir);
  const currentHashedAssets = new Set([manifest.css, manifest.js]);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  for (const file of await listAssetFiles(sourceDir)) {
    if (file === "assets-manifest.json" || shouldSkipPackagedWebAsset(file, currentHashedAssets)) {
      continue;
    }
    const source = path.join(sourceDir, file);
    const target = path.join(targetDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  await fs.writeFile(path.join(targetDir, "assets-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function readPackagedWebAssetManifest(sourceDir) {
  const manifest = JSON.parse(await fs.readFile(path.join(sourceDir, "assets-manifest.json"), "utf8"));
  if (typeof manifest.css !== "string" || typeof manifest.js !== "string") {
    throw new Error("Expected web asset manifest css and js entries");
  }
  await Promise.all([
    fs.access(path.join(sourceDir, manifest.css)),
    fs.access(path.join(sourceDir, manifest.js)),
  ]);
  return manifest;
}

function shouldSkipPackagedWebAsset(file, currentHashedAssets) {
  return (/^openwiki\.[0-9a-f]{10}\.(?:css|js)$/.test(file) && !currentHashedAssets.has(file)) ||
    /^assets-manifest\.json\..+\.tmp$/.test(file);
}

async function listAssetFiles(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listAssetFiles(fullPath, baseDir));
    } else if (entry.isFile()) {
      files.push(path.relative(baseDir, fullPath));
    }
  }
  return files.sort();
}
