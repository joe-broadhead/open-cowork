# npm deprecation notes (if/when public names exist)

Run only after a public monorepo package is the recommended install path.

```bash
# Example — only if opencode-gateway was published under that name:
npm deprecate opencode-gateway@"*" "Moved to open-cowork monorepo products/gateway. Install cowork-gateway from the open-cowork repository."

# Prefer dual-bin on @openwiki/cli rather than hard-deprecating openwiki immediately.
# If a confusing standalone name exists:
# npm deprecate <old-name>@"*" "Use cowork-wiki / @openwiki/cli from open-cowork products/wiki."
```

Private packages that never published to npm need no deprecation action.
