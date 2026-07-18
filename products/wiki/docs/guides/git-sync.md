# Git Sync

Use Git sync to mirror the live OpenWiki workspace to a private repository. Git
sync is separate from backup snapshots: sync keeps the canonical Git ledger
moving, while backups create point-in-time restore artifacts.

## Status Model

`openwiki sync status --json` reports raw Git counters plus a normalized
`diagnostic` object for scripts and humans. The `sync_state` values are:

| State | Meaning | Safe next action |
| --- | --- | --- |
| `clean` | Local workspace and known upstream counters are clean. | No action required. |
| `ahead` | Local commits have not been pushed. | `openwiki sync now --push` |
| `behind` | Remote commits have not been pulled. | `openwiki sync now --pull` |
| `diverged` | Local and remote history both moved. | Inspect with Git; OpenWiki will not auto-merge. |
| `dirty-workspace` | There are uncommitted local files. | Commit explicitly with `--message` or move unrelated files. |
| `conflicted` | Git reports unresolved conflict paths. | Resolve files manually, commit, then sync again. |
| `auth-failed` | The last remote operation failed authorization. | Fix SSH keys, deploy keys, or credential helper credentials. |
| `network-failed` | The last remote operation failed reachability. | Check DNS, proxy, firewall, VPN, or provider availability. |
| `remote-branch-missing` | The remote is reachable but the branch is not present. | Initial push is usually required. |
| `not-configured` | No usable remote URL is configured. | Run `sync connect git`. |
| `not-git-repo` | The workspace is not a Git repository. | Run `sync connect git` or initialize Git. |

Before enabling automation, validate the configured remote:

```sh
openwiki --root /data/wiki sync check-remote --json
```

`check-remote` uses a timeout-bounded `git ls-remote` call and reports
`reachable`, `missing_branch`, `auth_failed`, `network_failed`, or `failed`
without logging credentials.

## GitHub Private Repository

Create an empty private repository, then connect the workspace:

```sh
openwiki --root ~/openwiki-personal sync connect git \
  --remote-url git@github.com:you/private-openwiki.git \
  --branch main
openwiki --root ~/openwiki-personal sync now --push --message "Initial private wiki sync"
openwiki --root ~/openwiki-personal sync status --json
```

For HTTPS remotes, do not put tokens in the URL. Use a Git credential helper or
platform secret-backed helper:

```sh
git config --global credential.helper osxkeychain
openwiki --root ~/openwiki-personal sync connect git \
  --remote-url https://github.com/you/private-openwiki.git \
  --branch main
openwiki --root ~/openwiki-personal sync check-remote
```

For hosted deployments, prefer an SSH deploy key or provider-managed secret
that configures Git credentials at container startup. OpenWiki stores the remote
name and branch in `openwiki.json`; it never needs the raw token.

## GitLab Private Repository

GitLab SSH sync is the same shape:

```sh
openwiki --root ~/openwiki-personal sync connect git \
  --remote-url git@gitlab.com:you/private-openwiki.git \
  --branch main
openwiki --root ~/openwiki-personal sync check-remote
```

For HTTPS, configure a Git credential helper or deploy token outside OpenWiki,
then connect the clean remote URL:

```sh
git config --global credential.helper manager
openwiki --root ~/openwiki-personal sync connect git \
  --remote-url https://gitlab.com/you/private-openwiki.git \
  --branch main
```

Do not use URLs shaped like `https://token@host/group/wiki.git`; OpenWiki rejects
credential-bearing Git remotes and diagnostic output redacts credentials from
Git errors.

## Self-Hosted Git Over SSH

For Gitea, Forgejo, GitLab self-managed, or a plain SSH Git server, configure
SSH normally and connect the repository URL:

```sshconfig
Host git.internal-openwiki
  HostName git.example.internal
  User git
  IdentityFile ~/.ssh/openwiki-sync
  IdentitiesOnly yes
```

```sh
openwiki --root /data/wiki sync connect git \
  --remote-url git@git.internal-openwiki:knowledge/private-wiki.git \
  --branch main
openwiki --root /data/wiki sync check-remote
```

Make sure the deployment environment mounts the SSH key read-only and that the
server host key is pinned through `known_hosts`.

## Local Bare Remote

For home labs, NAS shares, and air-gapped testing, create a bare Git repository
outside the live workspace:

```sh
mkdir -p ~/openwiki-remotes
git init --bare ~/openwiki-remotes/personal-wiki.git
export OPENWIKI_ALLOW_LOCAL_GIT_REMOTE=1
openwiki --root ~/openwiki-personal sync connect git \
  --remote-url ~/openwiki-remotes/personal-wiki.git \
  --branch main
openwiki --root ~/openwiki-personal sync now --push --message "Initial private wiki sync"
```

Local filesystem remotes are disabled by default because hosted deployments
should only accept HTTPS or SSH Git URLs. Use
`OPENWIKI_ALLOW_LOCAL_GIT_REMOTE=1` only for local development, home-lab, NAS,
or air-gapped workflows where the operator controls both paths.

The bare repository is live version history, not a snapshot backup. Continue to
use `openwiki backup create` for restorable point-in-time artifacts.

## SSH Deploy Key

For a personal wiki or a single hosted deployment, prefer an SSH deploy key
scoped to one repository:

```sh
ssh-keygen -t ed25519 -C "openwiki-sync" -f ~/.ssh/openwiki-sync
```

Add the public key to the private repository as a deploy key. Mount or copy the
private key only onto the machine or container that runs OpenWiki, then point
Git at it through normal SSH config:

```sshconfig
Host github.com-openwiki
  HostName github.com
  User git
  IdentityFile ~/.ssh/openwiki-sync
  IdentitiesOnly yes
```

Connect using that host alias:

```sh
openwiki --root /data/wiki sync connect git \
  --remote-url git@github.com-openwiki:you/private-openwiki.git \
  --branch main
```

## Hosted And Container Deployments

In Docker, Cloud Run, Kubernetes, or VM deployments:

- keep the workspace on durable storage
- mount SSH keys or configure a credential helper through the platform secret
  manager
- keep `runtime.sync` in `openwiki.json`, but never raw credentials
- run sync through `openwiki sync now` so the write coordinator blocks agent and
  human writes during pull/push

Enable automation intent in config:

```sh
openwiki --root /data/wiki sync enable --every 15m --pull-on-start --push-after-commit
```

This records the schedule and startup behavior under `runtime.sync`. For a
local personal wiki, run a foreground watcher while testing:

```sh
openwiki --root /data/wiki sync watch --every 15m
```

Then install a user-level schedule:

```sh
openwiki --root /data/wiki service install sync --every 15m
```

See [Personal Automation](personal-automation.md) for launchd, systemd, status,
logs, and failure backoff details.

Agents should use `wiki.sync_now` over MCP or `POST /api/v1/sync/now` over HTTP
instead of raw Git. The operation runs through OpenWiki write coordination,
defaults to pull then push, refuses dirty workspaces, and never commits files on
the agent's behalf. Hosted queues may also run `git.sync` jobs when the queue
backend does not write run ledgers into the same Git working tree.

For event-triggered sync, add the events explicitly:

```json
{
  "runtime": {
    "sync": {
      "remote": "origin",
      "branch": "main",
      "push_after_commit": true,
      "sync_after_events": ["inbox.processed"],
      "debounce_seconds": 30,
      "max_attempts": 3,
      "backoff_seconds": 300,
      "conflict_policy": "stop"
    }
  }
}
```

## Dirty Workspaces And Conflicts

OpenWiki never silently overwrites local changes. A dirty workspace fails until
you either commit it explicitly or move the unrelated files:

```sh
openwiki --root /data/wiki sync now --message "Sync local wiki edits"
```

If Git reports conflicts, OpenWiki leaves the workspace inspectable and records
the failure in `.openwiki/sync/state.json` and structured runtime logs. Use:

```sh
openwiki --root /data/wiki sync explain-conflict
openwiki --root /data/wiki sync repair --json
git status
```

Resolve the conflicted files, commit the result, then push:

```sh
git add wiki path/to/resolved/file
git commit -m "Resolve wiki sync conflict"
openwiki --root /data/wiki sync now --push
```

Use `git merge --abort` only when you intentionally want to abandon the
in-progress Git operation.
