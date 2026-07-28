import { readFileSync } from 'node:fs'

import { finding } from './findings.mjs'
import { parseYamlDocuments } from './yaml.mjs'

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function list(value) {
  return Array.isArray(value) ? value : []
}

export function validateDesktopPackaging(packageJson, builder, path = 'apps/desktop') {
  const findings = []
  const requireEqual = (code, objectPath, actual, expected, message) => {
    if (actual !== expected) findings.push(finding(code, `${path}.${objectPath}`, message))
  }

  requireEqual(
    'DEPLOY_DESKTOP_MAIN_ENTRY_INVALID',
    'package.json.main',
    packageJson.main,
    'dist/main/index.js',
    'desktop main entry must target the packaged Electron main process',
  )
  if (!String(packageJson.productName ?? '').trim()) {
    findings.push(
      finding('DEPLOY_DESKTOP_PRODUCT_NAME_REQUIRED', `${path}.package.json.productName`, 'product name is required'),
    )
  }
  for (const field of ['appId', 'productName', 'executableName']) {
    if (!String(builder[field] ?? '').trim()) {
      findings.push(
        finding(
          'DEPLOY_DESKTOP_IDENTITY_REQUIRED',
          `${path}.electron-builder.yml.${field}`,
          `packaged Desktop ${field} is required`,
        ),
      )
    }
  }
  requireEqual('DEPLOY_DESKTOP_ASAR_REQUIRED', 'electron-builder.yml.asar', builder.asar, true, 'ASAR packaging is required')
  if (builder.publish !== undefined) {
    findings.push(
      finding(
        'DEPLOY_DESKTOP_STATIC_PUBLISH_FORBIDDEN',
        `${path}.electron-builder.yml.publish`,
        'Desktop update feed must be resolved from runtime configuration',
      ),
    )
  }
  for (const requiredFile of ['dist/**/*', 'package.json']) {
    if (!list(builder.files).includes(requiredFile)) {
      findings.push(
        finding(
          'DEPLOY_DESKTOP_PACKAGE_FILE_REQUIRED',
          `${path}.electron-builder.yml.files`,
          `packaged Desktop must include ${requiredFile}`,
        ),
      )
    }
  }

  for (const [key, expected] of Object.entries({
    runAsNode: true,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
  })) {
    requireEqual(
      'DEPLOY_DESKTOP_FUSE_INVALID',
      `electron-builder.yml.electronFuses.${key}`,
      record(builder.electronFuses)[key],
      expected,
      `Electron fuse ${key} must be ${expected}`,
    )
  }
  requireEqual(
    'DEPLOY_DESKTOP_HARDENED_RUNTIME_REQUIRED',
    'electron-builder.yml.mac.hardenedRuntime',
    record(builder.mac).hardenedRuntime,
    true,
    'macOS builds must enable hardened runtime',
  )
  requireEqual(
    'DEPLOY_DESKTOP_NOTARIZATION_REQUIRED',
    'electron-builder.yml.mac.notarize',
    record(builder.mac).notarize,
    true,
    'macOS release configuration must require notarization',
  )
  if (!record(builder.mac).entitlements || !record(builder.mac).entitlementsInherit) {
    findings.push(
      finding(
        'DEPLOY_DESKTOP_ENTITLEMENTS_REQUIRED',
        `${path}.electron-builder.yml.mac.entitlements`,
        'macOS parent and inherited entitlements are required',
      ),
    )
  }
  const targetNames = (platform) =>
    list(record(builder[platform]).target).map((target) =>
      typeof target === 'string' ? target : record(target).target,
    )
  for (const [platform, targets] of Object.entries({
    mac: ['dmg', 'zip'],
    linux: ['AppImage', 'deb'],
    win: ['nsis'],
  })) {
    const configured = targetNames(platform)
    for (const target of targets) {
      if (!configured.includes(target)) {
        findings.push(
          finding(
            'DEPLOY_DESKTOP_TARGET_REQUIRED',
            `${path}.electron-builder.yml.${platform}.target`,
            `${platform} packaging must include ${target}`,
          ),
        )
      }
    }
  }

  const destinations = new Set()
  list(builder.extraResources).forEach((resource, index) => {
    const destination = record(resource).to
    if (!destination) return
    if (destinations.has(destination)) {
      findings.push(
        finding(
          'DEPLOY_DESKTOP_RESOURCE_CONFLICT',
          `${path}.electron-builder.yml.extraResources[${index}].to`,
          `duplicate packaged resource destination ${destination}`,
        ),
      )
    }
    destinations.add(destination)
  })
  return findings
}

export function loadAndValidateDesktopPackaging() {
  const packageJson = JSON.parse(readFileSync('apps/desktop/package.json', 'utf8'))
  const builder = parseYamlDocuments(
    readFileSync('apps/desktop/electron-builder.yml', 'utf8'),
    'apps/desktop/electron-builder.yml',
  )[0]
  return validateDesktopPackaging(packageJson, builder)
}
