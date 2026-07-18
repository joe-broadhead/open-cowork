#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const inboxId = process.argv[2];
if (!inboxId || inboxId === "--root") {
  console.error("Usage: openwiki_inbox_process <inbox-id> [--root <path>] [--actor actor:id] [--dry-run]");
  process.exit(2);
}

const rootIndex = process.argv.indexOf("--root");
const rootArgs = rootIndex >= 0 && process.argv[rootIndex + 1] ? ["--root", process.argv[rootIndex + 1]] : [];
const passThrough = process.argv.slice(3).filter((value, index, values) => {
  if (value === "--root") {
    return false;
  }
  return index === 0 || values[index - 1] !== "--root";
});
const result = spawnSync("openwiki", [...rootArgs, "inbox", "process", inboxId, "--json", ...passThrough], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
