# Telemetry and Privacy

Open Cowork does not include product analytics, crash reporting, or
auto-update telemetry in the upstream build.

The app writes a small local NDJSON event log under Electron's
`userData` directory for diagnostics. Events cover app launch, auth
login, session creation, slow performance markers, and sanitized error
summaries. The log stays on the user's machine and is retained for 14
days.

No remote telemetry endpoint is configured in `open-cowork.config.json`.
The app only sends network traffic needed for the user's configured
runtime work:

- OpenCode provider calls to the selected LLM provider.
- MCP traffic for integrations the user or downstream build enables.
- Provider model-catalog refreshes for providers that expose a dynamic
  catalog, such as OpenRouter.
- OpenCode provider-auth browser flows when the user explicitly signs in
  to a provider such as OpenAI or Anthropic from setup or Settings.
- GitHub links opened by the user in their browser.

Downstream distributions can opt into remote telemetry by setting
`telemetry.enabled` and `telemetry.endpoint` in their own config. That
is not enabled in the public upstream build. See
[Downstream Customization](downstream.md#telemetry-forwarding) for the
exact contract and the privacy implications of turning it on.
