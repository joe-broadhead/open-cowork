import path from "node:path";

export function defaultIndexStorePath(root: string): string {
  return path.join(path.resolve(root), ".openwiki", "index-store", "openwiki.sqlite");
}
