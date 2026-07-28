import { finding } from './findings.mjs'

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function requirePositive(findings, value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    findings.push(finding('DEPLOY_POSITIVE_CAPACITY_REQUIRED', path, 'capacity and isolation budgets must be positive'))
  }
}

function checkCommon(findings, values, path) {
  const image = record(values.image)
  if (!image.repository) {
    findings.push(finding('DEPLOY_IMAGE_REPOSITORY_REQUIRED', `${path}.image.repository`, 'image repository is required'))
  }
  if (String(image.tag).toLowerCase() === 'latest') {
    findings.push(finding('DEPLOY_LATEST_TAG_FORBIDDEN', `${path}.image.tag`, 'latest is not a deployable image tag'))
  }

  const podSecurity = record(values.podSecurityContext)
  if (podSecurity.runAsNonRoot !== true) {
    findings.push(finding('DEPLOY_POD_NON_ROOT_REQUIRED', `${path}.podSecurityContext.runAsNonRoot`, 'pod must run as non-root'))
  }
  if (record(podSecurity.seccompProfile).type !== 'RuntimeDefault') {
    findings.push(
      finding(
        'DEPLOY_SECCOMP_REQUIRED',
        `${path}.podSecurityContext.seccompProfile.type`,
        'pod must use the RuntimeDefault seccomp profile',
      ),
    )
  }

  const containerSecurity = record(values.containerSecurityContext)
  if (containerSecurity.readOnlyRootFilesystem !== true) {
    findings.push(
      finding(
        'DEPLOY_CONTAINER_READ_ONLY_ROOT_REQUIRED',
        `${path}.containerSecurityContext.readOnlyRootFilesystem`,
        'container root filesystem must be read-only',
      ),
    )
  }
  if (!Array.isArray(record(containerSecurity.capabilities).drop) || !containerSecurity.capabilities.drop.includes('ALL')) {
    findings.push(
      finding(
        'DEPLOY_CAPABILITIES_DROP_ALL_REQUIRED',
        `${path}.containerSecurityContext.capabilities.drop`,
        'container must drop every Linux capability',
      ),
    )
  }

  const service = record(values.service)
  if (!Number.isInteger(service.port) || service.port <= 0 || service.port > 65535) {
    findings.push(finding('DEPLOY_SERVICE_PORT_INVALID', `${path}.service.port`, 'service port must be in the range 1-65535'))
  }

  const ingress = record(values.ingress)
  if (ingress.enabled === true && (!Array.isArray(ingress.tls) || ingress.tls.length === 0)) {
    findings.push(
      finding('DEPLOY_INGRESS_TLS_REQUIRED', `${path}.ingress.tls`, 'enabled public ingress must configure TLS'),
    )
  }
}

function checkResources(findings, resources, path, code) {
  for (const group of ['requests', 'limits']) {
    for (const resource of ['cpu', 'memory', 'ephemeral-storage']) {
      if (!record(record(resources)[group])[resource]) {
        findings.push(
          finding(
            code,
            `${path}.${group}.${resource}`,
            `workload must define ${group}.${resource}`,
          ),
        )
      }
    }
  }
}

export function validateCloudChartValues(values, path = 'helm/open-cowork-cloud/values.yaml') {
  const findings = []
  checkCommon(findings, record(values), path)
  const worker = record(record(values.roles).worker)
  for (const field of [
    'runtimeCapacity',
    'admissionQueueCapacity',
    'admissionQueueTimeoutMs',
    'runtimeProvisionTimeoutMs',
    'runtimeTeardownTimeoutMs',
    'isolationMemoryLimitBytes',
    'isolationCpuLimit',
    'isolationPidsLimit',
    'sessionConcurrency',
    'maxCommandsPerSessionPerTick',
    'maxLeases',
  ]) {
    requirePositive(findings, worker[field], `${path}.roles.worker.${field}`)
  }
  checkResources(
    findings,
    worker.resources,
    `${path}.roles.worker.resources`,
    'DEPLOY_WORKER_RESOURCES_REQUIRED',
  )
  for (const roleName of ['web', 'scheduler']) {
    const role = record(record(values.roles)[roleName])
    checkResources(
      findings,
      role.resources,
      `${path}.roles.${roleName}.resources`,
      'DEPLOY_ROLE_RESOURCES_REQUIRED',
    )
  }
  if (!record(worker.livenessProbe).periodSeconds) {
    findings.push(
      finding(
        'DEPLOY_WORKER_LIVENESS_PROBE_REQUIRED',
        `${path}.roles.worker.livenessProbe.periodSeconds`,
        'worker liveness probe must be enabled with a positive period',
      ),
    )
  }
  return findings
}

export function validateGatewayChartValues(values, path = 'helm/open-cowork-gateway/values.yaml') {
  const findings = []
  checkCommon(findings, record(values), path)
  checkResources(
    findings,
    values.resources,
    `${path}.resources`,
    'DEPLOY_GATEWAY_RESOURCES_REQUIRED',
  )
  if (record(values.gateway).port !== undefined) {
    const gatewayPort = record(values.gateway).port
    if (!Number.isInteger(gatewayPort) || gatewayPort <= 0 || gatewayPort > 65535) {
      findings.push(
        finding('DEPLOY_GATEWAY_PORT_INVALID', `${path}.gateway.port`, 'gateway port must be in the range 1-65535'),
      )
    }
  }
  return findings
}
