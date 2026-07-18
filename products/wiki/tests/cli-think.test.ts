import { createWorkspace } from "@openwiki/repo";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("CLI think JSON includes retrieval diagnostics by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-think-"));
  try {
    await createWorkspace(root, "CLI Think Wiki");
    await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
    await writeFile(
      path.join(root, "wiki", "concepts", "diagnostics.md"),
      [
        "---",
        "id: page:concept:cli-think-diagnostics",
        "title: CLI Think Diagnostics",
        "type: concept",
        "summary: CLI diagnostics token fixture",
        "topics:",
        "  - diagnostics",
        "status: draft",
        "created_at: 2026-06-13T00:00:00.000Z",
        "updated_at: 2026-06-13T00:00:00.000Z",
        "---",
        "",
        "# CLI Think Diagnostics",
        "",
        "The cli-diagnostics-token record proves the think command reports retrieval diagnostics.",
      ].join("\n"),
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "think",
        "where is cli diagnostics token stored?",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const parsed = JSON.parse(stdout) as {
      diagnostics?: { retrieval?: { retrievers_used?: string[] } };
      search?: { explain?: { retrievers_used?: string[] } };
    };
    assert.ok((parsed.search?.explain?.retrievers_used?.length ?? 0) > 0);
    assert.ok((parsed.diagnostics?.retrieval?.retrievers_used?.length ?? 0) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
