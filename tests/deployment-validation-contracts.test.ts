import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  validateCloudChartValues,
  validateGatewayChartValues,
} from '../scripts/deployment-validation/chart-values.mjs'
import { validateComposeDocument } from '../scripts/deployment-validation/compose.mjs'
import { assertDefaultCloudHelmBrandingUsesRuntimeTheme } from '../scripts/deployment-validation/core.mjs'
import { validateDesktopPackaging } from '../scripts/deployment-validation/desktop-packaging.mjs'
import { formatFinding } from '../scripts/deployment-validation/findings.mjs'
import { validateHybridSecurityDocument } from '../scripts/deployment-validation/hybrid-security.mjs'
import { validateKubernetesObjects } from '../scripts/deployment-validation/kubernetes.mjs'
import { validatePrivateBetaContracts } from '../scripts/deployment-validation/private-beta.mjs'
import { validatePublicTemplateContents } from '../scripts/deployment-validation/public-templates.mjs'
import { validateTopologyProfilesDocument } from '../scripts/deployment-validation/topology.mjs'
import { parseYamlDocuments, YamlValidationError } from '../scripts/deployment-validation/yaml.mjs'

const fixtureRoot = join(process.cwd(), 'tests/fixtures/deployment-validation')

function clone<T>(value: T): T {
  return structuredClone(value)
}

function mutate(documents: unknown[], fixture: {
  operation: 'set' | 'delete' | 'duplicate'
  path: Array<string | number>
  value?: unknown
}) {
  let parent: any = documents
  for (const segment of fixture.path.slice(0, -1)) parent = parent[segment]
  const key = fixture.path.at(-1) as string | number
  if (fixture.operation === 'set') parent[key] = fixture.value
  if (fixture.operation === 'delete') delete parent[key]
  if (fixture.operation === 'duplicate') {
    const value = clone(parent[key])
    if (fixture.path.length === 1) documents.push(value)
    else parent.push(value)
  }
}

test('parsed Kubernetes fixture satisfies the production deployment contract', () => {
  const source = readFileSync(join(fixtureRoot, 'valid-rendered.yaml'), 'utf8')
  const documents = parseYamlDocuments(source, 'valid-rendered.yaml')
  assert.deepEqual(validateKubernetesObjects(documents), [])
})

test('each declarative mutation fails with its stable code and object path', () => {
  const source = readFileSync(join(fixtureRoot, 'valid-rendered.yaml'), 'utf8')
  const valid = parseYamlDocuments(source, 'valid-rendered.yaml')
  const fixtures = JSON.parse(readFileSync(join(fixtureRoot, 'mutations.json'), 'utf8'))

  for (const fixture of fixtures) {
    const documents = clone(valid)
    mutate(documents, fixture)
    const findings = validateKubernetesObjects(documents)
    assert.ok(
      findings.some((finding) => finding.code === fixture.code && finding.path === fixture.findingPath),
      `${fixture.name} did not emit ${fixture.code} at ${fixture.findingPath}:\n${findings.map(formatFinding).join('\n')}`,
    )
  }
})

test('comments and expected phrases cannot make an invalid object pass', () => {
  const source = readFileSync(join(fixtureRoot, 'valid-rendered.yaml'), 'utf8')
    .replace('runAsNonRoot: true', 'runAsNonRoot: false')
    .concat('\n# runAsNonRoot: true\n# DEPLOY_POD_NON_ROOT_REQUIRED is satisfied\n')
  const findings = validateKubernetesObjects(parseYamlDocuments(source, 'comment-mutation.yaml'))
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_POD_NON_ROOT_REQUIRED'))
})

test('every Kubernetes workload kind is validated through its real pod-template path', () => {
  const source = readFileSync(join(fixtureRoot, 'valid-rendered.yaml'), 'utf8')
  const deployment = parseYamlDocuments(source, 'valid-rendered.yaml')[0]
  const cases = [
    {
      kind: 'Deployment',
      object: clone(deployment),
      podSpecPath: '$[0].spec.template.spec',
      requireProbes: true,
    },
    {
      kind: 'StatefulSet',
      object: { ...clone(deployment), kind: 'StatefulSet' },
      podSpecPath: '$[0].spec.template.spec',
      requireProbes: true,
    },
    {
      kind: 'DaemonSet',
      object: { ...clone(deployment), kind: 'DaemonSet' },
      podSpecPath: '$[0].spec.template.spec',
      requireProbes: true,
    },
    {
      kind: 'Job',
      object: { ...clone(deployment), apiVersion: 'batch/v1', kind: 'Job' },
      podSpecPath: '$[0].spec.template.spec',
      requireProbes: false,
    },
    {
      kind: 'CronJob',
      object: {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata: { name: 'open-cowork-cron' },
        spec: {
          jobTemplate: {
            spec: {
              template: clone(deployment.spec.template),
            },
          },
        },
      },
      podSpecPath: '$[0].spec.jobTemplate.spec.template.spec',
      requireProbes: false,
    },
  ]

  for (const fixture of cases) {
    const podSpec = fixture.kind === 'CronJob'
      ? fixture.object.spec.jobTemplate.spec.template.spec
      : fixture.object.spec.template.spec
    podSpec.securityContext.runAsNonRoot = false
    podSpec.securityContext.seccompProfile.type = 'Unconfined'
    podSpec.containers[0].securityContext.readOnlyRootFilesystem = false
    podSpec.containers[0].securityContext.capabilities.drop = []
    delete podSpec.containers[0].resources.limits.memory
    if (!fixture.requireProbes) {
      delete podSpec.containers[0].livenessProbe
      delete podSpec.containers[0].readinessProbe
    }

    const findings = validateKubernetesObjects([fixture.object])
    assert.ok(
      findings.some(
        (finding) =>
          finding.code === 'DEPLOY_POD_NON_ROOT_REQUIRED'
          && finding.path === `${fixture.podSpecPath}.securityContext.runAsNonRoot`,
      ),
      `${fixture.kind} bypassed pod security validation`,
    )
    assert.ok(
      findings.some(
        (finding) =>
          finding.code === 'DEPLOY_SECCOMP_REQUIRED'
          && finding.path === `${fixture.podSpecPath}.securityContext.seccompProfile.type`,
      ),
      `${fixture.kind} bypassed seccomp validation`,
    )
    assert.ok(
      findings.some(
        (finding) =>
          finding.code === 'DEPLOY_CONTAINER_READ_ONLY_ROOT_REQUIRED'
          && finding.path === `${fixture.podSpecPath}.containers[0].securityContext.readOnlyRootFilesystem`,
      ),
      `${fixture.kind} bypassed container validation`,
    )
    assert.ok(
      findings.some(
        (finding) =>
          finding.code === 'DEPLOY_CAPABILITIES_DROP_ALL_REQUIRED'
          && finding.path === `${fixture.podSpecPath}.containers[0].securityContext.capabilities.drop`,
      ),
      `${fixture.kind} bypassed capability validation`,
    )
    assert.ok(
      findings.some(
        (finding) =>
          finding.code === 'DEPLOY_RESOURCES_REQUIRED'
          && finding.path === `${fixture.podSpecPath}.containers[0].resources.limits.memory`,
      ),
      `${fixture.kind} bypassed resource validation`,
    )
    if (!fixture.requireProbes) {
      assert.equal(
        findings.some((finding) => finding.code === 'DEPLOY_LIVENESS_PROBE_REQUIRED'),
        false,
        `${fixture.kind} should not require a long-running liveness probe`,
      )
      assert.equal(
        findings.some((finding) => finding.code === 'DEPLOY_READINESS_PROBE_REQUIRED'),
        false,
        `${fixture.kind} should not require a long-running readiness probe`,
      )
    }
  }
})

test('writable /tmp validation follows the mount to writable backing storage', () => {
  const source = readFileSync(join(fixtureRoot, 'valid-rendered.yaml'), 'utf8')
  const valid = parseYamlDocuments(source, 'valid-rendered.yaml')

  const readOnlyMount = clone(valid)
  readOnlyMount[0].spec.template.spec.containers[0].volumeMounts[0].readOnly = true
  assert.ok(
    validateKubernetesObjects(readOnlyMount).some(
      (finding) =>
        finding.code === 'DEPLOY_TMP_MOUNT_WRITABLE_REQUIRED'
        && finding.path === '$[0].spec.template.spec.containers[0].volumeMounts[0].readOnly',
    ),
  )

  const missingVolume = clone(valid)
  missingVolume[0].spec.template.spec.containers[0].volumeMounts[0].name = 'missing'
  assert.ok(
    validateKubernetesObjects(missingVolume).some(
      (finding) =>
        finding.code === 'DEPLOY_TMP_VOLUME_REQUIRED'
        && finding.path === '$[0].spec.template.spec.containers[0].volumeMounts[0].name',
    ),
  )

  const readOnlyBacking = clone(valid)
  readOnlyBacking[0].spec.template.spec.volumes[0] = {
    name: 'tmp',
    secret: { secretName: 'not-writable' },
  }
  assert.ok(
    validateKubernetesObjects(readOnlyBacking).some(
      (finding) =>
        finding.code === 'DEPLOY_TMP_VOLUME_WRITABLE_REQUIRED'
        && finding.path === '$[0].spec.template.spec.volumes[0]',
    ),
  )
})

test('rendered NetworkPolicy checks inspect parsed peers, egress rules, and ports', () => {
  const documents = parseYamlDocuments(`
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: open-cowork-default-deny
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
  egress: []
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: open-cowork-ingress
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ingress-nginx
`, 'network-policy.yaml')
  const requirements = {
    egressMode: 'deny',
    ingressPeer: {
      namespaceLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
      podLabels: { 'app.kubernetes.io/name': 'ingress-nginx' },
    },
  } as const
  assert.deepEqual(validateKubernetesObjects(documents, {
    networkPolicy: requirements,
  }), [])

  documents[0].spec.egress = [{ to: [{ ipBlock: { cidr: '198.51.100.0/24' } }] }]
  documents[1].spec.ingress[0].from[0].podSelector.matchLabels['app.kubernetes.io/name'] = 'wrong'
  const findings = validateKubernetesObjects(documents, {
    networkPolicy: requirements,
  })
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_NETWORK_POLICY_DEFAULT_DENY_REQUIRED'))
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_NETWORK_POLICY_INGRESS_PEER_REQUIRED'))

  documents[0].spec.egress = [{
    to: [{ ipBlock: { cidr: '203.0.113.0/24' } }],
    ports: [{ protocol: 'TCP', port: 443 }],
  }]
  assert.equal(
    validateKubernetesObjects(documents, {
      networkPolicy: {
        allowedEgress: { cidr: '203.0.113.0/24', port: 443 },
        egressMode: 'allow',
      },
    }).length,
    0,
  )
})

test('rendered branding validation reads ConfigMap JSON, not matching comments', () => {
  const valid = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: cloud-config
data:
  OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON: '{"productName":"Open Cowork Cloud","shortName":"OC"}'
`
  assert.doesNotThrow(() => assertDefaultCloudHelmBrandingUsesRuntimeTheme(valid))
  assert.throws(
    () => assertDefaultCloudHelmBrandingUsesRuntimeTheme(`
# OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON: '{"productName":"Open Cowork Cloud"}'
apiVersion: v1
kind: ConfigMap
metadata:
  name: cloud-config
data:
  OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON: '{"productName":"Wrong","theme":{"bg":"#f5f6f3"}}'
`),
    /default public branding must preserve the product name/,
  )
})

test('rendered config and Secret wiring report stable semantic paths', () => {
  const source = readFileSync(join(fixtureRoot, 'valid-rendered.yaml'), 'utf8')
  const documents = parseYamlDocuments(source, 'valid-rendered.yaml')
  const findings = validateKubernetesObjects(documents, {
    requireSecretEnvFrom: true,
    requiredConfigMapKeys: ['OPEN_COWORK_REQUIRED_LIMIT'],
  })
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'DEPLOY_SECRET_ENV_FROM_REQUIRED' &&
        finding.path === '$[0].spec.template.spec.containers[0].envFrom',
    ),
  )
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'DEPLOY_CONFIGMAP_KEY_REQUIRED' &&
        finding.path ===
          '$[?kind=ConfigMap&&referencedBy=Deployment].data.OPEN_COWORK_REQUIRED_LIMIT',
    ),
  )
})

test('YAML loader rejects duplicate keys with a stable code and source line', () => {
  assert.throws(
    () => parseYamlDocuments('service:\n  port: 80\n  port: 443\n', 'duplicate.yaml'),
    (error) =>
      error instanceof YamlValidationError &&
      error.code === 'DEPLOY_YAML_DUPLICATE_KEY' &&
      error.path === 'duplicate.yaml:3',
  )
  assert.throws(
    () => parseYamlDocuments('items:\n  - name: first\n    name: second\n', 'sequence-duplicate.yaml'),
    (error) =>
      error instanceof YamlValidationError &&
      error.code === 'DEPLOY_YAML_DUPLICATE_KEY' &&
      error.path === 'sequence-duplicate.yaml:3',
  )
  assert.throws(
    () => parseYamlDocuments('defaults: &defaults\n  enabled: true\nitem:\n  <<: *defaults\n', 'anchor.yaml'),
    (error) => error instanceof YamlValidationError && error.code === 'DEPLOY_YAML_UNSUPPORTED_REFERENCE',
  )
})

test('real Cloud and Gateway values satisfy parsed chart contracts', () => {
  const cloud = parseYamlDocuments(
    readFileSync(join(process.cwd(), 'helm/open-cowork-cloud/values.yaml'), 'utf8'),
    'helm/open-cowork-cloud/values.yaml',
  )[0]
  const gateway = parseYamlDocuments(
    readFileSync(join(process.cwd(), 'helm/open-cowork-gateway/values.yaml'), 'utf8'),
    'helm/open-cowork-gateway/values.yaml',
  )[0]
  assert.deepEqual(validateCloudChartValues(cloud), [])
  assert.deepEqual(validateGatewayChartValues(gateway), [])
})

test('Cloud worker budget mutations fail on executable values rather than template phrases', () => {
  const source = readFileSync(join(process.cwd(), 'helm/open-cowork-cloud/values.yaml'), 'utf8')
  const values = parseYamlDocuments(source, 'cloud-values-mutation.yaml')[0]
  values.roles.worker.runtimeCapacity = 0
  values.roles.worker.runtimeProvisionTimeoutMs = 0
  values.roles.worker.resources.limits['ephemeral-storage'] = ''
  values.roles.scheduler.resources.requests.memory = ''
  const findings = validateCloudChartValues(values, 'cloud-values-mutation.yaml')
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'DEPLOY_POSITIVE_CAPACITY_REQUIRED' &&
        finding.path === 'cloud-values-mutation.yaml.roles.worker.runtimeCapacity',
    ),
  )
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'DEPLOY_POSITIVE_CAPACITY_REQUIRED' &&
        finding.path === 'cloud-values-mutation.yaml.roles.worker.runtimeProvisionTimeoutMs',
    ),
  )
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'DEPLOY_WORKER_RESOURCES_REQUIRED' &&
        finding.path === 'cloud-values-mutation.yaml.roles.worker.resources.limits.ephemeral-storage',
    ),
  )
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'DEPLOY_ROLE_RESOURCES_REQUIRED' &&
        finding.path === 'cloud-values-mutation.yaml.roles.scheduler.resources.requests.memory',
    ),
  )
})

test('Gateway resource mutations fail on parsed values', () => {
  const source = readFileSync(join(process.cwd(), 'helm/open-cowork-gateway/values.yaml'), 'utf8')
  const values = parseYamlDocuments(source, 'gateway-values-mutation.yaml')[0]
  values.resources.limits['ephemeral-storage'] = ''
  const findings = validateGatewayChartValues(values, 'gateway-values-mutation.yaml')
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'DEPLOY_GATEWAY_RESOURCES_REQUIRED' &&
        finding.path === 'gateway-values-mutation.yaml.resources.limits.ephemeral-storage',
    ),
  )
})

test('Compose mutations fail with stable paths after YAML parsing', () => {
  const path = 'docker-compose.gateway-remote.yml'
  const document = parseYamlDocuments(readFileSync(join(process.cwd(), path), 'utf8'), path)[0]
  assert.deepEqual(validateComposeDocument(document, path), [])

  document.services['open-cowork-gateway'].ports[0] = '0.0.0.0:8790:8790'
  document.services['open-cowork-gateway'].volumes[0] =
    './open-cowork.config.json:/etc/open-cowork/open-cowork.config.json'
  const findings = validateComposeDocument(document, path)
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'DEPLOY_COMPOSE_LOOPBACK_BIND_REQUIRED' &&
        finding.path === `${path}.services.open-cowork-gateway.ports[0]`,
    ),
  )
  assert.ok(
    findings.some(
      (finding) =>
        finding.code === 'DEPLOY_CONFIG_MOUNT_READ_ONLY_REQUIRED' &&
        finding.path === `${path}.services.open-cowork-gateway.volumes[0]`,
    ),
  )
})

test('Desktop packaging validation detects fuse and resource conflicts from parsed config', () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'))
  const builder = parseYamlDocuments(
    readFileSync(join(process.cwd(), 'apps/desktop/electron-builder.yml'), 'utf8'),
    'apps/desktop/electron-builder.yml',
  )[0]
  assert.deepEqual(validateDesktopPackaging(packageJson, builder), [])

  builder.electronFuses.onlyLoadAppFromAsar = false
  builder.publish = [{ provider: 'github' }]
  builder.extraResources.push(structuredClone(builder.extraResources[0]))
  const findings = validateDesktopPackaging(packageJson, builder)
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_DESKTOP_FUSE_INVALID'))
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_DESKTOP_STATIC_PUBLISH_FORBIDDEN'))
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_DESKTOP_RESOURCE_CONFLICT'))
})

test('private-beta contracts reject unallowlisted secrets and duplicate plans', () => {
  const readJson = (file: string) =>
    JSON.parse(readFileSync(join(process.cwd(), 'deploy/private-beta', file), 'utf8'))
  const files = {
    hosted: readJson('hosted-byok.config.example.json'),
    selfHost: readJson('self-host-oss.config.example.json'),
    plans: readJson('private-beta-plans.json'),
    launchEvidence: readJson('launch-evidence-record.template.json'),
  }
  assert.deepEqual(validatePrivateBetaContracts(files), [])

  files.hosted.cloud.auth.clientSecretRef = 'env:UNDECLARED_CLIENT_SECRET'
  files.selfHost.gateway.server.adminToken = 'inline-admin-token'
  files.plans.plans.push(structuredClone(files.plans.plans[0]))
  const findings = validatePrivateBetaContracts(files)
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_PRIVATE_BETA_ENV_NOT_ALLOWLISTED'))
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_PRIVATE_BETA_SECRET_REF_REQUIRED'))
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_PRIVATE_BETA_DUPLICATE_PLAN'))
})

test('topology and security contract references fail with stable paths', () => {
  const topology = JSON.parse(
    readFileSync(join(process.cwd(), 'deploy/topologies/topology-profiles.json'), 'utf8'),
  )
  const security = JSON.parse(
    readFileSync(join(process.cwd(), 'deploy/security/hybrid-security-gates.json'), 'utf8'),
  )
  const scripts = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts ?? {}
  assert.deepEqual(validateTopologyProfilesDocument(topology, scripts), [])
  assert.deepEqual(validateHybridSecurityDocument(security, topology, scripts), [])

  topology.profiles[0].validationCommands = ['pnpm missing:deployment-check']
  security.gates[0].topologyProfiles = ['missing-topology']
  assert.ok(
    validateTopologyProfilesDocument(topology, scripts).some(
      (finding) =>
        finding.code === 'DEPLOY_TOPOLOGY_SCRIPT_MISSING' &&
        finding.path.endsWith('.profiles[0].validationCommands[0]'),
    ),
  )
  assert.ok(
    validateHybridSecurityDocument(security, topology, scripts).some(
      (finding) =>
        finding.code === 'DEPLOY_SECURITY_GATE_TOPOLOGY_MISSING' &&
        finding.path.endsWith('.gates[0].topologyProfiles[0]'),
    ),
  )
})

test('public template scanner reports private material without relying on prose', () => {
  const findings = validatePublicTemplateContents([
    {
      path: 'deploy/example.yaml',
      contents: `token: ghp_${'x'.repeat(24)}\nurl: https://customer-prod.amazonaws.com`,
    },
  ])
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_PUBLIC_TEMPLATE_PRIVATE_MATERIAL'))
  assert.ok(findings.some((finding) => finding.code === 'DEPLOY_PUBLIC_TEMPLATE_PROVIDER_URL'))
})
