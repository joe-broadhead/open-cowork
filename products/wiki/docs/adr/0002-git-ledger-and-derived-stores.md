# ADR 0002: Git Ledger And Derived Stores

Date: 2026-05-29

## Status

Accepted

## Context

OpenWiki needs to be usable by local users, agents, static publishers, and
hosted teams without making one database engine the product boundary. The wiki
also needs reviewable history, portable backups, and human-readable recovery
paths.

## Decision

Git-backed repository files are the canonical ledger. SQLite, Postgres, search
indexes, graph indexes, static exports, and runtime queues are derived serving
layers. Derived stores can be rebuilt from Git records and must not introduce
new canonical record semantics.

## Consequences

- Local-first and static-export deployments remain simple and portable.
- Hosted deployments can use Postgres for read/search/job performance without
  changing protocol records.
- Recovery and audits can inspect Git history directly.
- Write paths must coordinate derived-store updates carefully and document when
  a rebuild is required.
