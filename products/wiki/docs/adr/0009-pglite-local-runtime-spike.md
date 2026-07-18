# ADR 0009: PGLite Local Runtime Spike

## Status

Accepted. PGLite is deferred as a default runtime and may be explored only as an
experimental, explicitly enabled local runtime spike.

## Context

OpenWiki's current local architecture is Git canonical data plus rebuildable
SQLite/index-store derived indexes. Hosted deployments can opt into Postgres
runtime stores for serving reads, search, operational state, queueing, rate
limits, sessions, OAuth metadata, request logs, and write coordination.

GBrain demonstrates a productive embedded Postgres/PGLite shape for a
database-first memory engine. OpenWiki has a different invariant: repository
files are canonical, and every runtime/index surface must be derivable from Git
state or explicit runtime metadata. A PGLite default would change packaging,
locking, backup, migration, and extension behavior for every local user, so it
needs proof before it can replace the existing SQLite local profile.

## Decision

OpenWiki keeps SQLite/index-store as the supported local default for 0.2.
PGLite is not required for local installs, OpenCode/OpenClaw use, vector search,
MCP, static export, or release validation.

A PGLite experiment is allowed only behind a clearly named experimental runtime
package or feature flag. The experiment must not alter canonical record layout,
make Bun mandatory, or make hosted Postgres optionality ambiguous. The spike can
reuse OpenWiki's Postgres schema concepts, but it must continue treating local
Git records as canonical and PGLite rows as derived or operational state.

## Required Promotion Gates

Before PGLite can move beyond experimental status, it must prove:

- record, source, claim, fact, take, event, and run derivation parity with the
  current SQLite/index-store path;
- search, graph, recall, queue, auth/session, rate-limit, and request-log
  behavior equal to the supported local and hosted runtime contracts;
- deterministic rebuild and freshness behavior that never requires request-path
  full repository scans;
- backup, restore, crash-recovery, and file-locking behavior on macOS, Linux,
  and the supported Node lines;
- migration, rollback, and corruption-recovery procedures that preserve Git
  canonical data and can rebuild derived tables;
- package/install behavior for the generated `@openwiki/cli` tarball without
  hidden native binary, platform, or postinstall surprises;
- vector-extension behavior, if claimed, including dimension/model migrations
  and a fallback when vector support is unavailable;
- tests covering local setup, static export, MCP read/proposal mode, OpenCode
  integration install, backups, and runtime health with PGLite enabled.

## Consequences

- The documented happy path remains `openwiki setup personal` or
  `openwiki setup team`, followed by local stdio MCP and optional OpenCode pack
  installation.
- `pnpm validate`, release smoke, and CI stay runnable without PGLite or a
  model provider.
- Roadmap work may add a PGLite spike issue, but it must be tracked separately
  from the release-ready local profile.
- Any docs or examples mentioning PGLite must label it experimental or deferred
  until the promotion gates above have evidence.

## Non-Goals

- Replacing Git-backed canonical records with an embedded database.
- Making PGLite or pgvector mandatory for personal wikis.
- Requiring Bun or a separate runtime toolchain for OpenWiki users.
- Claiming Postgres/PGLite parity without backup, restore, crash-recovery, and
  migration evidence.
