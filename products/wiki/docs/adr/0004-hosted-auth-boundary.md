# ADR 0004: Hosted Auth Boundary

Date: 2026-05-29

## Status

Accepted

Amended by [ADR 0008](0008-remote-mcp-oauth-and-policy-bounds.md) for hosted
OAuth 2.1 bearer-token issuance to remote MCP/API clients. ADR 0004 remains the
human-login boundary: OpenWiki still does not implement username/password login
or a general IdP product.

## Context

Enterprises already have SSO, device posture, directory groups, audit policy,
and gateway controls. Implementing a native login stack in OpenWiki v0.1 would
increase product complexity and duplicate infrastructure.

## Decision

OpenWiki does not implement native username/password login, browser sessions, or
OIDC flows in v0.1. Hosted deployments authenticate humans and managed agents at
a trusted proxy, IAP, load balancer, or API gateway. OpenWiki accepts identity
headers only when trusted-header mode is enabled and a shared proxy secret
matches. Service-account bearer tokens provide direct agent and automation
access.

## Consequences

- Local and hosted modes share the same application code.
- Operators keep identity enforcement in their existing SSO boundary.
- Proxies must strip inbound `x-openwiki-*` headers and inject trusted identity.
- Public documentation must be explicit that internet-facing write-capable
  OpenWiki servers belong behind an auth boundary.
