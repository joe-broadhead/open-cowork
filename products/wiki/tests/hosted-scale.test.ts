import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("hosted scale docs pin the Postgres serving, write, and operational-state assumptions", async () => {
  const operationsDocs = await readFile("docs/deployment/operations.md", "utf8");
  const monitoringDocs = await readFile("docs/deployment/operations/monitoring.md", "utf8");
  const allOperationsDocs = [operationsDocs, monitoringDocs].join("\n");
  for (const variable of [
    "OPENWIKI_READ_BACKEND",
    "OPENWIKI_SEARCH_BACKEND",
    "OPENWIKI_QUEUE_BACKEND",
    "OPENWIKI_WRITE_COORDINATOR_BACKEND",
    "OPENWIKI_OPERATIONAL_STATE_BACKEND",
    "OPENWIKI_RUNTIME_MODE",
  ]) {
    assert.match(operationsDocs, new RegExp("`" + variable + "`"));
  }
  assert.match(operationsDocs, /source-operated OpenWiki network runtime/);
  assert.match(operationsDocs, /Before adding\s+writers or replicas, use Postgres/);
  assert.match(allOperationsDocs, /Streamable HTTP MCP sessions/);
  assert.match(monitoringDocs, /rate-limit windows by workspace/);
  assert.match(monitoringDocs, /Prometheus metrics stay process-local/);
});

test("scale benchmarks enforce bounded source-runtime behavior", async () => {
  const performanceDocs = await readFile("docs/deployment/performance.md", "utf8");
  const scaleScript = await readFile("scripts/openwiki-scale-perf.mjs", "utf8");

  assert.match(performanceDocs, /Fast Blocking Gate/);
  assert.match(performanceDocs, /Larger Diagnostic Runs/);
  assert.match(performanceDocs, /machine-dependent/);
  assert.match(performanceDocs, /OPENWIKI_SCALE_ENFORCE=1/);
  assert.match(performanceDocs, /OPENWIKI_RUNTIME_MODE=hosted/);
  assert.match(performanceDocs, /disable request-path SQLite index rebuilds and full-repository\s+search fallbacks/);
  assert.match(performanceDocs, /`hosted` and `enterprise` modes/);
  assert.match(scaleScript, /"10k": 10_000/);
  assert.match(scaleScript, /MODE === "smoke"/);
});
