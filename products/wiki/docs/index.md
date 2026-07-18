# OpenWiki

OpenWiki is a versioned, permissioned knowledge base for humans and agents.

Teams use it to search, read, follow links, propose edits, inspect history, and
protect sensitive knowledge with Spaces. Git remains the canonical ledger, and
the web UI, CLI, HTTP API, MCP server, and static export all serve the same
records.

## What You Can Do

- Search and read team knowledge from a simple web UI.
- Propose, review, apply, and audit changes without losing history.
- Use Spaces to control sensitive knowledge by path and role.
- Let agents search, read, and propose edits through scoped MCP, HTTP, and CLI tools.
- Export a public read-only site when content is meant to be public.

## Start Here

1. [Install OpenWiki](getting-started/installation.md).
2. [Create your first wiki](getting-started/quickstart.md).
3. [Run the first-user path](getting-started/first-user-path.md).
4. [Learn the core concepts](getting-started/concepts.md).
5. [Choose a deployment tier](deployment/overview.md).

## Release Status

OpenWiki `v0.0.0` is a public preview: source checkout, the generated
`@openwiki/cli` package, the `ghcr.io/joe-broadhead/open-wiki` container
image, and static export distribution. Expect rapid iteration on the road to
`v0.1.0`. Static export and read-only hosted deployments are the safest
public paths.
Write-capable hosted deployments require an explicit authentication boundary and
same-origin browser write protection.

## Community And Operations

- [Deployment profiles](deployment/profiles.md) and the
  [operations matrix](deployment/operations/matrix.md) define supported local,
  private, hosted, and static paths.
- [Support](https://github.com/joe-broadhead/open-wiki/blob/master/SUPPORT.md),
  [security reporting](https://github.com/joe-broadhead/open-wiki/blob/master/SECURITY.md),
  [Code of Conduct](https://github.com/joe-broadhead/open-wiki/blob/master/CODE_OF_CONDUCT.md),
  and [release notes](https://github.com/joe-broadhead/open-wiki/blob/master/CHANGELOG.md)
  live at the repository root.
