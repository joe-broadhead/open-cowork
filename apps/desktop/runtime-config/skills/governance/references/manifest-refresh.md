# Manifest Refresh (Governance)

Use this after metadata changes so Nova reflects the latest manifest.

## Steps

1) Compile or build your dbt project
- Ensure `manifest.json` is up-to-date.
- Upload to your chosen manifest location.

2) Reload in Nova

```json
{"name":"reload_manifest","arguments":{"manifest_uri":"dbfs:///path/to/manifest.json","refresh_secs":300}}
```

3) Check readiness

```json
{"name":"health","arguments":{}}
```

Wait for `ready` before running `get_metadata_score` or audits.
