import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

type PackageJson = {
  name: string;
  private?: boolean;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const PACKAGE_LAYERS: Record<string, number> = {
  "@openwiki/core": 0,
  "@openwiki/connectors": 1,
  "@openwiki/policy": 1,
  "@openwiki/skills": 1,
  "@openwiki/storage": 1,
  "@openwiki/web": 1,
  "@openwiki/repo": 2,
  "@openwiki/git": 3,
  "@openwiki/index-store": 3,
  "@openwiki/postgres-runtime": 3,
  "@openwiki/validation": 3,
  "@openwiki/search": 4,
  "@openwiki/static-export": 5,
  "@openwiki/workflows": 5,
  "@openwiki/harness-opencode": 6,
  "@openwiki/jobs": 6,
  "@openwiki/mcp-server": 7,
  "@openwiki/http-api": 8,
  "@openwiki/cli": 9,
};

const EXTRA_NODE_BUILTINS = ["node:sqlite"];

test("workspace packages declare direct package imports", async () => {
  const packageRoot = path.join(process.cwd(), "packages");
  const packageDirs = await readdir(packageRoot, { withFileTypes: true });
  const builtinNames = nodeBuiltinNames();
  const missing: string[] = [];

  for (const entry of packageDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = path.join(packageRoot, entry.name);
    const packageJson = await readPackageJson(packageDir);
    if (packageJson === undefined) {
      continue;
    }
    const srcDir = path.join(packageDir, "src");
    const sourceFiles = await listSourceFiles(srcDir).catch(() => []);
    const declared = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {}),
    ]);
    const imports = new Set<string>();
    for (const sourceFile of sourceFiles) {
      for (const specifier of importSpecifiers(await readFile(sourceFile, "utf8"))) {
        if (specifier.startsWith(".") || builtinNames.has(specifier)) {
          continue;
        }
        imports.add(packageNameFromSpecifier(specifier));
      }
    }
    for (const imported of imports) {
      if (imported !== packageJson.name && !declared.has(imported)) {
        missing.push(`${packageJson.name} imports ${imported}`);
      }
    }
  }

  assert.deepEqual(missing.sort(), []);
});

test("workspace packages keep documented public/internal dependency boundaries", async () => {
  const packageRoot = path.join(process.cwd(), "packages");
  const packageDirs = await readdir(packageRoot, { withFileTypes: true });
  const builtinNames = nodeBuiltinNames();
  const violations: string[] = [];

  for (const entry of packageDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = path.join(packageRoot, entry.name);
    const packageJson = await readPackageJson(packageDir);
    if (packageJson === undefined) {
      continue;
    }
    const importerLayer = PACKAGE_LAYERS[packageJson.name];
    if (importerLayer === undefined) {
      violations.push(`${packageJson.name} is missing from PACKAGE_LAYERS`);
      continue;
    }
    if (packageJson.private !== true) {
      violations.push(`${packageJson.name} must stay private; product contracts are CLI/HTTP/MCP/schemas/static export`);
    }
    if (typeof packageJson.exports === "object" && packageJson.exports !== null) {
      violations.push(`${packageJson.name} must not expose package subpaths while workspace APIs are internal`);
    }

    const sourceFiles = await listSourceFiles(path.join(packageDir, "src")).catch(() => []);
    for (const sourceFile of sourceFiles) {
      for (const specifier of importSpecifiers(await readFile(sourceFile, "utf8"))) {
        if (specifier.startsWith(".") || builtinNames.has(specifier)) {
          continue;
        }
        const imported = packageNameFromSpecifier(specifier);
        if (!imported.startsWith("@openwiki/")) {
          continue;
        }
        const importedLayer = PACKAGE_LAYERS[imported];
        if (importedLayer === undefined) {
          violations.push(`${packageJson.name} imports undocumented workspace package ${imported}`);
          continue;
        }
        if (importedLayer >= importerLayer) {
          violations.push(`${packageJson.name} layer ${importerLayer} imports ${imported} layer ${importedLayer}`);
        }
      }
    }
  }

  assert.deepEqual(violations.sort(), []);
});

test("root runtime dependencies stay limited to source-run launcher requirements", async () => {
  const rootPackage = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as PackageJson;
  assert.deepEqual(
    Object.keys(rootPackage.dependencies ?? {}).sort(),
    ["tsx"],
    "Root production dependencies are installed into Docker after prune; add package runtime deps to the importing workspace package instead.",
  );
});

async function readPackageJson(packageDir: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as PackageJson;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function nodeBuiltinNames(): Set<string> {
  return new Set([...builtinModules.flatMap((name) => [name, "node:" + name]), ...EXTRA_NODE_BUILTINS]);
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listSourceFiles(resolved);
      }
      return /\.(?:ts|tsx|mts|cts)$/.test(entry.name) ? [resolved] : [];
    }),
  );
  return files.flat();
}

function importSpecifiers(source: string): string[] {
  const imports: string[] = [];
  const pattern = /from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const specifier = match[1] ?? match[2];
    if (specifier) {
      imports.push(specifier);
    }
  }
  return imports;
}

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return [scope, name].filter(Boolean).join("/");
  }
  return specifier.split("/")[0] ?? specifier;
}
