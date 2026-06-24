// Desktop adapter for the Electron-free config core (config-loader-core.ts).
// The core resolves config/app-data paths through an injected host instead of
// importing Electron; here we wire Electron's `app` (path resolution only:
// isPackaged / getAppPath / getPath). This runs at module load — before any
// importer calls a config-loader function — so the host is always set, and the
// core reads it lazily (so getPath is still only invoked when a path is first
// resolved, exactly as before the split).
//
// The cloud server reaches this same module via `../config-loader`; build-cloud's
// Electron shim makes `app` undefined there, so the host is null and the core's
// env/homedir/cwd fallbacks apply — structurally the same result the shim+guards
// produced before. Cutting that cloud→Electron edge for real means importing the
// core directly + injecting a cloud host; see docs/design/cloud-server-extraction.md.
import electron from 'electron'
import { setAppPathHost } from '@open-cowork/shared/node'

const electronApp = (electron as { app?: typeof import('electron').app }).app
setAppPathHost(electronApp ?? null)

export * from './config-loader-core.ts'
