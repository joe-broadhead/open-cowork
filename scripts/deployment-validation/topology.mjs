import { existsSync, readFileSync } from 'node:fs'

import { assertNoFindings, finding } from './findings.mjs'

const requiredProfileIds = [
  'desktop-only',
  'gateway-only',
  'cloud-only',
  'cloud-channel-gateway',
  'desktop-gateway',
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

export function validateTopologyProfilesDocument(document, packageScripts, path = 'deploy/topologies/topology-profiles.json') {
  const findings = []
  if (document.schemaVersion !== 1 || document.purpose !== 'open-cowork-deployment-topology-profiles') {
    findings.push(
      finding(
        'DEPLOY_TOPOLOGY_SCHEMA_INVALID',
        path,
        'topology contract must use schemaVersion 1 and the canonical purpose',
      ),
    )
  }
  const profiles = list(document.profiles)
  const ids = new Set()
  profiles.forEach((profile, index) => {
    const profilePath = `${path}.profiles[${index}]`
    if (!profile.id || ids.has(profile.id)) {
      findings.push(
        finding('DEPLOY_TOPOLOGY_ID_DUPLICATE', `${profilePath}.id`, `topology id ${profile.id ?? ''} is missing or duplicated`),
      )
    }
    ids.add(profile.id)
    const executionAuthorities = list(profile.executionAuthorities)
    if (
      executionAuthorities.length === 0 ||
      executionAuthorities.some((authority) => !authorities.has(authority))
    ) {
      findings.push(
        finding(
          'DEPLOY_TOPOLOGY_AUTHORITY_INVALID',
          `${profilePath}.executionAuthorities`,
          'topology must name at least one supported execution authority',
        ),
      )
    }
    for (const field of ['validationCommands', 'smokeCommands']) {
      list(profile[field]).forEach((command, commandIndex) => {
        const name = scriptName(command)
        if (!name || (!name.startsWith('--') && !packageScripts[name])) {
          findings.push(
            finding(
              'DEPLOY_TOPOLOGY_SCRIPT_MISSING',
              `${profilePath}.${field}[${commandIndex}]`,
              `${profile.id} references missing package script ${name ?? command}`,
            ),
          )
        }
      })
    }
    list(profile.referenceAssets).forEach((asset, assetIndex) => {
      if (!existsSync(asset)) {
        findings.push(
          finding(
            'DEPLOY_TOPOLOGY_ASSET_MISSING',
            `${profilePath}.referenceAssets[${assetIndex}]`,
            `referenced asset ${asset} does not exist`,
          ),
        )
      }
    })
  })
  for (const id of requiredProfileIds) {
    if (!ids.has(id)) {
      findings.push(
        finding('DEPLOY_TOPOLOGY_REQUIRED_PROFILE_MISSING', `${path}.profiles`, `required topology ${id} is missing`),
      )
    }
  }
  return findings
}

export function validateTopologyProfiles() {
  const document = JSON.parse(readFileSync('deploy/topologies/topology-profiles.json', 'utf8'))
  const packageScripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {}
  assertNoFindings(validateTopologyProfilesDocument(document, packageScripts), 'deployment topology profiles')
}
