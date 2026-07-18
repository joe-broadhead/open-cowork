# Operation Contract

## 10. Operation Contract

OpenWiki operations are the shared contract beneath MCP tools, CLI commands,
HTTP endpoints, and static export readers.

Each operation has:

- name
- input JSON Schema
- output JSON Schema
- required scopes
- safety tier
- adapter bindings

Required v0.1 operations:

| Operation | Read/write | Required scope | Description |
| --- | --- | --- | --- |
| `wiki.search` | read | `wiki:search` | Search pages, sources, claims, decisions, and proposals. |
| `wiki.read_page` | read | `wiki:read` | Read a page by ID, slug, path, or URI. |
| `wiki.read_source` | read | `wiki:read` | Read source metadata and allowed content. |
| `wiki.read_claim` | read | `wiki:read` | Read a claim and supporting source IDs. |
| `wiki.list_proposals` | read | `wiki:read` | Return the proposal queue with optional status, actor, target, and limit filters. |
| `wiki.read_proposal` | read | `wiki:read` | Read a proposal record by ID or URI. |
| `wiki.read_proposal_detail` | read | `wiki:read` | Read a proposal with diff, snapshot, and validation report artifacts. |
| `wiki.read_decision` | read | `wiki:read` | Read a decision record by ID or URI. |
| `wiki.trace_claim` | read | `wiki:read` | Explain why a claim is believed. |
| `wiki.get_history` | read | `wiki:read` | Return Git-backed history for a record. |
| `wiki.diff_versions` | read | `wiki:read` | Return a diff between record versions. |
| `wiki.list_recent_changes` | read | `wiki:read` | Return recent committed changes. |
| `wiki.git_status` | read | `wiki:read` | Return Git branch, remote, ahead/behind, and dirty workspace state. |
| `wiki.git_pull` | write workflow | `wiki:commit` | Fast-forward pull from the configured Git remote and branch. |
| `wiki.git_push` | write workflow | `wiki:publish` | Push the current Git HEAD to the configured Git remote and branch. |
| `wiki.sync_now` | write workflow | `wiki:publish` | Run safe product sync through OpenWiki coordination without committing files. |
| `wiki.list_events` | read | `wiki:read` | Return durable audit events. |
| `wiki.list_runs` | read | `wiki:read` | Return local and worker run records. |
| `wiki.list_topics` | read | `wiki:read` | Return derived topic summaries. |
| `wiki.list_open_questions` | read | `wiki:read` | Return open questions extracted from pages. |
| `wiki.detect_governance` | read | `wiki:read` | Return permission-filtered findings for stale claims, missing sources, broken links, and orphan pages. |
| `wiki.graph_neighbors` | read | `wiki:read` | Return graph nodes and edges around a page, source, claim, proposal, decision, topic, or section. |
| `wiki.graph_backlinks` | read | `wiki:read` | Return inbound graph context for a record or synthetic graph node. |
| `wiki.graph_related` | read | `wiki:read` | Return directly and topically related graph context for a record. |
| `wiki.graph_path` | read | `wiki:read` | Find a permission-filtered graph path between two records. |
| `wiki.graph_orphans` | read | `wiki:read` | Return visible pages that have no page-to-page graph links. |
| `wiki.graph_stale` | read | `wiki:read` | Return visible pages and claims that need graph or evidence maintenance. |
| `wiki.graph_report` | read | `wiki:read` | Return deterministic graph intelligence over the permission-filtered graph. |
| `wiki.ask` | read | `wiki:ask` | Answer using retrieved records and citations. |
| `wiki.think` | read | `wiki:ask` | Return a cited synthesis with retrieval diagnostics and explicit evidence gaps. |
| `wiki.read_policy` | admin read | `wiki:admin` | Return Git-backed sections, grants, and approval rules. |
| `wiki.propose_policy` | admin proposal | `wiki:admin` | Submit a governed proposal to replace one policy JSON file. |
| `wiki.propose_edit` | proposal | `wiki:propose` | Submit a proposed page or claim change. |
| `wiki.propose_synthesis` | proposal | `wiki:propose` | Submit a proposed new synthesis page with snapshot and target path. |
| `wiki.create_synthesis` | write workflow | `wiki:patch` | Create, review, and apply a synthesis page through the governed proposal workflow. |
| `wiki.propose_source` | proposal | `wiki:propose` | Submit a proposed source record. |
| `wiki.comment_on_proposal` | proposal | `wiki:propose` | Add review comments to a proposal. |
| `wiki.ingest_source` | write workflow | `wiki:ingest:draft` | Ingest a source into a draft manifest and source store. |
| `wiki.fetch_source` | write workflow | `wiki:ingest:draft` | Queue a bounded URL fetch that ingests fetched content through source policy. May carry `connector_id` and `credential_ref`, but never raw secrets. |
| `wiki.review_proposal` | write workflow | `wiki:review` | Attach a review decision to a proposal. |
| `wiki.apply_proposal` | write workflow | `wiki:commit` | Apply an approved proposal to Git. |
| `wiki.run_job` | write workflow | `wiki:patch` | Queue a trusted local or worker job such as index rebuild, static export, or lint. Implementations MAY support `wait=true` for inline execution. |
| `wiki.run_lint` | write workflow | `wiki:patch` | Run deterministic repository validation without queueing a job. |
| `wiki.commit_changes` | write workflow | `wiki:commit` | Commit staged, selected, or OpenWiki-managed Git paths and append a durable Git event. |
| `wiki.publish` | write workflow | `wiki:publish` | Publish derived outputs and append a durable `publish.completed` event. |
