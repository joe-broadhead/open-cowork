---
title: Custom MCPs
description: Add local stdio, remote HTTP/SSE, or downstream MCPs to Open Cowork.
---

# Custom MCPs

Custom MCPs let users add tools to Open Cowork without changing the
OpenCode runtime. Open Cowork owns the desktop form, validation, storage,
and permission presentation; OpenCode owns MCP execution and tool-call
semantics once the MCP is registered.

Use this guide when you want to connect a local stdio MCP, a remote HTTP
or SSE MCP, or a downstream company MCP that should appear on the
Tools & Skills page and in the agent builder.

## Trust model

Treat every custom MCP as executable or network-active code:

- stdio MCPs are local processes started by OpenCode.
- HTTP/SSE MCPs are remote services OpenCode connects to.
- MCP tools can receive model-generated inputs.
- Agents assigned to an MCP can request that MCP's tools.

Custom MCPs are ask-first by default. Mark an MCP as trusted only when
you control the server or have reviewed the service and its tool surface.

## Add an MCP from the app

1. Open **Tools & Skills**.
2. Select **Add MCP**.
3. Choose **Local stdio MCP** or **Remote HTTP / SSE MCP**.
4. Enter a stable MCP id. Use lowercase words with hyphens or
   underscores. This id becomes the runtime namespace, such as
   `mcp__warehouse__*`.
5. Add a clear label and description so users understand what the MCP can
   access.
6. Optionally set chat trace labels, such as `ticket action` /
   `ticket actions`, so tool-call summaries read naturally.
7. Fill in connection details.
8. Leave approval mode at the default unless the MCP is fully trusted.
9. Test the MCP from the form.
10. Save it, then reload the runtime if prompted.

Project-scoped MCPs are stored under the selected project's private
`.opencowork/` config area. Machine-scoped MCPs are stored in the app's
managed OpenCode config directory. In both cases Open Cowork keeps
sidecar metadata, such as labels and approval mode, separate from the
OpenCode-native MCP entry.

## Chat trace labels

The chat timeline groups adjacent tool calls into short summaries such as
`2 github issue actions` or `1 chart`. For custom MCPs, the Add MCP form
stores optional `traceLabel` and `tracePluralLabel` sidecar metadata:

```jsonc
{
  "name": "jira",
  "label": "Jira",
  "traceLabel": "ticket action",
  "tracePluralLabel": "ticket actions"
}
```

If the labels are blank, Open Cowork derives a readable fallback from the
MCP display name, such as `Jira tool`. Downstream distributions that bundle
company MCPs can also define `toolTrace.additionalRules` in
`open-cowork.config.json`; see [Configuration](configuration.md#tool-trace-rules).

## Local stdio MCPs

Local MCPs start a command on the user's machine:

```text
Command: node
Args:    /path/to/server/dist/index.js
```

The app validates local MCP commands before saving:

- shell binaries are rejected.
- shell metacharacters are rejected.
- `-c`, `--eval`, and similar eval flags are rejected.
- `..` traversal in command paths is rejected.
- project-relative commands are contained to the selected project.
- renderer payloads for command, args, environment, labels, and
  descriptions are size and count capped.

Prefer direct executable commands over shell wrappers. For example, use
`node /absolute/path/to/server.js` instead of `bash -lc ...`.

## Remote HTTP / SSE MCPs

Remote MCPs use a URL:

```text
URL: https://mcp.example.com/api
```

The default URL policy is public-internet only. Open Cowork rejects:

- loopback and localhost targets
- link-local addresses
- RFC1918 private networks
- cloud metadata endpoints
- other reserved or special-use IP ranges
- hostnames that resolve to blocked addresses at validation time

Use `https://` for remote MCPs. If the MCP is an internal corporate
service or local development server, the user must explicitly enable
**Allow private network**. That opt-in is logged and should only be used
for endpoints the user or downstream distribution controls.

Cloud metadata endpoints remain blocked even when private-network access
is enabled.

## Headers and OAuth

For static header-based MCPs, add only the headers the service needs.
Header keys and values are capped before persistence.

For OAuth-backed HTTP MCPs, leave headers blank when the MCP expects
OpenCode's browser-based OAuth flow. Save the MCP, reload the runtime,
then authenticate from the MCP status panel.

Bundled MCPs can also ship credential form metadata. Use a text field
for free-form values, or `type: "select"` / `type: "radio"` with
`options[]` when the MCP expects one of a fixed set of values. A field
can declare `when: { "key": "...", "op": "eq" | "neq", "value": "..." }`
to appear only for a selected mode. Changing modes does not delete
hidden stored values; the next save only patches fields the user edited.

## Google-auth stdio MCPs

Trusted local Google MCPs can opt into using the app's Google OAuth
session. When `googleAuth` is enabled and the user is signed in, Open
Cowork writes a short-lived ADC file under the app's private userData
directory and passes `GOOGLE_APPLICATION_CREDENTIALS` to that MCP
process.

Use this only for MCPs your distribution trusts. If the user is not
signed in or the token is expired, the MCP starts without Google
credentials and authenticated calls fail normally.

## Approval modes

Custom MCPs default to approval prompts. Assigned agents can request the
MCP's tools, but OpenCode asks before each tool call.

For MCPs you control or trust, the Tools & Skills UI can mark the MCP as
trusted. That persists `permissionMode: "allow"` in Open Cowork's
sidecar metadata and emits OpenCode allow patterns for assigned agents.

Agent-specific denied method patterns still override trusted MCP mode.
Use denied patterns for destructive methods even on internal MCPs.

## Link MCPs to skills and agents

MCPs add tools. Skills teach the model how and when to use those tools.

Recommended pattern:

1. Add and test the MCP.
2. Create or update a skill that names the MCP's tool ids and workflow.
3. Link the skill to the MCP from the MCP form or the Skill form.
4. Attach both the MCP and the skill to the agents that should use them.
5. Keep the MCP ask-first until the tool behavior is proven.

This keeps the extension model explicit: tools come from MCPs, workflow
instructions come from skills, and agent loadouts decide who can use
which tools.

## Downstream-bundled MCPs

Downstream distributions can ship bundled MCPs under:

```text
$OPEN_COWORK_DOWNSTREAM_ROOT/mcps/<name>/dist/index.js
```

The bundled MCP must also be declared in `open-cowork.config.json` under
`mcps`. Downstream MCPs override upstream resource MCPs with the same
name, so package names should be stable and deliberate.

Bundled MCPs are appropriate when every user of a downstream build should
receive the same reviewed tool. User-added custom MCPs are better for
per-user or per-project integrations.

## Troubleshooting

If the MCP does not appear in the agent builder:

- Confirm it is enabled on the Tools & Skills page.
- Run **Test MCP** and inspect the returned message.
- Reload the runtime after saving or editing the MCP.
- For HTTP OAuth MCPs, complete authentication from the MCP status panel.
- For project-scoped MCPs, make sure the current thread uses that project
  directory.

If a URL is blocked, read the error text carefully. The policy explains
whether the block is due to private network access, cloud metadata,
hostname resolution, or an invalid URL.

If a local command is blocked, prefer a direct runtime executable and
arguments. Avoid shell wrappers, eval flags, and project paths that rely
on symlink traversal.

## Related docs

- [Skills & MCPs](skills-and-mcps.md)
- [Configuration](configuration.md#mcps)
- [Security Model](security-model.md#mcp-sandbox-boundaries)
- [Troubleshooting](troubleshooting.md#mcp-doesnt-show-up-in-the-agent-builder)
