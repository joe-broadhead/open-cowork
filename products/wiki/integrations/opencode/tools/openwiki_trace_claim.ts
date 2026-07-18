#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const claimId = process.argv[2];
if (!claimId) {
  console.error("Usage: openwiki_trace_claim <claim-id> [--root <path>]");
  process.exit(2);
}

const rootIndex = process.argv.indexOf("--root");
const rootArgs = rootIndex >= 0 && process.argv[rootIndex + 1] ? ["--root", process.argv[rootIndex + 1]] : [];
const result = spawnSync("openwiki", [...rootArgs, "claim", "trace", claimId, "--json"], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
