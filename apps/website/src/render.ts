import { canManageOrg, type WebsiteRole } from './roles.ts'
import { CLOUD_WEB_ROUTE_GROUPS, CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE, type CloudWebRoute } from './app-shell.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientBootstrap } from './client-contract.ts'
import { CLOUD_WEB_THREAD_PAGE_SIZE } from './thread-workbench.ts'
import { CLOUD_SESSION_EVENT_TYPES, type PublicBrandingConfig } from '@open-cowork/shared'

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
  usageSummary: null,
  deliveries: [],
  diagnostics: null,
  sessions: [],
  sessionViews: {},
  selectedSessionId: null,
  runtimeActions: {},
  threadLimit: ${CLOUD_WEB_THREAD_PAGE_SIZE},
  threadFilters: {
    query: '',
    status: 'all',
    profile: '',
    project: 'all',
    tag: '',
  },
  sessionEvents: {
    source: null,
    sessionId: null,
    cursor: 0,
    status: 'idle',
    error: null,
  },
  workspaceEvents: {
    source: null,
    cursor: 0,
    status: 'idle',
    error: null,
  },
  artifactPanel: {
    sessionId: null,
    artifactId: null,
    metadata: null,
    status: 'idle',
    error: null,
  },
  capabilities: {
    tools: [],
    skills: [],
    error: null,
  },
  capabilityFilter: '',
  workflows: {
    workflows: [],
    runs: [],
    error: null,
  },
  admin: {
    policy: null,
    members: [],
    auditEvents: [],
    error: null,
  },
  memberFilter: '',
  auditFilter: '',
  selectedWorkflowId: null,
  workflowFilter: '',
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
  if (route.requiresAdmin && adminLocked()) return false;
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
    if (linkRoute?.id === route?.id) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
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

function endpointPath(id, fallback, params = {}) {
  let path = endpoint(id, fallback);
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(':' + key, encodeURIComponent(String(value)));
  }
  return path;
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
    let body = null;
    try {
      body = await response.json();
      message = body.error || message;
    } catch {}
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    error.verdict = body?.verdict || null;
    throw error;
  }
  return response.json();
}

function renderSignedOut() {
  closeEventSource(state.sessionEvents);
  closeEventSource(state.workspaceEvents);
  state.workspace = null;
  state.principal = null;
  state.sessions = [];
  state.sessionViews = {};
  state.selectedSessionId = null;
  state.runtimeActions = {};
  state.artifactPanel = {
    sessionId: null,
    artifactId: null,
    metadata: null,
    status: 'idle',
    error: null,
  };
  state.capabilities = {
    tools: [],
    skills: [],
    error: null,
  };
  state.workflows = {
    workflows: [],
    runs: [],
    error: null,
  };
  state.usageSummary = null;
  state.deliveries = [];
  state.diagnostics = null;
  state.admin = {
    policy: null,
    members: [],
    auditEvents: [],
    error: null,
  };
  state.memberFilter = '';
  state.auditFilter = '';
  state.selectedWorkflowId = null;
  state.sessionEvents = {
    source: null,
    sessionId: null,
    cursor: 0,
    status: 'idle',
    error: null,
  };
  state.workspaceEvents = {
    source: null,
    cursor: 0,
    status: 'idle',
    error: null,
  };
  document.body.dataset.auth = 'signed-out';
  setStatus('Sign in required', 'warn');
  setRoute(window.location.hash.replace(/^#/, '') || defaultRoute(), true);
  renderAll();
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
  button.addEventListener('click', () => {
    try {
      const result = onClick();
      if (result && typeof result.catch === 'function') result.catch((error) => setStatus(error.message || 'Action failed', 'error'));
    } catch (error) {
      setStatus(error.message || 'Action failed', 'error');
    }
  });
  return button;
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function compactJson(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function byteLabel(value) {
  const bytes = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

function quantityLabel(value, unit) {
  if (unit === 'byte') return byteLabel(value);
  const quantity = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return quantity + ' ' + (unit || 'count');
}

function percentLabel(used, limit) {
  if (!limit || !Number.isFinite(limit)) return 'unlimited';
  return Math.min(100, Math.round((Number(used || 0) / limit) * 100)) + '%';
}

function tokenNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function actionPending(key) {
  return Boolean(state.runtimeActions[key]);
}

async function withRuntimeAction(key, action) {
  if (state.runtimeActions[key]) return;
  state.runtimeActions[key] = true;
  renderChat();
  renderArtifacts();
  try {
    await action();
    await refreshSelectedSession();
    await loadSessions({ keepSelection: true });
  } finally {
    delete state.runtimeActions[key];
    renderChat();
    renderArtifacts();
  }
}

function runtimeViewFromCloudView(view) {
  const sessionView = safeObject(view?.view);
  const projection = projectionFromView(view);
  return {
    ...projection,
    messages: normalizeList(sessionView.messages).length ? normalizeList(sessionView.messages) : projection.messages,
    toolCalls: normalizeList(sessionView.toolCalls).length ? normalizeList(sessionView.toolCalls) : projection.toolCalls,
    taskRuns: normalizeList(sessionView.taskRuns).length ? normalizeList(sessionView.taskRuns) : projection.taskRuns,
    pendingApprovals: normalizeList(sessionView.pendingApprovals).length ? normalizeList(sessionView.pendingApprovals) : projection.pendingApprovals,
    pendingQuestions: normalizeList(sessionView.pendingQuestions).length ? normalizeList(sessionView.pendingQuestions) : projection.pendingQuestions,
    artifacts: normalizeList(sessionView.artifacts).length ? normalizeList(sessionView.artifacts) : projection.artifacts,
    todos: normalizeList(sessionView.todos).length ? normalizeList(sessionView.todos) : projection.todos,
    errors: normalizeList(sessionView.errors).length ? normalizeList(sessionView.errors) : projection.errors,
    sessionCost: typeof sessionView.sessionCost === 'number' ? sessionView.sessionCost : projection.sessionCost,
    sessionTokens: safeObject(sessionView.sessionTokens || projection.sessionTokens),
    lastInputTokens: typeof sessionView.lastInputTokens === 'number' ? sessionView.lastInputTokens : projection.lastInputTokens,
    contextState: sessionView.contextState || projection.contextState || 'idle',
    compactionCount: tokenNumber(sessionView.compactionCount || projection.compactionCount),
    lastCompactedAt: sessionView.lastCompactedAt || projection.lastCompactedAt || null,
    isGenerating: Boolean(sessionView.isGenerating || projection.isGenerating),
    isAwaitingPermission: Boolean(sessionView.isAwaitingPermission || projection.pendingApprovals.length),
    isAwaitingQuestion: Boolean(sessionView.isAwaitingQuestion || projection.pendingQuestions.length),
  };
}

function messageText(message) {
  if (typeof message.content === 'string' && message.content) return message.content;
  if (Array.isArray(message.segments)) return message.segments.map((segment) => segment.content || '').join('');
  return '';
}

function runtimeOrder(item, fallback) {
  return typeof item?.order === 'number' && Number.isFinite(item.order) ? item.order : fallback;
}

function artifactId(artifact) {
  return artifact?.cloudArtifactId || artifact?.artifactId || artifact?.id || '';
}

function safeArtifactMetadata(artifact) {
  const metadata = {};
  for (const [key, value] of Object.entries(safeObject(artifact))) {
    const normalized = key.toLowerCase();
    if (['database64', 'url', 'downloadurl', 'signedurl', 'presignedurl', 'key', 'objectkey', 'storagekey', 'bucket', 'container', 'authorization', 'token'].includes(normalized)) continue;
    metadata[key] = value;
  }
  return metadata;
}

function safeOperationalMetadata(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 25).map((entry) => safeOperationalMetadata(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    const compactKey = normalized.replace(/[^a-z0-9]/g, '');
    if (
      normalized.includes('secret')
      || normalized.includes('token')
      || normalized.includes('password')
      || normalized.includes('authorization')
      || normalized.includes('cookie')
      || normalized.includes('credential')
      || compactKey.includes('kmsref')
      || compactKey.includes('apikey')
      || compactKey.includes('signedurl')
      || compactKey.includes('downloadurl')
      || normalized === 'key'
    ) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = safeOperationalMetadata(entry, depth + 1);
  }
  return output;
}

function safeOperationalText(value) {
  return String(value || '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b(gcp-sm|aws-sm|azure-kv|env):[^\s,)]+/gi, '$1:[redacted]')
    .replace(/\b(sk-[A-Za-z0-9._-]{6,})\b/g, '[redacted]')
    .replace(/\b(occ_[A-Za-z0-9._-]{8,})\b/g, '[redacted]')
    .replace(/\b([A-Za-z0-9_-]{32,})\b/g, '[redacted]');
}

function capabilityLabel(capability) {
  return capability.label || capability.name || capability.id || 'Capability';
}

function capabilityPolicyNote(capability) {
  if (capability.kind === 'mcp' && capability.scope === 'machine') return 'Machine-scoped MCP metadata requires a cloud-safe profile capability.';
  if (capability.source === 'custom') return 'Synced custom metadata. Execution depends on org policy.';
  return 'Allowed by current cloud profile.';
}

function filterCapabilities(items) {
  const tokens = state.capabilityFilter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items;
  return items.filter((item) => {
    const haystack = [
      item.id,
      item.name,
      item.label,
      item.source,
      item.origin,
      item.scope,
      item.kind,
      item.namespace,
      ...(Array.isArray(item.agentNames) ? item.agentNames : []),
      ...(Array.isArray(item.toolIds) ? item.toolIds : []),
    ].filter(Boolean).join(' ').toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function deriveWorkbenchAgents() {
  const agents = new Map();
  const ensure = (name) => {
    const cleaned = String(name || '').trim();
    if (!cleaned) return null;
    const current = agents.get(cleaned) || {
      name: cleaned,
      toolCount: 0,
      skillCount: 0,
      custom: false,
    };
    agents.set(cleaned, current);
    return current;
  };
  for (const name of normalizeList(state.workspace?.policy?.allowedAgents)) ensure(name);
  for (const tool of normalizeList(state.capabilities.tools)) {
    for (const name of normalizeList(tool.agentNames)) {
      const agent = ensure(name);
      if (!agent) continue;
      agent.toolCount += 1;
      agent.custom = agent.custom || tool.source === 'custom' || tool.origin === 'custom';
    }
  }
  for (const skill of normalizeList(state.capabilities.skills)) {
    for (const name of normalizeList(skill.agentNames)) {
      const agent = ensure(name);
      if (!agent) continue;
      agent.skillCount += 1;
      agent.custom = agent.custom || skill.source === 'custom' || skill.origin === 'custom';
    }
  }
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function workflowTriggerSummary(workflow) {
  const triggers = normalizeList(workflow.triggers)
    .filter((trigger) => trigger.enabled !== false)
    .map((trigger) => trigger.type || 'trigger');
  return triggers.length ? triggers.join(', ') : 'manual';
}

function selectedWorkflow() {
  return state.workflows.workflows.find((workflow) => workflow.id === state.selectedWorkflowId)
    || state.workflows.workflows[0]
    || null;
}

function selectedWorkflowRuns(workflowId) {
  return normalizeList(state.workflows.runs)
    .filter((run) => run.workflowId === workflowId)
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

function filteredWorkflows() {
  const tokens = state.workflowFilter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const workflows = [...normalizeList(state.workflows.workflows)]
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  if (!tokens.length) return workflows;
  return workflows.filter((workflow) => {
    const haystack = [
      workflow.id,
      workflow.title,
      workflow.instructions,
      workflow.agentName,
      workflow.status,
      workflow.latestRunStatus,
      workflow.latestRunSummary,
      workflow.webhookUrl,
      ...normalizeList(workflow.skillNames),
      ...normalizeList(workflow.toolIds),
      ...normalizeList(workflow.triggers).map((trigger) => trigger.type),
    ].filter(Boolean).join(' ').toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function workflowPillKind(status) {
  if (status === 'active' || status === 'completed') return 'ok';
  if (status === 'paused' || status === 'queued' || status === 'running') return 'warn';
  if (status === 'failed' || status === 'cancelled' || status === 'archived') return 'warn';
  return '';
}

function membershipPillKind(status) {
  if (status === 'active') return 'ok';
  if (status === 'invited') return 'warn';
  return 'warn';
}

function filteredMembers() {
  const tokens = state.memberFilter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const members = [...normalizeList(state.admin.members)]
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')) || String(left.email || '').localeCompare(String(right.email || '')));
  if (!tokens.length) return members;
  return members.filter((member) => {
    const haystack = [
      member.accountId,
      member.email,
      member.displayName,
      member.role,
      member.status,
    ].filter(Boolean).join(' ').toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function filteredAuditEvents() {
  const tokens = state.auditFilter.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const events = [...normalizeList(state.admin.auditEvents)]
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  if (!tokens.length) return events;
  return events.filter((event) => {
    const haystack = [
      event.eventId,
      event.actorType,
      event.actorId,
      event.eventType,
      event.targetType,
      event.targetId,
      compactJson(event.metadata),
    ].filter(Boolean).join(' ').toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function deliveryPillKind(status) {
  if (status === 'sent') return 'ok';
  if (status === 'pending' || status === 'claimed' || status === 'failed') return 'warn';
  if (status === 'dead') return 'warn';
  return '';
}

function policyListLabel(values) {
  return Array.isArray(values) && values.length ? values.join(', ') : 'all profile defaults';
}

function workbenchAgentSurfaces() {
  const surfaces = [];
  if (bootstrap.features?.chat !== false) surfaces.push('Web');
  surfaces.push('Desktop cloud');
  if (state.agents.length || state.bindings.length) surfaces.push('Gateway');
  if (bootstrap.features?.workflows !== false) surfaces.push('Workflow');
  return surfaces;
}

function allArtifactRecords() {
  const records = [];
  for (const [sessionId, view] of Object.entries(state.sessionViews)) {
    const projection = runtimeViewFromCloudView(view);
    for (const artifact of normalizeList(projection.artifacts)) {
      records.push({
        sessionId,
        sessionTitle: sessionTitle(view?.session),
        artifact,
        updatedAt: artifact.createdAt || projection.updatedAt || view?.session?.updatedAt || '',
      });
    }
  }
  return records.sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
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
  qsa('[data-chat-control="true"]').forEach((element) => {
    const locked = !workspace || bootstrap.features?.chat === false;
    element.disabled = locked;
    element.dataset.locked = locked ? 'true' : 'false';
  });
  qsa('[data-capability-control="true"]').forEach((element) => {
    const locked = !workspace || (bootstrap.features?.agents === false && bootstrap.features?.customSkills === false && bootstrap.features?.customMcps === false);
    element.disabled = locked;
    element.dataset.locked = locked ? 'true' : 'false';
  });
  qsa('[data-workflow-control="true"]').forEach((element) => {
    const locked = !workspace || bootstrap.features?.workflows === false;
    element.disabled = locked;
    element.dataset.locked = locked ? 'true' : 'false';
  });
  renderRoutes();
}

function renderMembers() {
  const list = qs('#member-list');
  const count = qs('#member-count');
  const inviteForm = qs('#member-invite-form');
  const inviteNotice = qs('#member-invite-notice');
  if (!list) return;
  const policy = state.admin.policy;
  const signup = policy?.signup || {};
  if (inviteForm) {
    qsa('button, input, select', inviteForm).forEach((element) => {
      const locked = adminLocked() || signup.mode !== 'invite';
      element.disabled = locked;
      element.dataset.locked = locked ? 'true' : 'false';
    });
  }
  if (inviteNotice) {
    inviteNotice.textContent = signup.mode === 'invite'
      ? 'Invite mode is enabled. Invited users activate on first verified sign-in.'
      : 'Invite creation is disabled because this deployment signup mode is ' + (signup.mode || 'unknown') + '.';
  }
  const members = filteredMembers();
  if (count) count.textContent = String(members.length);
  removeChildren(list);
  if (state.admin.error) {
    const row = document.createElement('div');
    row.className = 'table-row empty-row';
    row.setAttribute('role', 'row');
    [state.admin.error, '-', '-', '-'].forEach((value) => {
      const cell = document.createElement('span');
      cell.setAttribute('role', 'cell');
      cell.textContent = value;
      row.appendChild(cell);
    });
    list.appendChild(row);
    return;
  }
  if (!members.length) {
    const row = document.createElement('div');
    row.className = 'table-row empty-row';
    row.setAttribute('role', 'row');
    ['No members loaded.', '-', '-', '-'].forEach((value) => {
      const cell = document.createElement('span');
      cell.setAttribute('role', 'cell');
      cell.textContent = value;
      row.appendChild(cell);
    });
    list.appendChild(row);
    return;
  }
  for (const member of members) {
    const row = document.createElement('div');
    row.className = 'table-row member-row';
    row.setAttribute('role', 'row');
    const identity = document.createElement('span');
    identity.setAttribute('role', 'cell');
    identity.textContent = [member.email, member.displayName].filter(Boolean).join(' - ');
    const role = document.createElement('span');
    role.setAttribute('role', 'cell');
    role.appendChild(pill(member.role || 'member', member.role === 'owner' ? 'ok' : ''));
    const status = document.createElement('span');
    status.setAttribute('role', 'cell');
    status.appendChild(pill(member.status || 'unknown', membershipPillKind(member.status)));
    const actions = document.createElement('span');
    actions.setAttribute('role', 'cell');
    actions.className = 'row-actions';
    actions.appendChild(actionButton('Make admin', () => updateMember(member.accountId, { role: 'admin' }), 'secondary', adminLocked() || member.role === 'admin' || member.status === 'disabled'));
    actions.appendChild(actionButton('Make member', () => updateMember(member.accountId, { role: 'member' }), 'secondary', adminLocked() || member.role === 'member' || member.status === 'disabled'));
    if (member.status === 'invited') {
      actions.appendChild(actionButton('Activate', () => updateMember(member.accountId, { status: 'active' }), 'primary', adminLocked()));
      actions.appendChild(actionButton('Revoke', () => disableMember(member.accountId), 'danger', adminLocked()));
    } else if (member.status !== 'disabled') {
      actions.appendChild(actionButton('Suspend', () => disableMember(member.accountId), 'danger', adminLocked()));
    }
    row.appendChild(identity);
    row.appendChild(role);
    row.appendChild(status);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function renderAdminPolicy() {
  const overview = qs('#admin-policy-overview');
  const features = qs('#admin-policy-features');
  const project = qs('#admin-project-policy');
  const runtime = qs('#admin-runtime-policy');
  const policy = state.admin.policy;
  if (overview) {
    removeChildren(overview);
    if (!policy) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = state.admin.error || 'No policy loaded.';
      overview.appendChild(empty);
    } else {
      const rows = [
        ['Org', policy.org?.name || policy.org?.orgId || 'unknown'],
        ['Signup mode', policy.signup?.mode || 'unknown'],
        ['Profile', [policy.profile?.name, policy.profile?.label].filter(Boolean).join(' - ')],
        ['Allowed agents', policyListLabel(policy.allowedAgents)],
        ['Allowed tools', policyListLabel(policy.allowedTools)],
        ['Allowed MCPs', policyListLabel(policy.allowedMcps)],
      ];
      for (const [label, value] of rows) {
        const row = document.createElement('div');
        row.className = 'row compact';
        const strong = document.createElement('strong');
        strong.textContent = label;
        const span = document.createElement('span');
        span.textContent = value || 'not configured';
        row.appendChild(strong);
        row.appendChild(span);
        overview.appendChild(row);
      }
      if (normalizeList(policy.signup?.allowedEmailDomains).length) {
        const row = document.createElement('div');
        row.className = 'row compact';
        const strong = document.createElement('strong');
        strong.textContent = 'Allowed domains';
        const span = document.createElement('span');
        span.textContent = policy.signup.allowedEmailDomains.join(', ');
        row.appendChild(strong);
        row.appendChild(span);
        overview.appendChild(row);
      }
    }
  }
  if (features) {
    removeChildren(features);
    const entries = Object.entries(safeObject(policy?.features || bootstrap.features)).sort(([left], [right]) => left.localeCompare(right));
    for (const [name, enabled] of entries) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const strong = document.createElement('strong');
      strong.textContent = name;
      const status = pill(enabled ? 'enabled' : 'disabled', enabled ? 'ok' : 'warn');
      row.appendChild(strong);
      row.appendChild(status);
      features.appendChild(row);
    }
  }
  if (project) {
    removeChildren(project);
    const sources = safeObject(policy?.projectSources);
    const rows = [
      ['Git hosts', policyListLabel(normalizeList(sources.git?.allowedHosts))],
      ['Git repositories', policyListLabel(normalizeList(sources.git?.allowedRepositories))],
      ['Git file URLs', sources.git?.allowFileUrls ? 'allowed' : 'disabled'],
      ['Uploaded snapshots', sources.uploadedSnapshots?.enabled ? 'enabled' : 'disabled'],
      ['Snapshot max files', sources.uploadedSnapshots?.maxFiles ?? 'not configured'],
      ['Snapshot max bytes', sources.uploadedSnapshots?.maxBytes ?? 'not configured'],
      ['Managed workspaces', sources.managedWorkspaces?.enabled ? 'enabled' : 'disabled'],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const strong = document.createElement('strong');
      strong.textContent = label;
      const span = document.createElement('span');
      span.textContent = String(value);
      row.appendChild(strong);
      row.appendChild(span);
      project.appendChild(row);
    }
  }
  if (runtime) {
    removeChildren(runtime);
    const rows = [
      ['Machine runtime config', policy?.runtime?.machineRuntimeConfig || 'disabled'],
      ['Stdio MCP processes', policy?.runtime?.localStdioMcps || 'disabled'],
      ['Host project directories', policy?.runtime?.hostProjectDirectories || 'disabled'],
      ['Gateway channels', policy?.gateway?.channelsEnabled ? 'enabled' : 'disabled'],
      ['Gateway webhooks', policy?.gateway?.webhooksEnabled ? 'enabled' : 'disabled'],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const strong = document.createElement('strong');
      strong.textContent = label;
      const span = document.createElement('span');
      span.textContent = String(value);
      row.appendChild(strong);
      row.appendChild(span);
      runtime.appendChild(row);
    }
  }
}

function renderAudit() {
  const list = qs('#audit-list');
  const count = qs('#audit-count');
  if (!list) return;
  const events = filteredAuditEvents();
  if (count) count.textContent = String(events.length);
  removeChildren(list);
  if (state.admin.error) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.admin.error;
    list.appendChild(empty);
    return;
  }
  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No audit events loaded.';
    list.appendChild(empty);
    return;
  }
  for (const event of events.slice(0, 100)) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = event.eventType || event.eventId || 'audit event';
    main.appendChild(title);
    const meta = document.createElement('small');
    meta.textContent = [
      event.actorType ? event.actorType + ':' + (event.actorId || 'unknown') : null,
      event.targetType ? event.targetType + ':' + (event.targetId || 'unknown') : null,
      formatDate(event.createdAt),
    ].filter(Boolean).join(' - ');
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(pill(event.actorType || 'system'));
    row.appendChild(main);
    row.appendChild(actions);
    appendDetails(row, 'Redacted metadata', event.metadata || {});
    list.appendChild(row);
  }
}

function renderByok() {
  const list = qs('#byok-list');
  const policyNote = qs('#byok-policy-note');
  if (!list) return;
  if (policyNote) {
    const byokPolicy = state.admin.policy?.byok || {};
    const providers = normalizeList(byokPolicy.allowedProviderIds);
    const parts = [
      providers.length ? 'Allowed providers: ' + providers.join(', ') : 'Allowed providers: profile defaults',
      byokPolicy.kmsRefsEnabled ? 'KMS refs enabled' : 'KMS refs disabled',
      byokPolicy.envRefsEnabled ? 'env: refs enabled' : 'env: refs disabled',
    ];
    policyNote.textContent = parts.join(' - ');
  }
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
    main.appendChild(document.createTextNode(' ' + (secret.credentialKind === 'kms_ref' ? 'KMS ref' : 'key') + ' ending ' + secret.last4));
    const meta = document.createElement('small');
    meta.textContent = [
      'Updated ' + formatDate(secret.updatedAt),
      secret.lastValidatedAt ? 'validated ' + formatDate(secret.lastValidatedAt) : 'not validated',
      secret.validationError ? 'validation: ' + secret.validationError : null,
    ].filter(Boolean).join(' - ');
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
  const deliveries = qs('#delivery-list');
  const setup = qs('#gateway-setup-guide');
  const select = qs('#binding-agent');
  if (!agents || !bindings || !select) return;
  removeChildren(agents);
  removeChildren(bindings);
  removeChildren(select);
  if (deliveries) removeChildren(deliveries);
  if (setup) {
    removeChildren(setup);
    const steps = [
      'Create or rotate a gateway-scoped service token in Connections.',
      'Deploy the gateway with OPEN_COWORK_CLOUD_BASE_URL and OPEN_COWORK_GATEWAY_SERVICE_TOKEN.',
      'Telegram: set OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN and bind the bot workspace.',
      'Slack: set OPEN_COWORK_GATEWAY_SLACK_BOT_TOKEN plus signing secret and bind the team/channel.',
      'Email: configure inbound secret plus SMTP settings, then bind the inbound address/domain.',
      'Webhook: set OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET and a HTTPS delivery URL.',
      'Use the delivery backlog below to retry or dead-letter stuck outbound messages.',
    ];
    for (const step of steps) {
      const row = document.createElement('div');
      row.className = 'row compact';
      row.appendChild(pill(String(setup.children.length + 1)));
      const text = document.createElement('span');
      text.textContent = step;
      row.appendChild(text);
      setup.appendChild(row);
    }
  }
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
  if (deliveries) {
    const backlog = normalizeList(state.deliveries);
    if (!backlog.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No gateway deliveries loaded.';
      deliveries.appendChild(empty);
    }
    for (const delivery of backlog.slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'row';
      const main = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = delivery.eventType || delivery.deliveryId || 'delivery';
      main.appendChild(title);
      const meta = document.createElement('small');
      meta.textContent = [
        delivery.provider,
        delivery.channelBindingId,
        'attempts ' + (delivery.attemptCount || 0),
        delivery.lastError ? safeOperationalText(delivery.lastError) : null,
        'next ' + formatDate(delivery.nextAttemptAt),
      ].filter(Boolean).join(' - ');
      main.appendChild(document.createElement('br'));
      main.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(pill(delivery.status || 'unknown', deliveryPillKind(delivery.status)));
      actions.appendChild(actionButton('Retry', () => retryDelivery(delivery.deliveryId), 'secondary', adminLocked() || !delivery.deliveryId || delivery.status === 'sent'));
      actions.appendChild(actionButton('Dead-letter', () => deadLetterDelivery(delivery.deliveryId), 'danger', adminLocked() || !delivery.deliveryId || delivery.status === 'dead'));
      row.appendChild(main);
      row.appendChild(actions);
      appendDetails(row, 'Redacted delivery payload', {
        target: safeOperationalMetadata(delivery.target),
        payload: safeOperationalMetadata(delivery.payload),
      });
      deliveries.appendChild(row);
    }
  }
}

function renderWorkbenchAgents() {
  const list = qs('#workbench-agent-list');
  const policy = qs('#agent-policy-list');
  if (!list) return;
  removeChildren(list);
  const agents = deriveWorkbenchAgents();
  const surfaces = workbenchAgentSurfaces();
  if (!agents.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.capabilities.error || 'No profile-allowed agents loaded.';
    list.appendChild(empty);
  }
  for (const agent of agents) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = agent.name;
    main.appendChild(title);
    main.appendChild(document.createTextNode(agent.custom ? ' - custom metadata' : ' - built-in/profile'));
    const meta = document.createElement('small');
    meta.textContent = [
      agent.toolCount + ' tool(s)',
      agent.skillCount + ' skill(s)',
      surfaces.join(', '),
    ].join(' - ');
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(pill(agent.custom ? 'custom' : 'profile', agent.custom ? 'warn' : 'ok'));
    actions.appendChild(actionButton('Start thread', () => startAgentThread(agent.name), 'primary', bootstrap.features?.chat === false || bootstrap.features?.agents === false));
    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }
  if (!policy) return;
  removeChildren(policy);
  const policyRows = [
    ['Profile', state.workspace?.profileName || bootstrap.profileName || 'default'],
    ['Chat', bootstrap.features?.chat === false ? 'disabled' : 'enabled'],
    ['Workflows', bootstrap.features?.workflows === false ? 'disabled' : 'enabled'],
    ['Surfaces', surfaces.join(', ') || 'none'],
  ];
  for (const [label, value] of policyRows) {
    const row = document.createElement('div');
    row.className = 'row compact';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const span = document.createElement('span');
    span.textContent = value;
    row.appendChild(strong);
    row.appendChild(span);
    policy.appendChild(row);
  }
}

function renderCapabilityRows(target, items, emptyText) {
  removeChildren(target);
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = emptyText;
    target.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = capabilityLabel(item);
    main.appendChild(title);
    const description = document.createElement('p');
    description.className = 'empty';
    description.textContent = item.description || capabilityPolicyNote(item);
    main.appendChild(description);
    const meta = document.createElement('small');
    meta.textContent = [
      item.kind || 'skill',
      item.source || item.origin || 'profile',
      item.scope || null,
      normalizeList(item.agentNames).length ? 'agents: ' + normalizeList(item.agentNames).join(', ') : null,
      normalizeList(item.toolIds).length ? 'tools: ' + normalizeList(item.toolIds).join(', ') : null,
    ].filter(Boolean).join(' - ');
    main.appendChild(meta);
    main.appendChild(document.createElement('br'));
    const policy = document.createElement('small');
    policy.textContent = capabilityPolicyNote(item);
    main.appendChild(policy);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(pill(item.source === 'custom' ? 'custom' : 'allowed', item.source === 'custom' ? 'warn' : 'ok'));
    row.appendChild(main);
    row.appendChild(actions);
    target.appendChild(row);
  }
}

function renderCapabilities() {
  const toolList = qs('#tool-list');
  const skillList = qs('#skill-list');
  const note = qs('#capability-policy-note');
  if (!toolList || !skillList) return;
  const tools = filterCapabilities(normalizeList(state.capabilities.tools));
  const skills = filterCapabilities(normalizeList(state.capabilities.skills));
  renderCapabilityRows(toolList, tools, state.capabilities.error || 'No allowed tools loaded.');
  renderCapabilityRows(skillList, skills, state.capabilities.error || 'No allowed skills loaded.');
  if (!note) return;
  removeChildren(note);
  if (state.capabilities.error) {
    const error = document.createElement('p');
    error.className = 'notice';
    error.textContent = state.capabilities.error;
    note.appendChild(error);
  }
  const rows = [
    bootstrap.features?.agents === false ? 'Agent capability browsing is disabled by this org profile.' : null,
    bootstrap.features?.customSkills === false ? 'Custom skill metadata may be synced but is disabled by this org profile.' : null,
    bootstrap.features?.customMcps === false ? 'Custom MCP metadata may be synced but is disabled by this org profile.' : null,
  ].filter(Boolean);
  if (!rows.length) rows.push('The browser shows cloud-safe capability metadata and policy verdicts only.');
  for (const text of rows) {
    const row = document.createElement('p');
    row.className = 'empty';
    row.textContent = text;
    note.appendChild(row);
  }
}

function renderWorkflows() {
  const list = qs('#workflow-list');
  const runs = qs('#workflow-run-list');
  const detail = qs('#workflow-detail');
  if (!list) return;
  removeChildren(list);
  const workflows = filteredWorkflows();
  if (!state.selectedWorkflowId && workflows[0]) state.selectedWorkflowId = workflows[0].id;
  if (!workflows.length) {
    const row = document.createElement('div');
    row.className = 'table-row empty-row';
    row.setAttribute('role', 'row');
    [state.workflows.error || 'No workflows loaded.', '-', '-', '-'].forEach((value) => {
      const cell = document.createElement('span');
      cell.setAttribute('role', 'cell');
      cell.textContent = value;
      row.appendChild(cell);
    });
    list.appendChild(row);
  }
  for (const workflow of workflows) {
    const row = document.createElement('div');
    row.className = 'table-row thread-row';
    row.dataset.selected = state.selectedWorkflowId === workflow.id ? 'true' : 'false';
    row.setAttribute('role', 'row');
    const selectWorkflow = () => {
      state.selectedWorkflowId = workflow.id;
      renderWorkflows();
    };
    const title = document.createElement('span');
    title.setAttribute('role', 'cell');
    const titleButton = document.createElement('button');
    titleButton.type = 'button';
    titleButton.className = 'row-link';
    titleButton.textContent = workflow.title || workflow.id;
    titleButton.setAttribute('aria-pressed', state.selectedWorkflowId === workflow.id ? 'true' : 'false');
    titleButton.addEventListener('click', selectWorkflow);
    title.appendChild(titleButton);
    const status = document.createElement('span');
    status.setAttribute('role', 'cell');
    status.appendChild(pill(workflow.status || 'unknown', workflowPillKind(workflow.status)));
    const last = document.createElement('span');
    last.setAttribute('role', 'cell');
    last.textContent = workflow.latestRunStatus || workflow.lastRunAt || 'never';
    const next = document.createElement('span');
    next.setAttribute('role', 'cell');
    next.textContent = workflow.nextRunAt ? formatDate(workflow.nextRunAt) : workflowTriggerSummary(workflow);
    row.appendChild(title);
    row.appendChild(status);
    row.appendChild(last);
    row.appendChild(next);
    list.appendChild(row);
  }

  const workflow = selectedWorkflow();
  if (runs) {
    removeChildren(runs);
    if (!workflow) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Select a workflow to inspect runs.';
      runs.appendChild(empty);
    } else {
      const workflowRuns = selectedWorkflowRuns(workflow.id);
      if (!workflowRuns.length) {
        const empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'No runs recorded.';
        runs.appendChild(empty);
      }
      for (const run of workflowRuns.slice(0, 12)) {
        const row = document.createElement('div');
        row.className = 'row compact';
        const main = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = run.title || run.id;
        main.appendChild(title);
        const meta = document.createElement('small');
        meta.textContent = [
          run.triggerType || 'manual',
          formatDate(run.createdAt),
          run.summary || run.error || null,
        ].filter(Boolean).join(' - ');
        main.appendChild(document.createElement('br'));
        main.appendChild(meta);
        const actions = document.createElement('div');
        actions.className = 'row-actions';
        actions.appendChild(pill(run.status || 'unknown', workflowPillKind(run.status)));
        if (run.sessionId) actions.appendChild(actionButton('Open thread', () => selectSession(run.sessionId), 'secondary'));
        row.appendChild(main);
        row.appendChild(actions);
        runs.appendChild(row);
      }
    }
  }

  if (!detail) return;
  removeChildren(detail);
  if (!workflow) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = state.workflows.error || 'Select or create a workflow.';
    detail.appendChild(empty);
    return;
  }
  detail.appendChild(pill(workflow.status || 'unknown', workflowPillKind(workflow.status)));
  detail.appendChild(pill('trigger: ' + workflowTriggerSummary(workflow)));
  if (workflow.webhookUrl) detail.appendChild(pill('webhook configured', 'ok'));
  const text = document.createElement('p');
  text.className = 'empty';
  text.textContent = workflow.instructions || 'No instructions.';
  detail.appendChild(text);
  appendDetails(detail, 'Workflow metadata', {
    id: workflow.id,
    agentName: workflow.agentName,
    skillNames: workflow.skillNames,
    toolIds: workflow.toolIds,
    latestRunId: workflow.latestRunId,
    latestRunStatus: workflow.latestRunStatus,
    latestRunSummary: workflow.latestRunSummary,
    nextRunAt: workflow.nextRunAt,
    lastRunAt: workflow.lastRunAt,
  });
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(actionButton('Run now', () => runWorkflow(workflow.id), 'primary', bootstrap.features?.workflows === false || workflow.status === 'archived'));
  if (workflow.status === 'paused') actions.appendChild(actionButton('Resume', () => updateWorkflowStatus(workflow.id, 'resume'), 'secondary', bootstrap.features?.workflows === false));
  else actions.appendChild(actionButton('Pause', () => updateWorkflowStatus(workflow.id, 'pause'), 'secondary', bootstrap.features?.workflows === false || workflow.status === 'archived'));
  actions.appendChild(actionButton('Archive', () => updateWorkflowStatus(workflow.id, 'archive'), 'danger', bootstrap.features?.workflows === false || workflow.status === 'archived'));
  if (workflow.latestRunSessionId) actions.appendChild(actionButton('Open run thread', () => selectSession(workflow.latestRunSessionId), 'secondary'));
  detail.appendChild(actions);
}

function renderBilling() {
  const billing = state.billing;
  const panel = qs('#billing-summary');
  const entitlements = qs('#billing-entitlements');
  const planSelect = qs('#billing-plan-select');
  if (!panel) return;
  removeChildren(panel);
  if (entitlements) removeChildren(entitlements);
  if (!billing || !billing.enabled) {
    panel.appendChild(pill('billing disabled', 'warn'));
    const text = document.createElement('p');
    text.className = 'empty';
    text.textContent = 'Self-host mode is active. BYOK, desktop tokens, gateway setup, and workbench features remain available without commercial billing.';
    panel.appendChild(text);
    if (entitlements) appendDetails(entitlements, 'Self-host entitlements', billing?.entitlements || {});
    qsa('[data-billing-control="true"]').forEach((element) => { element.disabled = true; });
    return;
  }
  qsa('[data-billing-control="true"]').forEach((element) => { element.disabled = adminLocked(); });
  panel.appendChild(pill(billing.active ? 'active' : 'action required', billing.active ? 'ok' : 'warn'));
  panel.appendChild(pill(billing.mode || 'managed'));
  panel.appendChild(pill(billing.providerId || 'provider'));
  const detail = document.createElement('p');
  const subscription = billing.subscription;
  detail.textContent = subscription
    ? subscription.planKey + ' - ' + subscription.status + ' - ' + subscription.seats + ' seat(s)' + (subscription.currentPeriodEnd ? ' - renews ' + formatDate(subscription.currentPeriodEnd) : '')
    : 'No subscription is attached to this org.';
  panel.appendChild(detail);
  if (planSelect) {
    removeChildren(planSelect);
    for (const plan of normalizeList(billing.plans)) {
      const option = document.createElement('option');
      option.value = plan.planKey;
      option.textContent = plan.label + (plan.default ? ' (default)' : '');
      planSelect.appendChild(option);
    }
  }
  if (entitlements) {
    const plans = normalizeList(billing.plans);
    for (const plan of plans) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const main = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = plan.label || plan.planKey;
      main.appendChild(title);
      const meta = document.createElement('small');
      meta.textContent = plan.planKey + (plan.default ? ' - default' : '');
      main.appendChild(document.createElement('br'));
      main.appendChild(meta);
      row.appendChild(main);
      row.appendChild(pill(plan.default ? 'default' : 'available'));
      appendDetails(row, 'Entitlements', plan.entitlements || {});
      entitlements.appendChild(row);
    }
    if (!plans.length) appendDetails(entitlements, 'Resolved entitlements', billing.entitlements || {});
  }
}

function renderUsage() {
  const list = qs('#usage-list');
  const quotas = qs('#usage-quota-list');
  const totals = qs('#usage-total-list');
  if (!list) return;
  removeChildren(list);
  if (quotas) {
    removeChildren(quotas);
    const quotaRows = normalizeList(state.usageSummary?.quotas);
    if (!quotaRows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No quota windows loaded.';
      quotas.appendChild(empty);
    }
    for (const quota of quotaRows) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const main = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = quota.label || quota.quotaKey;
      main.appendChild(title);
      const meta = document.createElement('small');
      meta.textContent = quota.enabled
        ? quantityLabel(quota.used, quota.unit) + ' of ' + quantityLabel(quota.limit, quota.unit) + ' - resets ' + formatDate(quota.resetAt)
        : 'unlimited or disabled';
      main.appendChild(document.createElement('br'));
      main.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(pill(quota.enabled ? percentLabel(quota.used, quota.limit) : 'unlimited', quota.enabled ? 'warn' : 'ok'));
      row.appendChild(main);
      row.appendChild(actions);
      quotas.appendChild(row);
    }
  }
  if (totals) {
    removeChildren(totals);
    const totalRows = normalizeList(state.usageSummary?.totals);
    const scope = document.createElement('p');
    scope.className = 'empty';
    scope.textContent = 'Recent totals from the latest ' + (state.usageSummary?.eventSampleLimit || 100) + ' usage events.';
    totals.appendChild(scope);
    if (!totalRows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No usage totals loaded.';
      totals.appendChild(empty);
    }
    for (const total of totalRows) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const strong = document.createElement('strong');
      strong.textContent = total.eventType;
      const span = document.createElement('span');
      span.textContent = quantityLabel(total.quantity, total.unit);
      row.appendChild(strong);
      row.appendChild(span);
      totals.appendChild(row);
    }
  }
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

function renderDiagnostics() {
  const health = qs('#diagnostics-health');
  const bundle = qs('#diagnostics-bundle');
  if (!health || !bundle) return;
  removeChildren(health);
  removeChildren(bundle);
  const diagnostics = state.diagnostics;
  if (!diagnostics) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = adminLocked() ? 'Diagnostics require admin or operator privileges.' : 'Diagnostics have not been requested.';
    health.appendChild(empty);
    return;
  }
  const runtime = safeObject(diagnostics.runtime);
  const gateway = safeObject(diagnostics.gateway);
  const byok = safeObject(diagnostics.byok);
  const rows = [
    ['Generated', formatDate(diagnostics.generatedAt)],
    ['Redaction', diagnostics.redaction || 'secrets-redacted'],
    ['Runtime role', runtime.role || 'unknown'],
    ['Command processing', runtime.commandProcessing || 'unknown'],
    ['Worker heartbeats', runtime.heartbeatCount ?? 0],
    ['BYOK providers', byok.configuredProviders ?? 0],
    ['Gateway agents', safeObject(gateway.agents).total ?? 0],
    ['Delivery status sample', 'latest ' + (gateway.deliverySampleLimit || 200) + ' deliveries'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'row compact';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const span = document.createElement('span');
    span.textContent = String(value);
    row.appendChild(strong);
    row.appendChild(span);
    health.appendChild(row);
  }
  appendDetails(bundle, 'Redacted diagnostics JSON', diagnostics);
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(actionButton('Download bundle', () => downloadJson('open-cowork-diagnostics.json', diagnostics), 'primary', false));
  bundle.appendChild(actions);
}

function sessionTitle(session) {
  return session?.title || session?.sessionId || 'New session';
}

function sessionStatus(session, projection) {
  if (projection?.pendingApprovals?.length) return 'approval';
  if (projection?.pendingQuestions?.length) return 'question';
  return projection?.status || session?.status || 'idle';
}

function projectionFromView(view) {
  const projection = view?.projection?.view;
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
    return {
      title: view?.session?.title || null,
      profileName: view?.session?.profileName || null,
      messages: [],
      toolCalls: [],
      taskRuns: [],
      pendingApprovals: [],
      pendingQuestions: [],
      resolvedApprovals: [],
      resolvedQuestions: [],
      artifacts: [],
      todos: [],
      errors: [],
      sessionCost: 0,
      sessionTokens: {},
      lastInputTokens: 0,
      isGenerating: false,
      contextState: 'idle',
      compactionCount: 0,
      lastCompactedAt: null,
      origin: null,
      projectSource: null,
      tags: [],
      smartFilters: [],
      updatedAt: view?.session?.updatedAt || null,
      status: view?.session?.status || 'idle',
    };
  }
  return {
    title: projection.title || view?.session?.title || null,
    profileName: projection.profileName || view?.session?.profileName || null,
    messages: Array.isArray(projection.messages) ? projection.messages : [],
    toolCalls: Array.isArray(projection.toolCalls) ? projection.toolCalls : [],
    taskRuns: Array.isArray(projection.taskRuns) ? projection.taskRuns : [],
    pendingApprovals: Array.isArray(projection.pendingApprovals) ? projection.pendingApprovals : [],
    pendingQuestions: Array.isArray(projection.pendingQuestions) ? projection.pendingQuestions : [],
    resolvedApprovals: Array.isArray(projection.resolvedApprovals) ? projection.resolvedApprovals : [],
    resolvedQuestions: Array.isArray(projection.resolvedQuestions) ? projection.resolvedQuestions : [],
    artifacts: Array.isArray(projection.artifacts) ? projection.artifacts : [],
    todos: Array.isArray(projection.todos) ? projection.todos : [],
    errors: Array.isArray(projection.errors) ? projection.errors : [],
    sessionCost: typeof projection.sessionCost === 'number' ? projection.sessionCost : 0,
    sessionTokens: projection.sessionTokens && typeof projection.sessionTokens === 'object' ? projection.sessionTokens : {},
    lastInputTokens: typeof projection.lastInputTokens === 'number' ? projection.lastInputTokens : 0,
    isGenerating: Boolean(projection.isGenerating),
    contextState: projection.contextState || 'idle',
    compactionCount: typeof projection.compactionCount === 'number' ? projection.compactionCount : 0,
    lastCompactedAt: projection.lastCompactedAt || null,
    origin: projection.origin && typeof projection.origin === 'object' ? projection.origin : null,
    projectSource: projection.projectSource && typeof projection.projectSource === 'object' ? projection.projectSource : null,
    tags: Array.isArray(projection.tags) ? projection.tags : [],
    smartFilters: Array.isArray(projection.smartFilters) ? projection.smartFilters : [],
    updatedAt: projection.updatedAt || view?.session?.updatedAt || null,
    status: projection.status || view?.session?.status || 'idle',
  };
}

function threadTags(session, projection) {
  return [
    ...(Array.isArray(session?.tags) ? session.tags : []),
    ...(Array.isArray(session?.smartFilters) ? session.smartFilters : []),
    ...(Array.isArray(projection.tags) ? projection.tags : []),
    ...(Array.isArray(projection.smartFilters) ? projection.smartFilters : []),
  ].filter((entry) => typeof entry === 'string' && entry.trim());
}

function projectLabel(projectSource) {
  if (!projectSource) return 'chat-only';
  if (projectSource.kind === 'git') {
    const repo = String(projectSource.repositoryUrl || 'git repository');
    return repo.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || repo;
  }
  if (projectSource.kind === 'snapshot') return projectSource.title || 'uploaded snapshot';
  return 'project';
}

function filteredSessions() {
  const query = state.threadFilters.query.trim().toLowerCase();
  const queryTokens = query.split(/\s+/).filter(Boolean);
  const status = state.threadFilters.status;
  const profile = state.threadFilters.profile.trim().toLowerCase();
  const project = state.threadFilters.project;
  const tag = state.threadFilters.tag.trim().toLowerCase();
  return [...state.sessions]
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .filter((session) => {
      const view = state.sessionViews[session.sessionId];
      const projection = projectionFromView(view);
      const computedStatus = sessionStatus(session, projection);
      if (status !== 'all' && computedStatus !== status && session.status !== status) return false;
      if (profile && String(session.profileName || projection.profileName || '').toLowerCase() !== profile) return false;
      if (project !== 'all') {
        const kind = projection.projectSource?.kind || 'chat';
        if (project !== kind) return false;
      }
      if (tag && !threadTags(session, projection).some((entry) => entry.toLowerCase().includes(tag))) return false;
      if (!queryTokens.length) return true;
      const haystack = [
        session.sessionId,
        session.title,
        session.profileName,
        computedStatus,
        projectLabel(projection.projectSource),
        ...threadTags(session, projection),
      ].filter(Boolean).join(' ').toLowerCase();
      return queryTokens.every((token) => haystack.includes(token));
    });
}

function statusPillKind(status) {
  if (status === 'running') return 'ok';
  if (status === 'approval' || status === 'question') return 'warn';
  if (status === 'errored' || status === 'error') return 'warn';
  return '';
}

function errorCategory(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('policy') || text.includes('disabled') || text.includes('not allowed')) return 'policy';
  if (text.includes('auth') || text.includes('token') || text.includes('forbidden') || text.includes('unauthorized')) return 'auth';
  if (text.includes('quota') || text.includes('rate limit') || text.includes('too many')) return 'quota';
  if (text.includes('billing') || text.includes('subscription') || text.includes('payment')) return 'billing';
  if (text.includes('provider') || text.includes('model') || text.includes('api key')) return 'provider';
  return 'runtime';
}

function appendDetails(parent, summaryText, value) {
  const details = document.createElement('details');
  details.className = 'runtime-detail';
  const summary = document.createElement('summary');
  summary.textContent = summaryText;
  const pre = document.createElement('pre');
  pre.textContent = compactJson(value);
  details.appendChild(summary);
  details.appendChild(pre);
  parent.appendChild(details);
}

function renderRuntimeSummary(projection) {
  const summary = document.createElement('section');
  summary.className = 'runtime-summary';
  summary.appendChild(pill(projection.status || 'idle', statusPillKind(projection.status)));
  if (projection.isGenerating) summary.appendChild(pill('generating', 'ok'));
  if (projection.isAwaitingPermission) summary.appendChild(pill('awaiting approval', 'warn'));
  if (projection.isAwaitingQuestion) summary.appendChild(pill('awaiting answer', 'warn'));
  summary.appendChild(pill('cost $' + Number(projection.sessionCost || 0).toFixed(4)));
  const tokens = safeObject(projection.sessionTokens);
  const tokenText = [
    'in ' + tokenNumber(tokens.input),
    'out ' + tokenNumber(tokens.output),
    'reason ' + tokenNumber(tokens.reasoning),
    'cache ' + (tokenNumber(tokens.cacheRead) + tokenNumber(tokens.cacheWrite)),
  ].join(' / ');
  summary.appendChild(pill(tokenText));
  if (projection.contextState && projection.contextState !== 'idle') summary.appendChild(pill('context ' + projection.contextState));
  if (projection.compactionCount) summary.appendChild(pill('compactions ' + projection.compactionCount));
  return summary;
}

function renderApprovalCard(approval) {
  const key = 'approval:' + approval.id;
  const card = document.createElement('article');
  card.className = 'runtime-card';
  card.dataset.kind = 'approval';
  const header = document.createElement('div');
  header.className = 'runtime-card-header';
  header.appendChild(pill('Approval', 'warn'));
  const title = document.createElement('strong');
  title.textContent = approval.description || approval.tool || 'Permission requested';
  header.appendChild(title);
  card.appendChild(header);
  const meta = document.createElement('small');
  meta.textContent = [approval.tool, approval.taskRunId ? 'task ' + approval.taskRunId : null].filter(Boolean).join(' - ');
  card.appendChild(meta);
  appendDetails(card, 'Permission input', approval.input || {});
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(actionButton('Allow', () => respondToPermission(approval.id, true), 'primary', actionPending(key)));
  actions.appendChild(actionButton('Deny', () => respondToPermission(approval.id, false), 'danger', actionPending(key)));
  card.appendChild(actions);
  return card;
}

function renderQuestionCard(question) {
  const key = 'question:' + question.id;
  const card = document.createElement('article');
  card.className = 'runtime-card';
  card.dataset.kind = 'question';
  const header = document.createElement('div');
  header.className = 'runtime-card-header';
  header.appendChild(pill('Question', 'warn'));
  const title = document.createElement('strong');
  title.textContent = question.questions?.[0]?.question || 'Question requested';
  header.appendChild(title);
  card.appendChild(header);
  for (const prompt of normalizeList(question.questions)) {
    const block = document.createElement('div');
    block.className = 'question-block';
    if (prompt.header) {
      const heading = document.createElement('strong');
      heading.textContent = prompt.header;
      block.appendChild(heading);
    }
    const text = document.createElement('p');
    text.textContent = prompt.question || '';
    block.appendChild(text);
    if (Array.isArray(prompt.options) && prompt.options.length) {
      const choices = document.createElement('div');
      choices.className = 'choice-row';
      for (const option of prompt.options) {
        choices.appendChild(actionButton(option.label || option.description || 'Select', () => answerQuestion(question.id, [option.label || option.description || '']), 'secondary', actionPending(key)));
      }
      block.appendChild(choices);
    }
    card.appendChild(block);
  }
  const input = document.createElement('textarea');
  input.placeholder = 'Answer';
  input.rows = 3;
  input.dataset.questionAnswer = question.id;
  input.disabled = actionPending(key);
  card.appendChild(input);
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(actionButton('Send answer', () => answerQuestion(question.id, [input.value.trim()].filter(Boolean)), 'primary', actionPending(key)));
  actions.appendChild(actionButton('Reject', () => rejectQuestion(question.id), 'danger', actionPending(key)));
  card.appendChild(actions);
  return card;
}

function renderResolvedCard(kind, item) {
  const row = document.createElement('div');
  row.className = 'activity-row';
  if (kind === 'approval') {
    row.appendChild(pill(item.allowed ? 'approved' : 'denied', item.allowed ? 'ok' : 'warn'));
    const text = document.createElement('span');
    text.textContent = item.description || item.tool || item.id;
    row.appendChild(text);
  } else {
    row.appendChild(pill(item.rejected ? 'question rejected' : 'answered', item.rejected ? 'warn' : 'ok'));
    const text = document.createElement('span');
    const prompt = item.questions?.[0]?.question || item.id;
    const answers = item.answers?.length ? ': ' + item.answers.join(', ') : '';
    text.textContent = prompt + answers;
    row.appendChild(text);
  }
  return row;
}

function renderMessageBubble(message) {
  const bubble = document.createElement('article');
  bubble.className = 'message-bubble';
  bubble.dataset.role = message.role;
  const heading = document.createElement('div');
  heading.className = 'message-heading';
  heading.textContent = message.role === 'user' ? 'You' : 'Assistant';
  const body = document.createElement('p');
  body.textContent = messageText(message);
  bubble.appendChild(heading);
  bubble.appendChild(body);
  if (Array.isArray(message.attachments) && message.attachments.length) {
    appendDetails(bubble, 'Attachments', message.attachments);
  }
  return bubble;
}

function renderToolTrace(tool) {
  const details = document.createElement('details');
  details.className = 'runtime-detail tool-trace';
  const summary = document.createElement('summary');
  summary.appendChild(pill(tool.status || 'tool', statusPillKind(tool.status)));
  const title = document.createElement('span');
  title.textContent = tool.name || tool.id || 'Tool call';
  summary.appendChild(title);
  details.appendChild(summary);
  appendDetails(details, 'Input', tool.input || {});
  if (tool.output !== undefined) appendDetails(details, 'Output', tool.output);
  if (Array.isArray(tool.attachments) && tool.attachments.length) appendDetails(details, 'Attachments', tool.attachments);
  return details;
}

function renderTaskRun(task) {
  const details = document.createElement('details');
  details.className = 'runtime-detail task-run';
  const summary = document.createElement('summary');
  summary.appendChild(pill(task.status || 'task', statusPillKind(task.status)));
  const title = document.createElement('span');
  title.textContent = task.title || task.agent || task.id || 'Task run';
  summary.appendChild(title);
  details.appendChild(summary);
  if (task.content) {
    const body = document.createElement('p');
    body.textContent = task.content;
    details.appendChild(body);
  }
  if (task.agent) details.appendChild(pill('agent ' + task.agent));
  if (task.error) {
    const error = document.createElement('p');
    error.className = 'notice';
    error.textContent = task.error;
    details.appendChild(error);
  }
  for (const tool of normalizeList(task.toolCalls)) {
    details.appendChild(renderToolTrace(tool));
  }
  if (normalizeList(task.todos).length) appendDetails(details, 'Task todos', task.todos);
  return details;
}

function renderArtifactCard(artifact) {
  const id = artifactId(artifact);
  const card = document.createElement('article');
  card.className = 'runtime-card artifact-card';
  card.dataset.kind = 'artifact';
  const header = document.createElement('div');
  header.className = 'runtime-card-header';
  header.appendChild(pill('Artifact', 'ok'));
  const title = document.createElement('strong');
  title.textContent = artifact.filename || artifact.name || id || 'Artifact';
  header.appendChild(title);
  card.appendChild(header);
  const meta = document.createElement('small');
  meta.textContent = [
    artifact.mime || artifact.contentType || 'unknown type',
    artifact.size !== undefined ? byteLabel(artifact.size) : null,
    artifact.taskRunId ? 'task ' + artifact.taskRunId : null,
    artifact.toolName || artifact.toolId || null,
  ].filter(Boolean).join(' - ');
  card.appendChild(meta);
  appendDetails(card, 'Metadata', safeArtifactMetadata({
    id,
    filePath: artifact.filePath || null,
    toolId: artifact.toolId || null,
    toolName: artifact.toolName || null,
    taskRunId: artifact.taskRunId || null,
    createdAt: artifact.createdAt || null,
  }));
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(actionButton('View', () => openArtifact(id, 'view'), 'secondary', !id || actionPending('artifact:' + id)));
  actions.appendChild(actionButton('Download', () => openArtifact(id, 'download'), 'primary', !id || actionPending('artifact:' + id)));
  actions.appendChild(actionButton('Inspect', () => inspectArtifact(id), 'secondary', !id));
  card.appendChild(actions);
  return card;
}

function renderTodoList(todos) {
  const list = document.createElement('section');
  list.className = 'activity-block';
  const heading = document.createElement('h4');
  heading.textContent = 'Todos';
  list.appendChild(heading);
  for (const todo of todos) {
    const row = document.createElement('div');
    row.className = 'activity-row';
    row.appendChild(pill(todo.status || 'todo'));
    const text = document.createElement('span');
    text.textContent = [todo.content, todo.priority ? '(' + todo.priority + ')' : null].filter(Boolean).join(' ');
    row.appendChild(text);
    list.appendChild(row);
  }
  return list;
}

function renderRuntimeError(error) {
  const item = document.createElement('div');
  item.className = 'notice runtime-error';
  item.appendChild(pill(errorCategory(error.message), 'warn'));
  const text = document.createElement('span');
  text.textContent = error.message || 'Runtime error';
  item.appendChild(text);
  return item;
}

function renderThreadList() {
  const list = qs('#thread-list');
  const count = qs('#thread-count');
  const limitStatus = qs('#thread-limit-status');
  const loadMore = qs('#thread-load-more');
  if (!list) return;
  const sessions = filteredSessions();
  const visible = sessions.slice(0, state.threadLimit);
  removeChildren(list);
  if (count) count.textContent = String(sessions.length);
  if (limitStatus) {
    limitStatus.textContent = sessions.length
      ? 'Showing ' + visible.length + ' of ' + sessions.length
      : 'No threads match the current filters';
  }
  if (loadMore) {
    loadMore.hidden = visible.length >= sessions.length;
    loadMore.disabled = visible.length >= sessions.length;
  }
  if (!sessions.length) {
    const row = document.createElement('div');
    row.className = 'table-row empty-row';
    row.setAttribute('role', 'row');
    ['No cloud threads loaded.', '-', '-', '-'].forEach((value) => {
      const cell = document.createElement('span');
      cell.setAttribute('role', 'cell');
      cell.textContent = value;
      row.appendChild(cell);
    });
    list.appendChild(row);
    return;
  }
  for (const session of visible) {
    const view = state.sessionViews[session.sessionId];
    const projection = projectionFromView(view);
    const status = sessionStatus(session, projection);
    const row = document.createElement('div');
    row.className = 'table-row thread-row';
    row.dataset.selected = state.selectedSessionId === session.sessionId ? 'true' : 'false';
    row.setAttribute('role', 'row');
    const title = document.createElement('span');
    title.setAttribute('role', 'cell');
    const titleButton = document.createElement('button');
    titleButton.type = 'button';
    titleButton.className = 'row-link';
    titleButton.textContent = sessionTitle(session);
    titleButton.setAttribute('aria-pressed', state.selectedSessionId === session.sessionId ? 'true' : 'false');
    titleButton.addEventListener('click', () => selectSession(session.sessionId).catch((error) => setStatus(error.message, 'error')));
    title.appendChild(titleButton);
    const statusCell = document.createElement('span');
    statusCell.setAttribute('role', 'cell');
    statusCell.appendChild(pill(status, statusPillKind(status)));
    const surface = document.createElement('span');
    surface.setAttribute('role', 'cell');
    surface.textContent = projection.origin?.kind === 'local-session-import' ? 'imported' : projectLabel(projection.projectSource);
    const updated = document.createElement('span');
    updated.setAttribute('role', 'cell');
    updated.textContent = formatDate(projection.updatedAt || session.updatedAt);
    row.appendChild(title);
    row.appendChild(statusCell);
    row.appendChild(surface);
    row.appendChild(updated);
    list.appendChild(row);
  }
}

function renderChat() {
  const title = qs('#chat-session-title');
  const meta = qs('#chat-session-meta');
  const timeline = qs('#chat-timeline');
  const composer = qs('#prompt-form');
  const eventStatus = qs('#chat-event-status');
  const view = state.selectedSessionId ? state.sessionViews[state.selectedSessionId] : null;
  const projection = runtimeViewFromCloudView(view);
  if (title) title.textContent = view ? sessionTitle(view.session) : 'No thread selected';
  if (meta) {
    const details = view
      ? [
          view.session.profileName,
          projectLabel(projection.projectSource),
          projection.messages.length + ' message(s)',
          projection.toolCalls.length + ' tool call(s)',
          projection.taskRuns.length + ' task run(s)',
          projection.artifacts.length + ' artifact(s)',
        ]
      : ['Select a cloud thread'];
    meta.textContent = details.filter(Boolean).join(' - ');
  }
  if (eventStatus) {
    eventStatus.textContent = state.sessionEvents.status;
    eventStatus.dataset.kind = state.sessionEvents.status === 'open' ? 'ok' : state.sessionEvents.status === 'error' ? 'warn' : '';
  }
  if (composer) {
    qsa('button, input, textarea', composer).forEach((element) => {
      const locked = !view || projection.status === 'closed' || bootstrap.features?.chat === false;
      element.disabled = locked;
      element.dataset.locked = locked ? 'true' : 'false';
    });
  }
  if (!timeline) return;
  removeChildren(timeline);
  if (!view) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No thread selected.';
    timeline.appendChild(empty);
    return;
  }

  timeline.appendChild(renderRuntimeSummary(projection));

  for (const approval of projection.pendingApprovals) {
    timeline.appendChild(renderApprovalCard(approval));
  }
  for (const question of projection.pendingQuestions) {
    timeline.appendChild(renderQuestionCard(question));
  }

  const resolved = [
    ...projection.resolvedApprovals.map((item) => ({ kind: 'approval', item, order: runtimeOrder(item, 0) })),
    ...projection.resolvedQuestions.map((item) => ({ kind: 'question', item, order: runtimeOrder(item, 0) })),
  ].sort((a, b) => a.order - b.order);
  if (resolved.length) {
    const activity = document.createElement('section');
    activity.className = 'activity-block';
    const heading = document.createElement('h4');
    heading.textContent = 'Resolved waits';
    activity.appendChild(heading);
    for (const entry of resolved.slice(-12)) {
      activity.appendChild(renderResolvedCard(entry.kind, entry.item));
    }
    timeline.appendChild(activity);
  }

  const timelineItems = [
    ...projection.messages.map((item, index) => ({ kind: 'message', item, order: runtimeOrder(item, index + 1) })),
    ...projection.taskRuns.map((item, index) => ({ kind: 'task', item, order: runtimeOrder(item, 5000 + index) })),
    ...projection.toolCalls.map((item, index) => ({ kind: 'tool', item, order: runtimeOrder(item, 6000 + index) })),
    ...projection.artifacts.map((item, index) => ({ kind: 'artifact', item, order: runtimeOrder(item, 7000 + index) })),
    ...projection.errors.map((item, index) => ({ kind: 'error', item, order: runtimeOrder(item, 8000 + index) })),
  ].sort((a, b) => a.order - b.order);

  for (const entry of timelineItems) {
    if (entry.kind === 'message') timeline.appendChild(renderMessageBubble(entry.item));
    if (entry.kind === 'task') timeline.appendChild(renderTaskRun(entry.item));
    if (entry.kind === 'tool') timeline.appendChild(renderToolTrace(entry.item));
    if (entry.kind === 'artifact') timeline.appendChild(renderArtifactCard(entry.item));
    if (entry.kind === 'error') timeline.appendChild(renderRuntimeError(entry.item));
  }

  if (projection.todos.length) {
    timeline.appendChild(renderTodoList(projection.todos));
  }
  if (!timelineItems.length && !projection.pendingApprovals.length && !projection.pendingQuestions.length && !resolved.length && !projection.todos.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No messages yet.';
    timeline.appendChild(empty);
  }
}

function renderArtifacts() {
  const panel = qs('#artifact-list');
  const detail = qs('#artifact-detail');
  const history = qs('#artifact-history');
  if (!panel) return;
  removeChildren(panel);
  const view = state.selectedSessionId ? state.sessionViews[state.selectedSessionId] : null;
  const projection = runtimeViewFromCloudView(view);
  if (!view || !projection.artifacts.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = view ? 'No artifacts for the selected thread.' : 'Select a cloud thread to inspect artifacts.';
    panel.appendChild(empty);
  } else {
    for (const artifact of projection.artifacts) {
      panel.appendChild(renderArtifactCard(artifact));
    }
  }
  if (history) {
    removeChildren(history);
    const records = allArtifactRecords();
    if (!records.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No artifact history loaded from current thread projections.';
      history.appendChild(empty);
    }
    for (const record of records.slice(0, 25)) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const main = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = record.artifact.filename || record.artifact.name || artifactId(record.artifact) || 'Artifact';
      main.appendChild(title);
      const meta = document.createElement('small');
      meta.textContent = [
        record.sessionTitle,
        record.artifact.mime || record.artifact.contentType || 'unknown type',
        record.artifact.size !== undefined ? byteLabel(record.artifact.size) : null,
        formatDate(record.updatedAt),
      ].filter(Boolean).join(' - ');
      main.appendChild(document.createElement('br'));
      main.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(actionButton('Open thread', () => selectSession(record.sessionId), 'secondary'));
      row.appendChild(main);
      row.appendChild(actions);
      history.appendChild(row);
    }
  }
  if (!detail) return;
  removeChildren(detail);
  if (state.artifactPanel.status === 'loading') {
    detail.appendChild(pill('loading', 'warn'));
    return;
  }
  if (state.artifactPanel.error) {
    const error = document.createElement('p');
    error.className = 'notice';
    error.textContent = state.artifactPanel.error;
    detail.appendChild(error);
    return;
  }
  if (!state.artifactPanel.metadata) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Choose Inspect on an artifact to load metadata. Artifact bodies are fetched only for explicit view or download actions.';
    detail.appendChild(empty);
    return;
  }
  appendDetails(detail, 'Artifact metadata', state.artifactPanel.metadata);
}

function closeEventSource(entry) {
  if (entry.source) entry.source.close();
  entry.source = null;
}

function sseUrl(path, afterSequence) {
  return afterSequence > 0 ? path + '?after=' + encodeURIComponent(String(afterSequence)) : path;
}

function bindCloudEventListeners(source, handler) {
  source.onmessage = handler;
  const types = [...new Set([...(bootstrap.sessionEventTypes || []), 'snapshot.required'])];
  types.forEach((type) => source.addEventListener(type, handler));
}

function readSseEvent(event) {
  try {
    return JSON.parse(event.data || '{}');
  } catch {
    return null;
  }
}

async function refreshSelectedSession() {
  if (!state.selectedSessionId) return;
  await loadSessionView(state.selectedSessionId, { render: true });
}

function openSessionEvents(sessionId, afterSequence = 0) {
  closeEventSource(state.sessionEvents);
  state.sessionEvents = {
    source: null,
    sessionId,
    cursor: afterSequence,
    status: 'connecting',
    error: null,
  };
  if (!window.EventSource) {
    state.sessionEvents.status = 'closed';
    renderChat();
    return;
  }
  const source = new EventSource(sseUrl(endpointPath('sessionEvents', '/api/sessions/:sessionId/events', { sessionId }), afterSequence), { withCredentials: true });
  state.sessionEvents.source = source;
  source.onopen = () => {
    state.sessionEvents.status = 'open';
    renderChat();
  };
  source.onerror = () => {
    state.sessionEvents.status = 'retrying';
    renderChat();
  };
  bindCloudEventListeners(source, (event) => {
    const payload = readSseEvent(event);
    if (payload?.sequence) state.sessionEvents.cursor = Math.max(state.sessionEvents.cursor, payload.sequence);
    if (payload?.type === 'snapshot.required') {
      state.sessionEvents.cursor = 0;
    }
    refreshSelectedSession().catch((error) => {
      state.sessionEvents.status = 'error';
      state.sessionEvents.error = error.message || 'Session refresh failed';
      setStatus(state.sessionEvents.error, 'error');
      renderChat();
    });
  });
  renderChat();
}

function openWorkspaceEvents(afterSequence = 0) {
  closeEventSource(state.workspaceEvents);
  state.workspaceEvents = {
    source: null,
    cursor: afterSequence,
    status: 'connecting',
    error: null,
  };
  if (!window.EventSource) return;
  const source = new EventSource(sseUrl('/api/events', afterSequence), { withCredentials: true });
  state.workspaceEvents.source = source;
  source.onopen = () => { state.workspaceEvents.status = 'open'; };
  source.onerror = () => { state.workspaceEvents.status = 'retrying'; };
  bindCloudEventListeners(source, (event) => {
    const payload = readSseEvent(event);
    if (payload?.sequence) state.workspaceEvents.cursor = Math.max(state.workspaceEvents.cursor, payload.sequence);
    if (payload?.type === 'snapshot.required') state.workspaceEvents.cursor = 0;
    loadSessions({ keepSelection: true }).catch((error) => setStatus(error.message, 'error'));
  });
}

async function loadSessions(options = {}) {
  const sessions = await api(endpoint('sessions', '/api/sessions')).then((body) => body.sessions || []);
  state.sessions = Array.isArray(sessions) ? sessions : [];
  if (state.selectedSessionId && !state.sessions.some((session) => session.sessionId === state.selectedSessionId)) {
    state.selectedSessionId = null;
    closeEventSource(state.sessionEvents);
  }
  if ((!options.keepSelection || !state.selectedSessionId) && state.sessions[0]) {
    state.selectedSessionId = state.sessions[0].sessionId;
  }
  if (state.selectedSessionId && !state.sessionViews[state.selectedSessionId]) {
    await loadSessionView(state.selectedSessionId, { render: false });
  }
  renderThreadList();
  renderChat();
  renderArtifacts();
}

async function loadSessionView(sessionId, options = {}) {
  const view = await api(endpointPath('sessionView', '/api/sessions/:sessionId/view', { sessionId }));
  state.sessionViews[sessionId] = view;
  if (options.render !== false) {
    renderThreadList();
    renderChat();
    renderArtifacts();
  }
  return view;
}

async function selectSession(sessionId) {
  state.selectedSessionId = sessionId;
  const view = await loadSessionView(sessionId, { render: false });
  const afterSequence = typeof view?.projection?.sequence === 'number' ? view.projection.sequence : 0;
  openSessionEvents(sessionId, afterSequence);
  setRoute('chat', true);
  renderThreadList();
  renderChat();
  renderArtifacts();
}

async function readFileAsBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function projectSourceFromSessionForm(form, formData) {
  const repositoryUrl = String(formData.get('repositoryUrl') || '').trim();
  if (repositoryUrl) {
    return {
      kind: 'git',
      repositoryUrl,
      ref: String(formData.get('ref') || '').trim() || null,
      subdirectory: String(formData.get('subdirectory') || '').trim() || null,
      credentialRef: String(formData.get('credentialRef') || '').trim() || null,
    };
  }
  const fileInput = qs('input[name="snapshotFiles"]', form);
  const files = fileInput?.files ? Array.from(fileInput.files) : [];
  if (!files.length) return null;
  const uploadedFiles = [];
  let byteCount = 0;
  for (const file of files.slice(0, 250)) {
    byteCount += file.size || 0;
    uploadedFiles.push({
      path: file.webkitRelativePath || file.name,
      dataBase64: await readFileAsBase64(file),
      byteCount: file.size || 0,
      mode: null,
    });
  }
  const uploaded = await api(endpoint('projectSnapshots', '/api/project-sources/snapshots'), {
    method: 'POST',
    body: JSON.stringify({
      title: String(formData.get('snapshotTitle') || '').trim() || 'Browser upload',
      files: uploadedFiles,
      fileCount: uploadedFiles.length,
      byteCount,
    }),
  });
  return uploaded.projectSource;
}

async function createCloudSessionFromForm(formData, form) {
  const projectSource = await projectSourceFromSessionForm(form, formData);
  if (projectSource) {
    const verdict = await api(endpoint('projectSourceValidate', '/api/project-sources/validate'), {
      method: 'POST',
      body: JSON.stringify({ projectSource }),
    });
    if (verdict && verdict.allowed === false) {
      throw new Error(verdict.reason || 'Project source is blocked by policy.');
    }
  }
  const created = await api(endpoint('sessions', '/api/sessions'), {
    method: 'POST',
    body: JSON.stringify({
      profileName: String(formData.get('profileName') || state.workspace?.profileName || bootstrap.profileName || 'default').trim(),
      projectSource,
    }),
  });
  const sessionId = created?.session?.sessionId;
  if (sessionId) {
    state.sessionViews[sessionId] = created;
    await loadSessions({ keepSelection: true });
    await selectSession(sessionId);
  } else {
    await loadSessions({ keepSelection: true });
  }
}

async function startAgentThread(agentName) {
  const created = await api(endpoint('sessions', '/api/sessions'), {
    method: 'POST',
    body: JSON.stringify({
      profileName: String(state.workspace?.profileName || bootstrap.profileName || 'default').trim(),
      projectSource: null,
    }),
  });
  const sessionId = created?.session?.sessionId;
  if (sessionId) {
    state.sessionViews[sessionId] = created;
    await loadSessions({ keepSelection: true });
    await selectSession(sessionId);
    const agentInput = qs('#prompt-form input[name="agent"]');
    if (agentInput) agentInput.value = agentName;
  } else {
    await loadSessions({ keepSelection: true });
  }
}

function commaList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function workflowTriggersFromForm(formData) {
  const type = String(formData.get('triggerType') || 'manual').trim();
  const id = type + '-web';
  if (type === 'schedule') {
    return [{
      id,
      type: 'schedule',
      enabled: true,
      schedule: {
        type: 'daily',
        timezone: 'UTC',
        runAtHour: 9,
        runAtMinute: 0,
      },
    }];
  }
  if (type === 'webhook') {
    return [{ id, type: 'webhook', enabled: true }];
  }
  return [{ id, type: 'manual', enabled: true }];
}

async function createWorkflowFromForm(formData) {
  const title = String(formData.get('title') || '').trim();
  const instructions = String(formData.get('instructions') || '').trim();
  const agentName = String(formData.get('agentName') || '').trim();
  if (!title || !instructions || !agentName) throw new Error('Workflow title, instructions, and agent are required.');
  const result = await api(endpoint('workflows', '/api/workflows'), {
    method: 'POST',
    body: JSON.stringify({
      title,
      instructions,
      agentName,
      toolIds: commaList(formData.get('toolIds')),
      skillNames: commaList(formData.get('skillNames')),
      triggers: workflowTriggersFromForm(formData),
    }),
  });
  if (result?.workflow?.id) state.selectedWorkflowId = result.workflow.id;
  await loadWorkflows();
}

async function runWorkflow(workflowId) {
  const result = await api(endpointPath('workflowRun', '/api/workflows/:workflowId/run', { workflowId }), {
    method: 'POST',
    body: JSON.stringify({ triggerType: 'manual', triggerPayload: { source: 'cloud-web' } }),
  });
  if (result?.workflow?.id) state.selectedWorkflowId = result.workflow.id;
  await loadWorkflows();
  if (result?.run?.sessionId) {
    await loadSessions({ keepSelection: true });
    await selectSession(result.run.sessionId);
  }
}

async function updateWorkflowStatus(workflowId, action) {
  const endpointId = action === 'resume' ? 'workflowResume' : action === 'archive' ? 'workflowArchive' : 'workflowPause';
  const fallback = '/api/workflows/:workflowId/' + action;
  const result = await api(endpointPath(endpointId, fallback, { workflowId }), {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (result?.workflow?.id) state.selectedWorkflowId = result.workflow.id;
  await loadWorkflows();
}

async function promptSelectedSession(formData) {
  if (!state.selectedSessionId) throw new Error('Select a thread first.');
  const text = String(formData.get('text') || '').trim();
  if (!text) throw new Error('Prompt text is required.');
  const agent = String(formData.get('agent') || '').trim() || null;
  const result = await api(endpointPath('sessionPrompt', '/api/sessions/:sessionId/prompt', { sessionId: state.selectedSessionId }), {
    method: 'POST',
    body: JSON.stringify({ text, agent }),
  });
  if (result?.view) state.sessionViews[state.selectedSessionId] = result.view;
  await loadSessions({ keepSelection: true });
  await refreshSelectedSession();
}

async function respondToPermission(permissionId, allowed) {
  if (!state.selectedSessionId) throw new Error('Select a thread first.');
  await withRuntimeAction('approval:' + permissionId, async () => {
    await api(endpointPath('sessionPermissionRespond', '/api/sessions/:sessionId/permission-respond', { sessionId: state.selectedSessionId }), {
      method: 'POST',
      body: JSON.stringify({ permissionId, response: { allowed } }),
    });
  });
}

async function answerQuestion(requestId, answers) {
  if (!state.selectedSessionId) throw new Error('Select a thread first.');
  const normalized = normalizeList(answers).map((answer) => String(answer || '').trim()).filter(Boolean);
  if (!normalized.length) throw new Error('Question answer is required.');
  await withRuntimeAction('question:' + requestId, async () => {
    await api(endpointPath('sessionQuestionReply', '/api/sessions/:sessionId/question-reply', { sessionId: state.selectedSessionId }), {
      method: 'POST',
      body: JSON.stringify({ requestId, answers: normalized }),
    });
  });
}

async function rejectQuestion(requestId) {
  if (!state.selectedSessionId) throw new Error('Select a thread first.');
  await withRuntimeAction('question:' + requestId, async () => {
    await api(endpointPath('sessionQuestionReject', '/api/sessions/:sessionId/question-reject', { sessionId: state.selectedSessionId }), {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    });
  });
}

function decodeBase64(dataBase64, contentType) {
  const binary = atob(String(dataBase64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: contentType || 'application/octet-stream' });
}

async function readArtifact(artifactIdValue) {
  if (!state.selectedSessionId) throw new Error('Select a thread first.');
  if (!artifactIdValue) throw new Error('Artifact id is required.');
  const body = await api(endpointPath('sessionArtifact', '/api/sessions/:sessionId/artifacts/:artifactId', {
    sessionId: state.selectedSessionId,
    artifactId: artifactIdValue,
  }));
  return body.artifact || {};
}

async function openArtifact(artifactIdValue, mode) {
  await withRuntimeAction('artifact:' + artifactIdValue, async () => {
    const artifact = await readArtifact(artifactIdValue);
    const blob = decodeBase64(artifact.dataBase64, artifact.contentType || artifact.mime);
    const url = URL.createObjectURL(blob);
    try {
      if (mode === 'download') {
        const link = document.createElement('a');
        link.href = url;
        link.download = artifact.filename || 'artifact';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
}

async function inspectArtifact(artifactIdValue) {
  if (!state.selectedSessionId) throw new Error('Select a thread first.');
  state.artifactPanel = {
    sessionId: state.selectedSessionId,
    artifactId: artifactIdValue,
    metadata: null,
    status: 'loading',
    error: null,
  };
  renderArtifacts();
  try {
    const artifacts = await api(endpointPath('sessionArtifacts', '/api/sessions/:sessionId/artifacts', { sessionId: state.selectedSessionId }))
      .then((body) => normalizeList(body.artifacts));
    const metadata = artifacts.find((artifact) => artifactId(artifact) === artifactIdValue) || { artifactId: artifactIdValue };
    state.artifactPanel.metadata = safeArtifactMetadata(metadata);
    state.artifactPanel.status = 'idle';
    state.artifactPanel.error = null;
    setRoute('artifacts', true);
  } catch (error) {
    state.artifactPanel.status = 'error';
    state.artifactPanel.error = error.message || 'Artifact metadata failed to load';
  } finally {
    renderArtifacts();
  }
}

function renderAll() {
  renderWorkspace();
  renderMembers();
  renderAdminPolicy();
  renderAudit();
  renderByok();
  renderTokens();
  renderGateway();
  renderBilling();
  renderUsage();
  renderDiagnostics();
  renderThreadList();
  renderChat();
  renderWorkbenchAgents();
  renderCapabilities();
  renderWorkflows();
  renderArtifacts();
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

async function optionalSurfaceLoad(load, fallback, setError) {
  try {
    const value = await load();
    setError(null);
    return value;
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      const reason = error.verdict?.reason || error.message || 'Surface unavailable for this cloud profile.';
      setError(reason);
      return fallback;
    }
    throw error;
  }
}

async function loadCapabilities() {
  const catalog = await optionalSurfaceLoad(
    () => api(endpoint('capabilitiesCatalog', '/api/capabilities')),
    { tools: [], skills: [] },
    (error) => { state.capabilities.error = error; },
  );
  state.capabilities.tools = normalizeList(catalog.tools);
  state.capabilities.skills = normalizeList(catalog.skills);
  renderWorkbenchAgents();
  renderCapabilities();
}

async function loadWorkflows() {
  const payload = await optionalSurfaceLoad(
    () => api(endpoint('workflows', '/api/workflows')),
    { workflows: [], runs: [] },
    (error) => { state.workflows.error = error; },
  );
  state.workflows.workflows = normalizeList(payload.workflows);
  state.workflows.runs = normalizeList(payload.runs);
  if (state.selectedWorkflowId && !state.workflows.workflows.some((workflow) => workflow.id === state.selectedWorkflowId)) {
    state.selectedWorkflowId = null;
  }
  if (!state.selectedWorkflowId && state.workflows.workflows[0]) state.selectedWorkflowId = state.workflows.workflows[0].id;
  renderWorkflows();
}

async function loadAdminSurfaces() {
  let adminError = null;
  const setAdminError = (error) => {
    if (error && !adminError) adminError = error;
  };
  if (!canManage(state.workspace?.role)) {
    const policy = await optionalSurfaceLoad(
      () => api(endpoint('adminPolicy', '/api/admin/policy')).then((body) => body.policy || null),
      null,
      setAdminError,
    );
    state.admin = {
      policy,
      members: [],
      auditEvents: [],
      error: adminError,
    };
    renderAdminPolicy();
    renderMembers();
    renderAudit();
    renderByok();
    return;
  }
  const [policy, members, auditEvents] = await Promise.all([
    optionalSurfaceLoad(
      () => api(endpoint('adminPolicy', '/api/admin/policy')).then((body) => body.policy || null),
      null,
      setAdminError,
    ),
    optionalSurfaceLoad(
      () => api(endpoint('adminMembers', '/api/admin/members')).then((body) => body.members || []),
      [],
      setAdminError,
    ),
    optionalSurfaceLoad(
      () => api(endpoint('adminAudit', '/api/admin/audit?limit=100')).then((body) => body.events || []),
      [],
      setAdminError,
    ),
  ]);
  state.admin.policy = policy;
  state.admin.members = normalizeList(members);
  state.admin.auditEvents = normalizeList(auditEvents);
  state.admin.error = adminError;
  renderMembers();
  renderAdminPolicy();
  renderAudit();
  renderByok();
}

async function loadGatewayOps() {
  const [agents, bindings, deliveries] = await Promise.all([
    optionalLoad(() => api(endpoint('channelAgents', '/api/channels/agents')).then((body) => body.agents || []), []),
    optionalLoad(() => api(endpoint('channelBindings', '/api/channels/bindings')).then((body) => body.bindings || []), []),
    optionalLoad(() => api(endpoint('channelDeliveries', '/api/channels/deliveries?limit=50')).then((body) => body.deliveries || []), []),
  ]);
  state.agents = normalizeList(agents);
  state.bindings = normalizeList(bindings);
  state.deliveries = normalizeList(deliveries);
  renderGateway();
}

async function loadDiagnostics() {
  state.diagnostics = await optionalSurfaceLoad(
    () => api(endpoint('diagnostics', '/api/diagnostics')),
    null,
    (error) => {
      if (error) setStatus(error, 'error');
    },
  );
  renderDiagnostics();
}

async function refreshDashboard() {
  const me = await optionalLoad(() => api(endpoint('authMe', '/auth/me')), null);
  if (!me) return;
  state.principal = me.principal;
  state.csrfToken = me.csrfToken || null;
  state.config = await api(endpoint('config', '/api/config'));
  state.workspace = await api(endpoint('workspace', '/api/workspace'));
  const [byok, tokens, billing, usage, usageSummary] = await Promise.all([
    optionalLoad(() => api(endpoint('byok', '/api/byok')).then((body) => body.secrets || []), []),
    optionalLoad(() => api(endpoint('apiTokens', '/api/api-tokens')).then((body) => body.tokens || []), []),
    optionalLoad(() => api(endpoint('billingSubscription', '/api/billing/subscription')), { enabled: false }),
    optionalLoad(() => api(endpoint('usageEvents', '/api/usage/events?limit=20')).then((body) => body.events || []), []),
    optionalLoad(() => api(endpoint('usageSummary', '/api/usage/summary?limit=100')), null),
  ]);
  state.byok = byok;
  state.tokens = tokens;
  state.billing = billing;
  state.usage = usage;
  state.usageSummary = usageSummary;
  document.body.dataset.auth = 'signed-in';
  setStatus('Workbench synced', 'ok');
  setRoute(window.location.hash.replace(/^#/, '') || state.activeRoute || defaultRoute(), true);
  renderAll();
  await Promise.all([
    loadAdminSurfaces(),
    loadGatewayOps(),
    loadCapabilities(),
    loadWorkflows(),
    loadSessions({ keepSelection: true }),
  ]);
  if (state.selectedSessionId) {
    const view = state.sessionViews[state.selectedSessionId];
    const afterSequence = typeof view?.projection?.sequence === 'number' ? view.projection.sequence : 0;
    openSessionEvents(state.selectedSessionId, afterSequence);
  }
  openWorkspaceEvents(state.workspaceEvents.cursor || 0);
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

async function submitScopedForm(form, handler, options = {}) {
  const formData = new FormData(form);
  setBusy(form, true);
  try {
    await handler(formData, form);
    if (options.reset !== false) form.reset();
    if (options.refresh) await refreshDashboard();
    renderAll();
  } catch (error) {
    setStatus(error.message || 'Action failed', 'error');
  } finally {
    setBusy(form, false);
    renderAll();
  }
}

async function setByokSecret(formData) {
  const providerId = String(formData.get('providerId') || '').trim().toLowerCase();
  const plaintext = String(formData.get('apiKey') || '').trim();
  const kmsRef = String(formData.get('kmsRef') || '').trim();
  if (!providerId || (!plaintext && !kmsRef)) throw new Error('Provider and credential are required.');
  if (plaintext && kmsRef) throw new Error('Use either an API key or a KMS ref, not both.');
  await api('/api/byok/' + encodeURIComponent(providerId), {
    method: 'POST',
    body: JSON.stringify(plaintext ? { apiKey: plaintext } : { kmsRef }),
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

async function inviteMember(formData) {
  await api(endpoint('adminMemberInvite', '/api/admin/members'), {
    method: 'POST',
    body: JSON.stringify({
      email: String(formData.get('email') || '').trim(),
      role: String(formData.get('role') || 'member').trim(),
    }),
  });
  await loadAdminSurfaces();
}

async function updateMember(accountId, input) {
  await api(endpointPath('adminMemberUpdate', '/api/admin/members/:accountId/update', { accountId }), {
    method: 'POST',
    body: JSON.stringify(input || {}),
  });
  await loadAdminSurfaces();
}

async function disableMember(accountId) {
  const confirmed = window.prompt('Type the account id to confirm member suspension or invite revocation: ' + accountId);
  if (confirmed !== accountId) throw new Error('Confirmation did not match the account id.');
  await updateMember(accountId, { status: 'disabled', confirm: accountId });
}

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function exportAuditEvents() {
  downloadJson('open-cowork-audit-events.json', { exportedAt: new Date().toISOString(), events: filteredAuditEvents() });
}

function exportUsageEvents() {
  downloadJson('open-cowork-usage-summary.json', { exportedAt: new Date().toISOString(), summary: state.usageSummary, events: state.usage });
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

async function retryDelivery(deliveryId) {
  await api(endpointPath('channelDeliveryRetry', '/api/channels/deliveries/:deliveryId/retry', { deliveryId }), {
    method: 'POST',
    body: JSON.stringify({}),
  });
  await loadGatewayOps();
}

async function deadLetterDelivery(deliveryId) {
  const reason = window.prompt('Optional dead-letter reason:') || 'Manually dead-lettered from Cloud Web.';
  await api(endpointPath('channelDeliveryDeadLetter', '/api/channels/deliveries/:deliveryId/dead-letter', { deliveryId }), {
    method: 'POST',
    body: JSON.stringify({ lastError: reason }),
  });
  await loadGatewayOps();
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
  qs('#refresh-threads').addEventListener('click', () => loadSessions({ keepSelection: true }).catch((error) => setStatus(error.message, 'error')));
  qs('#thread-load-more').addEventListener('click', () => {
    state.threadLimit += ${CLOUD_WEB_THREAD_PAGE_SIZE};
    renderThreadList();
  });
  qs('#new-thread-shortcut').addEventListener('click', () => {
    setRoute('threads', true);
    qs('#session-form input[name="profileName"]')?.focus();
  });
  qs('#thread-query').addEventListener('input', (event) => {
    state.threadFilters.query = event.currentTarget.value;
    state.threadLimit = ${CLOUD_WEB_THREAD_PAGE_SIZE};
    renderThreadList();
  });
  qs('#thread-status').addEventListener('change', (event) => {
    state.threadFilters.status = event.currentTarget.value;
    state.threadLimit = ${CLOUD_WEB_THREAD_PAGE_SIZE};
    renderThreadList();
  });
  qs('#thread-profile').addEventListener('input', (event) => {
    state.threadFilters.profile = event.currentTarget.value;
    state.threadLimit = ${CLOUD_WEB_THREAD_PAGE_SIZE};
    renderThreadList();
  });
  qs('#thread-project').addEventListener('change', (event) => {
    state.threadFilters.project = event.currentTarget.value;
    state.threadLimit = ${CLOUD_WEB_THREAD_PAGE_SIZE};
    renderThreadList();
  });
  qs('#thread-tag').addEventListener('input', (event) => {
    state.threadFilters.tag = event.currentTarget.value;
    state.threadLimit = ${CLOUD_WEB_THREAD_PAGE_SIZE};
    renderThreadList();
  });
  qs('#session-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitScopedForm(event.currentTarget, createCloudSessionFromForm, { refresh: false });
  });
  qs('#prompt-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitScopedForm(event.currentTarget, promptSelectedSession, { refresh: false });
  });
  qs('#capability-filter').addEventListener('input', (event) => {
    state.capabilityFilter = event.currentTarget.value;
    renderWorkbenchAgents();
    renderCapabilities();
  });
  qs('#refresh-capabilities').addEventListener('click', () => loadCapabilities().catch((error) => setStatus(error.message, 'error')));
  qs('#workflow-filter').addEventListener('input', (event) => {
    state.workflowFilter = event.currentTarget.value;
    renderWorkflows();
  });
  qs('#workflow-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitScopedForm(event.currentTarget, createWorkflowFromForm, { refresh: false });
  });
  qs('#refresh-workflows').addEventListener('click', () => loadWorkflows().catch((error) => setStatus(error.message, 'error')));
  qs('#byok-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, setByokSecret);
  });
  qs('#token-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, issueToken);
  });
  qs('#member-filter').addEventListener('input', (event) => {
    state.memberFilter = event.currentTarget.value;
    renderMembers();
  });
  qs('#member-invite-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitScopedForm(event.currentTarget, inviteMember, { refresh: false });
  });
  qs('#refresh-admin').addEventListener('click', () => loadAdminSurfaces().catch((error) => setStatus(error.message, 'error')));
  qs('#audit-filter').addEventListener('input', (event) => {
    state.auditFilter = event.currentTarget.value;
    renderAudit();
  });
  qs('#export-audit').addEventListener('click', () => exportAuditEvents());
  qs('#export-usage').addEventListener('click', () => exportUsageEvents());
  qs('#refresh-gateway').addEventListener('click', () => loadGatewayOps().catch((error) => setStatus(error.message, 'error')));
  qs('#prepare-diagnostics').addEventListener('click', () => loadDiagnostics().catch((error) => setStatus(error.message, 'error')));
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
    sessionEventTypes: [...CLOUD_SESSION_EVENT_TYPES],
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
    button, input, select, textarea {
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
    input, select, textarea {
      min-height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--text);
      padding: 0 10px;
      min-width: 0;
    }
    textarea {
      min-height: 108px;
      padding: 9px 10px;
      resize: vertical;
      line-height: 1.45;
    }
    input:focus, select:focus, textarea:focus, button:focus-visible, a:focus-visible {
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
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: end;
    }
    .toolbar label {
      flex: 1 1 150px;
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
    .thread-row {
      width: 100%;
      text-align: left;
      border-left: 0;
      border-right: 0;
      border-bottom: 0;
      border-radius: 0;
      background: #fff;
      color: var(--text);
    }
    .thread-row[data-selected="true"] {
      background: #eef8f2;
      box-shadow: inset 3px 0 0 var(--accent);
    }
    .row-link {
      min-height: 0;
      width: 100%;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      padding: 4px 0;
      text-align: left;
      font-weight: 600;
    }
    .row-link:hover {
      color: var(--accent);
      border-color: transparent;
      background: transparent;
      text-decoration: underline;
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
    .runtime-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 8px 10px;
    }
    .runtime-card {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 10px 12px;
      max-width: 880px;
      min-width: 0;
    }
    .runtime-card[data-kind="approval"], .runtime-card[data-kind="question"] {
      border-color: #dfc48f;
      background: #fffdf6;
    }
    .runtime-card-header {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .runtime-card-header strong {
      overflow-wrap: anywhere;
    }
    .question-block {
      display: grid;
      gap: 6px;
    }
    .question-block p {
      margin: 0;
      line-height: 1.45;
    }
    .choice-row {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .runtime-detail {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 8px 10px;
      max-width: 880px;
      min-width: 0;
    }
    .runtime-detail summary {
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
    }
    .runtime-detail pre {
      overflow: auto;
      margin: 8px 0 0;
      padding: 8px;
      border-radius: 6px;
      background: var(--muted-surface);
      color: var(--text);
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .runtime-error {
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: 880px;
    }
    .empty {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .chat-shell {
      display: grid;
      grid-template-rows: auto minmax(260px, 1fr);
      min-height: 520px;
    }
    .timeline {
      display: grid;
      gap: 10px;
      align-content: start;
      overflow: auto;
      max-height: 58vh;
      padding-right: 2px;
    }
    .message-bubble {
      max-width: 880px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fff;
    }
    .message-bubble[data-role="assistant"] {
      background: var(--muted-surface);
    }
    .message-heading {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .message-bubble p {
      margin: 0;
      white-space: pre-wrap;
      line-height: 1.5;
    }
    .wait-banner, .activity-row {
      display: flex;
      gap: 8px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      padding: 8px 10px;
      min-width: 0;
    }
    .activity-block {
      display: grid;
      gap: 8px;
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .activity-block h4 {
      margin: 0;
      font-size: 13px;
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
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
      }
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
            <button class="primary" id="new-thread-shortcut" type="button" data-chat-control="true">New thread</button>
          </div>
          <div class="workbench-split">
            <div class="panel">
              <div class="toolbar" aria-label="Thread filters">
                <label><span>Search</span><input id="thread-query" autocomplete="off" placeholder="title, profile, project, tag"></label>
                <label><span>Status</span><select id="thread-status">
                  <option value="all">All</option>
                  <option value="running">Running</option>
                  <option value="approval">Awaiting approval</option>
                  <option value="question">Awaiting answer</option>
                  <option value="idle">Idle</option>
                  <option value="errored">Error</option>
                  <option value="closed">Closed</option>
                </select></label>
                <label><span>Profile</span><input id="thread-profile" autocomplete="off" placeholder="${escapeHtml(policy.profileName)}"></label>
                <label><span>Project</span><select id="thread-project">
                  <option value="all">All</option>
                  <option value="chat">Chat-only</option>
                  <option value="git">Git</option>
                  <option value="snapshot">Uploaded snapshot</option>
                </select></label>
                <label><span>Tag/filter</span><input id="thread-tag" autocomplete="off" placeholder="tag or smart filter"></label>
                <button id="refresh-threads" type="button">Refresh</button>
              </div>
              <div class="table-shell" role="table" aria-label="Cloud threads">
                <div class="table-row table-head" role="row">
                  <span role="columnheader">Thread</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Project</span>
                  <span role="columnheader">Updated</span>
                </div>
                <div id="thread-list"></div>
              </div>
              <div class="section-header">
                <div class="meta"><span id="thread-count">0</span> thread(s). <span id="thread-limit-status">No threads loaded</span>.</div>
                <button id="thread-load-more" type="button" hidden>Load more</button>
              </div>
            </div>
            <form class="panel" id="session-form">
              <h3>Create cloud thread</h3>
              <div class="form-grid">
                <label><span>Profile</span><input name="profileName" autocomplete="off" value="${escapeHtml(policy.profileName)}" data-chat-control="true"></label>
                <label><span>Git repository URL</span><input name="repositoryUrl" autocomplete="off" placeholder="https://github.com/org/repo.git" data-chat-control="true"></label>
                <label><span>Ref</span><input name="ref" autocomplete="off" placeholder="main" data-chat-control="true"></label>
                <label><span>Subdirectory</span><input name="subdirectory" autocomplete="off" placeholder="optional" data-chat-control="true"></label>
                <label class="span"><span>Credential ref</span><input name="credentialRef" autocomplete="off" placeholder="secret://git/github-readonly" data-chat-control="true"></label>
                <label><span>Snapshot title</span><input name="snapshotTitle" autocomplete="off" placeholder="Browser upload" data-chat-control="true"></label>
                <label><span>Uploaded snapshot</span><input name="snapshotFiles" type="file" multiple webkitdirectory data-chat-control="true"></label>
                <button class="primary span" type="submit" data-chat-control="true">Create thread</button>
              </div>
              <p class="empty">Cloud policy validates git and uploaded snapshot sources before execution. Local desktop paths and local MCP details are not uploaded implicitly.</p>
            </form>
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
            <div class="panel chat-shell">
              <div class="section-header">
                <div>
                  <h3 id="chat-session-title">No thread selected</h3>
                  <div class="meta" id="chat-session-meta">Select a cloud thread</div>
                </div>
                <span class="pill" id="chat-event-status">idle</span>
              </div>
              <div class="timeline" id="chat-timeline" aria-live="polite">
                <p class="empty">No thread selected.</p>
              </div>
            </div>
            <form class="panel" id="prompt-form">
              <h3>Composer</h3>
              <label class="span"><span>Message</span><textarea name="text" disabled placeholder="Select a cloud thread"></textarea></label>
              <label><span>Agent</span><input name="agent" autocomplete="off" placeholder="optional agent override" disabled></label>
              <div class="row compact"><strong>Profile</strong><span>${escapeHtml(policy.profileName)}</span></div>
              <div class="row compact"><strong>Policy</strong><span>${policy.features.chat ? 'chat enabled' : 'chat disabled'}</span></div>
              <button class="primary" type="submit" disabled>Send</button>
            </form>
          </div>
        </section>

        <section ${routePanelAttrs('agents')}>
          <div class="section-header">
            <div>
              <h2>Agents</h2>
              <div class="meta">Profile-allowed execution choices</div>
            </div>
            <button id="refresh-capabilities" type="button" data-capability-control="true">Refresh</button>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Available agents</h3>
              <div class="list" id="workbench-agent-list">
                <p class="empty">No agents loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Policy</h3>
              <div class="list" id="agent-policy-list">
                <div class="row compact"><strong>Profile</strong><span>${escapeHtml(policy.profileName)}</span></div>
                <div class="row compact"><strong>Chat</strong><span>${policy.features.chat ? 'enabled' : 'disabled'}</span></div>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('capabilities')}>
          <div class="section-header">
            <div>
              <h2>Tools & Skills</h2>
              <div class="meta">Capability policy verdicts</div>
            </div>
            <label><span>Filter</span><input id="capability-filter" autocomplete="off" placeholder="tool, skill, agent, source" data-capability-control="true"></label>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Tools</h3>
              <div class="list" id="tool-list">
                <p class="empty">No tools loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Skills and MCPs</h3>
              <div class="list" id="skill-list">
                <p class="empty">No skills loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Policy notes</h3>
              <div class="list" id="capability-policy-note">
                <p class="empty">Cloud-safe capability metadata loads after sign-in.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('workflows')}>
          <div class="section-header">
            <div>
              <h2>Workflows</h2>
              <div class="meta">Definitions and runs</div>
            </div>
            <div class="row-actions">
              <label><span>Filter</span><input id="workflow-filter" autocomplete="off" placeholder="title, agent, trigger, status" data-workflow-control="true"></label>
              <button id="refresh-workflows" type="button" data-workflow-control="true">Refresh</button>
              <span class="pill" data-kind="${policy.features.workflows ? 'ok' : 'warn'}">${policy.features.workflows ? 'enabled' : 'disabled'}</span>
            </div>
          </div>
          <div class="workbench-split">
            <div class="panel">
              <div class="table-shell" role="table" aria-label="Cloud workflows">
                <div class="table-row table-head" role="row">
                  <span role="columnheader">Workflow</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Last run</span>
                  <span role="columnheader">Next run</span>
                </div>
                <div id="workflow-list">
                  <div class="table-row empty-row" role="row">
                    <span role="cell">No workflows loaded.</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                  </div>
                </div>
              </div>
              <h3>Runs</h3>
              <div class="list" id="workflow-run-list">
                <p class="empty">No runs loaded.</p>
              </div>
            </div>
            <div class="panel">
              <form id="workflow-form">
                <h3>Create workflow</h3>
                <div class="form-grid">
                  <label class="span"><span>Title</span><input name="title" autocomplete="off" placeholder="Daily review" data-workflow-control="true"></label>
                  <label><span>Agent</span><input name="agentName" autocomplete="off" placeholder="build" data-workflow-control="true"></label>
                  <label><span>Trigger</span><select name="triggerType" data-workflow-control="true">
                    <option value="manual">Manual</option>
                    <option value="schedule">Daily schedule</option>
                    <option value="webhook">Webhook</option>
                  </select></label>
                  <label><span>Tools</span><input name="toolIds" autocomplete="off" placeholder="comma-separated" data-workflow-control="true"></label>
                  <label><span>Skills</span><input name="skillNames" autocomplete="off" placeholder="comma-separated" data-workflow-control="true"></label>
                  <label class="span"><span>Instructions</span><textarea name="instructions" placeholder="What this workflow should do" data-workflow-control="true"></textarea></label>
                  <button class="primary span" type="submit" data-workflow-control="true">Create workflow</button>
                </div>
              </form>
              <h3>Selected workflow</h3>
              <div class="list" id="workflow-detail">
                <p class="empty">Select or create a workflow.</p>
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
          <div class="grid">
            <div class="panel">
              <h3>Selected thread artifacts</h3>
              <div class="list" id="artifact-list">
                <p class="empty">No artifacts loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Artifact history</h3>
              <div class="list" id="artifact-history">
                <p class="empty">No artifact history loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Inspector</h3>
              <div class="list" id="artifact-detail">
                <p class="empty">Choose Inspect on an artifact to load metadata.</p>
              </div>
            </div>
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
            <div class="row-actions">
              <label><span>Filter</span><input id="member-filter" autocomplete="off" placeholder="email, role, status" data-admin-control="true"></label>
              <button id="refresh-admin" type="button" data-admin-control="true">Refresh admin</button>
            </div>
          </div>
          <div class="workbench-split">
            <div class="panel">
              <div class="section-header">
                <h3>Org members</h3>
                <div class="meta"><span id="member-count">0</span> member(s)</div>
              </div>
              <div class="table-shell" role="table" aria-label="Org members">
                <div class="table-row table-head" role="row">
                  <span role="columnheader">Member</span>
                  <span role="columnheader">Role</span>
                  <span role="columnheader">Status</span>
                  <span role="columnheader">Actions</span>
                </div>
                <div id="member-list">
                  <div class="table-row empty-row" role="row">
                    <span role="cell">No member records loaded.</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                    <span role="cell">-</span>
                  </div>
                </div>
              </div>
            </div>
            <form class="panel" id="member-invite-form">
              <h3>Invite member</h3>
              <p class="empty" id="member-invite-notice">Invite availability loads after sign-in.</p>
              <div class="form-grid">
                <label class="span"><span>Email</span><input name="email" type="email" autocomplete="off" placeholder="teammate@example.com" data-admin-control="true"></label>
                <label><span>Role</span><select name="role" data-admin-control="true">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select></label>
                <button class="primary" type="submit" data-admin-control="true">Create invite</button>
              </div>
            </form>
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
              <div class="list" id="admin-policy-overview">
                <div class="row compact"><strong>Profile</strong><span>${escapeHtml(policy.profileName)}</span></div>
                <div class="row compact"><strong>Role</strong><span>${escapeHtml(policy.role)}</span></div>
              </div>
            </div>
            <div class="panel">
              <h3>Features</h3>
              <div class="list" id="admin-policy-features">
                <div class="row compact"><strong>Chat</strong><span>${policy.features.chat ? 'enabled' : 'disabled'}</span></div>
                <div class="row compact"><strong>Workflows</strong><span>${policy.features.workflows ? 'enabled' : 'disabled'}</span></div>
              </div>
            </div>
            <div class="panel">
              <h3>Project sources</h3>
              <div class="list" id="admin-project-policy">
                <p class="empty">Project-source policy loads after sign-in.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Runtime and gateway</h3>
              <div class="list" id="admin-runtime-policy">
                <p class="empty">Runtime policy loads after sign-in.</p>
              </div>
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
                <label class="span"><span>KMS secret ref</span><input name="kmsRef" autocomplete="off" placeholder="gcp-sm://projects/acme/secrets/anthropic/versions/latest" data-admin-control="true"></label>
                <button class="primary span" type="submit" data-admin-control="true">Save key</button>
              </div>
              <p class="empty" id="byok-policy-note">BYOK policy loads after sign-in.</p>
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
            <button id="refresh-gateway" type="button" data-admin-control="true">Refresh gateway</button>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Setup guide</h3>
              <div class="list" id="gateway-setup-guide">
                <p class="empty">Gateway setup guidance loads after sign-in.</p>
              </div>
            </div>
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
            <div class="panel">
              <h3>Delivery backlog</h3>
              <div class="list" id="delivery-list">
                <p class="empty">No gateway deliveries loaded.</p>
              </div>
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
                <label><span>Available plan</span><select id="billing-plan-select" name="planKey" data-admin-control="true" data-billing-control="true"></select></label>
                <button class="primary" type="submit" data-admin-control="true" data-billing-control="true">Start checkout</button>
                <button type="button" id="billing-portal" data-admin-control="true" data-billing-control="true">Open portal</button>
              </div>
            </form>
            <div class="panel">
              <h3>Entitlements</h3>
              <div class="list" id="billing-entitlements">
                <p class="empty">Billing entitlements are enforced by the cloud API and worker. The dashboard reflects the current subscription status.</p>
              </div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('audit', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Audit</h2>
              <div class="meta">Redacted administrative events</div>
            </div>
            <div class="row-actions">
              <label><span>Search</span><input id="audit-filter" autocomplete="off" placeholder="actor, action, entity" data-admin-control="true"></label>
              <button id="export-audit" type="button" data-admin-control="true">Export</button>
            </div>
          </div>
          <div class="panel">
            <div class="section-header">
              <h3>Events</h3>
              <div class="meta"><span id="audit-count">0</span> event(s)</div>
            </div>
            <div class="list" id="audit-list">
              <p class="empty">No audit events loaded.</p>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('usage')}>
          <div class="section-header">
            <div>
              <h2>Usage</h2>
              <div class="meta">${escapeHtml(copy.usageDescription || 'Recent metering events for this org.')}</div>
            </div>
            <button id="export-usage" type="button">Export usage</button>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Quota windows</h3>
              <div class="list" id="usage-quota-list"></div>
            </div>
            <div class="panel">
              <h3>Recent totals</h3>
              <div class="list" id="usage-total-list"></div>
            </div>
            <div class="panel">
              <h3>Recent events</h3>
              <div class="list" id="usage-list"></div>
            </div>
          </div>
        </section>

        <section ${routePanelAttrs('diagnostics', { admin: true })}>
          <div class="section-header">
            <div>
              <h2>Diagnostics</h2>
              <div class="meta">Redacted operational state</div>
            </div>
            <button id="prepare-diagnostics" type="button" data-admin-control="true">Prepare bundle</button>
          </div>
          <div class="grid">
            <div class="panel">
              <h3>Health</h3>
              <div class="list" id="diagnostics-health">
                <p class="empty">No diagnostics loaded.</p>
              </div>
            </div>
            <div class="panel">
              <h3>Support bundle</h3>
              <div class="list" id="diagnostics-bundle">
                <p class="empty">Prepare a bundle to inspect redacted support data.</p>
              </div>
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
