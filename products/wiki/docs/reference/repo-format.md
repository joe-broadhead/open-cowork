# Repository Format

An OpenWiki workspace is a Git repository with a small set of conventional
paths.

```text
openwiki.json
wiki/
sources/
claims/
inbox/
proposals/
decisions/
runs/
events/
policy/
.openwiki/
```

Canonical knowledge records live outside `.openwiki/`. Derived runtime data,
indexes, and caches live under `.openwiki/` and can be rebuilt.

Inbox records live in `inbox/items.jsonl`. Payload files submitted through the
local watcher or CLI live under `inbox/payloads/` unless a future adapter stores
large payloads in object storage. Inbox records are private by default and are
not emitted by static export artifacts.

The protocol details live in [Protocol v0.1](../spec/openwiki-protocol-v0.1.md).
