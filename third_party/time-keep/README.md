# Bundled time-keep (native MCP binary)

Open Cowork ships [joe-broadhead/time-keep](https://github.com/joe-broadhead/time-keep)
as the sole agent time MCP (replacing the previous Node `mcps/clock` package).

## Pin

See [`VERSION`](./VERSION) — must match a GitHub Release tag on that repo.

## Fetch platform binaries

```bash
pnpm binaries:time-keep
```

Downloads checksum-verified release assets into
`third_party/time-keep/platforms/<platform-arch>/time-keep` (gitignored).

Desktop packaging (`pnpm --dir apps/desktop dist …`) runs the fetch step and
copies the matching binary into `Resources/bin/time-keep` inside the app
bundle so GUI launches do not depend on shell PATH.
