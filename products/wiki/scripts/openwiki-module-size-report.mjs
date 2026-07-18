#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
const HARD_LIMIT = 800;
const WARN_LIMIT = 500;

const DOCUMENTED_EXCEPTIONS = new Map([
  ["tests/adapters-http-readiness.test.ts", "Broad HTTP API smoke surface kept together until route-fixture helpers land."],
  ["scripts/openwiki-opencode-tool-evals.mjs", "End-to-end OpenCode eval runner kept together until eval helper modules land."],
]);

const SCOPES = [
  { name: "production source", roots: ["packages"], include: (file) => file.includes("/src/") },
  { name: "tests", roots: ["tests"], include: () => true },
  { name: "scripts", roots: ["scripts"], include: () => true },
];

const EXTENSIONS = new Set([".ts", ".js", ".mjs"]);

async function main() {
  const rows = [];
  for (const scope of SCOPES) {
    for (const root of scope.roots) {
      const rootPath = path.join(REPO_ROOT, root);
      for (const file of await listFiles(rootPath)) {
        const relative = toRepoPath(file);
        if (!EXTENSIONS.has(path.extname(file)) || !scope.include(relative)) {
          continue;
        }
        const loc = lineCount(await readFile(file, "utf8"));
        if (loc > WARN_LIMIT) {
          rows.push({
            scope: scope.name,
            path: relative,
            loc,
            status: DOCUMENTED_EXCEPTIONS.has(relative) ? "documented exception" : loc > HARD_LIMIT ? "needs split" : "watch",
          });
        }
      }
    }
  }

  rows.sort((left, right) => right.loc - left.loc || left.path.localeCompare(right.path));
  if (rows.length === 0) {
    console.log("No OpenWiki modules exceed " + WARN_LIMIT + " LOC.");
    return;
  }
  console.log("OpenWiki module size report");
  console.log("warning threshold: " + WARN_LIMIT + " LOC; hard threshold: " + HARD_LIMIT + " LOC");
  for (const row of rows) {
    console.log(`${String(row.loc).padStart(5)}  ${row.status.padEnd(20)}  ${row.scope.padEnd(18)}  ${row.path}`);
  }
  const blockers = rows.filter((row) => row.loc > HARD_LIMIT && !DOCUMENTED_EXCEPTIONS.has(row.path));
  if (CHECK && blockers.length > 0) {
    throw new Error("Undocumented modules exceed " + HARD_LIMIT + " LOC: " + blockers.map((row) => row.path).join(", "));
  }
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "assets") {
        return [];
      }
      return listFiles(entryPath);
    }
    return entry.isFile() ? [entryPath] : [];
  }));
  return nested.flat();
}

function lineCount(text) {
  if (text.length === 0) {
    return 0;
  }
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function toRepoPath(file) {
  return path.relative(REPO_ROOT, file).replace(/\\/g, "/");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
