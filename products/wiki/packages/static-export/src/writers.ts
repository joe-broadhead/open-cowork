
import { promises as fs } from "node:fs";
import path from "node:path";

export async function writeFile(outDir: string, files: string[], relativePath: string, value: unknown): Promise<void> {
  const target = path.join(outDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const content = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(target, content);
  files.push(relativePath);
}

export async function writeJsonl(outDir: string, files: string[], relativePath: string, records: unknown[]): Promise<void> {
  await writeFile(outDir, files, relativePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}
