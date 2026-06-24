import type { ControlPlaneStore } from '../control-plane-store.ts'

export type SettingsControlPlaneStore = Pick<ControlPlaneStore,
  | 'setSettingMetadata'
  | 'getSettingMetadata'
  | 'listSettingMetadata'
>
