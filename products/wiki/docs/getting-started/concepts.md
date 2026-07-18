# Concepts

## Canonical Store

The OpenWiki repository is the source of truth. Pages, proposals, decisions,
Spaces policy, events, and supporting evidence are ordinary files that can be
reviewed and versioned with Git.

## Wiki Surfaces

Most users start with the web UI: search, read, follow links, propose edits,
and inspect history. Agents use the same records through MCP, HTTP, or CLI.
Static export is the public read-only path.

## Derived Runtime

SQLite, Postgres, search indexes, static sites, and object storage are serving
layers. They can be rebuilt from the Git-backed repository.

## Governance

Writes flow through proposals, reviews, decisions, validation reports, and
optional Git commits. This keeps knowledge changes auditable for both people and
agents.

## Spaces

Spaces define visibility and operation permissions by path. A hosted write
deployment should sit behind SSO or a trusted reverse proxy so OpenWiki receives
verified actors, principals, and groups.
