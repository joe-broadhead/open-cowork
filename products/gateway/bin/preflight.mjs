// Startup preflight for the OpenCode Gateway CLI wrapper.
// Kept as a standalone ESM module (no dist/ dependency) so it can run before —
// and explain — a failed dist import, and so tests can import it directly.

/**
 * node:sqlite loads without flags from Node 22.13.0 in the 22.x line (the
 * backport of the 23.4.0 unflagging) and from 23.4.0+ elsewhere. Older
 * runtimes crash at import time with ERR_UNKNOWN_BUILTIN_MODULE unless
 * --experimental-sqlite is passed, which Gateway does not do.
 */
export function nodeSqliteSupported(version) {
  const [major = 0, minor = 0] = String(version).split('.').map(part => Number.parseInt(part, 10) || 0)
  if (major >= 24) return true
  if (major === 23) return minor >= 4
  if (major === 22) return minor >= 13
  return false
}

/** Returns a friendly requirement message, or undefined when the runtime is fine. */
export function checkNodeSqliteRuntime(version) {
  if (nodeSqliteSupported(version)) return undefined
  return [
    `OpenCode Gateway requires Node.js >= 22.13 (the first 22.x release where node:sqlite loads without --experimental-sqlite). Current: v${version}.`,
    'Upgrade Node.js from https://nodejs.org (22.13+, 23.4+, or 24+), then retry.',
  ].join('\n')
}

/** True only when the failure is the CLI entry itself missing (unbuilt tree). */
export function isMissingBuildError(err) {
  if (!err || err.code !== 'ERR_MODULE_NOT_FOUND') return false
  // Only match when the module that cannot be found IS dist/cli.js — a missing
  // dependency "imported from dist/cli.js" is a real error to surface, not an
  // unbuilt tree.
  const missing = /Cannot find module '([^']+)'/.exec(String(err.message || ''))
  if (!missing) return false
  return /[\\/]dist[\\/]cli\.js$/.test(missing[1])
}

/**
 * Describe a failed dist/cli.js import without swallowing the real error:
 * only a genuinely missing build gets the rebuild hint; anything else prints
 * the underlying failure.
 */
export function describeCliStartupFailure(err) {
  if (isMissingBuildError(err)) {
    return 'Gateway not built. Run: npm run build && npm install -g .'
  }
  const detail = err?.stack || err?.message || String(err)
  return `${detail}\nGateway failed to start. See the error above.`
}
