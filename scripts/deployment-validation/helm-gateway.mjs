import {
  assertConfigChecksumRollsPods,
  expectFailure,
  publicHelmImagePrerequisites,
  publicHelmPrerequisites,
  run,
  runCapture,
  typedEgressAllowlist,
} from './core.mjs'
import { assertRenderedHelmObjects } from './rendered-helm.mjs'

export function validateGatewayHelm(gatewayChart) {
  run('helm', [
    'lint',
    gatewayChart,
    '--set',
    'gateway.cloudBaseUrl=https://cloud.example.com',
    '--set',
    'image.tag=ci',
    '--set',
    'gateway.serviceToken=ci-gateway-token',
    '--set',
    'gateway.adminToken=ci-gateway-admin-token',
    '--set',
    'gateway.telegram.botToken=ci-telegram-token',
  ])
  run('helm', [
    'template',
    'open-cowork-gateway',
    gatewayChart,
    '--set',
    'image.repository=example.com/open-cowork-gateway',
    '--set',
    'image.tag=ci',
    '--set',
    'gateway.cloudBaseUrl=https://cloud.example.com',
    '--set',
    'gateway.serviceToken=ci-gateway-token',
    '--set',
    'gateway.adminToken=ci-gateway-admin-token',
    '--set',
    'gateway.telegram.botToken=ci-telegram-token',
  ])
  assertConfigChecksumRollsPods(
    'open-cowork-gateway',
    runCapture('helm', [
      'template',
      'open-cowork-gateway-checksum',
      gatewayChart,
      '--set',
      'image.repository=example.com/open-cowork-gateway',
      '--set',
      'image.tag=ci',
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=ci-gateway-admin-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
      '--set',
      'gateway.logLevel=info',
    ]),
    runCapture('helm', [
      'template',
      'open-cowork-gateway-checksum',
      gatewayChart,
      '--set',
      'image.repository=example.com/open-cowork-gateway',
      '--set',
      'image.tag=ci',
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=ci-gateway-admin-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
      '--set',
      'gateway.logLevel=warn',
    ]),
  )
  run('helm', [
    'template',
    'open-cowork-gateway-shared-config',
    gatewayChart,
    '--set',
    'image.repository=example.com/open-cowork-gateway',
    '--set',
    'image.tag=ci',
    '--set',
    'gateway.configPath=/etc/open-cowork/open-cowork.config.json',
  ])
  expectFailure(
    'helm',
    [
      'template',
      'public-gateway-empty-ingress-allowlist',
      gatewayChart,
      ...publicHelmImagePrerequisites,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.publicUrl=https://gateway.example.com',
      '--set',
      'gateway.existingSecret=open-cowork-gateway-secrets',
    ],
    'public Gateway deployments require networkPolicy.ingress.from[]'
  )
  expectFailure(
    'helm',
    [
      'template',
      'strict-local-gateway-empty-ingress-allowlist',
      gatewayChart,
      '--set',
      'image.tag=ci',
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=ci-gateway-admin-token',
      '--set',
      'networkPolicy.ingress.allowAllSourcesForLocalOnly=false',
    ],
    'networkPolicy.ingress.from[] is required when networkPolicy.ingress.allowAllSourcesForLocalOnly=false'
  )
  const publicGatewayDenyEgressRender = runCapture('helm', [
    'template',
    'public-gateway-deny-egress',
    gatewayChart,
    ...publicHelmPrerequisites,
    '--set',
    'gateway.cloudBaseUrl=https://cloud.example.com',
    '--set',
    'gateway.publicUrl=https://gateway.example.com',
    '--set',
    'gateway.existingSecret=open-cowork-gateway-secrets',
  ])
  assertRenderedHelmObjects('public Gateway render', publicGatewayDenyEgressRender, {
    requiredConfigMapKeys: [
      'OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES',
      'OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS',
      'OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_TIMEOUT_MS',
      'OPEN_COWORK_GATEWAY_SMTP_TIMEOUT_MS',
      'OPEN_COWORK_GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS',
      'OPEN_COWORK_GATEWAY_EMAIL_MAX_ATTACHMENT_BYTES',
      'OPEN_COWORK_GATEWAY_WEBHOOK_MAX_ATTACHMENT_BYTES',
    ],
    networkPolicy: {
      egressMode: 'deny',
      ingressPeer: {
        namespaceLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
        podLabels: { 'app.kubernetes.io/name': 'ingress-nginx' },
      },
    },
  })
  const publicGatewayAllowedEgressRender = runCapture('helm', [
    'template',
    'public-gateway-allowed-egress',
    gatewayChart,
    ...publicHelmPrerequisites,
    ...typedEgressAllowlist,
    '--set',
    'gateway.cloudBaseUrl=https://cloud.example.com',
    '--set',
    'gateway.publicUrl=https://gateway.example.com',
    '--set',
    'gateway.existingSecret=open-cowork-gateway-secrets',
  ])
  assertRenderedHelmObjects(
    'public Gateway allowed egress render',
    publicGatewayAllowedEgressRender,
    {
      networkPolicy: {
        allowedEgress: { cidr: '203.0.113.0/24', port: 443 },
        egressMode: 'allow',
        ingressPeer: {
          namespaceLabels: { 'kubernetes.io/metadata.name': 'ingress-nginx' },
          podLabels: { 'app.kubernetes.io/name': 'ingress-nginx' },
        },
      },
    },
  )
  expectFailure(
    'helm',
    [
      'template',
      'latest-gateway-image',
      gatewayChart,
      '--set',
      'image.tag=latest',
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=ci-gateway-admin-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
    ],
    'image.tag=latest is not allowed'
  )
  expectFailure(
    'helm',
    [
      'template',
      'unsafe-webhook-gateway',
      gatewayChart,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=ci-gateway-admin-token',
      '--set',
      'gateway.webhook.deliveryUrl=https://bridge.example.com/inbound',
    ],
    'gateway.webhook.sharedSecret or gateway.existingSecret is required'
  )
  expectFailure(
    'helm',
    [
      'template',
      'unsafe-metrics-gateway',
      gatewayChart,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
      '--set',
      'gateway.metrics.enabled=true',
    ],
    'gateway.adminToken or gateway.existingSecret is required for gateway operator endpoints'
  )
  expectFailure(
    'helm',
    [
      'template',
      'unsafe-multi-gateway',
      gatewayChart,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=ci-gateway-admin-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
      '--set',
      'replicaCount=2',
    ],
    'gateway replicaCount > 1 is unsafe while stream/replay state is process-local'
  )
  expectFailure(
    'helm',
    [
      'template',
      'unsafe-telegram-webhook-gateway',
      gatewayChart,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=ci-gateway-admin-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
      '--set',
      'gateway.telegram.mode=webhook',
      '--set',
      'gateway.telegram.webhookSecret=ci-telegram-secret',
    ],
    'gateway.telegram.publicUrl or gateway.publicUrl is required when Telegram webhook mode is enabled'
  )
  expectFailure(
    'helm',
    [
      'template',
      'unsafe-public-gateway-inline-secrets',
      gatewayChart,
      ...publicHelmPrerequisites,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.publicUrl=https://gateway.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=ci-gateway-admin-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
    ],
    'public Gateway deployments reject inline secret-bearing Helm values'
  )
  expectFailure(
    'helm',
    [
      'template',
      'unsafe-gateway-http-public-url',
      gatewayChart,
      ...publicHelmPrerequisites,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.existingSecret=open-cowork-gateway-secrets',
      '--set',
      'gateway.publicUrl=http://gateway.example.com',
    ],
    'gateway.publicUrl must use HTTPS'
  )
  expectFailure(
    'helm',
    [
      'template',
      'unsafe-gateway-ingress-loopback-bypass',
      gatewayChart,
      ...publicHelmPrerequisites,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.existingSecret=open-cowork-gateway-secrets',
      '--set',
      'gateway.allowLoopbackOperatorBypass=true',
      '--set',
      'ingress.enabled=true',
      '--set',
      'gateway.publicUrl=https://gateway.example.com',
    ],
    'gateway.allowLoopbackOperatorBypass=true is not allowed with ingress'
  )
  expectFailure(
    'helm',
    [
      'template',
      'unsafe-gateway-placeholder-admin',
      gatewayChart,
      '--set',
      'gateway.cloudBaseUrl=https://cloud.example.com',
      '--set',
      'gateway.serviceToken=ci-gateway-token',
      '--set',
      'gateway.adminToken=replace-with-operator-token',
      '--set',
      'gateway.telegram.botToken=ci-telegram-token',
    ],
    'gateway.adminToken is a placeholder'
  )
}
