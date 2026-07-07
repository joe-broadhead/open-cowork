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
  to a provider such as OpenAI or GitHub Copilot from setup or Settings.
- GitHub links opened by the user in their browser.

## Local, cloud, and gateway data boundaries

The workspace selector is a privacy boundary:

- **Local workspace** data stays on the desktop except for the model,
  provider, MCP, or user-opened network calls needed for that local runtime
  work.
- **Cloud workspace** prompts, cloud artifacts, event projections, workflow
  metadata, portable settings, custom-content metadata, and policy verdicts are
  sent to the configured Open Cowork Cloud org so desktop, web, and gateway
  clients can sync.
- **Gateway** messages are channel input for cloud workspaces. The gateway
  sends channel text, approved attachments, and interaction decisions to the
  cloud control plane; it does not receive local desktop runtime state.

Open Cowork does not implicitly sync local threads, local project files, local
host paths, local stdio MCP commands, machine runtime config, provider API
keys, OAuth tokens, or refresh tokens. Secrets sync only as metadata or secret
references where a cloud deployment explicitly supports them. The renderer uses
the workspace support matrix to disable local-only actions in cloud workspaces
and to show the server policy reason.

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

## Opt-in adoption telemetry (content-free)

Separately from the diagnostic forwarder above, Open Cowork ships an
**opt-in, content-free adoption signal**. It is **off by default** and
sends **nothing** unless an operator explicitly enables it. When enabled,
it reports only coarse, anonymous usage so maintainers and self-hosters
can gauge adoption — never the substance of anyone's work.

What it *may* send when enabled:

- Coarse lifecycle events — that the app launched (with only the OS
  platform string `darwin`/`win32`/`linux` and the app's semantic
  version) and that it became ready.
- Coarse interaction events chosen from a fixed vocabulary — which
  built-in surface was opened (`home`, `chat`, `team`, `tools`,
  `playbooks`, `settings`, `admin`, `artifacts`, `knowledge`,
  `channels`, `onboarding`), whether a session streamed, an
  approval decision as the enum `approved`/`denied`, and a workflow
  run trigger as the enum `manual`/`scheduled`/`webhook`.

What it **never** sends — by construction, not by policy:

- Prompts, message content, chat transcripts, or model output.
- File contents, file names, or **any filesystem path**.
- Email addresses, API keys, tokens, hostnames, or free-form text.
- Any device id, install id, or user identifier — adoption events carry
  no identifier at all.

Every event passes through a strict allowlist guard
(`redactAdoptionEvent` in
`packages/runtime-host/src/adoption-telemetry.ts`). The guard rejects any
event name not on a fixed list and drops any property that is not both
on that event's schema and accepted by a coarse validator (fixed enums,
bounded integers, booleans, or a strict semver). There is intentionally
no validator that accepts arbitrary text, so prompts, content, and paths
have no way through even if a caller passes them in by mistake. A unit
test (`tests/adoption-telemetry.test.ts`) asserts that injected prompts,
file paths, emails, and secrets never appear in a transmitted payload.

### Enabling, self-hosting, or disabling it

The sink is fully configurable and HTTPS-only. Point it at your own
collector, or leave it unset to transmit nothing. In
`open-cowork.config.json`:

```json
{
  "telemetry": {
    "adoption": {
      "enabled": true,
      "endpoint": "https://adoption.example.com/ingest",
      "headers": { "Authorization": "Bearer {env:EXAMPLE_ADOPTION_TOKEN}" }
    }
  }
}
```

Operators who cannot edit the packaged config can toggle it with
environment variables, which take precedence over the config file:

- `OPEN_COWORK_ADOPTION_TELEMETRY_ENABLED` — `1`/`true` to enable,
  `0`/`false` to force off.
- `OPEN_COWORK_ADOPTION_TELEMETRY_ENDPOINT` — the HTTPS collector URL.

To disable entirely, leave `telemetry.adoption` unset (the default), set
`enabled: false`, or set `OPEN_COWORK_ADOPTION_TELEMETRY_ENABLED=0`. With
no endpoint configured the emitter performs no network I/O at all.
