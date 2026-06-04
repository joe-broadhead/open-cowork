import { CLOUD_WEB_THREAD_PAGE_SIZE } from '../thread-workbench.ts'

export function cloudWebsiteClientCommonScript() {
  return String.raw`const bootstrap = JSON.parse(document.getElementById('open-cowork-cloud-bootstrap').textContent || '{}');
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
  diagnosticsError: null,
  sessions: [],
  sessionList: {
    nextCursor: null,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    lastSyncedAt: null,
    totalEstimate: null,
    error: null,
  },
  sessionViews: {},
  selectedSessionId: null,
  sessionSelectionGeneration: 0,
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
    workerPools: [],
    workers: [],
    auditEvents: [],
    error: null,
    workerError: null,
  },
  memberFilter: '',
  auditFilter: '',
  selectedWorkflowId: null,
  workflowFilter: '',
  revealToken: null,
  activeRoute: bootstrap.defaultRoute || 'threads',
};

const CLOUD_WEB_LIST_LIMITS = {
  members: 100,
  apiTokens: 100,
  headlessAgents: 100,
  channelBindings: 100,
  channelDeliveries: 50,
  auditEvents: 100,
  usageEvents: 20,
  usageQuotas: 100,
  usageTotals: 100,
  workerPools: 100,
  workers: 100,
  workflows: 100,
  workflowRuns: 50,
  sessionArtifacts: 100,
  diagnosticsArrays: 50,
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
  state.sessionList = {
    nextCursor: null,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    lastSyncedAt: null,
    totalEstimate: null,
    error: null,
  };
  state.sessionViews = {};
  state.selectedSessionId = null;
  state.sessionSelectionGeneration += 1;
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
  state.diagnosticsError = null;
  state.admin = {
    policy: null,
    members: [],
    workerPools: [],
    workers: [],
    auditEvents: [],
    error: null,
    workerError: null,
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

function actionButton(label, onClick, variant = '', disabled = false, disabledReason = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.disabled = disabled;
  if (variant) button.className = variant;
  if (disabled && disabledReason) {
    button.title = disabledReason;
    button.setAttribute('aria-label', label + ' - ' + disabledReason);
  }
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

function listLimit(key) {
  const value = CLOUD_WEB_LIST_LIMITS[key];
  return Number.isFinite(value) && value > 0 ? value : 100;
}

function boundedList(value, key) {
  return normalizeList(value).slice(0, listLimit(key));
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

function parityEntry(conceptId) {
  return normalizeList(state.config?.workbenchParity || bootstrap.workbenchParity)
    .find((entry) => entry.conceptId === conceptId) || null;
}

function parityText(conceptId, field, fallback) {
  const entry = parityEntry(conceptId);
  return entry?.[field] || fallback;
}

function capabilityPolicyNote(capability) {
  if (capability.kind === 'mcp' && capability.scope === 'machine') return parityText('local-stdio-mcps', 'disabledReason', 'Machine-scoped MCP metadata requires a cloud-safe profile capability.');
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
      compactJson(safeOperationalMetadata(event.metadata)),
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
}`
}
