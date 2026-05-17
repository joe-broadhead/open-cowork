# Telemetry and Privacy

Open Cowork does not include product analytics, crash reporting, or
auto-update telemetry in the upstream build.

The app writes a small local NDJSON event log under Electron's
`userData` directory for diagnostics. Events cover app launch, auth
login, session creation, slow performance markers, and sanitized error
summaries. The log stays on the user's machine and is retained for 14
days.

Examples of local diagnostic events:

- App lifecycle: startup, shutdown, renderer error summaries, runtime
  reconnect attempts, and slow-operation markers.
- User-initiated runtime work: session ids, selected project directory
  status, workflow ids, and whether a workflow run was manual,
  scheduled, or webhook-triggered.
- Integration status: MCP connection/auth states and provider model
  catalog refresh results.

The diagnostic log is sanitized before it is written. API keys, OAuth
tokens, JWTs, cloud credentials, email addresses, and home-directory
paths are redacted by the main-process logger. Chat message bodies,
attachment contents, workflow webhook payloads, and credential values
are not written as routine telemetry.

No remote telemetry endpoint is configured in `open-cowork.config.json`.
The app only sends network traffic needed for the user's configured
runtime work:

- OpenCode provider calls to the selected LLM provider.
- MCP traffic for integrations the user or downstream build enables.
- Provider model-catalog refreshes for providers that expose a dynamic
  catalog, such as OpenRouter.
- OpenCode provider-auth browser flows when the user explicitly signs in
  to a provider such as OpenAI from setup or Settings.
- GitHub links opened by the user in their browser.

Local workflow webhooks are loopback-only. They listen on
`127.0.0.1`, require bearer/header/HMAC authentication, and do not send
webhook payloads to any Open Cowork service. A workflow run may still
contact the user's selected LLM provider or enabled MCP integrations as
part of the task the user configured.

Settings can export a diagnostics bundle for support. That export is a
user-initiated local file. It includes sanitized logs and app/runtime
metadata useful for debugging; it does not include unmasked provider
credentials or full chat transcript bodies.

Downstream distributions can opt into remote telemetry by setting
`telemetry.enabled` and `telemetry.endpoint` in their own config. That
is not enabled in the public upstream build. See
[Downstream Customization](downstream.md#telemetry-forwarding) for the
exact contract and the privacy implications of turning it on.
