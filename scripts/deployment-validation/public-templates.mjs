import { existsSync, readFileSync } from 'node:fs'

import { finding } from './findings.mjs'

const publicTemplatePaths = [
  'docs/managed-workers.md',
  'docs/deployment-topologies.md',
  'docs/runbooks/cloud-managed-operations.md',
  'deploy/managed-workers/README.md',
  'deploy/managed-workers/self-host-worker.env.example',
  'deploy/managed-workers/managed-operator-worker.env.template',
  'deploy/managed-workers/helm-values.worker-pool.yaml.example',
  'deploy/managed-workers/worker-release-evidence.template.md',
  'deploy/managed-workers/worker-restore-drill.template.md',
  'deploy/gcp/README.md',
  'deploy/gcp/gke/values.gke.yaml.example',
  'deploy/gcp/gke/external-secret.example.yaml',
  'deploy/gcp/gke/migrate-job.example.yaml',
  'deploy/gcp/gke/managed-certificate.example.yaml',
  'deploy/gcp/cloud-run/all-in-one.service.yaml.example',
  'deploy/gcp/smoke/README.md',
  'deploy/gcp/smoke/evidence.template.json',
  'deploy/topologies/README.md',
  'deploy/topologies/topology-profiles.json',
  'deploy/security/hybrid-security-gates.json',
  'docs/hybrid-security-gates.md',
  'docs/setup-and-health-center.md',
  'deploy/observability/managed-worker-slo-template.json',
  'deploy/private-beta/hosted-byok.config.example.json',
  'deploy/private-beta/self-host-oss.config.example.json',
  'deploy/private-beta/private-beta-plans.json',
  'deploy/private-beta/design-partner-onboarding.template.md',
  'deploy/private-beta/go-no-go-report.template.md',
  'deploy/private-beta/private-beta-launch-profile.template.json',
  'examples/downstream/example-org/README.md',
  'examples/downstream/example-org/open-cowork.config.json',
  'examples/downstream/example-org/cloud-values.yaml',
  'examples/downstream/example-org/gateway-values.yaml',
  'scripts/gcp-reference-preflight.mjs',
  'scripts/gcp-reference-smoke.mjs',
  'scripts/desktop-cloud-sync-smoke.mjs',
  'scripts/gateway-cloud-smoke.mjs',
  'scripts/cloud-continuation-smoke.mjs',
  'scripts/strict-deployment-smoke.mjs',
]

const forbiddenPatterns = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bghp_[A-Za-z0-9_]{20,}\b/],
  ['provider-key', /\bsk-[A-Za-z0-9]{20,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{20,}\b/],
  ['billing-id', /\b(?:price|prod|acct)_[0-9A-Za-z]{8,}\b/],
  ['cloud-account-id', /\b\d{12}\b/],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['non-placeholder-gcp-secret', /gcp-sm:\/\/projects\/(?!PROJECT(?:\/|$))[a-z][a-z0-9-]{4,}[a-z0-9]\//i],
  [
    'signed-url',
    /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|X-Goog-Credential|AWSAccessKeyId|sig|signature)=/i,
  ],
  ['customer-identity', /customer\s+(?:name|email|domain)\s*:/i],
  ['private-domain', /private\s+domain\s*:/i],
  ['private-key', /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/],
]
const providerHostPatterns = [
  /^[a-z0-9-]+\.amazonaws\.com$/i,
  /^[a-z0-9-]+\.azurewebsites\.net$/i,
  /^[a-z0-9-]+\.ondigitalocean\.app$/i,
]

export function validatePublicTemplateContents(files) {
  const findings = []
  for (const { path, contents } of files) {
    for (const [label, pattern] of forbiddenPatterns) {
      if (pattern.test(contents)) {
        findings.push(
          finding(
            'DEPLOY_PUBLIC_TEMPLATE_PRIVATE_MATERIAL',
            path,
            `public template contains non-placeholder ${label} material`,
          ),
        )
      }
    }
    for (const token of contents.split(/\s+/)) {
      const cleaned = token.replace(/^[("'`<]+|[)"'`>,.;]+$/g, '')
      if (!cleaned.startsWith('https://')) continue
      try {
        if (providerHostPatterns.some((pattern) => pattern.test(new URL(cleaned).hostname))) {
          findings.push(
            finding(
              'DEPLOY_PUBLIC_TEMPLATE_PROVIDER_URL',
              path,
              'public template contains a provider-hosted deployment URL',
            ),
          )
        }
      } catch {
        // Other validators own malformed example URLs; this scanner only finds concrete provider hosts.
      }
    }
  }
  return findings
}

export function loadAndValidatePublicTemplates() {
  const findings = []
  const files = []
  for (const path of publicTemplatePaths) {
    if (!existsSync(path)) {
      findings.push(finding('DEPLOY_PUBLIC_TEMPLATE_MISSING', path, 'required public template is missing'))
    } else {
      files.push({ path, contents: readFileSync(path, 'utf8') })
    }
  }
  return [...findings, ...validatePublicTemplateContents(files)]
}
