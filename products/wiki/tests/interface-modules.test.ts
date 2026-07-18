import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const INTERFACE_MODULE_ROOTS = [
  "packages/cli/src",
  "packages/mcp-server/src",
  "packages/static-export/src",
];

const TOP_LEVEL_LIMITS = new Map([
  ["packages/cli/src/main.ts", 500],
  ["packages/mcp-server/src/index.ts", 500],
  ["packages/static-export/src/index.ts", 500],
]);

test("public interface packages keep bounded module sizes", async () => {
  const oversized: string[] = [];
  for (const sourceRoot of INTERFACE_MODULE_ROOTS) {
    for (const filePath of await sourceFiles(path.join(process.cwd(), sourceRoot))) {
      const relativePath = path.relative(process.cwd(), filePath);
      const lineCount = (await readFile(filePath, "utf8")).split("\n").length;
      const limit = TOP_LEVEL_LIMITS.get(relativePath) ?? 800;
      if (lineCount > limit) {
        oversized.push(`${relativePath} has ${lineCount} lines; limit is ${limit}`);
      }
    }
  }

  assert.deepEqual(oversized, []);
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(resolved);
      }
      return entry.name.endsWith(".ts") ? [resolved] : [];
    }),
  );
  return files.flat();
}
