import { artifactsSurfaceCss } from '@open-cowork/ui'

// The Artifacts surface CSS now lives in the shared @open-cowork/ui stylesheet
// (`surface-styles.ts`) so the desktop renderer and Cloud Web render it from one
// source and cannot drift. This thin wrapper keeps the website's style-assembly
// entry point (`styles.ts`) stable.
export function cloudWebsiteArtifactStyles() {
  return artifactsSurfaceCss()
}
