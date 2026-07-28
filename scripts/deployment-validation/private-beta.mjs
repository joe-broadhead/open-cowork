import { readFileSync } from 'node:fs'

import { finding } from './findings.mjs'

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function validateReference(value, allowed, path, findings) {
  if (typeof value !== 'string') return
  const match = /^(?:\{)?env:([A-Z0-9_]+)(?:\})?$/.exec(value)
  if (match && !allowed.has(match[1])) {
    findings.push(
      finding(
        'DEPLOY_PRIVATE_BETA_ENV_NOT_ALLOWLISTED',
        path,
        `environment placeholder ${match[1]} is not declared in allowedEnvPlaceholders`,
      ),
    )
  }
  if (
    !match &&
    /(?:SecretRef|adminToken|sharedSecret|smtpPassword|credentialsRef|urlRef)$/.test(path)
  ) {
    findings.push(
      finding(
        'DEPLOY_PRIVATE_BETA_SECRET_REF_REQUIRED',
        path,
        'secret-bearing private-beta fields must use an allowlisted environment reference',
      ),
    )
  }
}

function walkReferences(value, allowed, path, findings) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkReferences(entry, allowed, `${path}[${index}]`, findings))
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      walkReferences(entry, allowed, `${path}.${key}`, findings)
    }
  } else {
    validateReference(value, allowed, path, findings)
  }
}

export function validatePrivateBetaContracts(files, path = 'deploy/private-beta') {
  const findings = []
  const hosted = record(files.hosted)
  const selfHost = record(files.selfHost)
  const plans = record(files.plans)
  const launchEvidence = record(files.launchEvidence)

  for (const [name, config] of [['hosted', hosted], ['selfHost', selfHost]]) {
    const configPath = `${path}.${name}`
    const allowed = new Set(list(config.allowedEnvPlaceholders))
    walkReferences(config, allowed, configPath, findings)
    const cloud = record(config.cloud)
    if (record(cloud.auth).allowSelfServiceSignup !== false) {
      findings.push(
        finding(
          'DEPLOY_PRIVATE_BETA_SELF_SIGNUP_FORBIDDEN',
          `${configPath}.cloud.auth.allowSelfServiceSignup`,
          'private-beta examples must disable self-service signup',
        ),
      )
    }
    if (record(cloud.runtime).allowMachineRuntimeConfig !== false) {
      findings.push(
        finding(
          'DEPLOY_PRIVATE_BETA_MACHINE_CONFIG_FORBIDDEN',
          `${configPath}.cloud.runtime.allowMachineRuntimeConfig`,
          'managed runtime examples must not inherit machine configuration',
        ),
      )
    }
    const gatewayUrl = record(record(config.gateway).server).publicBaseUrl
    if (!String(gatewayUrl ?? '').startsWith('https://')) {
      findings.push(
        finding(
          'DEPLOY_PRIVATE_BETA_GATEWAY_TLS_REQUIRED',
          `${configPath}.gateway.server.publicBaseUrl`,
          'Gateway public URL must use HTTPS',
        ),
      )
    }
  }

  if (record(record(selfHost.cloud).billing).provider !== 'none') {
    findings.push(
      finding(
        'DEPLOY_PRIVATE_BETA_SELF_HOST_BILLING_FORBIDDEN',
        `${path}.selfHost.cloud.billing.provider`,
        'self-host example must keep billing provider disabled',
      ),
    )
  }

  const planKeys = new Set()
  list(plans.plans).forEach((plan, index) => {
    const planPath = `${path}.plans.plans[${index}]`
    if (planKeys.has(plan.planKey)) {
      findings.push(
        finding(
          'DEPLOY_PRIVATE_BETA_DUPLICATE_PLAN',
          `${planPath}.planKey`,
          `duplicate private-beta plan key ${plan.planKey}`,
        ),
      )
    }
    planKeys.add(plan.planKey)
    for (const [key, value] of Object.entries(record(plan.entitlements))) {
      if ((key.startsWith('max') || key.endsWith('BytesPerDay')) && (typeof value !== 'number' || value <= 0)) {
        findings.push(
          finding(
            'DEPLOY_PRIVATE_BETA_ENTITLEMENT_INVALID',
            `${planPath}.entitlements.${key}`,
            'numeric entitlement limits must be positive',
          ),
        )
      }
    }
  })

  const statuses = new Set(list(launchEvidence.statusValues))
  for (const status of ['pending-private-evidence', 'private-pass', 'private-fail']) {
    if (!statuses.has(status)) {
      findings.push(
        finding(
          'DEPLOY_PRIVATE_BETA_EVIDENCE_STATUS_REQUIRED',
          `${path}.launchEvidence.statusValues`,
          `launch evidence contract must include ${status}`,
        ),
      )
    }
  }
  return findings
}

export function loadAndValidatePrivateBetaContracts() {
  const readJson = (file) => JSON.parse(readFileSync(`deploy/private-beta/${file}`, 'utf8'))
  return validatePrivateBetaContracts({
    hosted: readJson('hosted-byok.config.example.json'),
    selfHost: readJson('self-host-oss.config.example.json'),
    plans: readJson('private-beta-plans.json'),
    launchEvidence: readJson('launch-evidence-record.template.json'),
  })
}
