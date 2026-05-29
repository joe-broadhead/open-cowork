import { canManageOrg, type WebsiteRole } from './roles.ts'
import { CLOUD_WEB_ROUTE_GROUPS, CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE, type CloudWebRoute } from './app-shell.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientBootstrap } from './client-contract.ts'
import type { PublicBrandingConfig } from '@open-cowork/shared'

export type WebsiteBootstrapPolicy = {
  role: string
  profileName: string
  features: Record<string, boolean>
  publicBranding?: PublicBrandingConfig | null
}

const DEFAULT_WEBSITE_PUBLIC_BRANDING: PublicBrandingConfig = {
  productName: 'Open Cowork Cloud',
  shortName: 'OC',
  supportUrl: '',
  privacyUrl: '',
  securityUrl: '',
  legalUrl: '',
  theme: {
    background: '#f5f6f3',
    surface: '#ffffff',
    mutedSurface: '#ecefed',
    border: '#d8ddd7',
    text: '#18211c',
    mutedText: '#66736b',
    accent: '#2d6b56',
    accentStrong: '#1f503f',
    focus: 'rgba(45, 107, 86, 0.28)',
    warn: '#8a5a14',
    danger: '#9d3630',
    ok: '#1f6b46',
  },
  dashboard: {
    title: 'Workspace',
    subtitle: 'Cloud control plane state for this signed-in org.',
    signInTitle: 'Sign in',
    signInBody: 'Use the configured cloud auth provider to open your org dashboard.',
    byokDescription: 'Provider keys are write-only. The dashboard stores status metadata only.',
    connectionsDescription: 'Issue scoped tokens for desktop and gateway clients. Plaintext is shown once.',
    gatewayDescription: 'Headless agents route chat channels into cloud sessions.',
    billingDescription: 'Manage hosted plan state and entitlements for this org.',
    usageDescription: 'Recent metering events for this org.',
  },
  managedOrgConnectionLabels: {
    desktopToken: 'Desktop token',
    gatewayToken: 'Gateway token',
    apiToken: 'API token',
    cloudUrl: 'Cloud URL',
  },
}

function cleanObjectStrings(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry === 'string' && entry.trim())
    .map(([key, entry]) => [key, String(entry).trim()]))
}

function safeBrandingUrl(value: unknown, allowMailto = false) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return undefined
  try {
    const url = new URL(text)
    if (url.protocol === 'https:') return url.toString()
    if (allowMailto && url.protocol === 'mailto:') return url.toString()
  } catch {
    return undefined
  }
  return undefined
}

function resolvePublicBranding(input?: PublicBrandingConfig | null): PublicBrandingConfig {
  return {
    ...DEFAULT_WEBSITE_PUBLIC_BRANDING,
    ...(input || {}),
    productName: input?.productName?.trim() || DEFAULT_WEBSITE_PUBLIC_BRANDING.productName,
    shortName: input?.shortName?.trim() || DEFAULT_WEBSITE_PUBLIC_BRANDING.shortName,
    logoUrl: safeBrandingUrl(input?.logoUrl) || DEFAULT_WEBSITE_PUBLIC_BRANDING.logoUrl,
    supportUrl: safeBrandingUrl(input?.supportUrl, true) || DEFAULT_WEBSITE_PUBLIC_BRANDING.supportUrl,
    privacyUrl: safeBrandingUrl(input?.privacyUrl) || DEFAULT_WEBSITE_PUBLIC_BRANDING.privacyUrl,
    securityUrl: safeBrandingUrl(input?.securityUrl) || DEFAULT_WEBSITE_PUBLIC_BRANDING.securityUrl,
    legalUrl: safeBrandingUrl(input?.legalUrl) || DEFAULT_WEBSITE_PUBLIC_BRANDING.legalUrl,
    theme: {
      ...(DEFAULT_WEBSITE_PUBLIC_BRANDING.theme || {}),
      ...cleanObjectStrings(input?.theme),
    },
    dashboard: {
      ...(DEFAULT_WEBSITE_PUBLIC_BRANDING.dashboard || {}),
      ...cleanObjectStrings(input?.dashboard),
    },
    managedOrgConnectionLabels: {
      ...(DEFAULT_WEBSITE_PUBLIC_BRANDING.managedOrgConnectionLabels || {}),
      ...cleanObjectStrings(input?.managedOrgConnectionLabels),
    },
  }
}

function publicBrandingCss(branding: PublicBrandingConfig) {
  const theme = branding.theme || {}
  const cssToken = (value: string | undefined) => value && /^[#A-Za-z0-9(),.%\s-]+$/.test(value) ? value : undefined
  const tokens: Record<string, string | undefined> = {
    '--bg': cssToken(theme.background),
    '--surface': cssToken(theme.surface),
    '--muted-surface': cssToken(theme.mutedSurface),
    '--line': cssToken(theme.border),
    '--text': cssToken(theme.text),
    '--muted': cssToken(theme.mutedText),
    '--accent': cssToken(theme.accent),
    '--accent-strong': cssToken(theme.accentStrong),
    '--focus': cssToken(theme.focus),
    '--warn': cssToken(theme.warn),
    '--danger': cssToken(theme.danger),
    '--ok': cssToken(theme.ok),
  }
  return Object.entries(tokens)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => `      ${key}: ${escapeHtml(value || '')};`)
    .join('\n')
}

function brandLogoMarkup(branding: PublicBrandingConfig) {
  if (branding.logoUrl) {
    return `<img class="brand-logo" src="${escapeHtml(branding.logoUrl)}" alt="" aria-hidden="true">`
  }
  return `<div class="mark" aria-hidden="true">${escapeHtml(branding.shortName || 'OC')}</div>`
}

function brandLinksMarkup(branding: PublicBrandingConfig) {
  const links = [
    ['Support', branding.supportUrl],
    ['Privacy', branding.privacyUrl],
    ['Security', branding.securityUrl],
    ['Legal', branding.legalUrl],
  ].filter(([, url]) => typeof url === 'string' && url.trim())
  if (!links.length) return ''
  return `<div class="brand-links">${links.map(([label, url]) => `<a href="${escapeHtml(url || '')}" rel="noreferrer" target="_blank">${escapeHtml(label || '')}</a>`).join('')}</div>`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function jsonScript(value: unknown) {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function routeNavMarkup(route: CloudWebRoute) {
  const authClass = route.requiresAuth ? ' signed-in-only' : ''
  const adminClass = route.requiresAdmin ? ' admin-route' : ''
  return `<a href="#${escapeHtml(route.id)}" data-route-link="${escapeHtml(route.id)}" data-route-surface="${escapeHtml(route.surface)}" data-requires-auth="${route.requiresAuth ? 'true' : 'false'}" data-requires-admin="${route.requiresAdmin ? 'true' : 'false'}" class="${authClass.trim()}${adminClass}">${escapeHtml(route.label)}</a>`
}

function routeGroupsMarkup() {
  return CLOUD_WEB_ROUTE_GROUPS.map((group) => `<div class="nav-group" data-nav-group="${escapeHtml(group.id)}">
          <div class="nav-heading">${escapeHtml(group.label)}</div>
          <div class="nav-links">${group.routes.map(routeNavMarkup).join('')}</div>
        </div>`).join('\n        ')
}

function routePanelAttrs(routeId: string, options: { signedIn?: boolean, admin?: boolean } = {}) {
  const classes = ['section']
  if (options.signedIn !== false) classes.push('signed-in-only')
  if (options.admin) classes.push('admin-only-section')
  const route = CLOUD_WEB_ROUTES.find((entry) => entry.id === routeId)
  return `class="${classes.join(' ')}" id="${escapeHtml(routeId)}" data-route-panel="${escapeHtml(routeId)}" data-route-surface="${escapeHtml(route?.surface || 'workbench')}" data-requires-auth="${options.signedIn === false ? 'false' : 'true'}" data-requires-admin="${options.admin ? 'true' : 'false'}"`
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
  activeRoute: bootstrap.defaultRoute || 'threads',
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

function routeLinks() {
  return qsa('[data-route-link]');
}

function routePanels() {
  return qsa('[data-route-panel]');
}

function routeById(routeId) {
  return (state.config?.routes || bootstrap.routes || []).find((route) => route.id === routeId) || null;
}

function canViewRoute(route) {
  if (!route) return false;
  if (route.requiresAuth && !state.workspace) return false;
  return true;
}

function defaultRoute() {
  const preferred = routeById(bootstrap.defaultRoute || 'threads');
  if (canViewRoute(preferred)) return preferred.id;
  const first = (state.config?.routes || bootstrap.routes || []).find(canViewRoute);
  return first?.id || 'org';
}

function setRoute(routeId, replace = false) {
  const route = routeById(routeId) || routeById(defaultRoute());
  if (!canViewRoute(route)) {
    state.activeRoute = defaultRoute();
  } else {
    state.activeRoute = route.id;
  }
  if (window.location.hash !== '#' + state.activeRoute) {
    if (replace) window.history.replaceState(null, '', '#' + state.activeRoute);
  }
  renderRoutes();
}

function renderRoutes() {
  const route = routeById(state.activeRoute) || routeById(defaultRoute());
  routePanels().forEach((panel) => {
    const isActive = panel.dataset.routePanel === route?.id;
    panel.hidden = !isActive;
    panel.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });
  routeLinks().forEach((link) => {
    const linkRoute = routeById(link.dataset.routeLink);
    const visible = canViewRoute(linkRoute);
    link.hidden = !visible;
    link.dataset.active = linkRoute?.id === route?.id ? 'true' : 'false';
    if (linkRoute?.requiresAdmin && adminLocked()) {
      link.dataset.locked = 'true';
      link.setAttribute('aria-label', linkRoute.label + ' - admin permissions required');
    } else {
      link.dataset.locked = 'false';
      link.removeAttribute('aria-label');
    }
  });
  document.body.dataset.route = route?.id || '';
  document.body.dataset.surface = route?.surface || '';
}

function branding() {
  return state.config?.publicBranding || bootstrap.publicBranding || {};
}

function brandName() {
  return branding().productName || 'Open Cowork Cloud';
}

function connectionLabel(key, fallback) {
  const labels = branding().managedOrgConnectionLabels || {};
  return labels[key] || fallback;
}

function endpoint(id, fallback) {
  const entry = (state.config?.api || bootstrap.api || []).find((candidate) => candidate.id === id);
  return entry?.path || fallback;
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
  state.workspace = null;
  state.principal = null;
  document.body.dataset.auth = 'signed-out';
  setStatus('Sign in required', 'warn');
  setRoute(window.location.hash.replace(/^#/, '') || defaultRoute(), true);
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
  document.title = brandName();
  setText('#org-name', workspace?.orgName || workspace?.tenantName || brandName());
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
  renderRoutes();
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
    meta.textContent = [binding.externalWorkspaceId || 'tenant-wide channel', bindingSettingsLabel(binding.settings)].filter(Boolean).join(' - ');
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
  renderRoutes();
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
  const me = await optionalLoad(() => api(endpoint('authMe', '/auth/me')), null);
  if (!me) return;
  state.principal = me.principal;
  state.csrfToken = me.csrfToken || null;
  state.config = await api(endpoint('config', '/api/config'));
  state.workspace = await api(endpoint('workspace', '/api/workspace'));
  const [byok, tokens, agents, bindings, billing, usage] = await Promise.all([
    optionalLoad(() => api(endpoint('byok', '/api/byok')).then((body) => body.secrets || []), []),
    optionalLoad(() => api(endpoint('apiTokens', '/api/api-tokens')).then((body) => body.tokens || []), []),
    optionalLoad(() => api(endpoint('channelAgents', '/api/channels/agents')).then((body) => body.agents || []), []),
    optionalLoad(() => api(endpoint('channelBindings', '/api/channels/bindings')).then((body) => body.bindings || []), []),
    optionalLoad(() => api(endpoint('billingSubscription', '/api/billing/subscription')), { enabled: false }),
    optionalLoad(() => api(endpoint('usageEvents', '/api/usage/events?limit=20')).then((body) => body.events || []), []),
  ]);
  state.byok = byok;
  state.tokens = tokens;
  state.agents = agents;
  state.bindings = bindings;
  state.billing = billing;
  state.usage = usage;
  document.body.dataset.auth = 'signed-in';
  setStatus('Workbench synced', 'ok');
  setRoute(window.location.hash.replace(/^#/, '') || state.activeRoute || defaultRoute(), true);
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
  const provider = String(formData.get('provider') || '').trim();
  const externalWorkspaceId = String(formData.get('externalWorkspaceId') || '').trim()
    || String(formData.get('slackTeamId') || '').trim()
    || String(formData.get('emailDomain') || '').trim()
    || null;
  await api('/api/channels/bindings', {
    method: 'POST',
    body: JSON.stringify({
      agentId: String(formData.get('agentId') || '').trim(),
      provider,
      displayName: String(formData.get('displayName') || '').trim(),
      externalWorkspaceId,
      credentialRef: String(formData.get('credentialRef') || '').trim() || null,
      status: 'auth_required',
      settings: providerSettingsFromForm(provider, formData),
    }),
  });
}

function providerSettingsFromForm(provider, formData) {
  if (provider === 'slack') {
    return pruneEmpty({
      teamId: String(formData.get('slackTeamId') || '').trim(),
      defaultChannelId: String(formData.get('slackChannelId') || '').trim(),
      apiBaseUrl: String(formData.get('slackApiBaseUrl') || '').trim(),
    });
  }
  if (provider === 'email') {
    return pruneEmpty({
      inboundAddress: String(formData.get('emailAddress') || '').trim(),
      domain: String(formData.get('emailDomain') || '').trim(),
      smtpHost: String(formData.get('emailSmtpHost') || '').trim(),
    });
  }
  if (provider === 'webhook') {
    return pruneEmpty({
      deliveryUrl: String(formData.get('webhookDeliveryUrl') || '').trim(),
    });
  }
  return {};
}

function pruneEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => Boolean(entry)));
}

function bindingSettingsLabel(settings) {
  if (!settings || typeof settings !== 'object') return '';
  const values = [
    settings.teamId,
    settings.defaultChannelId,
    settings.inboundAddress,
    settings.smtpHost,
    settings.deliveryUrl,
  ].filter(Boolean);
  return values.slice(0, 2).join(' / ');
}

function updateBindingProviderFields() {
  const form = qs('#binding-form');
  const provider = String(qs('select[name="provider"]', form).value || '');
  qsa('[data-provider-field]', form).forEach((field) => {
    field.hidden = field.dataset.providerField !== provider;
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
  window.addEventListener('hashchange', () => {
    setRoute(window.location.hash.replace(/^#/, '') || defaultRoute(), true);
  });
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
  qs('#desktop-token').addEventListener('click', () => quickToken(connectionLabel('desktopToken', 'Desktop token') + ' connection token', 'desktop').catch((error) => setStatus(error.message, 'error')));
  qs('#gateway-token').addEventListener('click', () => quickToken(connectionLabel('gatewayToken', 'Gateway token') + ' service token', 'gateway').catch((error) => setStatus(error.message, 'error')));
  qs('#agent-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, createAgent);
  });
  qs('#binding-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, createBinding);
  });
  qs('select[name="provider"]', qs('#binding-form')).addEventListener('change', updateBindingProviderFields);
  updateBindingProviderFields();
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

export function cloudWebsiteHtml(policy: WebsiteBootstrapPolicy, publicBranding?: PublicBrandingConfig | null, cspNonce = '') {
  const branding = resolvePublicBranding(publicBranding || policy.publicBranding)
  const copy = branding.dashboard || DEFAULT_WEBSITE_PUBLIC_BRANDING.dashboard || {}
  const labels = branding.managedOrgConnectionLabels || DEFAULT_WEBSITE_PUBLIC_BRANDING.managedOrgConnectionLabels || {}
  const bootstrap: CloudWebClientBootstrap = {
    role: policy.role,
    profileName: policy.profileName,
    features: policy.features,
    publicBranding: branding,
    routes: CLOUD_WEB_ROUTES,
    defaultRoute: DEFAULT_CLOUD_WEB_ROUTE,
    api: CLOUD_WEB_CLIENT_ENDPOINTS,
  }
  const adminDefault = canManageOrg(policy.role as WebsiteRole)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(branding.productName)}</title>
  <style${cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : ''}>
    :root {
      color-scheme: light;
${publicBrandingCss(branding)}
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
    .brand-logo {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      object-fit: contain;
      background: var(--surface);
      border: 1px solid var(--line);
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
    .nav-sections {
      display: grid;
      gap: 14px;
    }
    .nav-group {
      display: grid;
      gap: 6px;
    }
    .nav-heading {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 0 10px;
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
    .nav-links a[data-active="true"] {
      background: var(--surface);
      border: 1px solid var(--line);
      box-shadow: 0 1px 0 rgba(24, 33, 28, 0.04);
    }
    .nav-links a[data-locked="true"] {
      color: var(--muted);
    }
    .brand-links {
      margin-top: auto;
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      font-size: 12px;
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
    [data-route-panel][hidden], [data-route-link][hidden] {
      display: none;
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
    .workbench-split {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.6fr);
      gap: 12px;
      align-items: start;
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
    .table-shell {
      display: grid;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #fff;
    }
    .table-row {
      display: grid;
      grid-template-columns: minmax(180px, 1.4fr) minmax(90px, 0.6fr) minmax(110px, 0.7fr) minmax(120px, 0.7fr);
      gap: 10px;
      min-height: 42px;
      align-items: center;
      padding: 0 12px;
      border-top: 1px solid var(--line);
      font-size: 13px;
    }
    .table-row:first-child {
      border-top: 0;
    }
    .table-head {
      min-height: 34px;
      background: var(--muted-surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .empty-row {
      color: var(--muted);
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
    [data-provider-field][hidden] {
      display: none;
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
      .grid, .form-grid, .workbench-split {
        grid-template-columns: 1fr;
      }
      .table-shell {
        overflow-x: auto;
      }
      .table-row {
        min-width: 620px;
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
        ${brandLogoMarkup(branding)}
        <div>
          <div class="brand-title">${escapeHtml(branding.productName)}</div>
          <div class="meta" id="profile-name">${escapeHtml(policy.profileName)}</div>
        </div>
      </div>
      <nav class="nav-sections" aria-label="Cloud Web sections">
        ${routeGroupsMarkup()}
      </nav>
      <div>
        <div class="meta">Role</div>
        <strong id="role-name">${adminDefault ? 'admin' : 'member'}</strong>
      </div>
      ${brandLinksMarkup(branding)}
    </aside>
    <main class="main">
      <header class="topbar">
        <div>
          <h1 id="org-name">${escapeHtml(branding.productName)}</h1>
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

        <section ${routePanelAttrs('threads')}>
          <div class="section-header">
            <div>
              <h2>Threads</h2>
              <div class="meta">Cloud workspace threads</div>
            </div>
            <button class="primary" type="button" disabled data-policy-state="deferred">New thread</button>
          </div>
          <div class="panel">
            <div class="table-shell" role="table" aria-label="Cloud threads">
              <div class="table-row table-head" role="row">
                <span role="columnheader">Thread</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Surface</span>
                <span role="columnheader">Updated</span>
              </div>
              <div class="table-row empty-row" role="row">
                <span role="cell">No cloud threads loaded.</span>
                <span role="cell">-</span>
                <span role="cell">-</span>
                <span role="cell">-</span>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('chat')}>
          <div class="section-header">
            <div>
              <h2>Chat</h2>
              <div class="meta">Selected cloud session</div>
            </div>
            <span class="pill" data-kind="${policy.features.chat ? 'ok' : 'warn'}">${policy.features.chat ? 'enabled' : 'disabled'}</span>
          </div>
          <div class="workbench-split">
            <div class="panel">
              <h3>Timeline</h3>
              <p class="empty">No thread selected.</p>
            </div>
            <form class="panel">
              <h3>Composer</h3>
              <label><span>Message</span><input disabled placeholder="Select a cloud thread"></label>
              <button class="primary" type="button" disabled>Send</button>
            </form>
          </div>
        </section>

        <section ${routePanelAttrs('agents')}>
          <div class="section-header">
            <div>
              <h2>Agents</h2>
              <div class="meta">Profile-allowed execution choices</div>
            </div>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Available agents</h3>
              <p class="empty">No agents loaded.</p>
            </div>
            <div class="panel">
              <h3>Policy</h3>
              <div class="row compact"><strong>Profile</strong><span>${escapeHtml(policy.profileName)}</span></div>
              <div class="row compact"><strong>Chat</strong><span>${policy.features.chat ? 'enabled' : 'disabled'}</span></div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('capabilities')}>
          <div class="section-header">
            <div>
              <h2>Tools & Skills</h2>
              <div class="meta">Capability policy verdicts</div>
            </div>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Tools</h3>
              <p class="empty">No tools loaded.</p>
            </div>
            <div class="panel">
              <h3>Skills and MCPs</h3>
              <p class="empty">No skills loaded.</p>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('workflows')}>
          <div class="section-header">
            <div>
              <h2>Workflows</h2>
              <div class="meta">Definitions and runs</div>
            </div>
            <span class="pill" data-kind="${policy.features.workflows ? 'ok' : 'warn'}">${policy.features.workflows ? 'enabled' : 'disabled'}</span>
          </div>
          <div class="panel">
            <div class="table-shell" role="table" aria-label="Cloud workflows">
              <div class="table-row table-head" role="row">
                <span role="columnheader">Workflow</span>
                <span role="columnheader">Status</span>
                <span role="columnheader">Last run</span>
                <span role="columnheader">Next run</span>
              </div>
              <div class="table-row empty-row" role="row">
                <span role="cell">No workflows loaded.</span>
                <span role="cell">-</span>
                <span role="cell">-</span>
                <span role="cell">-</span>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('artifacts')}>
          <div class="section-header">
            <div>
              <h2>Artifacts</h2>
              <div class="meta">Cloud artifact metadata</div>
            </div>
          </div>
          <div class="panel">
            <p class="empty">No artifacts loaded.</p>
          </div>
        </section>

        <section ${routePanelAttrs('org', { signedIn: false })}>
          <div class="section-header">
            <div>
              <h2>${escapeHtml(copy.title || 'Workspace')}</h2>
              <div class="meta">${escapeHtml(copy.subtitle || 'Cloud control plane state for this signed-in org.')}</div>
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
              <h3>${escapeHtml(copy.signInTitle || 'Sign in')}</h3>
              <p class="empty">${escapeHtml(copy.signInBody || 'Use the configured cloud auth provider to open your org dashboard.')}</p>
              <button id="signin-inline" class="primary" type="button">Sign in</button>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('members', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Members</h2>
              <div class="meta">Roles and invites</div>
            </div>
          </div>
          <div class="panel">
            <p class="empty">No member records loaded.</p>
          </div>
        </section>

        <section ${routePanelAttrs('policy')}>
          <div class="section-header">
            <div>
              <h2>Profiles & Policy</h2>
              <div class="meta">Runtime profile and feature flags</div>
            </div>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Runtime profile</h3>
              <div class="row compact"><strong>Profile</strong><span>${escapeHtml(policy.profileName)}</span></div>
              <div class="row compact"><strong>Role</strong><span>${escapeHtml(policy.role)}</span></div>
            </div>
            <div class="panel">
              <h3>Features</h3>
              <div class="row compact"><strong>Chat</strong><span>${policy.features.chat ? 'enabled' : 'disabled'}</span></div>
              <div class="row compact"><strong>Workflows</strong><span>${policy.features.workflows ? 'enabled' : 'disabled'}</span></div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('byok', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>BYOK</h2>
              <div class="meta">${escapeHtml(copy.byokDescription || 'Provider keys are write-only. The dashboard stores status metadata only.')}</div>
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

        <section ${routePanelAttrs('connections', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Connections</h2>
              <div class="meta">${escapeHtml(copy.connectionsDescription || 'Issue scoped tokens for desktop and gateway clients. Plaintext is shown once.')}</div>
            </div>
          </div>
          <div class="grid">
            <form class="panel" id="token-form">
              <h3>Create ${escapeHtml(labels.apiToken || 'API token')}</h3>
              <div class="form-grid">
                <label class="span"><span>Name</span><input name="name" autocomplete="off" placeholder="Desktop connection" data-admin-control="true"></label>
                <div class="check-row span">
                  <label><input type="checkbox" name="scopes" value="desktop" checked data-admin-control="true"> Desktop</label>
                  <label><input type="checkbox" name="scopes" value="gateway" data-admin-control="true"> Gateway</label>
                  <label><input type="checkbox" name="scopes" value="admin" data-admin-control="true"> Admin</label>
                </div>
                <button class="primary" type="submit" data-admin-control="true">Create token</button>
                <button type="button" id="desktop-token" data-admin-control="true">${escapeHtml(labels.desktopToken || 'Desktop token')}</button>
                <button type="button" id="gateway-token" data-admin-control="true">${escapeHtml(labels.gatewayToken || 'Gateway token')}</button>
              </div>
            </form>
            <div class="panel">
              <h3>Issued tokens</h3>
              <div class="list" id="token-list"></div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('gateway', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Headless gateway</h2>
              <div class="meta">${escapeHtml(copy.gatewayDescription || 'Headless agents route chat channels into cloud sessions.')}</div>
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
                <label data-provider-field="slack"><span>Slack team ID</span><input name="slackTeamId" autocomplete="off" placeholder="T0123ABC" data-admin-control="true"></label>
                <label data-provider-field="slack"><span>Slack channel ID</span><input name="slackChannelId" autocomplete="off" placeholder="C0123ABC" data-admin-control="true"></label>
                <label class="span" data-provider-field="slack"><span>Slack API base URL</span><input name="slackApiBaseUrl" autocomplete="off" placeholder="https://slack.com/api" data-admin-control="true"></label>
                <label data-provider-field="email"><span>Inbound address</span><input name="emailAddress" autocomplete="off" placeholder="agent@example.com" data-admin-control="true"></label>
                <label data-provider-field="email"><span>Email domain</span><input name="emailDomain" autocomplete="off" placeholder="example.com" data-admin-control="true"></label>
                <label class="span" data-provider-field="email"><span>SMTP host</span><input name="emailSmtpHost" autocomplete="off" placeholder="smtp.example.com" data-admin-control="true"></label>
                <label class="span" data-provider-field="webhook"><span>Webhook delivery URL</span><input name="webhookDeliveryUrl" autocomplete="off" placeholder="https://bridge.example.com/open-cowork" data-admin-control="true"></label>
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

        <section ${routePanelAttrs('billing', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Billing</h2>
              <div class="meta">${escapeHtml(copy.billingDescription || 'Manage hosted plan state and entitlements for this org.')}</div>
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

        <section ${routePanelAttrs('audit', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Audit</h2>
              <div class="meta">Redacted administrative events</div>
            </div>
          </div>
          <div class="panel">
            <p class="empty">No audit events loaded.</p>
          </div>
        </section>

        <section ${routePanelAttrs('usage')}>
          <div class="section-header">
            <div>
              <h2>Usage</h2>
              <div class="meta">${escapeHtml(copy.usageDescription || 'Recent metering events for this org.')}</div>
            </div>
          </div>
          <div class="panel">
            <div class="list" id="usage-list"></div>
          </div>
        </section>

        <section ${routePanelAttrs('diagnostics', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Diagnostics</h2>
              <div class="meta">Redacted operational state</div>
            </div>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Health</h3>
              <p class="empty">No diagnostics loaded.</p>
            </div>
            <div class="panel">
              <h3>Support bundle</h3>
              <button type="button" disabled data-admin-control="true">Prepare bundle</button>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>
  <script${cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : ''} id="open-cowork-cloud-bootstrap" type="application/json">${jsonScript(bootstrap)}</script>
  <script${cspNonce ? ` nonce="${escapeHtml(cspNonce)}"` : ''}>${cloudWebsiteClientScript()}</script>
</body>
</html>`
}
