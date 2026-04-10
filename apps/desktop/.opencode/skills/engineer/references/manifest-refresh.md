# Manifest Refresh (Engineer)

Use this after rebuilding or moving the manifest so Nova can index the latest version.

## Steps

1) Compile or build your dbt project
- Ensure `manifest.json` is up-to-date.
- Upload to your chosen manifest location (local, dbfs, s3, gcs, http).

2) Reload in Nova

```json
{"name":"reload_manifest","arguments":{"manifest_uri":"dbfs:///path/to/manifest.json","refresh_secs":300}}
```

You can also use a local path:

```json
{"name":"reload_manifest","arguments":{"manifest_path":"/abs/path/to/manifest.json","refresh_secs":300}}
```

3) Check readiness

```json
{"name":"health","arguments":{}}
```

Wait until status is `ready` before searching.
