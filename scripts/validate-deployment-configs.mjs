#!/usr/bin/env node
import {
  validateCloudChartValues,
  validateGatewayChartValues,
} from './deployment-validation/chart-values.mjs'
import { validateCompose } from './deployment-validation/compose.mjs'
import { log } from './deployment-validation/core.mjs'
import { loadAndValidateDesktopPackaging } from './deployment-validation/desktop-packaging.mjs'
import { assertNoFindings } from './deployment-validation/findings.mjs'
import { validateHelm } from './deployment-validation/helm.mjs'
import { validateHybridSecurityGates } from './deployment-validation/hybrid-security.mjs'
import { loadAndValidatePrivateBetaContracts } from './deployment-validation/private-beta.mjs'
import { loadAndValidatePublicTemplates } from './deployment-validation/public-templates.mjs'
import { validateTopologyProfiles } from './deployment-validation/topology.mjs'
import { loadYamlDocuments } from './deployment-validation/yaml.mjs'

function validateExecutableChartValues() {
  const cloudValues = loadYamlDocuments('helm/open-cowork-cloud/values.yaml')[0]
  const gatewayValues = loadYamlDocuments('helm/open-cowork-gateway/values.yaml')[0]
  assertNoFindings(
    [
      ...validateCloudChartValues(cloudValues),
      ...validateGatewayChartValues(gatewayValues),
    ],
    'parsed Helm values',
  )
}

function validateExecutableProductContracts() {
  assertNoFindings(loadAndValidateDesktopPackaging(), 'Desktop packaging')
  assertNoFindings(loadAndValidatePrivateBetaContracts(), 'private-beta deployment contracts')
  assertNoFindings(loadAndValidatePublicTemplates(), 'public deployment templates')
}

validateExecutableChartValues()
validateExecutableProductContracts()
validateCompose()
validateHelm()
validateTopologyProfiles()
validateHybridSecurityGates()
log('deployment configuration validation passed')
