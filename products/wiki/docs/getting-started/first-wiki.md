# First Wiki

The default workspace is a private team wiki. It includes starter pages, a
source, claims, a Team Knowledge Space, and configuration files. Use it to learn
the human workflow before exploring the repository internals.

```sh
openwiki init /tmp/openwiki-demo --title "Demo Wiki"
find /tmp/openwiki-demo -maxdepth 3 -type f | sort
```

Key files:

- `openwiki.json`: workspace configuration
- `wiki/`: Markdown pages with frontmatter
- `sources/`: source manifests and captured evidence
- `claims/`: claims linked to pages and sources
- `policy/`: Spaces, grants, and review rules
- `.openwiki/`: derived local runtime state

After initialization, run:

```sh
openwiki --root /tmp/openwiki-demo index
openwiki --root /tmp/openwiki-demo db rebuild
openwiki --root /tmp/openwiki-demo topics --json
openwiki --root /tmp/openwiki-demo questions --json
```

`index` builds the local search index. `db rebuild` builds the local index-store
used by readiness, graph, and record-browsing paths. Docker runs both on boot;
source-checkout users should run both before serving a new wiki.
