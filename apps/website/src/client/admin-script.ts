export function cloudWebsiteClientAdminScript() {
  return String.raw`function renderWorkspace() {
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
  const workerSummary = qs('#admin-worker-summary');
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
  if (workerSummary) {
    removeChildren(workerSummary);
    if (state.admin.workerError) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = state.admin.workerError;
      workerSummary.appendChild(empty);
    }
    const pools = normalizeList(state.admin.workerPools);
    const workers = normalizeList(state.admin.workers);
    const activeWorkers = workers.filter((worker) => worker.status === 'active').length;
    const totalLoad = workers.reduce((total, worker) => total + tokenNumber(worker.currentLoad), 0);
    const summary = document.createElement('div');
    summary.className = 'row compact';
    const strong = document.createElement('strong');
    strong.textContent = 'Org worker capacity';
    const span = document.createElement('span');
    span.textContent = pools.length + ' pool(s), ' + activeWorkers + ' active worker(s), load ' + totalLoad;
    summary.appendChild(strong);
    summary.appendChild(span);
    workerSummary.appendChild(summary);
    if (!pools.length && !workers.length && !state.admin.workerError) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No worker pools loaded.';
      workerSummary.appendChild(empty);
    }
    for (const pool of pools.slice(0, 4)) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const label = document.createElement('strong');
      label.textContent = pool.name || pool.poolId;
      const meta = document.createElement('span');
      meta.textContent = [pool.mode, pool.status, pool.region].filter(Boolean).join(' - ') || 'pool';
      row.appendChild(label);
      row.appendChild(meta);
      workerSummary.appendChild(row);
    }
    for (const worker of workers.slice(0, 6)) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const label = document.createElement('strong');
      label.textContent = worker.displayName || worker.workerId;
      const meta = document.createElement('span');
      meta.textContent = (worker.status || 'unknown') + ' - load ' + tokenNumber(worker.currentLoad) + ' - heartbeat ' + formatDate(worker.lastHeartbeatAt);
      row.appendChild(label);
      row.appendChild(meta);
      workerSummary.appendChild(row);
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
}`
}
