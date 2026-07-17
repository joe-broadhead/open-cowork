// Shared Studio surface stylesheet (CSS-in-TS) — domain-split barrel.
//
// These rules style the shared @open-cowork/ui surfaces. There is one renderer
// (`packages/app`) running on both Electron (desktop) and the browser (cloud), so
// styling the surfaces here — once, in @open-cowork/ui — means both platforms are
// pixel-identical by construction.
//
// Domain ownership (JOE-851):
//   styles/shared-keyframes.ts     — cross-app keyframes
//   styles/controls-surface.ts     — form controls
//   styles/primitives-surface.ts   — empty/skeleton/card primitives
//   styles/artifacts-surface.ts    — artifacts library
//   styles/knowledge-graph-surface.ts
//   styles/approvals-surface.ts
//   styles/wiki-surface.ts
//   styles/channels-surface.ts
//   styles/projects-surface.ts
//
// Consumed by `packages/app/src/index.tsx`, which injects `studioSurfaceStyles()`
// into a <style> element at renderer startup.
//
// Rules may use only design tokens emitted by @open-cowork/shared
// (`emitRootTokensCss`). Do not use app-local CSS aliases.

export { artifactsSurfaceCss } from './styles/artifacts-surface.js'
export { knowledgeGraphCss } from './styles/knowledge-graph-surface.js'
export { approvalsSurfaceCss } from './styles/approvals-surface.js'
export { wikiSurfaceCss } from './styles/wiki-surface.js'
export { channelsSurfaceCss } from './styles/channels-surface.js'
export { projectsSurfaceCss } from './styles/projects-surface.js'
export { controlsSurfaceCss } from './styles/controls-surface.js'
export { primitivesSurfaceCss } from './styles/primitives-surface.js'
export { sharedKeyframesCss } from './styles/shared-keyframes.js'

import { artifactsSurfaceCss } from './styles/artifacts-surface.js'
import { knowledgeGraphCss } from './styles/knowledge-graph-surface.js'
import { approvalsSurfaceCss } from './styles/approvals-surface.js'
import { wikiSurfaceCss } from './styles/wiki-surface.js'
import { channelsSurfaceCss } from './styles/channels-surface.js'
import { projectsSurfaceCss } from './styles/projects-surface.js'
import { controlsSurfaceCss } from './styles/controls-surface.js'
import { primitivesSurfaceCss } from './styles/primitives-surface.js'
import { sharedKeyframesCss } from './styles/shared-keyframes.js'

export function studioSurfaceStyles(): string {
  return [
    sharedKeyframesCss(),
    controlsSurfaceCss(),
    primitivesSurfaceCss(),
    artifactsSurfaceCss(),
    knowledgeGraphCss(),
    approvalsSurfaceCss(),
    wikiSurfaceCss(),
    channelsSurfaceCss(),
    projectsSurfaceCss(),
  ].join('\n')
}
