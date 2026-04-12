export type {
  IntegrationBundle,
  BundleSkill,
  BundleApp,
  BundleAgentAccess,
  BundleCredential,
  BundleHeaderSetting,
  BundleEnvSetting,
  BundleMcp,
} from './config-loader.ts'
import { getIntegrationBundlesFromConfig } from './config-loader.ts'

export const BUILTIN_INTEGRATION_BUNDLES = getIntegrationBundlesFromConfig()

export function getConfiguredIntegrationBundles() {
  return getIntegrationBundlesFromConfig()
}
