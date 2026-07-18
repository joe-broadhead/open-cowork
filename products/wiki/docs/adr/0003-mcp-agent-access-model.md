# ADR 0003: MCP Agent Access Model

Date: 2026-05-29

## Status

Accepted

## Context

OpenWiki has to support local stdio agents and hosted HTTP MCP clients while
keeping the human wiki permissions model understandable. Agents should not get a
separate permission universe.

## Decision

MCP tools expose human-equivalent wiki capabilities through three modes:
`read`, `proposal`, and `write`. Local stdio MCP is intended for trusted local
workspaces. Hosted MCP should use service-account bearer tokens, trusted proxy
identity, or both. Write-capable tools require elevated scopes and remain behind
the same operation contracts as HTTP and CLI surfaces.

## Consequences

- Agent access maps to existing roles, scopes, proposals, and audit events.
- Hosted agent deployments can use least-privilege service accounts.
- Tool names and protocol contracts stay stable across stdio and streamable HTTP
  transports.
- Documentation must distinguish local trusted agents from hosted authenticated
  agents.
