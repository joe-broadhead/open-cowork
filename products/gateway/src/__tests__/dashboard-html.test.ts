import { describe, expect, it } from 'vitest'
import { attr, html, renderDashboardDocument, trustedHtml } from '../dashboard.js'

describe('dashboard html tagged template (safe-by-default)', () => {
  it('auto-escapes an interpolated value with <>&"\' by default (text context)', () => {
    const payload = `<script>alert("x&y'z")</script>`
    const out = html`<div class="title">${payload}</div>`.value
    // esc() escapes & < > (text context); quotes are left as-is in text.
    expect(out).toBe(`<div class="title">&lt;script&gt;alert("x&amp;y'z")&lt;/script&gt;</div>`)
    expect(out).not.toContain('<script>')
  })

  it('escapes attribute interpolations (including double quotes) via attr()', () => {
    const payload = `" onmouseover="alert(1)`
    const out = html`<a href="${attr(payload)}">link</a>`.value
    expect(out).toBe(`<a href="&quot; onmouseover=&quot;alert(1)">link</a>`)
    // The injected attribute breakout quote is neutralized.
    expect(out).not.toContain('onmouseover="alert')
  })

  it('keeps dashboard data-* attributes closed around untrusted filter text', () => {
    const payload = `task" autofocus data-owned="yes<&>`
    const out = html`<tr data-filter-text="${attr(payload)}"><td>${payload}</td></tr>`.value
    const openingTag = out.slice(0, out.indexOf('>') + 1)

    expect(out).toContain('data-filter-text="task&quot; autofocus data-owned=&quot;yes&lt;&amp;&gt;"')
    expect(openingTag).not.toContain('data-owned="yes')
    expect(out).toContain('<td>task" autofocus data-owned="yes&lt;&amp;&gt;</td>')
  })

  it('does not double-escape a nested marked-safe html fragment', () => {
    const inner = html`<b>${'a & b'}</b>`
    const out = html`<div>${inner}</div>`.value
    // Inner is escaped exactly once; the outer template inserts it verbatim.
    expect(out).toBe(`<div><b>a &amp; b</b></div>`)
    expect(out).not.toContain('&amp;amp;')
  })

  it('inserts trustedHtml() verbatim and renders arrays of fragments without joins', () => {
    const rows = ['x & y', '<z>'].map(v => html`<li>${v}</li>`)
    const out = html`<ul>${rows}</ul>${trustedHtml('<hr>')}`.value
    expect(out).toBe(`<ul><li>x &amp; y</li><li>&lt;z&gt;</li></ul><hr>`)
  })

  it('escapes external task/roadmap/environment/session data in a representative rendered page', () => {
    const payload = `A<b>&"'C`
    const page = renderDashboardDocument({
      sessions: [{ id: `ses_${payload}`, title: `Sess ${payload}`, status: 'running', agent: `gateway-${payload}`, cost: 1.23, webUrl: `http://x/${payload}` }],
      questions: [],
      permissions: [],
      roadmaps: [{ id: `rm-${payload}`, title: `Road ${payload}`, status: payload, agentTeam: payload, doneTasks: 1, totalTasks: 2, progress: 50, runningTasks: 1 }],
      tasks: [{ id: `task-${payload}`, title: `Task ${payload}`, status: 'running', priority: 'HIGH', currentStage: payload, agentTeam: payload, lastRun: { resolvedProfile: payload, resolvedAgent: payload, stage: payload }, readiness: { reason: payload } }],
      runs: [{ id: `run-${payload}`, stage: payload, agentTeam: payload, environment: { name: payload, backend: payload, preflight: { ok: false } }, resolvedProfile: payload, resolvedAgent: payload, status: 'passed' }],
      readiness: { state: 'ready', summary: 'Ready', checks: [] },
      profiles: { implementer: { agent: 'gateway-implementer', model: { providerID: 'openrouter', modelID: 'test' }, role: 'execution' } },
      scheduler: { enabled: false, maxConcurrent: 3 },
      environments: [{ id: `env_${payload}`, name: `env ${payload}`, backend: payload, status: 'retained', cleanup: { state: payload }, runId: `run_1${payload}`, taskTitle: `ET ${payload}`, stage: payload, leaseId: payload, artifacts: ['file:/tmp/demo.log'], updatedAt: '2026-06-13T00:00:00.000Z' }],
    })

    // The raw <b> payload must never survive into the document.
    expect(page).not.toContain('A<b>&"\'C')
    // It is present in its escaped form (esc(): & < > ) from the migrated helpers.
    expect(page).toContain('A&lt;b&gt;&amp;"\'C')
  })
})
