import type { ControlPlaneStore } from '../control-plane-store.ts'

export type SchemaMigrationControlPlaneStore = Pick<ControlPlaneStore,
  | 'recordSchemaMigration'
  | 'listSchemaMigrations'
>
