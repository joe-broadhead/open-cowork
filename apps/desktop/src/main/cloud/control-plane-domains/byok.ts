import type { ControlPlaneStore } from '../control-plane-store.ts'

export type ByokControlPlaneStore = Pick<ControlPlaneStore,
  | 'createByokSecret'
  | 'getByokSecret'
  | 'getActiveByokSecret'
  | 'listByokSecrets'
  | 'disableByokSecret'
  | 'recordByokSecretValidation'
>
