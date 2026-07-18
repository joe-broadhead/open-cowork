#!/usr/bin/env node
import { execFile } from "node:child_process";
import { gzipSync } from "node:zlib";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await fs.readFile(path.join(root, "assets", "assets-manifest.json"), "utf8"));
const ASSET_JAVASCRIPT_BUDGET_BYTES = 80 * 1024;
const budgets = [
  { file: manifest.js, max: 120 * 1024, label: "JavaScript" },
  { file: manifest.css, max: 40 * 1024, label: "CSS" },
];

async function listJavaScriptFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listJavaScriptFiles(fullPath);
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
        return [fullPath];
      }
      return [];
    }),
  );
  return files.flat().sort();
}

async function syntaxCheckJavaScript(filePath) {
  try {
    await execFileAsync(process.execPath, ["--check", filePath]);
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    console.error(`JavaScript failed syntax check (${path.relative(root, filePath)}): ${stderr || (error instanceof Error ? error.message : String(error))}`);
    failed = true;
  }
}

let failed = false;
const syntaxChecked = new Set();
for (const budget of budgets) {
  const budgetPath = path.join(root, "assets", budget.file);
  const content = await fs.readFile(budgetPath);
  if (budget.file.endsWith(".js")) {
    await syntaxCheckJavaScript(budgetPath);
    syntaxChecked.add(budgetPath);
  }
  const gzipBytes = gzipSync(content).byteLength;
  console.log(`${budget.label}: ${gzipBytes} gzip bytes (${budget.file})`);
  if (gzipBytes > budget.max) {
    console.error(`${budget.label} exceeds budget ${budget.max} gzip bytes`);
    failed = true;
  }
}
const clientJavaScriptFiles = await listJavaScriptFiles(path.join(root, "src", "client"));
const assetJavaScriptFiles = await listJavaScriptFiles(path.join(root, "assets"));
for (const filePath of [...clientJavaScriptFiles, ...assetJavaScriptFiles]) {
  if (!syntaxChecked.has(filePath)) {
    await syntaxCheckJavaScript(filePath);
    syntaxChecked.add(filePath);
  }
}
let assetJavaScriptGzipBytes = 0;
for (const filePath of assetJavaScriptFiles) {
  assetJavaScriptGzipBytes += gzipSync(await fs.readFile(filePath)).byteLength;
}
console.log(`Total asset JavaScript: ${assetJavaScriptGzipBytes} gzip bytes (${assetJavaScriptFiles.length} files)`);
if (assetJavaScriptGzipBytes > ASSET_JAVASCRIPT_BUDGET_BYTES) {
  console.error(`Total asset JavaScript exceeds budget ${ASSET_JAVASCRIPT_BUDGET_BYTES} gzip bytes`);
  failed = true;
}
if (failed) {
  process.exitCode = 1;
}
