# Spaces And Permissions

OpenWiki Spaces control who can read, propose, review, maintain, and administer
knowledge by path.

Spaces are the human-facing layer over Git-backed policy records under
`policy/`. Space changes are proposed through the same governance flow as
content changes.

Important rules:

- Write-capable deployments should sit behind organization SSO or a trusted
  reverse proxy.
- `group:all-users` means authenticated users supplied by that trusted boundary
  in private team deployments.
- Space grants define visibility and role access.
- Review operations can require distinct reviewers.
- Permission previews are available through CLI, HTTP, and the Spaces UI. They
  show matching Spaces, allowed operations, and record-level reasons for why a
  page, proposal, or source is visible or hidden.

Use the CLI for dry runs:

```sh
openwiki --root /data/wiki policy preview \
  --group finance \
  --target-path wiki/finance/budget.md \
  --operation wiki.propose_edit
```

Use the UI for common admin workflows:

- open `/spaces` to create or edit a Space proposal without hand-editing JSON
- open `/spaces/preview` to answer whether an actor or group can read, propose,
  or review a path
- open `/admin/service-accounts` to inspect sanitized service-account token
  metadata

CLI `policy propose-section` is additive by default. Use `--replace-grants`
when editing an existing Space and you want the supplied viewer, contributor,
reviewer, maintainer, and admin lists to replace the current grants for that
Space.

For public deployments, document which paths are public and which require a
trusted identity boundary.
