// Desktop/cloud adapter for the shared logger core (@open-cowork/shared/node).
// The core is destination-agnostic; here we inject the resolved data directory
// and brand log-file prefix from config-loader. This runs at module load — before
// any importer's first `log()` call — so the resolver is always configured and
// behavior is byte-identical to the pre-extraction logger. The resolver itself is
// invoked lazily (on the first file write), so `getAppDataDir()` is still only
// called when logging actually begins, exactly as before.
//
// The cloud server reaches this same module (via `../logger`), so its log
// destination continues to resolve through config-loader until the config core is
// itself decoupled from Electron — see docs/design/cloud-server-extraction.md.
import { setLogStorage } from '@open-cowork/shared/node'
import { getAppDataDir, getLogFilePrefix } from './config-loader.ts'

setLogStorage(() => ({ directory: getAppDataDir(), filePrefix: getLogFilePrefix() }))

export { log, getLogFilePath, closeLogger, pruneLogDirectory } from '@open-cowork/shared/node'
