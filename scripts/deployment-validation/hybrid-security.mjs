import { readFileSync } from 'node:fs'

import { assertNoFindings, finding } from './findings.mjs'

const requiredGateIds = [
  'desktop-local',
  'desktop-pairing',
  'standalone-gateway',
  'cloud-worker',
  'cloud-channel-gateway',
  'cloud-gateway-edge',
  'full-hybrid',
]
const authorities = new Set(['desktop_local', 'gateway_standalone', 'cloud_worker'])

function list(value) {
  return Array.isArray(value) ? value : []
}

function scriptName(command) {
  return /^pnpm\s+([^\s]+)/.exec(String(command))?.[1]
}

export function validateHybridSecurityDocument(
  document,
  topologyDocument,
  packageScripts,
  path = 'deploy/security/hybrid-security-gates.json',
) {
  const findings = []
  if (document.schemaVersion !== 1 || document.purpose !== 'open-cowork-hybrid-security-gates') {
    findings.push(
      finding(
        'DEPLOY_SECURITY_GATE_SCHEMA_INVALID',
        path,
        'security gate contract must use schemaVersion 1 and the canonical purpose',
      ),
    )
  }
  const topologyIds = new Set(list(topologyDocument.profiles).map((profile) => profile.id))
  const ids = new Set()
  list(document.gates).forEach((gate, index) => {
    const gatePath = `${path}.gates[${index}]`
    if (!gate.id || ids.has(gate.id)) {
      findings.push(
        finding('DEPLOY_SECURITY_GATE_ID_DUPLICATE', `${gatePath}.id`, `security gate id ${gate.id ?? ''} is missing or duplicated`),
      )
    }
    ids.add(gate.id)
    const gateAuthorities = String(gate.authority ?? '').split(',').filter(Boolean)
    if (gateAuthorities.length === 0 || gateAuthorities.some((authority) => !authorities.has(authority))) {
      findings.push(
        finding(
          'DEPLOY_SECURITY_GATE_AUTHORITY_INVALID',
          `${gatePath}.authority`,
          `unsupported execution authority ${gate.authority ?? ''}`,
        ),
      )
    }
    list(gate.topologyProfiles).forEach((topologyId, topologyIndex) => {
      if (!topologyIds.has(topologyId)) {
        findings.push(
          finding(
            'DEPLOY_SECURITY_GATE_TOPOLOGY_MISSING',
            `${gatePath}.topologyProfiles[${topologyIndex}]`,
            `security gate references missing topology ${topologyId}`,
          ),
        )
      }
    })
    for (const field of ['approvalPolicy', 'failClosedChecks', 'validationEvidence']) {
      if (list(gate[field]).length === 0) {
        findings.push(
          finding(
            'DEPLOY_SECURITY_GATE_CONTRACT_INCOMPLETE',
            `${gatePath}.${field}`,
            `${gate.id} must define ${field}`,
          ),
        )
      }
    }
    list(gate.validationEvidence).forEach((command, commandIndex) => {
      const name = scriptName(command)
      if (!name || (!name.startsWith('--') && !packageScripts[name])) {
        findings.push(
          finding(
            'DEPLOY_SECURITY_GATE_SCRIPT_MISSING',
            `${gatePath}.validationEvidence[${commandIndex}]`,
            `${gate.id} references missing package script ${name ?? command}`,
          ),
        )
      }
    })
  })
  for (const id of requiredGateIds) {
    if (!ids.has(id)) {
      findings.push(
        finding('DEPLOY_SECURITY_GATE_REQUIRED_MISSING', `${path}.gates`, `required security gate ${id} is missing`),
      )
    }
  }
  return findings
}

export function validateHybridSecurityGates() {
  const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
  const document = readJson('deploy/security/hybrid-security-gates.json')
  const topologyDocument = readJson('deploy/topologies/topology-profiles.json')
  const packageScripts = readJson('package.json').scripts ?? {}
  assertNoFindings(
    validateHybridSecurityDocument(document, topologyDocument, packageScripts),
    'hybrid security gates',
  )
}
