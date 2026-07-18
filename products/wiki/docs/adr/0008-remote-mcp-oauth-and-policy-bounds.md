# ADR 0008: Remote MCP OAuth And Policy Bounds

Date: 2026-06-14

## Status

Accepted

## Context

OpenWiki already supports local stdio MCP, hosted HTTP MCP, service-account
bearer tokens, and trusted identity headers from an external SSO or proxy
boundary. That model remains the right default for local and team deployments,
but remote MCP clients increasingly expect OAuth discovery, authorization-code
with PKCE, refresh, revocation, and token introspection.

OpenWiki also needs a token-level policy envelope that is narrower than a role
or scope set. A hosted MCP client may be allowed to read only one source family,
one path prefix, a few operations, or one inbox provider even when its scopes
would otherwise permit broader reads.

## Decision

OpenWiki adds a hosted OAuth 2.1 provider for remote MCP and HTTP API clients.
It is an agent/API credential issuer, not a native human login product. Human
browser authentication still belongs at the trusted proxy, IAP, load balancer,
or SSO boundary described in ADR 0004.

OAuth, service-account tokens, and trusted headers all resolve into the same
OpenWiki policy context: actor id, role, scopes, principals, and optional
policy bounds. Bounds are enforced in central policy code, not only in route
handlers. Supported bounds include operations, MCP tool modes, path prefixes,
section ids, source ids, inbox providers, expiry, daily budget, and max
concurrency metadata.

Hosted OAuth requires an explicit issuer from `auth.oauth.issuer`,
`OPENWIKI_OAUTH_ISSUER`, or `OPENWIKI_PUBLIC_ORIGIN`. OAuth fails closed when
the issuer is missing or ambiguous. Dynamic client registration is disabled by
default. Client secrets, authorization codes, access tokens, and refresh tokens
are persisted only as hashes or metadata. Local stdio MCP does not require or
use OAuth.

## Consequences

- Existing service-account and trusted-header deployments continue to work.
- Remote MCP clients can use OAuth discovery and PKCE without bypassing
  OpenWiki scopes, policy sections, or tool modes.
- Source/path scoped tokens are filtered across read surfaces before results,
  facets, and diagnostic counters are returned.
- Hosted deployments need operational storage for OAuth client/token metadata,
  revocation, request logs, and budget counters. The Postgres runtime schema
  includes these tables.
- Operators must set issuer/origin and proxy assumptions deliberately before
  exposing OAuth or HTTP MCP outside a trusted local network.
