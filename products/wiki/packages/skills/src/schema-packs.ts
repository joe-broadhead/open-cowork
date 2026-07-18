import {
  type OpenWikiYamlValue,
  OpenWikiYamlError,
  assertYamlKnownKeys,
  parseOpenWikiYaml,
  yamlObject,
  yamlString,
  yamlStringArray,
} from "./yaml.ts";

export const OPENWIKI_SCHEMA_PACK_API_VERSION = "openwiki.schema-pack.v1" as const;

export interface OpenWikiSchemaRecordTemplate {
  type: string;
  page_type?: string;
  path_template: string;
  required_frontmatter: string[];
  section_defaults?: string[];
}

export interface OpenWikiSchemaValidationRule {
  id: string;
  severity: "error" | "warning";
  description: string;
}

export interface OpenWikiSchemaPack {
  api_version: typeof OPENWIKI_SCHEMA_PACK_API_VERSION;
  name: string;
  version: string;
  description: string;
  record_templates: OpenWikiSchemaRecordTemplate[];
  required_frontmatter: Record<string, string[]>;
  topic_taxonomies: Record<string, string[]>;
  allowed_edge_types: string[];
  section_defaults: Record<string, string[]>;
  proposal_requirements: string[];
  validation_rules: OpenWikiSchemaValidationRule[];
}

export interface OpenWikiSchemaPackResolutionStep {
  source: "cli" | "env" | "repo_config" | "workspace_profile" | "bundled_default" | "none";
  reference?: string;
  active: boolean;
}

export interface OpenWikiSchemaPackResolution {
  selected: OpenWikiSchemaPackResolutionStep;
  order: OpenWikiSchemaPackResolutionStep[];
}

const PACK_KEYS = new Set([
  "api_version",
  "name",
  "version",
  "description",
  "record_templates",
  "required_frontmatter",
  "topic_taxonomies",
  "allowed_edge_types",
  "section_defaults",
  "proposal_requirements",
  "validation_rules",
]);

const RECORD_TEMPLATE_KEYS = new Set(["type", "page_type", "path_template", "required_frontmatter", "section_defaults"]);
const VALIDATION_RULE_KEYS = new Set(["id", "severity", "description"]);
const EDGE_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export const DEFAULT_OPENWIKI_SCHEMA_PACK: OpenWikiSchemaPack = {
  api_version: OPENWIKI_SCHEMA_PACK_API_VERSION,
  name: "openwiki-default",
  version: "1.0.0",
  description: "Default OpenWiki schema pack for proposal-safe personal and team wikis.",
  record_templates: [
    {
      type: "page",
      page_type: "concept",
      path_template: "wiki/concepts/{slug}.md",
      required_frontmatter: ["id", "title", "type", "page_type", "status", "source_ids", "claim_ids", "topics"],
      section_defaults: ["Summary", "Evidence", "Open Questions"],
    },
    {
      type: "page",
      page_type: "meeting",
      path_template: "wiki/meetings/{slug}.md",
      required_frontmatter: ["id", "title", "type", "page_type", "status", "source_ids", "claim_ids", "topics"],
      section_defaults: ["Participants", "Summary", "Decisions", "Action Items", "Open Questions"],
    },
  ],
  required_frontmatter: {
    page: ["id", "title", "type", "page_type", "status", "source_ids", "claim_ids", "topics"],
    source: ["id", "title", "source_type", "retrieved_at", "content_hash"],
  },
  topic_taxonomies: {
    default: ["people", "organizations", "projects", "meetings", "decisions", "sources"],
  },
  allowed_edge_types: [
    "page_link",
    "page_typed_link",
    "page_source",
    "page_claim",
    "claim_source",
    "proposal_target",
    "decision_proposal",
    "page_topic",
    "page_section",
    "source_relation",
  ],
  section_defaults: {
    concept: ["Summary", "Evidence", "Open Questions"],
    meeting: ["Participants", "Summary", "Decisions", "Action Items", "Open Questions"],
  },
  proposal_requirements: [
    "Search existing records before creating new pages.",
    "Use OpenWiki proposal tools for canonical page changes unless trusted write mode is explicitly authorized.",
    "Cite page IDs, source IDs, claim IDs, and inbox IDs when they drive a proposal.",
  ],
  validation_rules: [
    {
      id: "frontmatter.required",
      severity: "error",
      description: "Records must include required frontmatter for their record family.",
    },
    {
      id: "proposal.provenance",
      severity: "warning",
      description: "Proposal rationales should name the sources, inbox items, or graph suggestions that justify the change.",
    },
  ],
};

export function parseOpenWikiSchemaPackYaml(yaml: string, sourcePath = "schema-pack.yaml"): OpenWikiSchemaPack {
  const record = parseOpenWikiYaml(yaml, sourcePath);
  return openWikiSchemaPackFromYaml(record, sourcePath);
}

export function validateOpenWikiSchemaPackYaml(yaml: string, sourcePath = "schema-pack.yaml"): { ok: true; pack: OpenWikiSchemaPack } | { ok: false; errors: string[] } {
  try {
    return { ok: true, pack: parseOpenWikiSchemaPackYaml(yaml, sourcePath) };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function bundledOpenWikiSchemaPacks(): OpenWikiSchemaPack[] {
  return [DEFAULT_OPENWIKI_SCHEMA_PACK];
}

export function renderOpenWikiSchemaPackYaml(pack: OpenWikiSchemaPack = DEFAULT_OPENWIKI_SCHEMA_PACK): string {
  const lines = [
    `api_version: ${pack.api_version}`,
    `name: ${pack.name}`,
    `version: ${pack.version}`,
    `description: "${pack.description}"`,
    "record_templates:",
    ...pack.record_templates.flatMap((template) => [
      `  - type: ${template.type}`,
      ...(template.page_type === undefined ? [] : [`    page_type: ${template.page_type}`]),
      `    path_template: ${template.path_template}`,
      `    required_frontmatter: [${template.required_frontmatter.join(", ")}]`,
      ...(template.section_defaults === undefined ? [] : [`    section_defaults: [${template.section_defaults.map((item) => JSON.stringify(item)).join(", ")}]`]),
    ]),
    "required_frontmatter:",
    ...Object.entries(pack.required_frontmatter).flatMap(([key, values]) => [`  ${key}: [${values.join(", ")}]`]),
    "topic_taxonomies:",
    ...Object.entries(pack.topic_taxonomies).flatMap(([key, values]) => [`  ${key}: [${values.join(", ")}]`]),
    `allowed_edge_types: [${pack.allowed_edge_types.join(", ")}]`,
    "section_defaults:",
    ...Object.entries(pack.section_defaults).flatMap(([key, values]) => [`  ${key}: [${values.map((item) => JSON.stringify(item)).join(", ")}]`]),
    "proposal_requirements:",
    ...pack.proposal_requirements.map((item) => `  - "${item.replace(/"/g, "\\\"")}"`),
    "validation_rules:",
    ...pack.validation_rules.flatMap((rule) => [
      `  - id: ${rule.id}`,
      `    severity: ${rule.severity}`,
      `    description: "${rule.description.replace(/"/g, "\\\"")}"`,
    ]),
  ];
  return lines.join("\n") + "\n";
}

export function explainOpenWikiSchemaPackResolution(input: {
  cliPath?: string;
  env?: Record<string, string | undefined>;
  repoConfig?: { runtime?: { schema_pack?: { path?: string; name?: string } } };
  workspaceProfile?: string;
  bundledDefaultName?: string;
} = {}): OpenWikiSchemaPackResolution {
  const repoPack = input.repoConfig?.runtime?.schema_pack;
  const bundledDefaultName = input.bundledDefaultName ?? DEFAULT_OPENWIKI_SCHEMA_PACK.name;
  const bundledPackNames = new Set([...bundledOpenWikiSchemaPacks().map((pack) => pack.name), bundledDefaultName]);
  const workspacePackReference = input.workspaceProfile !== undefined && bundledPackNames.has(input.workspaceProfile) ? input.workspaceProfile : undefined;
  const order: OpenWikiSchemaPackResolutionStep[] = [
    resolutionStep("cli", input.cliPath),
    resolutionStep("env", input.env?.OPENWIKI_SCHEMA_PACK),
    resolutionStep("repo_config", repoPack?.path ?? repoPack?.name),
    resolutionStep("workspace_profile", workspacePackReference),
    resolutionStep("bundled_default", bundledDefaultName),
    { source: "none", active: false },
  ];
  const selectedIndex = order.findIndex((step) => step.reference !== undefined && step.reference.length > 0);
  const selected = selectedIndex === -1 ? order[order.length - 1] : order[selectedIndex];
  if (selected === undefined) {
    throw new Error("Schema-pack resolution order is empty");
  }
  const activeSelected = { ...selected, active: true };
  return {
    selected: activeSelected,
    order: order.map((step, index) => (index === selectedIndex || (selectedIndex === -1 && step.source === "none") ? { ...step, active: true } : step)),
  };
}

function resolutionStep(source: OpenWikiSchemaPackResolutionStep["source"], reference: string | undefined): OpenWikiSchemaPackResolutionStep {
  const cleaned = cleanReference(reference);
  return cleaned === undefined ? { source, active: false } : { source, reference: cleaned, active: false };
}

function openWikiSchemaPackFromYaml(record: Record<string, OpenWikiYamlValue>, sourcePath: string): OpenWikiSchemaPack {
  try {
    assertYamlKnownKeys(record, PACK_KEYS, sourcePath);
    const apiVersion = yamlString(record.api_version, "api_version");
    if (apiVersion !== OPENWIKI_SCHEMA_PACK_API_VERSION) {
      throw new OpenWikiYamlError(`api_version must be ${OPENWIKI_SCHEMA_PACK_API_VERSION}`);
    }
    const allowedEdgeTypes = yamlStringArray(record.allowed_edge_types, "allowed_edge_types", { minItems: 1 });
    for (const edgeType of allowedEdgeTypes) {
      if (!EDGE_TYPE_PATTERN.test(edgeType)) {
        throw new OpenWikiYamlError(`allowed_edge_types contains invalid edge type '${edgeType}'`);
      }
    }
    return {
      api_version: OPENWIKI_SCHEMA_PACK_API_VERSION,
      name: yamlString(record.name, "name"),
      version: yamlString(record.version, "version"),
      description: yamlString(record.description, "description"),
      record_templates: schemaRecordTemplates(record.record_templates),
      required_frontmatter: stringArrayMap(record.required_frontmatter, "required_frontmatter"),
      topic_taxonomies: stringArrayMap(record.topic_taxonomies, "topic_taxonomies"),
      allowed_edge_types: allowedEdgeTypes,
      section_defaults: stringArrayMap(record.section_defaults, "section_defaults"),
      proposal_requirements: yamlStringArray(record.proposal_requirements, "proposal_requirements"),
      validation_rules: schemaValidationRules(record.validation_rules),
    };
  } catch (error) {
    throw new OpenWikiYamlError(`${sourcePath}: invalid OpenWiki schema pack: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function schemaRecordTemplates(value: OpenWikiYamlValue | undefined): OpenWikiSchemaRecordTemplate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OpenWikiYamlError("record_templates must be a non-empty array");
  }
  return value.map((item, index): OpenWikiSchemaRecordTemplate => {
    const record = yamlObject(item, `record_templates[${index}]`);
    assertYamlKnownKeys(record, RECORD_TEMPLATE_KEYS, `record_templates[${index}]`);
    const sectionDefaults = record.section_defaults === undefined ? undefined : yamlStringArray(record.section_defaults, `record_templates[${index}].section_defaults`);
    return {
      type: yamlString(record.type, `record_templates[${index}].type`),
      ...(record.page_type === undefined ? {} : { page_type: yamlString(record.page_type, `record_templates[${index}].page_type`) }),
      path_template: yamlString(record.path_template, `record_templates[${index}].path_template`),
      required_frontmatter: yamlStringArray(record.required_frontmatter, `record_templates[${index}].required_frontmatter`, { minItems: 1 }),
      ...(sectionDefaults === undefined ? {} : { section_defaults: sectionDefaults }),
    };
  });
}

function schemaValidationRules(value: OpenWikiYamlValue | undefined): OpenWikiSchemaValidationRule[] {
  if (!Array.isArray(value)) {
    throw new OpenWikiYamlError("validation_rules must be an array");
  }
  return value.map((item, index): OpenWikiSchemaValidationRule => {
    const record = yamlObject(item, `validation_rules[${index}]`);
    assertYamlKnownKeys(record, VALIDATION_RULE_KEYS, `validation_rules[${index}]`);
    const severity = yamlString(record.severity, `validation_rules[${index}].severity`);
    if (severity !== "error" && severity !== "warning") {
      throw new OpenWikiYamlError(`validation_rules[${index}].severity must be error or warning`);
    }
    return {
      id: yamlString(record.id, `validation_rules[${index}].id`),
      severity,
      description: yamlString(record.description, `validation_rules[${index}].description`),
    };
  });
}

function stringArrayMap(value: OpenWikiYamlValue | undefined, label: string): Record<string, string[]> {
  const record = yamlObject(value, label);
  const output: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(record)) {
    output[key] = yamlStringArray(entry, `${label}.${key}`);
  }
  return output;
}

function cleanReference(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned === undefined || cleaned.length === 0 ? undefined : cleaned;
}
