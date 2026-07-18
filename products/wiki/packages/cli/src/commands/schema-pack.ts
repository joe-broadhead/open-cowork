import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_OPENWIKI_SCHEMA_PACK,
  bundledOpenWikiSchemaPacks,
  explainOpenWikiSchemaPackResolution,
  parseOpenWikiSchemaPackYaml,
  renderOpenWikiSchemaPackYaml,
  validateOpenWikiSchemaPackYaml,
  type OpenWikiSchemaPack,
} from "@openwiki/skills";
import { loadRepository } from "@openwiki/repo";
import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import { exists, resolveRoot } from "../utils.ts";

export async function schemaPackCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, first] = args;
  if (subcommand === "list") {
    const packs = bundledOpenWikiSchemaPacks().map(packSummary);
    if (options.json) {
      printJson({ schema_packs: packs });
      return;
    }
    for (const pack of packs) {
      console.log(`${pack.name} ${pack.version} ${pack.description}`);
    }
    return;
  }
  if (subcommand === "validate") {
    const target = first ?? options.schemaPack;
    const result = await validateSchemaPackTarget(target);
    if (!result.ok) {
      process.exitCode = 1;
    }
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(result.ok ? `valid ${result.pack.name} ${result.pack.version}` : `invalid ${result.errors.join("; ")}`);
    return;
  }
  if (subcommand === "explain") {
    const repoConfig = await repoConfigForSchemaPackExplain(options);
    const resolution = explainOpenWikiSchemaPackResolution({
      env: process.env,
      ...(options.schemaPack === undefined ? {} : { cliPath: options.schemaPack }),
      ...(repoConfig === undefined ? {} : { repoConfig }),
      ...(repoConfig?.runtime?.profile === undefined ? {} : { workspaceProfile: repoConfig.runtime.profile }),
    });
    if (options.json) {
      printJson(resolution);
      return;
    }
    console.log(`selected ${resolution.selected.source}${resolution.selected.reference === undefined ? "" : " " + resolution.selected.reference}`);
    for (const step of resolution.order) {
      console.log(`${step.active ? "*" : "-"} ${step.source}${step.reference === undefined ? "" : " " + step.reference}`);
    }
    return;
  }
  if (subcommand === "scaffold") {
    const name = first ?? "openwiki-custom";
    const pack: OpenWikiSchemaPack = { ...DEFAULT_OPENWIKI_SCHEMA_PACK, name };
    const outDir = path.resolve(options.outDir ?? ".");
    await mkdir(outDir, { recursive: true });
    const filePath = path.join(outDir, "schema-pack.yaml");
    if (!options.force && await exists(filePath)) {
      throw new Error(`Refusing to overwrite existing schema pack: ${filePath}. Pass --force to replace it.`);
    }
    await writeFile(filePath, renderOpenWikiSchemaPackYaml(pack), "utf8");
    const result = { path: filePath, pack: packSummary(pack) };
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Wrote ${filePath}`);
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] schema-pack list|validate [path]|explain [--schema-pack path-or-name]|scaffold [name] [--out-dir folder] [--force] [--json]");
}

async function validateSchemaPackTarget(target: string | undefined): Promise<{ ok: true; pack: OpenWikiSchemaPack } | { ok: false; errors: string[] }> {
  if (target === undefined || target === DEFAULT_OPENWIKI_SCHEMA_PACK.name) {
    const rendered = renderOpenWikiSchemaPackYaml(DEFAULT_OPENWIKI_SCHEMA_PACK);
    return validateOpenWikiSchemaPackYaml(rendered, DEFAULT_OPENWIKI_SCHEMA_PACK.name);
  }
  const bundled = bundledOpenWikiSchemaPacks().find((pack) => pack.name === target);
  if (bundled !== undefined) {
    return validateOpenWikiSchemaPackYaml(renderOpenWikiSchemaPackYaml(bundled), bundled.name);
  }
  const sourcePath = path.resolve(target);
  const yaml = await readFile(sourcePath, "utf8");
  const validated = validateOpenWikiSchemaPackYaml(yaml, sourcePath);
  if (!validated.ok) {
    return validated;
  }
  return { ok: true, pack: parseOpenWikiSchemaPackYaml(yaml, sourcePath) };
}

async function repoConfigForSchemaPackExplain(options: CliOptions): Promise<Awaited<ReturnType<typeof loadRepository>>["config"] | undefined> {
  try {
    return (await loadRepository(await resolveRoot(options))).config;
  } catch {
    return undefined;
  }
}

function packSummary(pack: OpenWikiSchemaPack): { name: string; version: string; description: string; api_version: string; record_template_count: number; allowed_edge_types: string[] } {
  return {
    name: pack.name,
    version: pack.version,
    description: pack.description,
    api_version: pack.api_version,
    record_template_count: pack.record_templates.length,
    allowed_edge_types: pack.allowed_edge_types,
  };
}
