// Runtime shim so `import ... from '../../shared/bridge.js'` resolves everywhere:
// - tsc (moduleResolution: bundler) maps the .js specifier to ./bridge.ts for types,
// - esbuild bundles ./bridge.ts through this re-export,
// - `node --experimental-strip-types` (used by MCP contract tests that run src/ or
//   import the shared module directly) loads this file, which forwards to ./bridge.ts.
export * from './bridge.ts'
