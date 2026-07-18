import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { OPENWIKI_ERROR_MODEL } from "@openwiki/core";
import { commandHelpText } from "../packages/cli/src/output.ts";
import { handleMcpRequest, type McpToolMode } from "@openwiki/mcp-server";

const execFileAsync = promisify(execFile);

test("generated reference docs are checked in and current", async () => {
  await execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", "scripts/openwiki-generate-reference-docs.mjs", "--check"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });
});

test("CLI reference covers every command visible in openwiki help", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", "packages/cli/src/main.ts", "--help"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });
  const cliReference = await readFile(path.join(process.cwd(), "docs", "reference", "cli.md"), "utf8");
  const commands = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("openwiki "));
  assert.ok(commands.length > 40);
  for (const command of commands) {
    assert.match(cliReference, new RegExp(escapeRegExp(`- \`${command}\``)));
  }
});

test("CLI command-scoped help works without a workspace", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", "packages/cli/src/main.ts", "--help"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });
  const commands = new Set<string>();
  for (const line of stdout.split("\n").map((entry) => entry.trim()).filter((entry) => entry.startsWith("openwiki "))) {
    const command = commandForUsageLine(line);
    if (command !== undefined && !command.startsWith("-")) {
      commands.add(command);
    }
  }
  assert.ok(commands.size > 35);
  for (const command of commands) {
    const help = commandHelpText(command);
    assert.match(help, /Usage:/, `missing Usage section for ${command}`);
    assert.match(help, new RegExp(escapeRegExp("openwiki ")), `missing usage line for ${command}`);
  }
  const searchHelp = await execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", "packages/cli/src/main.ts", "search", "--help"], {
    cwd: process.cwd(),
    maxBuffer: 1024 * 1024,
  });
  assert.match(searchHelp.stdout, /OpenWiki search/);
  assert.match(searchHelp.stdout, /--mode lexical\|hybrid/);
});

function commandForUsageLine(line: string): string | undefined {
  const tokens = line.split(/\s+/).slice(1);
  while (tokens[0]?.startsWith("[") && tokens.length > 0) {
    const token = tokens.shift();
    if (token?.endsWith("]")) {
      break;
    }
    while (tokens.length > 0) {
      const optionalToken = tokens.shift();
      if (optionalToken?.endsWith("]")) {
        break;
      }
    }
  }
  return tokens[0];
}

test("MCP reference covers every tool exposed by each mode", async () => {
  const mcpReference = await readFile(path.join(process.cwd(), "docs", "reference", "mcp-tools.md"), "utf8");
  const expectedCounts: Record<McpToolMode, number> = { read: 37, proposal: 47, write: 68 };
  for (const mode of ["read", "proposal", "write"] satisfies McpToolMode[]) {
    const response = await handleMcpRequest(process.cwd(), { jsonrpc: "2.0", id: mode, method: "tools/list" }, { toolMode: mode });
    assert.ok(isRecord(response));
    assert.ok(Array.isArray(response.tools));
    assert.equal(response.tools.length, expectedCounts[mode]);
    assert.match(mcpReference, new RegExp(`\\| \`${mode}\` \\| ${response.tools.length} \\|`));
    for (const tool of response.tools) {
      assert.ok(isRecord(tool));
      assert.equal(typeof tool.name, "string");
      assert.match(mcpReference, new RegExp(escapeRegExp(`\`${tool.name}\``)));
    }
  }
});

test("schema, package, error, and compatibility references cover their inventories", async () => {
  const schemaReference = await readFile(path.join(process.cwd(), "docs", "reference", "schemas.md"), "utf8");
  const schemaFiles = (await readdir(path.join(process.cwd(), "schemas", "openwiki", "v0"))).filter((name) => name.endsWith(".schema.json"));
  assert.ok(schemaFiles.length >= 10);
  for (const schemaFile of schemaFiles) {
    const relativePath = `schemas/openwiki/v0/${schemaFile}`;
    const schema = JSON.parse(await readFile(path.join(process.cwd(), relativePath), "utf8")) as { $id?: string };
    assert.match(schemaReference, new RegExp(escapeRegExp(relativePath)));
    if (typeof schema.$id !== "string") {
      throw new Error(`Missing schema $id for ${relativePath}`);
    }
    const schemaId: string = schema.$id;
    assert.match(schemaReference, new RegExp(escapeRegExp(schemaId)));
  }
  for (const artifact of ["pages.jsonl", "search-index.json", "graph.json", "openapi.json", "mcp-manifest.json", "static-export-report.json"]) {
    assert.match(schemaReference, new RegExp(escapeRegExp(artifact)));
  }

  const packageReference = await readFile(path.join(process.cwd(), "docs", "reference", "package-apis.md"), "utf8");
  const packageDirs = await readdir(path.join(process.cwd(), "packages"));
  for (const packageDir of packageDirs) {
    const packageJsonPath = path.join(process.cwd(), "packages", packageDir, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: string };
    if (typeof packageJson.name !== "string") {
      throw new Error(`Missing package name for ${packageJsonPath}`);
    }
    const packageName: string = packageJson.name;
    assert.match(packageReference, new RegExp(escapeRegExp(packageName)));
  }
  assert.match(packageReference, /Internal workspace API/);

  const errorReference = await readFile(path.join(process.cwd(), "docs", "reference", "errors.md"), "utf8");
  for (const entry of OPENWIKI_ERROR_MODEL) {
    assert.match(errorReference, new RegExp(escapeRegExp(`\`${entry.category}\``)));
    assert.match(errorReference, new RegExp(escapeRegExp(`\`${entry.code}\``)));
  }

  const compatibilityReference = await readFile(path.join(process.cwd(), "docs", "reference", "compatibility.md"), "utf8");
  for (const channel of ["CLI", "HTTP API", "MCP", "Repository records", "Static export", "Workspace packages"]) {
    assert.match(compatibilityReference, new RegExp(escapeRegExp(channel)));
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
