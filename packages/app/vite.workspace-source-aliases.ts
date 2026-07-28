import { resolve } from 'node:path'

/**
 * The renderer is developed and bundled from the monorepo source graph.
 *
 * Workspace package exports intentionally point at publishable `dist/`
 * artifacts. Vite must not depend on those ignored artifacts already existing
 * in a checkout: the root build owns dependency ordering, while development
 * and the Cloud browser bundle compose these browser-safe sources directly.
 */
export function rendererWorkspaceSourceAliases(repoRoot: string) {
  return [
    {
      find: /^@open-cowork\/ui\/primitive-gallery$/,
      replacement: resolve(repoRoot, 'packages/ui/src/PrimitiveGallery.tsx'),
    },
    {
      find: /^@open-cowork\/ui$/,
      replacement: resolve(repoRoot, 'packages/ui/src/index.ts'),
    },
    {
      find: /^@open-cowork\/shared$/,
      replacement: resolve(repoRoot, 'packages/shared/src/index.ts'),
    },
  ]
}
