import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

test("generated CLI package installs outside the monorepo", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-package-"));
  try {
    const tarballPath = await resolveCliPackageTarball(temp);
    const tarListing = (await execFileAsync("tar", ["-tzf", tarballPath], { cwd: ROOT, maxBuffer: 1024 * 1024 * 16 })).stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    for (const expected of [
      "package/openwiki.js",
      "package/openwiki.d.ts",
      "package/LICENSE",
      "package/build-metadata.json",
      "package/assets/assets-manifest.json",
      "package/integrations/opencode/opencode.json",
      "package/schemas/openwiki/v0/openwiki.schema.json",
      "package/templates/team-wiki/README.md",
      "package/reference/cli.md",
      "package/package.json",
    ]) {
      assert.ok(tarListing.includes(expected), `missing packed CLI entry ${expected}`);
    }
    for (const forbidden of [/node_modules\//, /(?:^|\/)\.openwiki\//, /\.sqlite$/, /(?:^|\/)\.env(?:\.|$)/, /artifacts\//]) {
      assert.equal(tarListing.some((entry) => forbidden.test(entry)), false, `packed CLI contains forbidden entry matching ${forbidden}`);
    }

    await execFileAsync("node", ["scripts/openwiki-packaged-cli-smoke.mjs", tarballPath], { cwd: ROOT, maxBuffer: 1024 * 1024 * 16 });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

async function resolveCliPackageTarball(temp: string): Promise<string> {
  const provided = process.env.OPENWIKI_CLI_PACKAGE_TARBALL?.trim();
  if (provided) {
    const tarballPath = path.resolve(provided);
    await access(tarballPath);
    assert.match(path.basename(tarballPath), /\.tgz$/);
    return tarballPath;
  }
  await execFileAsync("pnpm", ["build:cli"], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  const packDir = path.join(temp, "packs");
  await mkdir(packDir);
  await execFileAsync("npm", ["pack", "./packages/cli/dist", "--pack-destination", packDir], { cwd: ROOT, maxBuffer: 1024 * 1024 });
  const tarball = (await readdir(packDir)).find((entry) => entry.endsWith(".tgz"));
  assert.ok(tarball);
  return path.join(packDir, tarball);
}
