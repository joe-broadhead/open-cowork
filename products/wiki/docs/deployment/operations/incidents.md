# Incidents

## Incident Playbooks

The Incident Runbooks page contains command-oriented procedures for auth
exposure, stuck write lock, stale derived store, failing source fetch, queue
backlog, and restore drills.

### Unauthorized Writes

Confirm the deployment is behind the intended proxy, `OPENWIKI_PUBLIC_ORIGIN`
matches the public URL, and trusted headers require
`OPENWIKI_TRUST_AUTH_HEADERS_SECRET`. Rotate service-account tokens and proxy
secrets if header trust was exposed.

### Git Divergence

Stop workers, inspect `openwiki --root /data/wiki git status --json`, and
resolve the branch using normal Git operations. Rebuild indexes after the branch
is clean.

### Queue Backlog

Check `runs monitor`, database availability, worker logs, and failed run events.
Retry only idempotent jobs until the failing input is understood.

### Search Or Read Drift

Run a full index rebuild and Postgres sync. If drift remains, compare the Git
commit reported by the derived store with the current workspace commit.

### Object Capture Missing

Verify the object storage credentials, bucket, and endpoint in `openwiki.json`
credential refs. Restore the missing object from bucket backups before editing
source manifests.
