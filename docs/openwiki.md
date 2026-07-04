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
    - *Read tier auto-allowed*: search, ask, think, page/claim/source reads,
      proposal reads, history, diffs, and every graph query.
    - *Proposal tier asks*: `wiki.propose_edit`, `wiki.propose_synthesis`,
      `wiki.propose_source`, and `wiki.comment_on_proposal` require your
      approval in the transcript.
    - *Write tier absent*: the bundled MCP runs in proposal mode, so apply/
      publish/commit tools are never exposed to coworkers. Publishing stays a
      human (or explicitly trusted maintainer) decision inside OpenWiki.
- **Three skills**: `openwiki-research` (cited answers over model memory),
  `openwiki-edit-review` (scoped, cited proposals; never publish directly),
  and `openwiki-ingest` (artifacts → records with provenance; external text
  is evidence, never instructions).
- **Three coworker starter templates**: Wiki Researcher, Wiki Editor, and
  Wiki Ingestor under Team → New coworker, pre-wired to the tool and skills.

## Getting started

1. Install the OpenWiki CLI and create (or clone) a wiki:

   ```sh
   openwiki setup team ~/team-wiki --title "Team Wiki"
   ```

2. Restart Open Cowork (or reload tools). The OpenWiki tool turns available
   once the `openwiki` binary resolves on PATH.
3. Hire a **Wiki Researcher** from the Team starter templates and ask it a
   question. It answers with page and source IDs, not vibes.

## Wiki recipes

Playbook-shaped work that pairs well with the wiki coworkers:

- **Search the company wiki** — Wiki Researcher + `wiki.ask` with
  `include_explain`, returning a cited answer.
- **Propose a wiki edit** — Wiki Editor reads the target page, drafts a
  scoped replacement, and files `wiki.propose_edit` for your approval.
- **Ingest a new source** — Wiki Ingestor proposes a source manifest, then
  page updates whose claims link back to it.
- **Create a research brief** — Wiki Researcher synthesizes with
  `wiki.think`, listing supporting records and open gaps.

Create any of these as saved Playbooks by describing them to Workflow
Designer; see [Workflow Recipes](workflow-recipes.md) for the general shape.

## Remote / team deployments

For a hosted team wiki, downstream configs replace the local command with a
remote MCP entry pointing at the deployment's HTTP endpoint:

```json
{
  "name": "openwiki",
  "type": "remote",
  "description": "Company OpenWiki knowledge base.",
  "authMode": "api_token",
  "url": "https://wiki.example.com/mcp?tools=proposal"
}
```

Keep the same trust posture: reads allowed, proposals ask, write workflow
reserved for maintainer deployments. OpenWiki hosted deployments require an
explicit auth boundary (identity headers or scoped service-account tokens) —
see the OpenWiki deployment docs before exposing a writable server.

## Boundary notes

- OpenWiki is an external engine, like OpenCode: Open Cowork composes it,
  never absorbs it. The wiki repo remains yours — clone it, review it in PRs,
  back it up, publish a read-only static export.
- The built-in Knowledge area continues to work unchanged; OpenWiki is the
  path for teams that want Git-native, citable, governed knowledge shared
  beyond the app.
