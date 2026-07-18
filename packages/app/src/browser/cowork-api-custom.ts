// Browser (cloud web) implementation of the `CoworkAPI['custom']` surface.
//
// Extracted from cowork-api.ts to keep that facade within its documented size
// budget. Local FS imports, custom MCP/skill mutations, and setup-bundle
// export/import have no cloud-web equivalent — they are host-only capabilities —
// so every mutation is a hard "not available in the browser build" and every
// listing is empty.

import type { CoworkAPI } from '@open-cowork/shared'

function browserUnavailable(name: string): never {
  throw new Error(`${name} is not available in the browser build.`)
}

export function createBrowserCustomApi(): CoworkAPI['custom'] {
  return {
    listMcps: async () => [],
    addMcp: () => browserUnavailable('custom.addMcp'),
    removeMcp: () => browserUnavailable('custom.removeMcp'),
    testMcp: () => browserUnavailable('custom.testMcp'),
    // Product MCP soft-links require local binaries; not available in cloud web.
    productMcpProbe: async () => [],
    productMcpLink: () => browserUnavailable('custom.productMcpLink'),
    listSkills: async () => [],
    addSkill: () => browserUnavailable('custom.addSkill'),
    selectSkillDirectoryImport: async () => null,
    importSkillDirectory: async () => null,
    removeSkill: () => browserUnavailable('custom.removeSkill'),
    exportSetupBundle: () => browserUnavailable('custom.exportSetupBundle'),
    importSetupBundle: () => browserUnavailable('custom.importSetupBundle'),
  }
}
