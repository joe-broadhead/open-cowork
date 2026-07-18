import { expect } from 'vitest'
import {
  progressCard,
  renderStructuredMessage,
  type MessageAction,
  type StructuredGatewayMessage,
} from '../../channels/renderer.js'

const adapterContractActions: MessageAction[] = [
  { label: 'Open run', url: 'https://example.com/runs/run_contract_1', style: 'primary' },
  { label: 'Copy status', command: '/status run_contract_1' },
]

export const richCardFixture: StructuredGatewayMessage = progressCard({
  title: 'Adapter contract card',
  status: 'running',
  summary: 'Structured rendering must preserve the same issue data on every surface.',
  completed: 1,
  total: 2,
  steps: [
    { label: 'JOE-83 Adapter contract tests', status: 'In Progress' },
    { label: 'JOE-85 Adapter fixture pack', status: 'Blocked' },
  ],
  nextAction: 'Run the shared contract suite before enabling a new adapter.',
  actions: adapterContractActions,
})

export function fallbackActionIdentifiers(message: StructuredGatewayMessage): string[] {
  const identifiers: string[] = []
  let inActions = false
  for (const line of renderStructuredMessage(message, { plainText: true }).plainText.split('\n')) {
    if (line === 'Actions:') {
      inActions = true
      continue
    }
    if (!inActions) continue
    const identifier = line.match(/^-\s+[^:]+:\s+(.+)$/)?.[1]
    if (identifier) identifiers.push(identifier)
  }
  return identifiers
}

export function assertNativeActionIdentifiersMatchFallback(nativeIdentifiers: string[], message: StructuredGatewayMessage, unsafeNeedles: string[] = []): void {
  const fallbackIdentifiers = fallbackActionIdentifiers(message)

  expect(nativeIdentifiers).toEqual(fallbackIdentifiers)
  assertStableIdentifierList(nativeIdentifiers, unsafeNeedles)
  assertStableIdentifierList(fallbackIdentifiers, unsafeNeedles)
}

function assertStableIdentifierList(identifiers: string[], unsafeNeedles: string[]): void {
  const first = [...identifiers]
  const second = [...identifiers]

  expect(first).toEqual(second)
  expect(first.length).toBeGreaterThan(0)
  for (const identifier of first) {
    expect(identifier).toMatch(/^(\/|https?:\/\/)/)
    expect(identifier).not.toMatch(/[{}]/)
    for (const needle of unsafeNeedles) expect(identifier).not.toContain(needle)
  }
}
