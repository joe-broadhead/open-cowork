# Singleton cache reset contracts (tests)

Desktop-process modules keep module-level caches for performance. Multi-tenant
purity and unit tests require explicit reset APIs so suites do not leak state.

## Runtime-host caches

| Cache | Module | Reset API |
| --- | --- | --- |
| Settings | `packages/runtime-host/src/settings.ts` | `clearSettingsCache()` |
| Config layers | `packages/runtime-host/src/config-loader-core.ts` | `clearConfigCaches()` |
| Session registry | `packages/runtime-host/src/session-registry.ts` | `clearSessionRegistryCache()` |
| Knowledge | `packages/runtime-host/src/knowledge/knowledge-store.ts` | `clearKnowledgeStoreCache()` |
| Workflows | `packages/runtime-host/src/workflow/workflow-store.ts` | `clearWorkflowStoreCache()` |
| Artifacts | `packages/runtime-host/src/artifact-index.ts` | `clearArtifactLifecycleStoreCache()` |
| Coordination | `packages/runtime-host/src/coordination/coordination-store.ts` | `clearCoordinationStoreCache()` |
| Thread index | `thread-index-store.ts` / `thread-index-service.ts` | `clearThreadIndexStoreCache()` / `clearThreadIndexServiceCache()` |
| Bundled skills | `bundled-skill-index.ts` | `clearBundledSkillIndexCache()` |
| Project overlays | `runtime-project-overlay.ts` | `clearProjectOverlayCopies()` |

## Renderer caches

| Cache | Module | Reset API / notes |
| --- | --- | --- |
| Markdown HTML | `packages/app/src/components/chat/MarkdownContent.tsx` | `htmlCache` is module-private; tests should remount components or call the exported clear helper when present |

## Rules

1. Every new module-level singleton **must** export a `clear*` function.
2. Tests that mutate settings/config/registry **must** clear in `after`/`finally`.
3. Do not share process-global caches across cloud tenants — cloud uses per-request
   stores, not these desktop singletons.
