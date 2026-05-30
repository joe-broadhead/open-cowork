# Acme Downstream Deployment Example

This example shows how a company can ship one branded Open Cowork deployment
without forking runtime code.

It includes:

- `open-cowork.config.json`: desktop and cloud product configuration for
  Acme Cowork, including the shared `gateway` section that the headless gateway
  can load with `OPEN_COWORK_CONFIG_PATH`.
- `cloud-values.yaml`: Helm values for the Acme cloud control plane.
- `gateway-values.yaml`: Helm values for the Acme headless gateway.

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

## Shared Config And Secret Injection

`open-cowork.config.json` keeps Desktop, Cloud Web, and Gateway branding in one
audited file:

- `branding` controls the desktop app shell.
- `cloud.publicBranding` controls the Cloud Web workbench and admin dashboard.
- `cloudDesktop` pins the desktop app to the Acme cloud org.
- `gateway.providers` controls headless channel bindings; `gateway.branding`,
  `gateway.cloud`, and `gateway.server` control the gateway label, cloud URL,
  and public URL.

Secrets are deliberately not hardcoded. Gateway service tokens and channel
credentials are referenced with `{env:...}` placeholders listed in
`allowedEnvPlaceholders`; Kubernetes, Compose, or a VPS process manager should
supply those values from the provider secret manager. The separate
`gateway-values.yaml` file shows the equivalent Helm wiring when operators
prefer chart values over the shared config file.
