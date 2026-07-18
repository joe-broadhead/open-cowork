# ADR 0006: Graph Index And Search

Date: 2026-05-29

## Status

Accepted

## Context

Humans and agents both need more than full-text search: they need backlinks,
related pages, stale records, governance signals, citations, and explainable
retrieval paths.

## Decision

OpenWiki materializes graph edges and search documents as derived indexes. The
graph index captures page, source, claim, topic, proposal, and governance
relationships. Search combines lexical retrieval with graph-aware signals while
keeping canonical records in Git.

## Consequences

- Graph and search outputs are rebuildable and safe to expose through CLI, HTTP,
  MCP, and static artifacts.
- Static export can publish machine-readable graph/search artifacts without
  introducing a server dependency.
- Large installations need recurring benchmark evidence and, over time,
  incremental rebuild paths.
- Search and graph implementations must keep results explainable for human
  review and agent grounding.
