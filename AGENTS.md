# Cowork

Cowork is an Electron desktop app that embeds OpenCode as the agent runtime.

## Architecture

- `apps/desktop/` — Electron app (main, preload, renderer)
- `mcps/google-workspace/` — Local MCP server wrapping the `gws` CLI
- `packages/shared/` — Shared types and utilities

## Key patterns

- **Main process** hosts OpenCode via `createOpencode()` from `@opencode-ai/sdk`
- **Preload** exposes a typed IPC bridge via `contextBridge`
- **Renderer** is a React app with no Node access (contextIsolation: true, nodeIntegration: false)
- **Never** expose OpenCode server credentials to the renderer
- **Never** let the renderer make direct HTTP calls to external services

## UI design

Dark theme with Apple glassmorphism (frosted glass cards, backdrop-filter blur).
Codex-style layout: sidebar + main chat panel.

## MCP servers

- **Nova** — remote streamable HTTP MCP for datalake queries
- **Google Workspace** — local MCP wrapping `gws` CLI for Gmail, Sheets, Drive, Calendar

## Model provider

Vertex AI via OpenAI-compatible endpoint, authenticated with gcloud ADC.
