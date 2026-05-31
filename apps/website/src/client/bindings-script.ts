import { CLOUD_WEB_THREAD_PAGE_SIZE } from '../thread-workbench.ts'

export function cloudWebsiteClientBindingsScript() {
  return String.raw`function bindForms() {
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
  qs('#thread-load-more').addEventListener('click', () => loadMoreSessions().catch((error) => setStatus(error.message, 'error')));
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
});`
}
