# Integrations

OpenWiki includes integration packs for agent runtimes and adjacent tools.

Current integration areas:

- OpenCode agents, skills, tools, and guardrails
- Open Cowork MCP and workflow examples
- GitHub Actions workflows for linting, proposal review, static export, and
  image publishing

Install the OpenCode integration pack into another project:

```sh
openwiki agent install --provider opencode --profile personal-curator --out-dir /path/to/project --wiki-root /path/to/wiki
openwiki integrate opencode --profile wiki-curator --out-dir /path/to/project --wiki-root /path/to/wiki
```

Use `agent providers list` to inspect provider capabilities. OpenCode installs
project-local `.opencode` files by default; `--profile global` is available for
users who intentionally want a global OpenCode config. Generic MCP clients use
`agent configure --client generic` and do not install skills or agents.
When `--wiki-root` is omitted, the pack is installed without an MCP binding so
it can be committed safely before the wiki path is known.

The OpenCode/OpenClaw pack includes skills for retrieval, proposal drafting,
inbox processing, policy-safe editing, transcript handling, meeting curation,
operation, and dream-cycle review. These skills treat watched-folder payloads,
transcript exports, and hosted user submissions as untrusted evidence, search
existing pages before proposing new ones, and keep knowledge changes in proposal
mode by default.

Skill manifests use strict YAML frontmatter and are documentation only; they do
not execute code. See [Skills, Schema Packs, And Typed Links](skills-schema-packs-and-links.md)
for authoring and validation details.

Integration files should reference OpenWiki through CLI, HTTP, or MCP contracts
rather than relying on private implementation details.
