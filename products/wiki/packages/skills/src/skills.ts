import {
  type OpenWikiYamlValue,
  OpenWikiYamlError,
  assertYamlKnownKeys,
  parseOpenWikiYaml,
  yamlOptionalString,
  yamlOptionalStringArray,
  yamlString,
  yamlStringArray,
} from "./yaml.ts";

export type OpenWikiSkillRiskLevel = "low" | "medium" | "high";

export interface OpenWikiSkillManifest {
  name: string;
  description: string;
  version: string;
  applies_to: string[];
  required_tools: string[];
  allowed_operations: string[];
  risk_level: OpenWikiSkillRiskLevel;
  inputs?: string[];
  outputs?: string[];
  examples?: string[];
  owner?: string;
  reviewers?: string[];
}

export interface ParsedOpenWikiSkill {
  manifest: OpenWikiSkillManifest;
  body: string;
  source_path: string;
}

const SKILL_KEYS = new Set([
  "name",
  "description",
  "version",
  "applies_to",
  "required_tools",
  "allowed_operations",
  "risk_level",
  "inputs",
  "outputs",
  "examples",
  "owner",
  "reviewers",
]);

const SKILL_RISK_LEVELS = new Set(["low", "medium", "high"]);

export class OpenWikiSkillManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenWikiSkillManifestError";
  }
}

export function parseOpenWikiSkillMarkdown(markdown: string, sourcePath = "SKILL.md"): ParsedOpenWikiSkill {
  const frontmatter = splitFrontmatter(markdown, sourcePath);
  const rawManifest = parseOpenWikiYaml(frontmatter.yaml, sourcePath);
  const manifest = openWikiSkillManifestFromYaml(rawManifest, sourcePath);
  return {
    manifest,
    body: frontmatter.body.trim(),
    source_path: sourcePath,
  };
}

export function validateOpenWikiSkillMarkdown(markdown: string, sourcePath = "SKILL.md"): { ok: true; skill: ParsedOpenWikiSkill } | { ok: false; errors: string[] } {
  try {
    return { ok: true, skill: parseOpenWikiSkillMarkdown(markdown, sourcePath) };
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, errors: [error.message] };
    }
    return { ok: false, errors: [String(error)] };
  }
}

function openWikiSkillManifestFromYaml(record: Record<string, OpenWikiYamlValue>, sourcePath: string): OpenWikiSkillManifest {
  try {
    assertYamlKnownKeys(record, SKILL_KEYS, sourcePath);
    const riskLevel = yamlString(record.risk_level, "risk_level");
    if (!SKILL_RISK_LEVELS.has(riskLevel)) {
      throw new OpenWikiYamlError("risk_level must be low, medium, or high");
    }
    const optional = {
      inputs: yamlOptionalStringArray(record.inputs, "inputs"),
      outputs: yamlOptionalStringArray(record.outputs, "outputs"),
      examples: yamlOptionalStringArray(record.examples, "examples"),
      owner: yamlOptionalString(record.owner, "owner"),
      reviewers: yamlOptionalStringArray(record.reviewers, "reviewers"),
    };
    return {
      name: yamlString(record.name, "name"),
      description: yamlString(record.description, "description"),
      version: assertSkillVersion(yamlString(record.version, "version")),
      applies_to: yamlStringArray(record.applies_to, "applies_to", { minItems: 1 }),
      required_tools: yamlStringArray(record.required_tools, "required_tools", { minItems: 1 }),
      allowed_operations: yamlStringArray(record.allowed_operations, "allowed_operations", { minItems: 1 }),
      risk_level: riskLevel as OpenWikiSkillRiskLevel,
      ...(optional.inputs === undefined ? {} : { inputs: optional.inputs }),
      ...(optional.outputs === undefined ? {} : { outputs: optional.outputs }),
      ...(optional.examples === undefined ? {} : { examples: optional.examples }),
      ...(optional.owner === undefined ? {} : { owner: optional.owner }),
      ...(optional.reviewers === undefined ? {} : { reviewers: optional.reviewers }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpenWikiSkillManifestError(`${sourcePath}: invalid OpenWiki skill manifest: ${message}`);
  }
}

function splitFrontmatter(markdown: string, sourcePath: string): { yaml: string; body: string } {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new OpenWikiSkillManifestError(`${sourcePath}: SKILL.md must start with YAML frontmatter`);
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing === -1) {
    throw new OpenWikiSkillManifestError(`${sourcePath}: SKILL.md is missing closing frontmatter marker`);
  }
  return {
    yaml: normalized.slice(4, closing),
    body: normalized.slice(closing + "\n---\n".length),
  };
}

function assertSkillVersion(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    throw new OpenWikiYamlError("version must be a semantic version such as 1.0.0");
  }
  return version;
}
