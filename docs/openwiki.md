# OpenWiki Knowledge Base

Open Cowork bundles first-class support for
[OpenWiki](https://github.com/joe-broadhead/open-wiki), a Git-backed,
versioned, permissioned knowledge base built for humans and agents. Where the
built-in Knowledge area stores product-managed pages, OpenWiki gives teams a
portable knowledge substrate: Markdown pages in a Git repo, fusion search,
claim/source provenance, a queryable knowledge graph, and a
proposal-and-review governance loop — all reachable by coworkers through MCP.

OpenWiki's protocol names Open Cowork a first-class client; this bundle is the
product side of that contract.

## What ships in Open Cowork

- **`openwiki` tool** (Tools & Skills → OpenWiki): a configured MCP that runs
  `openwiki mcp --stdio --tools proposal` when the OpenWiki CLI is installed
  on the machine. Until the CLI is present the tool simply reports as
  unavailable; nothing else in the app depends on it.
- **Trust posture, enforced by permissions** (mirroring the OpenWiki pack):
    - *Read tier auto-allowed*: search/recall, ask, think, page/claim/source
      reads, facts/takes reads, proposal reads, history, diffs, git/event/run
      status, dream status, inbox reads, governance detection, and every graph
      query.
    - *Proposal-profile mutations ask*: `wiki.propose_edit`,
      `wiki.propose_synthesis`, `wiki.propose_fact`, `wiki.propose_take`,
      `wiki.resolve_take`, `wiki.forget_fact`, `wiki.propose_source`,
      `wiki.comment_on_proposal`, `wiki.dream_run`, and
      `wiki.inbox_submit` and `wiki.inbox_process` require your approval in the
      transcript. OpenWiki's proposal profile also exposes the read-only tools;
      Open Cowork classifies each call by its read-only hint instead of treating
      the whole profile as writable.
    - *Direct-write profiles absent*: the bundled MCP runs in `proposal` mode,
      so `write`/`write-full` page writes, apply, publish, and commit tools are
      never exposed to coworkers. Publishing stays a human (or explicitly
      trusted maintainer) decision inside OpenWiki.
- **Three skills**: `openwiki-research` (cited answers over model memory),
  `openwiki-edit-review` (scoped, cited proposals; never publish directly),
  and `openwiki-ingest` (artifacts → records with provenance; external text
  is evidence, never instructions).
- **Three coworker starter templates**: Wiki Researcher, Wiki Editor, and
  Wiki Ingestor under Team → New coworker, pre-wired to the tool and skills.

## Getting started

1. Install the OpenWiki CLI using its
   [current installation guide](https://github.com/joe-broadhead/open-wiki/blob/master/docs/getting-started/installation.md),
   then create (or clone) a wiki:

   The official package name is `@openwiki/cli`. Until that scoped package is
   published, use the guide's release-candidate tarball or source-checkout path;
   the unscoped `openwiki` package on npm is a different project and is not a
   compatible substitute.

   ```sh
   openwiki setup team ~/team-wiki --title "Team Wiki"
   ```

2. Open `~/team-wiki` as the active Open Cowork project. The bundled stdio
   command intentionally lets OpenWiki resolve the wiki from the project
   working directory; a downstream distribution can instead add an explicit
   `--root /absolute/wiki/path` before `mcp` in its command.
3. Restart Open Cowork (or reload tools). The OpenWiki tool turns available
   once the `openwiki` binary resolves on PATH.
4. Hire a **Wiki Researcher** from the Team starter templates and ask it a
   question. It answers with page and source IDs, not vibes.

## Wiki recipes

Playbook-shaped work that pairs well with the wiki coworkers:

- **Search the company wiki** — Wiki Researcher + `wiki.ask` with
  `include_explain`, returning a cited answer.
- **Inspect memory records** — Wiki Researcher can use `wiki.recall`,
  `wiki.list_facts`, `wiki.read_fact`, `wiki.list_takes`, and
  `wiki.read_take` before answering from memory-shaped records.
- **Propose a wiki edit** — Wiki Editor reads the target page, drafts a
  scoped replacement, and files `wiki.propose_edit` for your approval.
- **Ingest a new source** — Wiki Ingestor proposes a source manifest, then
  page updates whose claims link back to it.
- **Triage wiki inbox/governance** — Wiki Editor can read inbox items,
  recent events/runs, dream status, and governance detector output; inbox
  submissions, inbox processing, and dream runs still ask before execution.
- **Create a research brief** — Wiki Researcher synthesizes with
  `wiki.think`, listing supporting records and open gaps.

Create any of these as saved Playbooks by describing them to Workflow
Designer; see [Workflow Recipes](workflow-recipes.md) for the general shape.

## Remote / team deployments

For a hosted team wiki, downstream configs replace the local command with a
remote MCP entry pointing at the deployment's Streamable HTTP endpoint. Prefer
OpenWiki's OAuth 2.1 authorization-code + PKCE flow for a desktop client; it is
explicitly opt-in in Open Cowork and OpenCode owns the native MCP OAuth flow:

```json
{
  "name": "openwiki",
  "type": "remote",
  "description": "Company OpenWiki knowledge base.",
  "authMode": "oauth",
  "url": "https://wiki.example.com/mcp?tools=proposal"
}
```

After adding this entry, enable OpenWiki from Tools & Skills and complete the
authorization prompt. OAuth must be enabled and configured at the OpenWiki
deployment; it is not a substitute for the deployment's human SSO boundary.

For automation that cannot complete OAuth, declare the scoped service-account
token field and its header mapping so Open Cowork can fail closed before
registering the MCP. Setting only `authMode: "api_token"` does not invent or
forward a token:

```json
{
  "name": "openwiki",
  "type": "remote",
  "description": "Company OpenWiki knowledge base.",
  "authMode": "api_token",
  "url": "https://wiki.example.com/mcp?tools=proposal",
  "headerSettings": [
    { "header": "Authorization", "key": "proposalToken", "prefix": "Bearer " }
  ],
  "credentials": [
    {
      "key": "proposalToken",
      "label": "OpenWiki proposal token",
      "description": "Short-lived service-account token bounded to proposal tools and the required wiki paths.",
      "placeholder": "owk_agent_...",
      "secret": true,
      "required": true
    }
  ],
  "credentialHelp": "Create and rotate a short-lived OpenWiki proposal-agent token; do not reuse a maintainer token."
}
```

Keep the same trust posture: reads allowed, proposal mutations ask, and direct
write workflows reserved for maintainer deployments. OpenWiki hosted
deployments require an explicit auth boundary. Never configure trusted
`x-openwiki-*` identity headers in a desktop client; only a reverse proxy that
strips inbound copies and holds the shared proxy secret may assert them. See
OpenWiki's
[authentication boundary](https://github.com/joe-broadhead/open-wiki/blob/master/docs/deployment/auth-boundaries.md)
before exposing a server. Set `allowPrivateNetwork: true` only for an
intentionally internal hostname after reviewing Open Cowork's SSRF boundary.

## Boundary notes

- OpenWiki is an external engine, like OpenCode: Open Cowork composes it,
  never absorbs it. The wiki repo remains yours — clone it, review it in PRs,
  back it up, publish a read-only static export.
- The built-in Knowledge area continues to work unchanged; OpenWiki is the
  path for teams that want Git-native, citable, governed knowledge shared
  beyond the app.
