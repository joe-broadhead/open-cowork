# Repository Format

## 5. Canonical Identifiers

OpenWiki IDs are stable strings. IDs MUST be globally unique within a workspace.

ID format:

```text
<kind>:<scope-or-date>:<slug-or-sequence>
```

Required kinds:

- `page`
- `source`
- `claim`
- `proposal`
- `comment`
- `decision`
- `commit`
- `actor`
- `run`
- `workspace`

Examples:

```text
page:concept:agent-memory
page:entity:open-cowork
source:2026-05-21-001
fragment:source:2026-05-21-001:0001
claim:2026-05-21-001
proposal:2026-05-21-001
comment:2026-05-21-001
decision:2026-05-21-001
commit:abc123
run:2026-05-21-001
actor:user:joe
actor:agent:wiki-editor
workspace:personal
```

## 6. Canonical URIs

Every canonical record SHOULD have an `openwiki://` URI.

```text
openwiki://page/concept/agent-memory
openwiki://page/entity/open-cowork
openwiki://source/2026-05-21-001
openwiki://fragment/source/2026-05-21-001/0001
openwiki://claim/2026-05-21-001
openwiki://proposal/2026-05-21-001
openwiki://comment/2026-05-21-001
openwiki://decision/2026-05-21-001
openwiki://commit/abc123
openwiki://run/2026-05-21-001
openwiki://search?q=agent%20memory
```

URI rules:

- URIs MUST be stable across MCP, CLI, HTTP, and static exports.
- URIs MUST resolve to a record or a clear not-found error.
- HTTP servers SHOULD expose adjacent JSON and Markdown URLs for pages, including
  ID-addressed routes such as `/pages/page%3Aconcept%3Aagent-memory.md` and
  public routes such as `/concepts/agent-memory.md`.
- Static exports SHOULD preserve the same URI values inside JSON files.

## 7. Repository Format

Minimum repository layout:

```text
openwiki.json
wiki/
  concepts/
    agent-memory.md
  entities/
    open-cowork.md
sources/
  manifests/
    source_2026_05_21_001.yaml
  raw/
    source_2026_05_21_001.pdf
claims/
  claim-index.jsonl
policy/
  sections.json
  grants.json
  approval-rules.json
proposals/
  proposal_2026_05_21_001.yaml
  comments.jsonl
decisions/
  decision_2026_05_21_001.yaml
events/
  events.jsonl
runs/
  runs.jsonl
```

Recommended expanded layout:

```text
openwiki.json
wiki/
sources/
claims/
proposals/
decisions/
attachments/
exports/
  latest/
schemas/
  openwiki/
    v0/
```

Reference implementations SHOULD provide starter templates for common workspace
profiles:

- `team-wiki`
- `basic`
- `personal-wiki`
- `company-wiki`
- `public-encyclopedia`
- `github-pages`

Templates MUST still emit the same canonical repository format. A template may
choose different starter pages, page statuses, source sensitivity, and runtime
profile, but it must not create a separate template-specific protocol.

`openwiki.json` declares workspace-level configuration:

```json
{
  "protocol_version": "0.1",
  "workspace_id": "workspace:personal",
  "title": "Personal OpenWiki",
  "default_language": "en",
  "repo_format": "openwiki-repo-v0",
  "runtime": {
    "profile": "local",
    "git": {
      "remote": "origin",
      "branch": "main"
    },
    "sync": {
      "remote": "origin",
      "branch": "main",
      "mode": "manual",
      "pull_on_start": false,
      "push_after_commit": false,
      "sync_after_events": ["inbox.processed"],
      "debounce_seconds": 30,
      "max_attempts": 3,
      "backoff_seconds": 300,
      "interval_seconds": 900,
      "conflict_policy": "stop"
    },
    "backups": {
      "enabled": true,
      "schedule": "manual",
      "backup_after_events": ["proposal.applied", "inbox.processed"],
      "event_threshold": 5,
      "min_interval_seconds": 3600,
      "retention": {
        "keep_last": 20,
        "keep_days": 90
      },
      "destinations": [
        {
          "id": "local-backups",
          "kind": "local",
          "path": "~/OpenWiki Backups"
        }
      ]
    },
    "queue": {
      "backend": "local",
      "poll_ms": 1000,
      "max_jobs_per_worker": 1
    },
    "storage": {
      "backend": "local",
      "local_path": ".openwiki/objects",
      "inline_max_bytes": 65536
    },
    "connectors": {
      "http": [
        {
          "id": "docs",
          "label": "Docs",
          "allowed_hosts": ["docs.example.com"],
          "credential_refs": ["cred:docs-reader"],
          "default_headers": {
            "accept": "text/markdown"
          }
        }
      ],
      "github": [
        {
          "id": "github-docs",
          "allowed_repositories": ["openwiki/*"],
          "credential_refs": ["cred:github-reader"]
        }
      ],
      "gitlab": [
        {
          "id": "gitlab-docs",
          "web_base_url": "https://gitlab.example.com",
          "api_base_url": "https://gitlab.example.com/api/v4",
          "allowed_repositories": ["platform/wiki"],
          "credential_refs": ["cred:gitlab-reader"]
        }
      ]
    },
    "secrets": {
      "backend": "env",
      "env_prefix": "OPENWIKI_SECRET_"
    }
  },
  "auth": {
    "service_accounts": [
      {
        "id": "service:proposal-agent",
        "actor_id": "actor:agent:open-cowork",
        "role": "contributor",
        "description": "Proposal-mode agent token",
        "tokens": [
          {
            "id": "token:proposal-agent-2026-05-28-0123456789ab",
            "token_hash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "description": "Desktop MCP client",
            "created_at": "2026-05-28T00:00:00.000Z",
            "expires_at": "2026-08-26T00:00:00.000Z"
          }
        ]
      }
    ]
  },
  "search": {
    "default_persona": "default",
    "default_limit": 20,
    "max_limit": 200,
    "max_query_length": 2000,
    "overfetch": 3,
    "rrf_k": 60,
    "ngram_min": 3,
    "fuzzy_min_length": 4,
    "fuzzy_mid_length": 7,
    "fuzzy_max_distance": 2,
    "enabled_retrievers": {
      "exact": true,
      "bm25": true,
      "ngram": true,
      "fuzzy": true,
      "graph": true
    },
    "persona_weights": {
      "researcher": {
        "exact": 1.8,
        "bm25": 1.0,
        "ngram": 0.9,
        "fuzzy": 0.7,
        "graph": 1.2
      }
    }
  },
  "created_at": "2026-05-21T00:00:00Z"
}
```

The `runtime` and `search` blocks are optional. Implementations MUST merge
missing values with protocol defaults so older repositories continue to work.
The `runtime.git` block MAY select the default Git remote and branch used by sync operations. It MUST NOT contain credentials; deployments provide Git auth through standard Git mechanisms such as SSH keys, credential helpers, provider tokens, or mounted secrets.
The `runtime.sync` block describes product-level Git synchronization defaults
for the live workspace. `mode = "manual"` means users or operators initiate
sync; `mode = "auto"` allows a scheduler or service wrapper to use the same
remote, branch, interval, and conflict policy. The v0.1 conflict policy is
`stop`: implementations MUST NOT silently overwrite local or remote changes
when Git reports a conflict. `sync_after_events` MAY request post-workflow sync
after proposal apply, source ingest, or inbox processing events; implementations
MUST debounce and back off failed event sync attempts when those fields are set.
The `runtime.backups` block describes snapshot backup artifacts, not the live
workspace location. Local destinations MAY point at normal directories,
including directories that another backup tool syncs to Google Drive, iCloud,
Dropbox, or a NAS. Implementations SHOULD warn if the live workspace is inside
a consumer sync folder and MUST reject backup destinations that resolve to the
workspace root, filesystem root, `.git`, or derived `.openwiki` runtime state.
`backup_after_events`, `event_threshold`, and `min_interval_seconds` MAY be used
to create bounded post-workflow backups without writing a backup for every
single inbox item.
Backup destination config MUST store only destination metadata, environment
variable names, or `credential_ref` values; raw access keys, bearer tokens,
connection strings, private keys, and passwords MUST NOT be written to
`openwiki.json`.
The `runtime.queue.backend` value declares the run queue adapter. `local` uses
the Git-backed run ledger. `postgres` is the implemented hosted adapter.
`redis` is a reserved future adapter name, not a v0.1 implementation. The
`runtime.storage` block declares where large raw
source captures and attachments are stored. `local` uses a content-addressed
filesystem store under `.openwiki/objects`; `s3` and `minio` are the v0.1
S3-compatible object-store adapters. `gcs` is a reserved future live runtime
storage adapter and is rejected by v0.1 config validation; use
`runtime.backups.destinations` for Google Cloud Storage backup artifacts.
`inline_max_bytes` controls when source content stays in Git under
`sources/raw/` instead of moving to object storage.
The `runtime.connectors.http` block declares named URL fetch connectors with
host allow-lists, non-sensitive default headers, and credential references.
Named HTTP connectors MUST declare at least one `allowed_hosts` entry. Named
GitHub and GitLab connectors MUST declare at least one `allowed_repositories`
entry; omitting an allow-list is not treated as "allow all."
Secret values are resolved by deployment-specific secret stores and MUST NOT be
written into `openwiki.json`, run records, source manifests, or static exports.
The v0.1 reference resolver supports `runtime.secrets.backend = "env"`, where a
reference such as `cred:docs-reader` maps to a normalized env var with a short
hash suffix such as `OPENWIKI_SECRET_CRED_DOCS_READER_90A74884`. Env secret
values MAY be raw bearer tokens,
`Bearer ...`, or `header:Header-Name=value`.
The `runtime.connectors.github` and `runtime.connectors.gitlab` blocks declare
repository allow-lists for raw file ingestion through provider APIs. The source
manifest SHOULD store the browser-facing repository URL, while run output MAY
include the non-secret API request URL used by the worker.
The `auth.service_accounts[].tokens[].token_hash` and legacy
`auth.service_accounts[].token_hashes` values MUST store token hashes, not raw
tokens. The reference implementation uses `sha256:<hex>`. Token creation and
rotation workflows print the raw token once, then persist only the hash,
expiration, revocation status, and human-readable metadata.

## 8. Page Format

Pages are Markdown files with YAML frontmatter.

```markdown
---
id: page:concept:agent-memory
type: concept
title: Agent Memory
summary: Overview of memory systems used by AI agents.
status: draft
topics:
  - agents
  - memory
source_ids:
  - source:2026-05-21-001
claim_ids:
  - claim:2026-05-21-001
created_at: 2026-05-21T10:00:00Z
updated_at: 2026-05-21T10:00:00Z
---

# Agent Memory

Agent memory is ...
```

Required frontmatter:

- `id`
- `type`
- `title`
- `status`
- `created_at`
- `updated_at`

Page types:

- `concept`
- `entity`
- `person`
- `organization`
- `project`
- `decision`
- `guide`
- `brief`
- `reference`
