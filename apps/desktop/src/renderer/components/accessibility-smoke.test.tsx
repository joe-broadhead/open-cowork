import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { LoginScreen } from './LoginScreen'
import { ApprovalCard } from './chat/ApprovalCard'
import type { PendingApproval } from '../stores/session'
import { SettingsPanel } from './sidebar/SettingsPanel'
import { configureI18n } from '../helpers/i18n'

const axeOptions = {
  rules: {
    // jsdom cannot compute the CSS custom-property palette reliably. Static
    // contrast still lives in design review; this smoke gate covers DOM a11y
    // regressions such as missing labels, landmarks, and ARIA contracts.
    'color-contrast': { enabled: false },
  },
}

async function expectNoA11yViolations(container: HTMLElement) {
  const result = await axe(container, axeOptions)
  expect(result.violations).toEqual([])
}

afterEach(async () => {
  await configureI18n({ locale: 'en' })
})

const approval: PendingApproval = {
  id: 'permission-1',
  sessionId: 'session-1',
  tool: 'gmail_send_email',
  input: {
    to: 'user@example.com',
    subject: 'Launch notes',
  },
  description: 'Send a message',
  order: 0,
}

describe('focused accessibility smoke', () => {
  it('keeps the login screen structurally accessible', async () => {
    const { container } = render(<LoginScreen brandName="Open Cowork" onLoggedIn={() => undefined} />)

    expect(screen.getByRole('heading', { name: 'Open Cowork' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('keeps approval cards structurally accessible', async () => {
    const { container } = render(<ApprovalCard approval={approval} />)

    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('keeps the settings shell structurally accessible', async () => {
    const { container } = render(<SettingsPanel onClose={() => undefined} />)

    expect(await screen.findByText('Settings')).toBeInTheDocument()
    await expectNoA11yViolations(container)
  })

  it('keeps the settings shell accessible when the active locale is RTL', async () => {
    await configureI18n({ locale: 'ar' })

    const { container } = render(<SettingsPanel onClose={() => undefined} />)

    expect(document.documentElement).toHaveAttribute('lang', 'ar')
    expect(document.documentElement).toHaveAttribute('dir', 'rtl')
    expect(await screen.findByText('الإعدادات')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'اللغة' })).toHaveValue('ar')
    await expectNoA11yViolations(container)
  })
})
