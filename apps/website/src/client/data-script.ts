export function cloudWebsiteClientDataScript() {
  return String.raw`async function optionalLoad(load, fallback) {
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
    () => api(withQuery(endpoint('workflows', '/api/workflows'), { limit: listLimit('workflows') })),
    { workflows: [], runs: [] },
    (error) => { state.workflows.error = error; },
  );
  state.workflows.workflows = boundedList(payload.workflows, 'workflows');
  state.workflows.runs = boundedList(payload.runs, 'workflowRuns');
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
      workerPools: [],
      workers: [],
      auditEvents: [],
      error: adminError,
      workerError: adminError,
    };
    renderAdminPolicy();
    renderMembers();
    renderAudit();
    renderByok();
    return;
  }
  let workerError = null;
  const setWorkerError = (error) => {
    if (error && !workerError) workerError = error;
  };
  const [policy, members, auditEvents, workerPools, workers] = await Promise.all([
    optionalSurfaceLoad(
      () => api(endpoint('adminPolicy', '/api/admin/policy')).then((body) => body.policy || null),
      null,
      setAdminError,
    ),
    optionalSurfaceLoad(
      () => api(withQuery(endpoint('adminMembers', '/api/admin/members'), { limit: listLimit('members') })).then((body) => body.members || []),
      [],
      setAdminError,
    ),
    optionalSurfaceLoad(
      () => api(endpoint('adminAudit', '/api/admin/audit?limit=100')).then((body) => body.events || []),
      [],
      setAdminError,
    ),
    optionalSurfaceLoad(
      () => api(endpoint('adminWorkerPools', '/api/admin/worker-pools?limit=100')).then((body) => body.pools || []),
      [],
      setWorkerError,
    ),
    optionalSurfaceLoad(
      () => api(endpoint('adminWorkers', '/api/admin/workers?limit=100')).then((body) => body.workers || []),
      [],
      setWorkerError,
    ),
  ]);
  state.admin.policy = policy;
  state.admin.members = boundedList(members, 'members');
  state.admin.workerPools = boundedList(workerPools, 'workerPools');
  state.admin.workers = boundedList(workers, 'workers');
  state.admin.auditEvents = boundedList(auditEvents, 'auditEvents').map((event) => ({
    ...event,
    metadata: safeOperationalMetadata(event.metadata),
  }));
  state.admin.error = adminError;
  state.admin.workerError = workerError;
  renderMembers();
  renderAdminPolicy();
  renderAudit();
  renderByok();
}

async function loadGatewayOps() {
  const [agents, bindings, deliveries] = await Promise.all([
    optionalLoad(() => api(withQuery(endpoint('channelAgents', '/api/channels/agents'), { limit: listLimit('headlessAgents') })).then((body) => body.agents || []), []),
    optionalLoad(() => api(withQuery(endpoint('channelBindings', '/api/channels/bindings'), { limit: listLimit('channelBindings') })).then((body) => body.bindings || []), []),
    optionalLoad(() => api(endpoint('channelDeliveries', '/api/channels/deliveries?limit=50')).then((body) => body.deliveries || []), []),
  ]);
  state.agents = boundedList(agents, 'headlessAgents');
  state.bindings = boundedList(bindings, 'channelBindings');
  state.deliveries = boundedList(deliveries, 'channelDeliveries').map((delivery) => ({
    ...delivery,
    target: safeOperationalMetadata(delivery.target),
    payload: safeOperationalMetadata(delivery.payload),
    lastError: safeOperationalText(delivery.lastError),
  }));
  renderGateway();
}

async function loadDiagnostics() {
  state.diagnosticsError = null;
  const diagnostics = await optionalSurfaceLoad(
    () => api(endpoint('diagnostics', '/api/diagnostics')),
    null,
    (error) => {
      state.diagnosticsError = error;
      if (error) setStatus(error, 'error');
    },
  );
  state.diagnostics = diagnostics ? safeOperationalMetadata(diagnostics) : null;
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
    optionalLoad(() => api(withQuery(endpoint('apiTokens', '/api/api-tokens'), { limit: listLimit('apiTokens') })).then((body) => body.tokens || []), []),
    optionalLoad(() => api(endpoint('billingSubscription', '/api/billing/subscription')), { enabled: false }),
    optionalLoad(() => api(endpoint('usageEvents', '/api/usage/events?limit=20')).then((body) => body.events || []), []),
    optionalLoad(() => api(endpoint('usageSummary', '/api/usage/summary?limit=100')), null),
  ]);
  state.byok = normalizeList(byok);
  state.tokens = boundedList(tokens, 'apiTokens');
  state.billing = billing;
  state.usage = boundedList(usage, 'usageEvents').map((event) => safeOperationalMetadata(event));
  state.usageSummary = usageSummary ? safeOperationalMetadata(usageSummary) : null;
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
  const confirmed = window.prompt('Type the provider id to confirm BYOK credential disablement: ' + providerId);
  if (confirmed !== providerId) throw new Error('Confirmation did not match the provider id.');
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
  const confirmed = window.prompt('Type the token id to confirm token revocation: ' + tokenId);
  if (confirmed !== tokenId) throw new Error('Confirmation did not match the token id.');
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
  downloadJson('open-cowork-audit-events.json', {
    exportedAt: new Date().toISOString(),
    events: filteredAuditEvents().map((event) => safeOperationalMetadata(event)),
  });
}

function exportUsageEvents() {
  downloadJson('open-cowork-usage-summary.json', {
    exportedAt: new Date().toISOString(),
    summary: safeOperationalMetadata(state.usageSummary),
    events: state.usage.map((event) => safeOperationalMetadata(event)),
  });
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
  const confirmed = window.prompt('Type the delivery id to confirm dead-lettering: ' + deliveryId);
  if (confirmed !== deliveryId) throw new Error('Confirmation did not match the delivery id.');
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
}`
}
