import assert from 'node:assert/strict'

export type SecretRedactionFixture = {
  id: string
  label: string
  value: string
  keyedName?: string
}

function token(prefix: string, char: string, length: number) {
  return `${prefix}${char.repeat(length)}`
}

export const SECRET_REDACTION_FIXTURES: SecretRedactionFixture[] = [
  { id: 'openai-legacy', label: 'OpenAI legacy API key', value: token('sk-', 'a', 48) },
  { id: 'openai-project', label: 'OpenAI project API key', value: token('sk-proj-', 'b', 48) },
  { id: 'openai-admin', label: 'OpenAI admin API key', value: token('sk-admin-', 'c', 48) },
  { id: 'openai-service-account', label: 'OpenAI service-account API key', value: token('sk-svcacct-', 'd', 48) },
  { id: 'anthropic', label: 'Anthropic API key', value: token('sk-ant-api03-', 'e', 40) },
  { id: 'openrouter', label: 'OpenRouter API key', value: token('sk-or-v1-', 'f', 36) },
  { id: 'google-api-key', label: 'Google API key', value: token(['AI', 'za'].join(''), 'g', 35) },
  { id: 'google-oauth-access', label: 'Google OAuth access token', value: token('ya29.', 'h', 28) },
  { id: 'google-client-secret', label: 'Google OAuth client secret', value: token(['GOC', 'SPX', '-'].join(''), 'i', 30) },
  { id: 'slack-bot', label: 'Slack bot token', value: ['xoxb', '123456789012', 'j'.repeat(24)].join('-') },
  { id: 'telegram-bot', label: 'Telegram bot token', value: ['123456789', 'k'.repeat(35)].join(':') },
  { id: 'cloud-api-token', label: 'Open Cowork Cloud API token', value: token('occ_', 'l', 30) },
  { id: 'gateway-service-token', label: 'Open Cowork Gateway service token', value: token('ocgw_', 'm', 30) },
  { id: 'github-classic-token', label: 'GitHub classic token', value: token('ghp_', 'n', 36) },
  { id: 'github-fine-grained-token', label: 'GitHub fine-grained token', value: ['github', 'pat', '0'.repeat(22), 'p'.repeat(24)].join('_') },
  { id: 'jwt', label: 'JWT-style bearer token', value: ['eyJ' + 'q'.repeat(10), 'r'.repeat(12), 's'.repeat(12)].join('.') },
  { id: 'webhook-shared-secret', label: 'Webhook shared secret', value: 't'.repeat(48), keyedName: 'webhook_secret' },
]

export function redactionFixtureCorpus() {
  return SECRET_REDACTION_FIXTURES
    .map((fixture) => fixture.keyedName ? `${fixture.keyedName}=${fixture.value}` : fixture.value)
    .join('\n')
}

export function assertNoSecretFixtureLeaks(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  for (const fixture of SECRET_REDACTION_FIXTURES) {
    assert.equal(text.includes(fixture.value), false, `${fixture.id} leaked from redacted output`)
  }
}
