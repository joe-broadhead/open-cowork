# Agent Provider Contract

OpenWiki owns the wiki workflow: durable records, policy, inbox state, jobs,
sync, and audit. Agent providers own client-specific config files, skills,
agents, plugins, commands, and optional local runner conventions.

Provider support is intentionally additive. Inbox, workflow, policy, HTTP, MCP,
and Git semantics must not change when a new provider is added.

## Provider Fields

Each provider declares:

| Field | Contract |
| --- | --- |
| `id` | Stable provider id. Shipped ids are `opencode` and `generic-mcp`. Future ids may include `claude` and `codex`. |
| `aliases` | CLI aliases. `generic` resolves to `generic-mcp` for compatibility. |
| `transports` | Supported MCP transports: `stdio`, `http`, or both. |
| `configShape` | Provider-specific config shape. OpenCode uses its `mcp` block; generic clients use `mcpServers`. |
| `install.kind` | `opencode-pack` for providers with files to install, or `config-only` for MCP-only clients. |
| `install.profiles` | Supported integration profiles. |
| `localRunnerCommand` | Optional example command for local task execution. |
| `toolModes` | Supported OpenWiki MCP tool modes: `read`, `proposal`, and `write`. |
| `features` | Whether the provider supports skills, agents, plugins, commands, and model override. |
| `model` | Default and override behavior. User installs must not force an eval model. |
| `writeModeSecurity` | Required guardrails before write-mode config can be generated. |

## Shipped Providers

| Provider | Use For | Transports | Install Behavior |
| --- | --- | --- | --- |
| `opencode` | First-class local and hosted OpenWiki agents. | `stdio`, `http` | Installs project-local `.opencode` files by default. |
| `generic-mcp` (`generic`) | Any MCP client that accepts `mcpServers`. | `stdio`, `http` | Config only; no skills or agent prompts. |

List providers:

```sh
openwiki agent providers list
openwiki agent providers list --json
```

## Config Generation

Generate local OpenCode stdio config:

```sh
openwiki --root ~/openwiki-personal agent configure \
  --client opencode \
  --transport stdio \
  --tools proposal \
  --config-out ./opencode.openwiki.json
```

Generate hosted generic HTTP MCP config:

```sh
openwiki --root /data/wiki agent configure \
  --client generic \
  --transport http \
  --server-url https://wiki.example.com \
  --tools proposal \
  --token-env OPENWIKI_PROPOSAL_TOKEN \
  --config-out ./openwiki.remote-mcp.json
```

HTTP configs include `MCP-Protocol-Version` and reference bearer tokens through
environment variables. Raw token values are not written into generated config.
If `--create-token --token-out <path>` is used, OpenWiki writes the token to a
0600 file and tells you which environment secret should load it.

Write mode can apply changes. All providers must refuse write-mode config unless
the caller passes `--confirm-write-tools`.

## OpenCode Install Profiles

Install OpenCode files into a project-local `.opencode` directory:

```sh
openwiki agent install \
  --provider opencode \
  --profile personal-curator \
  --out-dir ~/openwiki-personal \
  --wiki-root ~/openwiki-personal
```

Supported OpenCode install profiles:

| Profile | Intended Use |
| --- | --- |
| `personal-curator` | Full personal wiki pack: inbox, meeting curator, monitor, researcher, editor, reviewer, skills, tools, examples, and guardrails. |
| `researcher` | Read/search/trace focused profile with monitor and researcher agents. |
| `reviewer` | Proposal review profile with reviewer, monitor, edit/operator skills, tools, and guardrails. |
| `maintainer` | Full pack for trusted operators that may later configure write-mode MCP. |
| `wiki-curator` | Default `openwiki integrate opencode` project profile. |
| `developer` | Full pack for developers integrating OpenWiki into another project. |
| `global` | Global OpenCode config install under `~/.config/opencode` unless `--out-dir` is provided. |

Full profiles install transcript-specific assets:

- `openwiki-inbox-operator` routes inbox queues, duplicate checks, owner/Space
  checks, and authorized processing.
- `openwiki-meeting-curator` turns transcript inbox items into
  proposal-safe meeting, person, organization, project, topic, decision, and
  action-item page updates.
- `openwiki-transcript-inbox` and `openwiki-meeting-curation` define privacy,
  prompt-injection, provenance, uncertainty, and source-citation rules.
- `examples/opencode.local-proposal.json` and
  `examples/opencode.hosted-http-proposal.json` show local stdio and hosted HTTP
  MCP proposal-mode setups.

The legacy integration command remains available:

```sh
openwiki integrate opencode --profile wiki-curator --out-dir /path/to/project --wiki-root /path/to/wiki
openwiki integrate opencode --profile global --wiki-root /path/to/wiki
```

Global install is never the default. Prefer project-local installs so wiki rules,
guardrails, and MCP config are visible in the repository that the agent is
working in.

When `--wiki-root` is omitted, OpenWiki installs agents, skills, examples, and
rules but leaves the generated MCP config unbound. Bind MCP later with
`openwiki --root <wiki> agent configure` or reinstall the pack with
`--wiki-root <wiki>`. Reference TS tool stubs remain in the source integration
pack, but the default installer relies on MCP as the supported OpenCode tool
surface.

## Model Handling

OpenWiki user installs do not pin a model in agent prompt files. Configure the
model in OpenCode project/user settings or pass `--model` to `opencode run`.

Release evals may pin a model separately with `OPENWIKI_OPENCODE_MODEL`; that
pinning lives in eval fixtures and scripts, not in installed user agent files.

## Future Providers

New provider support should add a provider registry entry and provider-specific
config/install tests. It should not require changes to:

- inbox item schemas;
- proposal/review/apply workflow semantics;
- MCP tool names or tool modes;
- HTTP API endpoints;
- Spaces and permission checks;
- sync and backup orchestration.

Provider config must continue to use token-file or environment-secret references
for credentials, never raw token literals.
