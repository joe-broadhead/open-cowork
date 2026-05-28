import { canManageOrg, type WebsiteRole } from './roles.ts'

export type WebsiteBootstrapPolicy = {
  role: string
  profileName: string
  features: Record<string, boolean>
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function jsonScript(value: unknown) {
  return escapeHtml(JSON.stringify(value))
}

export function cloudWebsiteClientScript() {
  return String.raw`
const bootstrap = JSON.parse(document.getElementById('open-cowork-cloud-bootstrap').textContent || '{}');
const state = {
  csrfToken: null,
  principal: null,
  workspace: null,
  config: bootstrap,
  byok: [],
  tokens: [],
  agents: [],
  bindings: [],
  billing: null,
  usage: [],
  revealToken: null,
};

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function canManage(role) {
  return role === 'owner' || role === 'admin';
}

function setText(selector, value) {
  const element = qs(selector);
  if (element) element.textContent = String(value ?? '');
}

function setStatus(message, kind = 'ok') {
  const element = qs('#status');
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = kind;
}

function setBusy(form, busy) {
  qsa('button, input, select, textarea', form).forEach((element) => {
    element.disabled = busy || (element.dataset.locked === 'true');
  });
}

function adminLocked() {
  return !canManage(state.workspace?.role);
}

function headers(hasBody) {
  const next = hasBody ? { 'content-type': 'application/json' } : {};
  if (state.csrfToken) next['x-csrf-token'] = state.csrfToken;
  return next;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...headers(Boolean(options.body)),
      ...(options.headers || {}),
    },
  });
  if (response.status === 401) {
    renderSignedOut();
  }
  if (!response.ok) {
    let message = 'Request failed';
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {}
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function renderSignedOut() {
  document.body.dataset.auth = 'signed-out';
  setStatus('Sign in required', 'warn');
}

function formatDate(value) {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
}

function scopeLabel(scopes) {
  return Array.isArray(scopes) && scopes.length ? scopes.join(', ') : 'none';
}

function removeChildren(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function pill(text, kind = '') {
  const node = document.createElement('span');
  node.className = 'pill';
  if (kind) node.dataset.kind = kind;
  node.textContent = text;
  return node;
}

function actionButton(label, onClick, variant = '', disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.disabled = disabled;
  if (variant) button.className = variant;
  button.addEventListener('click', onClick);
  return button;
}

function renderWorkspace() {
  const workspace = state.workspace;
  setText('#org-name', workspace?.orgName || workspace?.tenantName || 'Open Cowork Cloud');
  setText('#org-meta', workspace ? workspace.email + ' - ' + workspace.role + ' - ' + workspace.profileName : 'Not signed in');
  setText('#profile-name', workspace?.profileName || bootstrap.profileName || 'default');
  setText('#role-name', workspace?.role || 'signed out');
  const adminNotice = qs('#admin-notice');
  if (adminNotice) {
    adminNotice.hidden = !workspace || canManage(workspace.role);
  }
  qsa('[data-admin-control="true"]').forEach((element) => {
    element.disabled = adminLocked();
    element.dataset.locked = adminLocked() ? 'true' : 'false';
  });
}

function renderByok() {
  const list = qs('#byok-list');
  if (!list) return;
  removeChildren(list);
  if (!state.byok.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No provider keys configured.';
    list.appendChild(empty);
    return;
  }
  for (const secret of state.byok) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = secret.providerId;
    main.appendChild(title);
    main.appendChild(document.createTextNode(' key ending ' + secret.last4));
    const meta = document.createElement('small');
    meta.textContent = 'Updated ' + formatDate(secret.updatedAt);
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(pill(secret.status, secret.status === 'active' ? 'ok' : 'warn'));
    actions.appendChild(actionButton('Validate', () => validateByok(secret.providerId), 'secondary', adminLocked()));
    actions.appendChild(actionButton('Disable', () => deleteByok(secret.providerId), 'danger', adminLocked()));
    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function renderTokens() {
  const list = qs('#token-list');
  if (!list) return;
  removeChildren(list);
  if (state.revealToken) {
    const reveal = document.createElement('div');
    reveal.className = 'secret-reveal';
    const label = document.createElement('label');
    label.textContent = 'New token';
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = state.revealToken;
    label.appendChild(input);
    const note = document.createElement('small');
    note.textContent = 'Shown once. It is not stored by this dashboard.';
    reveal.appendChild(label);
    reveal.appendChild(note);
    list.appendChild(reveal);
  }
  if (!state.tokens.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No API tokens issued.';
    list.appendChild(empty);
    return;
  }
  for (const token of state.tokens) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = token.name;
    main.appendChild(title);
    main.appendChild(document.createTextNode(' ending ' + token.last4));
    const meta = document.createElement('small');
    meta.textContent = scopeLabel(token.scopes) + ' - last used ' + formatDate(token.lastUsedAt);
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(pill(token.revokedAt ? 'revoked' : 'active', token.revokedAt ? 'warn' : 'ok'));
    if (!token.revokedAt) actions.appendChild(actionButton('Revoke', () => revokeToken(token.tokenId), 'danger', adminLocked()));
    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function renderGateway() {
  const agents = qs('#agent-list');
  const bindings = qs('#binding-list');
  const select = qs('#binding-agent');
  if (!agents || !bindings || !select) return;
  removeChildren(agents);
  removeChildren(bindings);
  removeChildren(select);
  if (!state.agents.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No headless agents configured.';
    agents.appendChild(empty);
  }
  for (const agent of state.agents) {
    const option = document.createElement('option');
    option.value = agent.agentId;
    option.textContent = agent.name;
    select.appendChild(option);
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = agent.name;
    main.appendChild(title);
    main.appendChild(document.createTextNode(' - ' + agent.profileName));
    row.appendChild(main);
    row.appendChild(pill(agent.status, agent.status === 'active' ? 'ok' : 'warn'));
    agents.appendChild(row);
  }
  if (!state.bindings.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No channel bindings configured.';
    bindings.appendChild(empty);
  }
  for (const binding of state.bindings) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = binding.displayName;
    main.appendChild(title);
    main.appendChild(document.createTextNode(' - ' + binding.provider));
    const meta = document.createElement('small');
    meta.textContent = binding.externalWorkspaceId || 'tenant-wide channel';
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    row.appendChild(main);
    row.appendChild(pill(binding.status, binding.status === 'active' ? 'ok' : 'warn'));
    bindings.appendChild(row);
  }
}

function renderBilling() {
  const billing = state.billing;
  const panel = qs('#billing-summary');
  if (!panel) return;
  removeChildren(panel);
  if (!billing || !billing.enabled) {
    panel.appendChild(pill('billing disabled', 'warn'));
    const text = document.createElement('p');
    text.className = 'empty';
    text.textContent = 'This deployment has billing disabled.';
    panel.appendChild(text);
    qsa('[data-billing-control="true"]').forEach((element) => { element.disabled = true; });
    return;
  }
  qsa('[data-billing-control="true"]').forEach((element) => { element.disabled = adminLocked(); });
  panel.appendChild(pill(billing.active ? 'active' : 'action required', billing.active ? 'ok' : 'warn'));
  const detail = document.createElement('p');
  const subscription = billing.subscription;
  detail.textContent = subscription
    ? subscription.planKey + ' - ' + subscription.status + ' - ' + subscription.seats + ' seat(s)'
    : 'No subscription is attached to this org.';
  panel.appendChild(detail);
}

function renderUsage() {
  const list = qs('#usage-list');
  if (!list) return;
  removeChildren(list);
  if (!state.usage.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No usage events recorded yet.';
    list.appendChild(empty);
    return;
  }
  for (const event of state.usage.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'row compact';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = event.eventType;
    main.appendChild(title);
    const meta = document.createElement('small');
    meta.textContent = event.quantity + ' ' + event.unit + ' - ' + formatDate(event.createdAt);
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    row.appendChild(main);
    list.appendChild(row);
  }
}

function renderAll() {
  renderWorkspace();
  renderByok();
  renderTokens();
  renderGateway();
  renderBilling();
  renderUsage();
}

async function optionalLoad(load, fallback) {
  try {
    return await load();
  } catch (error) {
    if (error.status === 403 || error.status === 404) return fallback;
    throw error;
  }
}

async function refreshDashboard() {
  const me = await optionalLoad(() => api('/auth/me'), null);
  if (!me) return;
  state.principal = me.principal;
  state.csrfToken = me.csrfToken || null;
  state.config = await api('/api/config');
  state.workspace = await api('/api/workspace');
  const [byok, tokens, agents, bindings, billing, usage] = await Promise.all([
    optionalLoad(() => api('/api/byok').then((body) => body.secrets || []), []),
    optionalLoad(() => api('/api/api-tokens').then((body) => body.tokens || []), []),
    optionalLoad(() => api('/api/channels/agents').then((body) => body.agents || []), []),
    optionalLoad(() => api('/api/channels/bindings').then((body) => body.bindings || []), []),
    optionalLoad(() => api('/api/billing/subscription'), { enabled: false }),
    optionalLoad(() => api('/api/usage/events?limit=20').then((body) => body.events || []), []),
  ]);
  state.byok = byok;
  state.tokens = tokens;
  state.agents = agents;
  state.bindings = bindings;
  state.billing = billing;
  state.usage = usage;
  document.body.dataset.auth = 'signed-in';
  setStatus('Dashboard synced', 'ok');
  renderAll();
}

async function submitForm(form, handler) {
  const formData = new FormData(form);
  setBusy(form, true);
  try {
    await handler(formData);
    form.reset();
    await refreshDashboard();
  } catch (error) {
    setStatus(error.message || 'Action failed', 'error');
  } finally {
    setBusy(form, false);
    renderWorkspace();
  }
}

async function setByokSecret(formData) {
  const providerId = String(formData.get('providerId') || '').trim().toLowerCase();
  const plaintext = String(formData.get('apiKey') || '').trim();
  if (!providerId || !plaintext) throw new Error('Provider and key are required.');
  await api('/api/byok/' + encodeURIComponent(providerId), {
    method: 'POST',
    body: JSON.stringify({ apiKey: plaintext }),
  });
}

async function validateByok(providerId) {
  await api('/api/byok/' + encodeURIComponent(providerId) + '/validate', { method: 'POST' });
  await refreshDashboard();
}

async function deleteByok(providerId) {
  await api('/api/byok/' + encodeURIComponent(providerId), { method: 'DELETE' });
  await refreshDashboard();
}

async function issueToken(formData) {
  const scopes = qsa('input[name="scopes"]:checked', qs('#token-form')).map((input) => input.value);
  const issued = await api('/api/api-tokens', {
    method: 'POST',
    body: JSON.stringify({
      name: String(formData.get('name') || '').trim(),
      scopes,
    }),
  });
  state.revealToken = issued.plaintext;
}

async function quickToken(name, scope) {
  const issued = await api('/api/api-tokens', {
    method: 'POST',
    body: JSON.stringify({ name, scopes: [scope] }),
  });
  state.revealToken = issued.plaintext;
  await refreshDashboard();
}

async function revokeToken(tokenId) {
  await api('/api/api-tokens/' + encodeURIComponent(tokenId), { method: 'DELETE' });
  if (state.revealToken) state.revealToken = null;
  await refreshDashboard();
}

async function createAgent(formData) {
  await api('/api/channels/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: String(formData.get('name') || '').trim(),
      profileName: String(formData.get('profileName') || state.workspace?.profileName || bootstrap.profileName || 'default').trim(),
      status: 'active',
      managed: true,
    }),
  });
}

async function createBinding(formData) {
  await api('/api/channels/bindings', {
    method: 'POST',
    body: JSON.stringify({
      agentId: String(formData.get('agentId') || '').trim(),
      provider: String(formData.get('provider') || '').trim(),
      displayName: String(formData.get('displayName') || '').trim(),
      externalWorkspaceId: String(formData.get('externalWorkspaceId') || '').trim() || null,
      credentialRef: String(formData.get('credentialRef') || '').trim() || null,
      status: 'auth_required',
      settings: {},
    }),
  });
}

async function openCheckout(formData) {
  const result = await api('/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ planKey: String(formData.get('planKey') || '').trim() || null }),
  });
  window.location.href = result.url;
}

async function openBillingPortal() {
  const result = await api('/api/billing/portal', { method: 'POST', body: JSON.stringify({}) });
  window.location.href = result.url;
}

function bindForms() {
  qs('#signin').addEventListener('click', () => { window.location.href = '/auth/login'; });
  qs('#signin-inline').addEventListener('click', () => { window.location.href = '/auth/login'; });
  qs('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    renderSignedOut();
  });
  qs('#refresh').addEventListener('click', () => refreshDashboard().catch((error) => setStatus(error.message, 'error')));
  qs('#byok-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, setByokSecret);
  });
  qs('#token-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, issueToken);
  });
  qs('#desktop-token').addEventListener('click', () => quickToken('Desktop connection token', 'desktop').catch((error) => setStatus(error.message, 'error')));
  qs('#gateway-token').addEventListener('click', () => quickToken('Gateway service token', 'gateway').catch((error) => setStatus(error.message, 'error')));
  qs('#agent-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, createAgent);
  });
  qs('#binding-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, createBinding);
  });
  qs('#billing-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, openCheckout);
  });
  qs('#billing-portal').addEventListener('click', () => openBillingPortal().catch((error) => setStatus(error.message, 'error')));
}

bindForms();
refreshDashboard().catch((error) => {
  if (error.status === 401) renderSignedOut();
  else setStatus(error.message || 'Dashboard failed to load', 'error');
  renderAll();
});
`
}

export function cloudWebsiteHtml(policy: WebsiteBootstrapPolicy) {
  const bootstrap = {
    role: policy.role,
    profileName: policy.profileName,
    features: policy.features,
  }
  const adminDefault = canManageOrg(policy.role as WebsiteRole)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Cowork Cloud</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f3;
      --surface: #ffffff;
      --muted-surface: #ecefed;
      --line: #d8ddd7;
      --text: #18211c;
      --muted: #66736b;
      --accent: #2d6b56;
      --accent-strong: #1f503f;
      --focus: rgba(45, 107, 86, 0.28);
      --warn: #8a5a14;
      --danger: #9d3630;
      --ok: #1f6b46;
      --shadow: 0 8px 24px rgba(24, 33, 28, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    button, input, select {
      font: inherit;
    }
    button {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--surface);
      color: var(--text);
      padding: 0 12px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    button.primary:hover {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
    }
    button.danger {
      color: var(--danger);
      border-color: #d9bbb8;
    }
    button.secondary {
      color: var(--accent);
    }
    button:disabled, input:disabled, select:disabled {
      opacity: 0.54;
      cursor: not-allowed;
    }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    input, select {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      padding: 0 10px;
      min-width: 0;
    }
    input:focus, select:focus, button:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
    label {
      display: grid;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      min-width: 0;
    }
    label span {
      color: var(--text);
      font-size: 13px;
      font-weight: 600;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr);
    }
    .nav {
      background: var(--muted-surface);
      border-right: 1px solid var(--line);
      padding: 18px 14px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .mark {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: var(--text);
      color: #fff;
      font-weight: 700;
      flex: 0 0 auto;
    }
    .brand-title, h1, h2 {
      margin: 0;
      font-weight: 700;
      letter-spacing: 0;
    }
    .brand-title { font-size: 15px; }
    .meta, small {
      color: var(--muted);
      font-size: 12px;
    }
    .nav-links {
      display: grid;
      gap: 4px;
    }
    .nav-links a {
      min-height: 34px;
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--text);
    }
    .nav-links a:hover {
      background: var(--surface);
      text-decoration: none;
    }
    .main {
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .topbar {
      border-bottom: 1px solid var(--line);
      background: var(--surface);
      min-height: 68px;
      padding: 14px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .status {
      color: var(--muted);
      font-size: 13px;
    }
    .status[data-kind="error"] { color: var(--danger); }
    .status[data-kind="warn"] { color: var(--warn); }
    .status[data-kind="ok"] { color: var(--ok); }
    .content {
      overflow: auto;
      padding: 22px;
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .section {
      border-top: 1px solid var(--line);
      padding-top: 16px;
      display: grid;
      gap: 12px;
    }
    .section:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .section-header {
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      display: grid;
      gap: 12px;
      box-shadow: var(--shadow);
      min-width: 0;
    }
    .panel h3 {
      margin: 0;
      font-size: 15px;
      letter-spacing: 0;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      align-items: end;
    }
    .form-grid .span {
      grid-column: 1 / -1;
    }
    .check-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: center;
    }
    .check-row label {
      display: flex;
      grid-template-columns: none;
      align-items: center;
      flex-direction: row;
      gap: 6px;
      color: var(--text);
      font-size: 13px;
    }
    .check-row input {
      min-height: 0;
    }
    .list {
      display: grid;
      gap: 8px;
    }
    .row {
      min-height: 52px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 10px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      background: #fff;
    }
    .row.compact {
      min-height: 44px;
    }
    .row-actions {
      display: flex;
      gap: 7px;
      align-items: center;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .pill {
      min-height: 24px;
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 8px;
      color: var(--muted);
      background: #f7f8f6;
      font-size: 12px;
      white-space: nowrap;
    }
    .pill[data-kind="ok"] {
      color: var(--ok);
      border-color: #a6cfb8;
      background: #eef8f2;
    }
    .pill[data-kind="warn"] {
      color: var(--warn);
      border-color: #dfc48f;
      background: #fff8e8;
    }
    .notice {
      border: 1px solid #dfc48f;
      border-radius: 8px;
      background: #fff8e8;
      color: var(--warn);
      padding: 10px 12px;
      font-size: 13px;
    }
    .empty {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .secret-reveal {
      border: 1px solid #a6cfb8;
      border-radius: 8px;
      background: #eef8f2;
      padding: 10px;
      display: grid;
      gap: 6px;
    }
    .secret-reveal input {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    body:not([data-auth="signed-in"]) .signed-in-only {
      display: none;
    }
    body[data-auth="signed-in"] .signed-out-only {
      display: none;
    }
    @media (max-width: 920px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .nav {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .grid, .form-grid {
        grid-template-columns: 1fr;
      }
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }
      .topbar-actions {
        justify-content: flex-start;
      }
      .row {
        grid-template-columns: 1fr;
      }
      .row-actions {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body data-auth="loading">
  <div class="shell">
    <aside class="nav">
      <div class="brand">
        <div class="mark" aria-hidden="true">OC</div>
        <div>
          <div class="brand-title">Open Cowork Cloud</div>
          <div class="meta" id="profile-name">${escapeHtml(policy.profileName)}</div>
        </div>
      </div>
      <nav class="nav-links" aria-label="Dashboard sections">
        <a href="#workspace">Workspace</a>
        <a href="#byok">BYOK</a>
        <a href="#connections">Connections</a>
        <a href="#gateway">Gateway</a>
        <a href="#billing">Billing</a>
        <a href="#usage">Usage</a>
      </nav>
      <div>
        <div class="meta">Role</div>
        <strong id="role-name">${adminDefault ? 'admin' : 'member'}</strong>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div>
          <h1 id="org-name">Open Cowork Cloud</h1>
          <div class="meta" id="org-meta">Loading workspace</div>
        </div>
        <div class="topbar-actions">
          <span class="status" id="status" data-kind="warn">Loading</span>
          <button id="refresh" type="button">Refresh</button>
          <button id="signin" class="primary signed-out-only" type="button">Sign in</button>
          <button id="logout" class="signed-in-only" type="button">Sign out</button>
        </div>
      </header>
      <div class="content">
        <p class="notice" id="admin-notice" hidden>Admin actions are disabled for this role. Ask an org owner or admin to manage keys, tokens, billing, and channel setup.</p>

        <section class="section" id="workspace">
          <div class="section-header">
            <div>
              <h2>Workspace</h2>
              <div class="meta">Cloud control plane state for this signed-in org.</div>
            </div>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Profile and policy</h3>
              <div class="row compact"><strong>Profile</strong><span id="profile-summary">${escapeHtml(policy.profileName)}</span></div>
              <div class="row compact"><strong>Chat</strong><span>${policy.features.chat ? 'enabled' : 'disabled'}</span></div>
              <div class="row compact"><strong>Workflows</strong><span>${policy.features.workflows ? 'enabled' : 'disabled'}</span></div>
            </div>
            <div class="panel signed-out-only">
              <h3>Sign in</h3>
              <p class="empty">Use the configured cloud auth provider to open your org dashboard.</p>
              <button id="signin-inline" class="primary" type="button">Sign in</button>
            </div>
          </div>
        </section>

        <section class="section signed-in-only" id="byok">
          <div class="section-header">
            <div>
              <h2>BYOK</h2>
              <div class="meta">Provider keys are write-only. The dashboard stores status metadata only.</div>
            </div>
          </div>
          <div class="grid">
            <form class="panel" id="byok-form">
              <h3>Add or rotate key</h3>
              <div class="form-grid">
                <label><span>Provider</span><input name="providerId" autocomplete="off" placeholder="anthropic" data-admin-control="true"></label>
                <label><span>API key</span><input name="apiKey" type="password" autocomplete="off" placeholder="provider key" data-admin-control="true"></label>
                <button class="primary span" type="submit" data-admin-control="true">Save key</button>
              </div>
            </form>
            <div class="panel">
              <h3>Configured providers</h3>
              <div class="list" id="byok-list"></div>
            </div>
          </div>
        </section>

        <section class="section signed-in-only" id="connections">
          <div class="section-header">
            <div>
              <h2>Connections</h2>
              <div class="meta">Issue scoped tokens for desktop and gateway clients. Plaintext is shown once.</div>
            </div>
          </div>
          <div class="grid">
            <form class="panel" id="token-form">
              <h3>Create API token</h3>
              <div class="form-grid">
                <label class="span"><span>Name</span><input name="name" autocomplete="off" placeholder="Desktop connection" data-admin-control="true"></label>
                <div class="check-row span">
                  <label><input type="checkbox" name="scopes" value="desktop" checked data-admin-control="true"> Desktop</label>
                  <label><input type="checkbox" name="scopes" value="gateway" data-admin-control="true"> Gateway</label>
                  <label><input type="checkbox" name="scopes" value="admin" data-admin-control="true"> Admin</label>
                </div>
                <button class="primary" type="submit" data-admin-control="true">Create token</button>
                <button type="button" id="desktop-token" data-admin-control="true">Desktop token</button>
                <button type="button" id="gateway-token" data-admin-control="true">Gateway token</button>
              </div>
            </form>
            <div class="panel">
              <h3>Issued tokens</h3>
              <div class="list" id="token-list"></div>
            </div>
          </div>
        </section>

        <section class="section signed-in-only" id="gateway">
          <div class="section-header">
            <div>
              <h2>Headless gateway</h2>
              <div class="meta">Configure a cloud-owned headless agent and channel bindings for self-hosted or managed gateway daemons.</div>
            </div>
          </div>
          <div class="grid">
            <form class="panel" id="agent-form">
              <h3>Create headless agent</h3>
              <div class="form-grid">
                <label><span>Name</span><input name="name" autocomplete="off" placeholder="On-call coding agent" data-admin-control="true"></label>
                <label><span>Profile</span><input name="profileName" autocomplete="off" value="${escapeHtml(policy.profileName)}" data-admin-control="true"></label>
                <button class="primary span" type="submit" data-admin-control="true">Create agent</button>
              </div>
            </form>
            <form class="panel" id="binding-form">
              <h3>Add channel binding</h3>
              <div class="form-grid">
                <label><span>Agent</span><select id="binding-agent" name="agentId" data-admin-control="true"></select></label>
                <label><span>Provider</span><select name="provider" data-admin-control="true">
                  <option value="telegram">Telegram</option>
                  <option value="slack">Slack</option>
                  <option value="email">Email</option>
                  <option value="discord">Discord</option>
                  <option value="webhook">Webhook</option>
                </select></label>
                <label><span>Display name</span><input name="displayName" autocomplete="off" placeholder="Team Slack" data-admin-control="true"></label>
                <label><span>External workspace</span><input name="externalWorkspaceId" autocomplete="off" placeholder="optional" data-admin-control="true"></label>
                <label class="span"><span>Credential ref</span><input name="credentialRef" autocomplete="off" placeholder="secret://gateway/slack-bot" data-admin-control="true"></label>
                <button class="primary span" type="submit" data-admin-control="true">Create binding</button>
              </div>
            </form>
            <div class="panel">
              <h3>Agents</h3>
              <div class="list" id="agent-list"></div>
            </div>
            <div class="panel">
              <h3>Channel bindings</h3>
              <div class="list" id="binding-list"></div>
            </div>
          </div>
        </section>

        <section class="section signed-in-only" id="billing">
          <div class="section-header">
            <div>
              <h2>Billing</h2>
              <div class="meta">Hosted deployments can expose checkout and portal links. Self-hosted deployments can leave this disabled.</div>
            </div>
          </div>
          <div class="grid">
            <form class="panel" id="billing-form">
              <h3>Plan</h3>
              <div id="billing-summary" class="list"></div>
              <div class="form-grid">
                <label><span>Plan key</span><input name="planKey" autocomplete="off" placeholder="pro" data-admin-control="true" data-billing-control="true"></label>
                <button class="primary" type="submit" data-admin-control="true" data-billing-control="true">Start checkout</button>
                <button type="button" id="billing-portal" data-admin-control="true" data-billing-control="true">Open portal</button>
              </div>
            </form>
            <div class="panel">
              <h3>Entitlements</h3>
              <p class="empty">Billing entitlements are enforced by the cloud API and worker. The dashboard reflects the current subscription status.</p>
            </div>
          </div>
        </section>

        <section class="section signed-in-only" id="usage">
          <div class="section-header">
            <div>
              <h2>Usage</h2>
              <div class="meta">Recent metered events for quota and billing visibility.</div>
            </div>
          </div>
          <div class="panel">
            <div class="list" id="usage-list"></div>
          </div>
        </section>
      </div>
    </main>
  </div>
  <script id="open-cowork-cloud-bootstrap" type="application/json">${jsonScript(bootstrap)}</script>
  <script>${cloudWebsiteClientScript()}</script>
</body>
</html>`
}
