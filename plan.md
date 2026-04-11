# Cowork Production Hardening Plan

## Approach

Four phases ordered by effort/impact ratio. Each phase is shippable independently.

---

## Phase 1: Build System + Type Safety

- [x] Root build orchestration — `pnpm build` builds shared → MCPs → desktop in order
- [x] Root `pnpm dist` builds everything then packages (not relying on pre-built state)
- [x] @cowork/shared as single source of truth — move ALL IPC types there
- [x] Remove all `(window.cowork as any)` casts — everything typed through CoworkAPI
- [x] History loading fix — atomic clear+load to prevent duplicate messages on reload
- [x] CI gates — GitHub Actions: lint → typecheck → build → package smoke

## Phase 2: Security Hardening

- [x] Remove `rehypeRaw` from markdown rendering (XSS vector)
- [x] Navigation guards — block in-app navigation, deny window creation
- [x] Stop writing to user's `$HOME` — move skills/AGENTS.md back to app sandbox
- [x] Input validation for custom MCPs/skills (name format, size caps)
- [x] Remove plaintext token fallback in production builds

## Phase 3: Runtime + SDK Alignment

- [x] Hot model switching via `config.update()` — no reboot on model change
- [x] Dynamic MCP management — `mcp.connect()` / `mcp.disconnect()` live toggle
- [x] Session todos on switch — `session.todo()` API call
- [x] Agent listing in command palette — `app.agents()`
- [ ] Per-session directory investigation — test if OpenCode project system scopes file tools
- [ ] Subtask investigation — test `task` tool with Vertex AI provider

## Phase 4: Performance

- [ ] File-backed attachments — replace base64 data URLs with temp file paths
- [ ] Streaming buffer — batch deltas per animation frame
- [ ] Code splitting — lazy load vega-embed, DiffViewer, CommandPalette, PluginsPage
- [ ] Markdown streaming — plain text during streaming, markdown after completion
- [ ] Long thread virtualization — virtual scroll for 100+ items

## Out of scope (deferred)

- Auth redesign (PKCE) — current auth works, PKCE is better but not blocking
- Per-tool incremental Google consent — complexity not worth it
- Custom agent definitions — subtask issue needs solving first
- File browser UI — users have Finder
- Offline mode — cloud-dependent by design
