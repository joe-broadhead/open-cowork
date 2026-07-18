import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { printJson } from "../output.ts";
import { exists } from "../utils.ts";
import { cliVersionReport, readCliBuildMetadata } from "./version.ts";

type SelfCheckStatus = "pass" | "warn" | "fail";

interface SelfCheck {
  name: string;
  status: SelfCheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

interface SelfCheckReport {
  command: "self-check";
  status: SelfCheckStatus;
  distribution_mode: "package" | "source";
  package_root: string;
  checks: SelfCheck[];
}

export async function selfCheckCommand(options: { json: boolean }): Promise<void> {
  const report = await selfCheckReport();
  if (options.json) {
    printJson(report);
  } else {
    console.log(`OpenWiki self-check: ${report.status}`);
    console.log(`Distribution mode: ${report.distribution_mode}`);
    for (const check of report.checks) {
      console.log(`${check.status.toUpperCase().padEnd(4)} ${check.name} - ${check.message}`);
    }
  }
  if (report.status === "fail") {
    process.exitCode = 1;
  }
}

async function selfCheckReport(): Promise<SelfCheckReport> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const sourceRoot = path.resolve(moduleDir, "../../../..");
  const packageMode = await exists(path.join(moduleDir, "package.json"));
  const distributionMode = packageMode ? "package" : "source";
  const packageRoot = packageMode ? moduleDir : sourceRoot;
  const checks = [
    await binaryCheck(moduleDir, sourceRoot, distributionMode),
    await versionCheck(),
    await buildMetadataCheck(distributionMode),
    await licenseCheck(packageRoot, sourceRoot, distributionMode),
    await webAssetCheck(packageRoot, sourceRoot, distributionMode),
    await integrationCheck(packageRoot, sourceRoot, distributionMode),
    await schemasCheck(packageRoot, sourceRoot, distributionMode),
    await templatesCheck(packageRoot, sourceRoot, distributionMode),
    await referenceDocsCheck(packageRoot, sourceRoot, distributionMode),
  ];
  return {
    command: "self-check",
    status: summarizeSelfChecks(checks),
    distribution_mode: distributionMode,
    package_root: packageRoot,
    checks,
  };
}

async function binaryCheck(moduleDir: string, sourceRoot: string, mode: "package" | "source"): Promise<SelfCheck> {
  const binary = mode === "package" ? path.join(moduleDir, "openwiki.js") : path.join(sourceRoot, "packages", "cli", "src", "main.ts");
  return await requiredPathCheck("binary", binary, "OpenWiki CLI entrypoint is present.");
}

async function versionCheck(): Promise<SelfCheck> {
  const report = await cliVersionReport(false);
  return {
    name: "version",
    status: report.node.supported && report.git.available ? "pass" : "warn",
    message: `OpenWiki ${report.version}; Node ${report.node.version}; Git ${report.git.version ?? "unavailable"}.`,
    details: {
      version: report.version,
      node: report.node,
      git: report.git,
      warnings: report.compatibility.warnings,
    },
  };
}

async function buildMetadataCheck(mode: "package" | "source"): Promise<SelfCheck> {
  const metadata = await readCliBuildMetadata();
  if (metadata !== undefined) {
    return { name: "build-metadata", status: "pass", message: "Packaged CLI build metadata is present.", details: { metadata } };
  }
  return {
    name: "build-metadata",
    status: mode === "package" ? "fail" : "warn",
    message: mode === "package" ? "Packaged CLI build metadata is missing." : "Source checkout has no packaged build metadata.",
  };
}

async function licenseCheck(packageRoot: string, sourceRoot: string, mode: "package" | "source"): Promise<SelfCheck> {
  const license = mode === "package" ? path.join(packageRoot, "LICENSE") : path.join(sourceRoot, "LICENSE");
  return await requiredPathCheck("license", license, "Package license file is present.");
}

async function webAssetCheck(packageRoot: string, sourceRoot: string, mode: "package" | "source"): Promise<SelfCheck> {
  const assetRoot = mode === "package" ? path.join(packageRoot, "assets") : path.join(sourceRoot, "packages", "web", "assets");
  const manifestPath = path.join(assetRoot, "assets-manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { css?: unknown; js?: unknown };
    if (typeof manifest.css !== "string" || typeof manifest.js !== "string") {
      return { name: "web-assets", status: "fail", message: "Web asset manifest is missing css/js entries.", details: { path: manifestPath } };
    }
    const missing = [];
    for (const file of [manifest.css, manifest.js, "graph/index.js", "theme.js"]) {
      if (!(await exists(path.join(assetRoot, file)))) {
        missing.push(file);
      }
    }
    if (missing.length > 0) {
      return { name: "web-assets", status: "fail", message: `Packaged web assets are missing: ${missing.join(", ")}`, details: { path: assetRoot, missing } };
    }
    return { name: "web-assets", status: "pass", message: "Web assets and manifest are present.", details: { path: assetRoot } };
  } catch (error: unknown) {
    return { name: "web-assets", status: "fail", message: "Web asset manifest could not be read.", details: { path: manifestPath, error: error instanceof Error ? error.message : String(error) } };
  }
}

async function integrationCheck(packageRoot: string, sourceRoot: string, mode: "package" | "source"): Promise<SelfCheck> {
  const root = mode === "package" ? path.join(packageRoot, "integrations", "opencode") : path.join(sourceRoot, "integrations", "opencode");
  const required = ["opencode.json", "AGENTS.md", "agents/openwiki-editor.md", "skills/openwiki-edit/SKILL.md"];
  return await requiredFilesCheck("integrations", root, required, "OpenCode integration pack is present.");
}

async function schemasCheck(packageRoot: string, sourceRoot: string, mode: "package" | "source"): Promise<SelfCheck> {
  const root = mode === "package" ? path.join(packageRoot, "schemas", "openwiki", "v0") : path.join(sourceRoot, "schemas", "openwiki", "v0");
  return await requiredFilesCheck("schemas", root, ["openwiki.schema.json", "page.schema.json", "source.schema.json"], "Protocol schema files are present.");
}

async function templatesCheck(packageRoot: string, sourceRoot: string, mode: "package" | "source"): Promise<SelfCheck> {
  const root = mode === "package" ? path.join(packageRoot, "templates") : path.join(sourceRoot, "templates");
  return await requiredFilesCheck("templates", root, ["team-wiki/README.md", "personal-wiki/README.md", "public-encyclopedia/README.md"], "Workspace template reference files are present.");
}

async function referenceDocsCheck(packageRoot: string, sourceRoot: string, mode: "package" | "source"): Promise<SelfCheck> {
  const root = mode === "package" ? path.join(packageRoot, "reference") : path.join(sourceRoot, "docs", "reference");
  return await requiredFilesCheck("reference-docs", root, ["cli.md", "mcp-tools.md", "distribution.md"], "Generated reference docs are present.");
}

async function requiredPathCheck(name: string, filePath: string, message: string): Promise<SelfCheck> {
  if (await exists(filePath)) {
    return { name, status: "pass", message, details: { path: filePath } };
  }
  return { name, status: "fail", message: `Missing required path: ${filePath}`, details: { path: filePath } };
}

async function requiredFilesCheck(name: string, root: string, files: string[], message: string): Promise<SelfCheck> {
  const missing = [];
  for (const file of files) {
    if (!(await exists(path.join(root, file)))) {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    return { name, status: "fail", message: `Missing required ${name} files: ${missing.join(", ")}`, details: { root, missing } };
  }
  const entries = await readdir(root).catch(() => []);
  return { name, status: "pass", message, details: { root, entries: entries.length } };
}

function summarizeSelfChecks(checks: SelfCheck[]): SelfCheckStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (checks.some((check) => check.status === "warn")) {
    return "warn";
  }
  return "pass";
}
