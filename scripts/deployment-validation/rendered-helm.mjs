import { assertNoFindings } from './findings.mjs'
import { validateKubernetesObjects } from './kubernetes.mjs'
import { parseYamlDocuments } from './yaml.mjs'

export function assertRenderedHelmObjects(label, manifest, options = {}) {
  const documents = parseYamlDocuments(manifest, label)
  const findings = validateKubernetesObjects(documents, {
    requireImmutableImages: true,
    requireIngressTls: true,
    requireProbes: true,
    requireResources: true,
    requireSecretEnvFrom: true,
    requiredConfigMapKeys: options.requiredConfigMapKeys ?? [],
    networkPolicy: options.networkPolicy,
  })
  assertNoFindings(findings, label)
}
