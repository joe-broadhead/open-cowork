// Public barrel for @open-cowork/cloud-server. The cloud deployment bundles the
// server from `./app` (via the build-cloud entry scripts) and the desktop's local
// control plane imports individual modules through the `./*` subpath export.
export * from './app.ts'

// Optional, pluggable monetization SDK (#897). A downstream fork wires its own
// entitlement resolver with a small module: implement EntitlementResolver, call
// registerEntitlementResolverProvider('custom', factory) at startup, then set
// OPEN_COWORK_CLOUD_ENTITLEMENTS_PROVIDER=custom.
export * from './entitlements/entitlement-resolver.ts'
export * from './entitlements/metadata-entitlement-resolver.ts'
export * from './entitlements/entitlement-provider.ts'
export { CloudEntitlementService } from './services/entitlement-service.ts'
