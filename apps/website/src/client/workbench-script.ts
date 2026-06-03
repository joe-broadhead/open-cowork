export function cloudWebsiteClientWorkbenchScript() {
  return String.raw`function sessionTitle(session) {
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
    const estimate = state.sessionList.totalEstimate ? ' of about ' + state.sessionList.totalEstimate + ' total' : '';
    const more = state.sessionList.hasMore ? ' More are available.' : '';
    if (state.sessionList.isLoading && !state.sessions.length) limitStatus.textContent = 'Loading cloud threads';
    else if (state.sessionList.error && !state.sessions.length) limitStatus.textContent = state.sessionList.error;
    else {
      limitStatus.textContent = sessions.length
        ? 'Showing ' + visible.length + ' of ' + sessions.length + ' loaded' + estimate + '.' + more
        : 'No loaded threads match the current filters' + (state.sessionList.hasMore ? '; load more to search older threads' : '');
    }
  }
  if (loadMore) {
    const canLoadLocal = visible.length < sessions.length;
    const canLoadRemote = state.sessionList.hasMore;
    loadMore.hidden = !canLoadLocal && !canLoadRemote;
    loadMore.disabled = state.sessionList.isLoading || state.sessionList.isLoadingMore || (!canLoadLocal && !canLoadRemote);
    loadMore.textContent = state.sessionList.isLoadingMore ? 'Loading...' : canLoadRemote && !canLoadLocal ? 'Load more from cloud' : 'Load more';
  }
  if (!sessions.length) {
    const row = document.createElement('div');
    row.className = 'table-row empty-row';
    row.setAttribute('role', 'row');
    const emptyMessage = state.sessionList.isLoading
      ? 'Loading cloud threads.'
      : state.sessionList.error || (state.sessionList.hasMore ? 'No loaded cloud threads match current filters.' : 'No cloud threads loaded.');
    [emptyMessage, '-', '-', '-'].forEach((value) => {
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
    for (const artifact of projection.artifacts.slice(0, listLimit('sessionArtifacts'))) {
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
  await loadSessionView(state.selectedSessionId, {
    render: true,
    selectionGeneration: state.sessionSelectionGeneration,
  });
}

function isCurrentSessionSelection(sessionId, selectionGeneration) {
  return state.selectedSessionId === sessionId
    && state.sessionSelectionGeneration === selectionGeneration;
}

function openSessionEvents(sessionId, afterSequence = 0, selectionGeneration = state.sessionSelectionGeneration) {
  closeEventSource(state.sessionEvents);
  state.sessionEvents = {
    source: null,
    sessionId,
    cursor: afterSequence,
    status: 'connecting',
    error: null,
  };
  if (!window.EventSource) {
    if (!isCurrentSessionSelection(sessionId, selectionGeneration)) return;
    state.sessionEvents.status = 'closed';
    renderChat();
    return;
  }
  const source = new EventSource(sseUrl(endpointPath('sessionEvents', '/api/sessions/:sessionId/events', { sessionId }), afterSequence), { withCredentials: true });
  state.sessionEvents.source = source;
  source.onopen = () => {
    if (!isCurrentSessionSelection(sessionId, selectionGeneration)) return;
    state.sessionEvents.status = 'open';
    renderChat();
  };
  source.onerror = () => {
    if (!isCurrentSessionSelection(sessionId, selectionGeneration)) return;
    state.sessionEvents.status = 'retrying';
    renderChat();
  };
  bindCloudEventListeners(source, (event) => {
    if (!isCurrentSessionSelection(sessionId, selectionGeneration)) return;
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
    loadSessions({ keepSelection: true, preserveLoadedPages: true }).catch((error) => setStatus(error.message, 'error'));
  });
}

async function loadSessionView(sessionId, options = {}) {
  const view = await api(endpointPath('sessionView', '/api/sessions/:sessionId/view', { sessionId }));
  if (
    typeof options.selectionGeneration === 'number'
    && !isCurrentSessionSelection(sessionId, options.selectionGeneration)
  ) {
    return null;
  }
  state.sessionViews[sessionId] = view;
  if (options.render !== false) {
    renderThreadList();
    renderChat();
    renderArtifacts();
  }
  return view;
}

async function selectSession(sessionId) {
  const selectionGeneration = state.sessionSelectionGeneration + 1;
  state.sessionSelectionGeneration = selectionGeneration;
  state.selectedSessionId = sessionId;
  closeEventSource(state.sessionEvents);
  state.sessionEvents = {
    source: null,
    sessionId,
    cursor: 0,
    status: 'connecting',
    error: null,
  };
  renderThreadList();
  renderChat();
  renderArtifacts();
  const view = await loadSessionView(sessionId, { render: false, selectionGeneration });
  if (!view || !isCurrentSessionSelection(sessionId, selectionGeneration)) return;
  const afterSequence = typeof view?.projection?.sequence === 'number' ? view.projection.sequence : 0;
  openSessionEvents(sessionId, afterSequence, selectionGeneration);
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
  if (action === 'archive') {
    const confirmed = window.prompt('Type the workflow id to confirm archive: ' + workflowId);
    if (confirmed !== workflowId) throw new Error('Confirmation did not match the workflow id.');
  }
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
    const artifacts = await api(withQuery(endpointPath('sessionArtifacts', '/api/sessions/:sessionId/artifacts', { sessionId: state.selectedSessionId }), { limit: listLimit('sessionArtifacts') }))
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
}`
}
