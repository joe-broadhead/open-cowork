# ADR 0007: Consumer Backup Adapters

## Status

Accepted

## Context

OpenWiki needs backup paths for personal users who do not want to operate S3,
GCS, MinIO, rclone-backed consumer storage, or a private Git remote. The common consumer choices are
Google Drive, WebDAV-backed NAS products, and rclone. These destinations are for
snapshot backup artifacts only. The live OpenWiki workspace remains a Git
workspace on a normal filesystem.

## Decision

OpenWiki ships an rclone bridge first. Direct Google Drive and WebDAV adapters
are deferred until their auth, token storage, retry, and provider-behavior
contracts can be implemented without weakening the current secret-handling and
restore guarantees.

The rclone bridge uses a configured rclone remote such as
`gdrive:OpenWiki Backups`. OpenWiki stores only the remote name/path and backup
prefix in `openwiki.json`. Provider credentials remain in rclone's own config or
OS-specific credential storage. OpenWiki invokes only the allowlisted `rclone`
binary name through `execFile`, never through a shell, and never passes provider
secrets on the command line.

## Provider Evaluation

| Provider | Fit | Auth | Reliability | Decision |
| --- | --- | --- | --- | --- |
| Google Drive direct | Good for non-technical personal users | Requires OAuth device/browser flow, refresh-token storage, account display, and revocation UX | Needs resumable uploads, quota/rate handling, and app-folder scoping | Deferred until OpenWiki has a secure token storage story |
| WebDAV direct | Good for Nextcloud, Synology, TrueNAS, and NAS users | Usually username/password or app password; must forbid raw credentials in URLs/config | Server behavior varies for ETag, quota, locking, overwrite, and TLS | Deferred until a conformance matrix exists |
| rclone bridge | Good for advanced users and broad provider coverage | Delegated to configured rclone remotes; OpenWiki sees no provider secret | rclone handles provider specifics; OpenWiki verifies readback checksums | Shipped first |

## Production Requirements

- Uploads are read back and byte-compared before success is reported.
- Manifest upload remains the final publish step, so incomplete backup
  directories are ignored or marked invalid by list/restore flows.
- List, verify, restore, and prune use the same backup artifact lifecycle as S3,
  GCS, rclone-backed consumer storage, and local folders.
- Missing binary, missing remote, auth, quota, rate-limit, and generic provider
  errors are reported without leaking provider tokens or embedded credentials.
- `openwiki backup status --json` reports readiness and credential state without
  exposing secrets.

## Consequences

- Personal users can use Google Drive, Dropbox, OneDrive, WebDAV, SFTP, and many
  NAS/cloud providers today by configuring rclone outside OpenWiki.
- Direct Google Drive and WebDAV adapters remain explicit future work rather than
  partial implementations.
- OpenWiki keeps its dependency footprint small and avoids storing OAuth refresh
  tokens before it has an OS keychain or credential-reference design.

## Non-Goals

- rclone is not a live workspace synchronization backend.
- Google Drive, WebDAV, Dropbox, OneDrive, and similar providers are not
  supported live workspace filesystems.
- OpenWiki does not manage rclone provider credentials.
