# Example Downstream Deployment

This example shows how an organization can ship one branded Open Cowork
deployment without forking runtime code. All names, domains, buckets, and ids
are placeholders reserved for examples; real customer or cloud-provider values
belong in a private downstream repo or secret manager.

It includes:

- `open-cowork.config.json`: desktop and cloud product configuration for
  Example Cowork, including the shared `gateway` section that the **Channel
  Gateway** headless process can load with `OPEN_COWORK_CONFIG_PATH`.

### Progressive disclosure (product purity)

Desktop secondary Studio surfaces (`knowledge`, `approvals`, `channels`,
`artifacts`) default **off** when omitted. Only enable them when the deploy
has the backing plane (e.g. `channels` needs Cloud + Channel Gateway). See
`docs/progressive-disclosure.md`. Do not auto-register durable Gateway
(`cowork-gateway`) or Wiki (`cowork-wiki`) MCP entries in public defaults.
- `cloud-values.yaml`: Helm values for the example cloud control plane.
- `gateway-values.yaml`: Helm values for the example headless gateway.

The shared config declares `contractVersion: 1`, the current downstream
distribution contract documented in `docs/downstream-contract.md`.

The values pin images with an example release tag. Replace that tag with an
immutable downstream release tag or digest in a private deployment repo; do not
ship `latest`, `stable`, or another mutable registry alias.

## Distribution Modes

Internal enterprise mode:

- preconfigure the desktop app with `cloudDesktop.preconfiguredConnections`
  and `cloudDesktop.requireManagedOrg`
- run cloud behind the company OIDC provider
- restrict profiles to approved agents, tools, MCPs, and project sources
- run the gateway inside company infrastructure with service/API tokens

Managed BYOK SaaS mode:

- keep the OSS desktop and cloud deployable
- brand the hosted dashboard through `cloud.publicBranding`
- require users to add provider keys through BYOK
- expose gateway connection setup from the dashboard
- charge for hosted sync, workers, object storage, and managed channel bindings

The OpenCode runtime boundary does not change in either mode. OpenCode owns
execution; Open Cowork owns branding, policy, sync, tenancy, and deployability.

Self-host installs can keep `cloud.billing.enabled=false` and
`cloud.billing.provider=none`. Managed SaaS billing is a downstream hosting
overlay, not a requirement for the OSS self-host path.

## Shared Config And Secret Injection

`open-cowork.config.json` keeps Desktop, Cloud Web, and Gateway branding in one
audited file:

- `branding` controls the desktop app shell.
- `cloud.publicBranding` controls the Cloud Web workbench and admin dashboard.
- `cloudDesktop` pins the desktop app to the configured cloud org.
- `gateway.productMode=cloud_channel` makes this a Cloud Channel Gateway, not
  a Standalone Team Gateway runtime.
- `gateway.providers` controls headless channel bindings; `gateway.branding`
  and `gateway.server` control the gateway label, server, and public URL.

Secrets are deliberately not hardcoded. Channel credentials are referenced
with `{env:...}` placeholders listed in `allowedEnvPlaceholders`; the Gateway
service token and cloud connection are deployment-only environment settings.
Set `OPEN_COWORK_CLOUD_BASE_URL`, `OPEN_COWORK_GATEWAY_SERVICE_TOKEN`, and
`OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS` in Kubernetes, Compose, or the
VPS process manager from the provider secret manager. File-backed Gateway
cloud connection fields are intentionally rejected. The separate
`gateway-values.yaml` file shows the equivalent Helm wiring when operators
prefer chart values over the shared config file.
