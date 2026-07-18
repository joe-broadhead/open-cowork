# Skills, Schema Packs, And Typed Links

OpenWiki supports three agent-facing authoring contracts:

- Skills: Markdown guidance files with strict YAML frontmatter.
- Schema packs: YAML contracts for local record templates and validation guidance.
- Typed links: deterministic derived edges proposed from wiki content before they become canonical edits.

These contracts are guidance and validation surfaces. They do not execute code,
weaken repository JSON schemas, or bypass proposal review.

## Skill Manifests

OpenWiki skills are Markdown files named `SKILL.md`. The file must start with
YAML frontmatter containing:

```yaml
name: openwiki-proposal-drafting
description: Use when drafting reviewable OpenWiki proposals from retrieved evidence.
version: 1.0.0
applies_to: [opencode, openclaw, mcp]
required_tools: [wiki.search, wiki.read_page, wiki.propose_edit]
allowed_operations: [wiki.search, wiki.read_page, wiki.propose_edit, wiki.read_proposal_detail]
risk_level: medium
```

Optional fields are `inputs`, `outputs`, `examples`, `owner`, and `reviewers`.
The parser rejects unknown fields, missing required fields, bad semantic
versions, and invalid risk levels. Markdown body content is documentation only.

The bundled OpenCode/OpenClaw integration pack includes skills for retrieval,
proposal drafting, inbox processing, policy-safe editing, transcript handling,
meeting curation, operation, and dream-cycle review.

Install the pack into a project:

```sh
openwiki integrate opencode --profile wiki-curator --out-dir /path/to/project --wiki-root /path/to/wiki
```

OpenClaw agents can consume the installed `.opencode/skills` directory as
normal skill guidance while using the generated OpenWiki MCP configuration.

## Schema Packs

Schema packs are YAML files with `api_version: openwiki.schema-pack.v1`.
They define record templates, required frontmatter, topic taxonomies, allowed
edge types, section defaults, proposal requirements, and validation rules.

List bundled packs:

```sh
openwiki schema-pack list
```

Create a local starter pack:

```sh
openwiki schema-pack scaffold personal-pack --out-dir ./schema-packs
```

Validate a pack:

```sh
openwiki schema-pack validate ./schema-packs/schema-pack.yaml
```

Explain which pack OpenWiki would select:

```sh
openwiki --root /path/to/wiki schema-pack explain --schema-pack ./schema-packs/schema-pack.yaml
```

Resolution order is deterministic:

1. CLI `--schema-pack`
2. `OPENWIKI_SCHEMA_PACK`
3. `runtime.schema_pack.path` or `runtime.schema_pack.name` in `openwiki.json`
4. workspace runtime profile
5. bundled default pack
6. no-pack fallback

Schema packs are additive guidance. Repository record validation and JSON Schema
validation still run independently.

## Typed Links

OpenWiki derives `page_typed_link` graph edges from:

- wiki links such as `[[Project Alpha]]`;
- Markdown links to known records;
- configured frontmatter relation fields in pure extraction helpers;
- known page/source/claim/topic aliases;
- conservative relation phrases such as “depends on”, “blocks”, “supports”,
  “contradicts”, and “supersedes”.

Derived edges include provenance metadata: relation, extraction rule,
confidence, span, and whether the link was already explicit. They do not edit
canonical pages automatically. Suggested canonical changes must go through
existing proposal workflows.

Use graph explain output to inspect link provenance:

```sh
openwiki --root /path/to/wiki graph edges --explain
```

Policy filtering still applies. Graph APIs only expose edges when both endpoints
are visible to the caller, so typed links cannot reveal private record names in
public graph queries.
