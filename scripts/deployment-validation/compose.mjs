import {
  commandExists,
  composeFiles,
  gatewayOnlyComposeFiles,
  log,
  requireTools,
  run,
  spawnSync,
} from './core.mjs'
import { assertNoFindings, finding } from './findings.mjs'
import { loadYamlDocuments } from './yaml.mjs'

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function environment(value) {
  if (!Array.isArray(value)) return record(value)
  return Object.fromEntries(
    value.map((entry) => {
      const separator = String(entry).indexOf('=')
      return separator < 0
        ? [String(entry), '']
        : [String(entry).slice(0, separator), String(entry).slice(separator + 1)]
    }),
  )
}

export function validateComposeDocument(document, path = '<compose>') {
  const findings = []
  const services = record(record(document).services)
  if (Object.keys(services).length === 0) {
    return [finding('DEPLOY_COMPOSE_SERVICES_REQUIRED', `${path}.services`, 'Compose file must define services')]
  }

  for (const [serviceName, serviceValue] of Object.entries(services)) {
    const service = record(serviceValue)
    const servicePath = `${path}.services.${serviceName}`
    if (!service.image) {
      findings.push(finding('DEPLOY_COMPOSE_IMAGE_REQUIRED', `${servicePath}.image`, 'service image is required'))
    } else if (/(?:^|:)latest(?:@|$)/i.test(String(service.image))) {
      findings.push(finding('DEPLOY_LATEST_TAG_FORBIDDEN', `${servicePath}.image`, 'latest is not a deployable image tag'))
    }

    list(service.ports).forEach((port, index) => {
      if (!String(port).includes('127.0.0.1')) {
        findings.push(
          finding(
            'DEPLOY_COMPOSE_LOOPBACK_BIND_REQUIRED',
            `${servicePath}.ports[${index}]`,
            'local reference ports must bind to loopback by default',
          ),
        )
      }
    })

    if (!serviceName.startsWith('open-cowork-')) continue
    const env = environment(service.environment)
    for (const name of ['OPEN_COWORK_CONFIG_PATH', 'OPEN_COWORK_CONFIG_DIR', 'OPEN_COWORK_DOWNSTREAM_ROOT']) {
      if (env[name] === undefined) {
        findings.push(
          finding('DEPLOY_CONFIG_ENV_REQUIRED', `${servicePath}.environment.${name}`, `${name} must be wired`),
        )
      }
    }
    for (const [index, mount] of list(service.volumes).entries()) {
      const value = String(mount)
      if (
        value.includes('OPEN_COWORK_CONFIG_') ||
        value.includes('OPEN_COWORK_DOWNSTREAM_ROOT') ||
        value.includes(':/etc/open-cowork/')
      ) {
        if (!value.endsWith(':ro')) {
          findings.push(
            finding(
              'DEPLOY_CONFIG_MOUNT_READ_ONLY_REQUIRED',
              `${servicePath}.volumes[${index}]`,
              'configuration bind mounts must be read-only',
            ),
          )
        }
      }
    }
    for (const target of [
      '/etc/open-cowork/open-cowork.config.json',
      '/etc/open-cowork/config',
      '/etc/open-cowork/downstream',
    ]) {
      if (
        !list(service.volumes).some(
          (mount) => String(mount).includes(target) && String(mount).endsWith(':ro'),
        )
      ) {
        findings.push(
          finding(
            'DEPLOY_CONFIG_MOUNT_READ_ONLY_REQUIRED',
            `${servicePath}.volumes`,
            `configuration target ${target} must be mounted read-only`,
          ),
        )
      }
    }
    if (
      serviceName.includes('gateway') &&
      !String(env.OPEN_COWORK_GATEWAY_ADMIN_TOKEN ?? '').includes(':?')
    ) {
      findings.push(
        finding(
          'DEPLOY_GATEWAY_ADMIN_TOKEN_REQUIRED',
          `${servicePath}.environment.OPEN_COWORK_GATEWAY_ADMIN_TOKEN`,
          'Gateway operator token must use a required environment substitution',
        ),
      )
    }
  }
  return findings
}

export function validateCompose() {
  const paths = [...composeFiles, ...gatewayOnlyComposeFiles]
  for (const path of paths) {
    const document = loadYamlDocuments(path)[0]
    assertNoFindings(validateComposeDocument(document, path), path)
  }

  if (!commandExists('docker')) {
    if (requireTools) throw new Error('docker is required for deployment validation')
    log('docker not found; parsed Compose checks passed')
    return
  }
  if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) {
    if (requireTools) throw new Error('docker compose is required for deployment validation')
    log('docker compose not found; parsed Compose checks passed')
    return
  }

  const env = {
    ...process.env,
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN:
      process.env.OPEN_COWORK_GATEWAY_ADMIN_TOKEN || 'validate-gateway-admin-token',
  }
  for (const path of paths) run('docker', ['compose', '-f', path, 'config', '--quiet'], { env })
}
