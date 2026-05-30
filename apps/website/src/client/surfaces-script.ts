export function cloudWebsiteClientSurfacesScript() {
  return String.raw`function renderWorkbenchAgents() {
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
}`
}
