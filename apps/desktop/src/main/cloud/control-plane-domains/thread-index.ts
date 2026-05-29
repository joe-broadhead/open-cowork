import type { ControlPlaneStore } from '../control-plane-store.ts'

export type ThreadIndexControlPlaneStore = Pick<ControlPlaneStore,
  | 'listThreadTags'
  | 'createThreadTag'
  | 'updateThreadTag'
  | 'deleteThreadTag'
  | 'applyThreadTags'
  | 'removeThreadTags'
  | 'listThreadSmartFilters'
  | 'createThreadSmartFilter'
  | 'updateThreadSmartFilter'
  | 'deleteThreadSmartFilter'
  | 'listThreadMetadata'
>
