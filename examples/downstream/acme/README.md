# Acme Downstream Deployment Example

This example shows how a company can ship one branded Open Cowork deployment
without forking runtime code.

It includes:

- `open-cowork.config.json`: desktop and cloud product configuration for
  Acme Cowork.
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
