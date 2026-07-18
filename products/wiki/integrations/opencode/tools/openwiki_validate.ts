#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const rootIndex = process.argv.indexOf("--root");
const rootArgs = rootIndex >= 0 && process.argv[rootIndex + 1] ? ["--root", process.argv[rootIndex + 1]] : [];
const result = spawnSync("openwiki", [...rootArgs, "index", "--json"], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
