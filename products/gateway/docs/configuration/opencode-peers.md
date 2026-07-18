# Trusted OpenCode Peers

Gateway defaults to fetching OpenCode only on **local** hosts
(`127.0.0.1`, `localhost`, `*.localhost`, `host.docker.internal`).

To use full OpenCode on a **trusted lab/remote** `opencode serve` instance:

```json
{
  "opencodeUrl": "https://opencode.lab.example",
  "opencodePeers": {
    "lab": {
      "baseUrl": "https://opencode.lab.example",
      "allowHostnames": ["opencode.lab.example"],
      "requireHttps": true,
      "basicAuth": {
        "usernameEnv": "OPENCODE_SERVER_USERNAME",
        "passwordEnv": "OPENCODE_SERVER_PASSWORD"
      }
    }
  }
}
```

## Behavior

| Concern | Implementation |
| --- | --- |
| Host allowlist | `opencode-peer-hosts` + `safeOpenCodeBaseUrl` (SSRF closed by default) |
| Credentials | **Required** when `basicAuth` is set — read from env/file, never URL userinfo |
| Client wiring | `createGatewayOpenCodeClient` injects `Authorization: Basic …` via headers + fetch wrapper |

OpenCode side:

```bash
OPENCODE_SERVER_PASSWORD=... opencode serve --hostname 0.0.0.0 --port 4096
```

## Claim boundary

Trusted peer + Basic auth is **single-operator local/lab beta**, not multi-tenant
hosted production certification.
