#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const rootIndex = process.argv.indexOf("--root");
const rootArgs = rootIndex >= 0 && process.argv[rootIndex + 1] ? ["--root", process.argv[rootIndex + 1]] : [];
const passThrough = process.argv.slice(2).filter((value, index, values) => {
  if (value === "--root") {
    return false;
  }
  return index === 0 || values[index - 1] !== "--root";
});
const result = spawnSync("openwiki", [...rootArgs, "inbox", "list", "--json", ...passThrough], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
