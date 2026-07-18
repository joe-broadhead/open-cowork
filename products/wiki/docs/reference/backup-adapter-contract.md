# Backup Adapter Contract

OpenWiki backup destinations are snapshot artifact stores. They are not live
workspace backends and must not run the Git working tree from consumer sync
folders or object stores.

Every advertised backup destination must satisfy this contract before it is
listed as supported.

## Object Operations

Adapters expose one provider-neutral object surface:

| Operation | Requirement |
| --- | --- |
| `putObject` | Write one artifact object under a validated relative key. |
| `getObject` | Read one artifact object back for verification or restore. |
| `listObjects` | List artifact objects under a validated prefix with size and update metadata when available. |
| `deleteObject` | Delete one object and tolerate already-missing objects where the provider allows it. |
| `deletePrefix` | Delete only objects below the configured backup prefix. |
| `status` | Return readiness, credential state, capabilities, and redacted diagnostics. |

Object keys and prefixes must reject absolute paths, `..`, empty path parts,
NUL bytes, control characters, and path parts that start with `-`. This blocks
filesystem traversal and provider option injection before commands reach a
cloud SDK or subprocess bridge.

## Durability Semantics

A successful backup write means the artifact is restorable, not merely that an
upload request was accepted.

OpenWiki enforces this in three layers:

- each uploaded object is read back and byte-compared before the upload step
  succeeds
- `manifest.json` is uploaded last, so incomplete uploads do not look complete
  to normal list, verify, or restore flows
- `list` marks backups invalid when the manifest is missing or the checksum
  file hash does not match the manifest

`verify` and `restore` still perform full checksum verification over every
declared payload file. `list` is a readiness signal, not a substitute for
restore rehearsal.

## Status JSON

`openwiki backup status --json` returns stable provider-neutral fields for each
destination:

```json
{
  "id": "aws",
  "kind": "s3",
  "status": "ok",
  "readiness": "ok",
  "provider_state": "configured",
  "credential_state": "env_configured",
  "credential_requirements": [
    {
      "source": "env",
      "name": "AWS_ACCESS_KEY_ID",
      "purpose": "Access key id used only at runtime.",
      "required": true,
      "present": true
    }
  ],
  "credential_lifecycle": {
    "rotation_mode": "manual",
    "rotate_steps": ["Create a new least-privilege access key in the provider."],
    "revoke_steps": ["Disable and delete the old key after verification passes."],
    "verify_steps": ["openwiki backup verify latest --destination aws --json"]
  },
  "configured_prefix": "openwiki-backups",
  "capabilities": {
    "put": true,
    "get": true,
    "list": true,
    "delete": true,
    "delete_prefix": true,
    "status": true,
    "durable_readback": true,
    "manifest_final_publish": true,
    "prefix_scoped_delete": true
  },
  "diagnostics": [],
  "backup_count": 3,
  "latest_backup_id": "openwiki-backup-workspace-2026-01-01T00-00-00-000Z",
  "last_verification": {
    "backup_id": "openwiki-backup-workspace-2026-01-01T00-00-00-000Z",
    "verified_at": "2026-01-01T00:05:00.000Z"
  }
}
```

Credential state values are:

| Value | Meaning |
| --- | --- |
| `not_required` | Local-folder destination; no provider credential is needed. |
| `env_configured` | All configured credential environment variables are present. |
| `env_missing` | One or more required credential environment variables are absent or empty. |
| `external` | Credentials are managed by an external provider tool such as rclone. |
| `unsupported` | The destination kind is reserved but not implemented in this release. |

Provider state values are:

| Value | Meaning |
| --- | --- |
| `configured` | Credential evidence is present and the destination status check did not detect a provider error. |
| `missing` | A required environment variable or external credential reference is missing. |
| `expired` | Provider evidence indicates an expired token or grant. |
| `denied` | Provider evidence indicates authorization, IAM, key, or permission denial. |
| `quota_exceeded` | Provider evidence indicates object-store or account quota exhaustion. |
| `rate_limited` | Provider evidence indicates throttling or a rate-limit response. |
| `unknown` | The provider failed without enough evidence for a more specific state. |
| `unsupported` | The destination kind is reserved but not implemented in this release. |

Diagnostics must be redacted. They must not include access tokens, refresh
tokens, private keys, signed URLs, bearer tokens, passwords, cloud secret keys,
or local credential-file contents.

## Provider Requirements

Supported providers must prove:

- create, list, verify, restore, and prune through the standard backup CLI
- partial uploads are not listed as valid restorable backups
- checksum-file mismatches are marked invalid before restore
- full payload checksum mismatches fail `verify` and `restore`
- auth, quota, rate-limit, missing-provider, and unavailable states are reported
  without leaking secrets
- retention/prune deletes only below the configured prefix
- no raw provider secrets are written to `openwiki.json`, events, manifests,
  generated docs, Git config, or process arguments

The reusable conformance harness lives in
`tests/support/backup-adapter-conformance.ts`. New providers should add a fake
or local emulator test that exercises the harness plus at least one workflow
test that creates a real OpenWiki backup artifact.

## Local Folder Exception

Local-folder backup destinations use atomic directory staging and rename rather
than object-level upload calls. They satisfy the same product contract through
the backup workflow tests: unsafe paths are rejected, partial staging
directories are hidden, checksum verification is mandatory before restore, and
retention only deletes backup directories under the configured destination.

Local folders remain the recommended bridge for Google Drive, iCloud, Dropbox,
NAS, and similar consumer tools when the provider sync client owns the backup
folder.
