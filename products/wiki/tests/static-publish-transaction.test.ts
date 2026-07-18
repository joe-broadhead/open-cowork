import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { EventRecord } from "@openwiki/core";
import {
  replaceStaticExportDirectory,
  runStaticPublishTransaction,
  type StaticExportFileSystem,
} from "../packages/static-export/src/publish-transaction.ts";
import type { StaticExportResult } from "../packages/static-export/src/types.ts";

test("publish transaction preserves named double-export phases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-publish-transaction-"));
  const phases: string[] = [];
  const exportOutDirs: Array<string | undefined> = [];
  const event = publishEvent();
  try {
    const result = await runStaticPublishTransaction({ root, outDir: "public", actorId: "actor:user:publisher" }, {
      exportStaticSite: async (exportOptions) => {
        phases.push("export");
        exportOutDirs.push(exportOptions.outDir);
        return exportResult(root, phases.length === 1 ? ["index.html"] : ["events.jsonl", "index.html"], exportOptions.outDir);
      },
      loadRepository: async () => {
        phases.push("snapshot");
        return { config: { workspace_id: "workspace:test" } };
      },
      appendEvent: async (_root, input) => {
        phases.push("append");
        assert.equal(input.type, "publish.completed");
        assert.equal(input.actor_id, "actor:user:publisher");
        assert.deepEqual(input.subject_paths, ["openwiki.json"]);
        assert.equal(input.data?.out_dir, path.join(root, "public"));
        return event;
      },
    });

    assert.deepEqual(phases, ["export", "snapshot", "append", "export"]);
    assert.match(exportOutDirs[0] ?? "", /^\.public\.[^.]+\.\d+\.tmp$/);
    assert.equal(exportOutDirs[1], "public");
    assert.deepEqual(result.files, ["events.jsonl", "index.html"]);
    assert.equal(result.event, event);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish transaction stops before append when initial render fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-publish-transaction-"));
  let appendCalled = false;
  try {
    await assert.rejects(
      runStaticPublishTransaction({ root }, {
        exportStaticSite: async () => {
          throw new Error("render failed");
        },
        loadRepository: async () => ({ config: { workspace_id: "workspace:test" } }),
        appendEvent: async () => {
          appendCalled = true;
          return publishEvent();
        },
      }),
      /render failed/,
    );
    assert.equal(appendCalled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish transaction stops before final render when event append fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-publish-transaction-"));
  let exports = 0;
  const exportOutDirs: Array<string | undefined> = [];
  try {
    await assert.rejects(
      runStaticPublishTransaction({ root }, {
        exportStaticSite: async (exportOptions) => {
          exports += 1;
          exportOutDirs.push(exportOptions.outDir);
          return exportResult(root, ["index.html"], exportOptions.outDir);
        },
        loadRepository: async () => ({ config: { workspace_id: "workspace:test" } }),
        appendEvent: async () => {
          throw new Error("append failed");
        },
      }),
      /append failed/,
    );
    assert.equal(exports, 1);
    assert.match(exportOutDirs[0] ?? "", /^\.public\.[^.]+\.\d+\.tmp$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish transaction reports final render failure after event append", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-publish-transaction-"));
  let exports = 0;
  const appendedTypes: string[] = [];
  try {
    await assert.rejects(
      runStaticPublishTransaction({ root }, {
        exportStaticSite: async (exportOptions) => {
          exports += 1;
          if (exports === 2) {
            throw new Error("final render failed");
          }
          return exportResult(root, ["index.html"], exportOptions.outDir);
        },
        loadRepository: async () => ({ config: { workspace_id: "workspace:test" } }),
        appendEvent: async (_root, input) => {
          appendedTypes.push(input.type);
          if (input.type === "publish.failed") {
            assert.equal(input.record_id, "workspace:test");
            assert.equal(input.data?.completed_event_id, "event:publish");
            assert.equal(input.data?.stage, "final_export");
            assert.equal(input.data?.failure, "final_export_failed");
          }
          return publishEvent(input.type);
        },
      }),
      /final render failed/,
    );
    assert.equal(exports, 2);
    assert.deepEqual(appendedTypes, ["publish.completed", "publish.failed"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish transaction rejects invalid final output before rendering or appending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-publish-transaction-"));
  let exports = 0;
  let appended = false;
  try {
    await assert.rejects(
      runStaticPublishTransaction({ root, outDir: "wiki" }, {
        exportStaticSite: async () => {
          exports += 1;
          return exportResult(root, ["index.html"]);
        },
        loadRepository: async () => ({ config: { workspace_id: "workspace:test" } }),
        appendEvent: async () => {
          appended = true;
          return publishEvent();
        },
      }),
      /reserved workspace directory 'wiki'/,
    );
    assert.equal(exports, 0);
    assert.equal(appended, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static export replacement rolls back previous output on replacement failure", async () => {
  const calls: Array<[string, string, string?]> = [];
  const fileSystem: StaticExportFileSystem = {
    async rm(target) {
      calls.push(["rm", target]);
    },
    async rename(from, to) {
      calls.push(["rename", from, to]);
      if (from === "/tmp/export") {
        throw new Error("replace failed");
      }
    },
  };

  await assert.rejects(replaceStaticExportDirectory("/tmp/export", "/site/public", fileSystem), /replace failed/);

  assert.equal(calls[0]?.[0], "rm");
  assert.deepEqual(calls.slice(1), [
    ["rename", "/site/public", calls[0]?.[1]],
    ["rename", "/tmp/export", "/site/public"],
    ["rename", calls[0]?.[1] ?? "", "/site/public"],
  ]);
});

function exportResult(root: string, files: string[], outDir = "public"): StaticExportResult {
  return {
    root,
    outDir: path.resolve(root, outDir),
    files,
    html_mode: "full",
    html_page_count: 1,
    html_page_ceiling: 10_000,
    sitemap_files: [],
    warnings: [],
  };
}

function publishEvent(type = "publish.completed"): EventRecord {
  return {
    id: "event:publish",
    uri: "openwiki://event/publish",
    type,
    workspace_id: "workspace:test",
    occurred_at: "2026-01-01T00:00:00.000Z",
    path: "events/events.jsonl",
  };
}
