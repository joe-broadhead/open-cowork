import { CLOUD_WEB_THREAD_PAGE_SIZE } from '../thread-workbench.ts'

export function cloudWebsiteClientSessionPaginationScript() {
  return String.raw`function sessionPageLimit() {
  const configured = Number(bootstrap.threadPageSize || state.config?.threadPageSize || 0);
  if (!Number.isFinite(configured) || configured <= 0) return ${CLOUD_WEB_THREAD_PAGE_SIZE};
  return Math.min(Math.max(Math.floor(configured), 25), 500);
}

function withQuery(path, params) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.pathname + url.search;
}

function mergeSessions(existing, incoming, append) {
  const base = append ? [...existing] : [];
  const positions = new Map(base.map((session, index) => [session.sessionId, index]));
  for (const session of normalizeList(incoming)) {
    if (!session?.sessionId) continue;
    const position = positions.get(session.sessionId);
    if (position === undefined) {
      positions.set(session.sessionId, base.length);
      base.push(session);
    } else {
      base[position] = { ...base[position], ...session };
    }
  }
  return base;
}

async function fetchSessionPage(cursor = null) {
  const body = await api(withQuery(endpoint('sessions', '/api/sessions'), { limit: sessionPageLimit(), cursor }));
  return {
    sessions: Array.isArray(body.sessions) ? body.sessions : [],
    nextCursor: body.nextCursor || null,
    totalEstimate: typeof body.totalEstimate === 'number' ? body.totalEstimate : null,
  };
}

async function loadSessions(options = {}) {
  const pageLimit = sessionPageLimit();
  const loadedPages = Math.max(1, Math.ceil(Math.max(state.sessions.length, state.threadLimit, pageLimit) / pageLimit));
  const pageTarget = options.preserveLoadedPages ? loadedPages : 1;
  if (!options.preserveLoadedPages) state.threadLimit = pageLimit;
  state.sessionList.isLoading = true;
  state.sessionList.error = null;
  renderThreadList();
  try {
    let nextCursor = null;
    let merged = [];
    let totalEstimate = null;
    for (let index = 0; index < pageTarget; index += 1) {
      const page = await fetchSessionPage(nextCursor);
      merged = mergeSessions(merged, page.sessions, true);
      nextCursor = page.nextCursor;
      totalEstimate = page.totalEstimate;
      if (!nextCursor) break;
    }
    state.sessions = merged;
    state.sessionList.nextCursor = nextCursor;
    state.sessionList.hasMore = Boolean(nextCursor);
    state.sessionList.totalEstimate = totalEstimate;
    state.sessionList.lastSyncedAt = new Date().toISOString();
  } catch (error) {
    state.sessionList.error = error.message || 'Thread list failed to load';
    throw error;
  } finally {
    state.sessionList.isLoading = false;
  }
  if (state.selectedSessionId && !state.sessions.some((session) => session.sessionId === state.selectedSessionId) && !state.sessionViews[state.selectedSessionId]) {
    state.selectedSessionId = null;
    closeEventSource(state.sessionEvents);
  }
  if ((!options.keepSelection || !state.selectedSessionId) && state.sessions[0]) state.selectedSessionId = state.sessions[0].sessionId;
  if (state.selectedSessionId && !state.sessionViews[state.selectedSessionId]) await loadSessionView(state.selectedSessionId, { render: false });
  renderThreadList();
  renderChat();
  renderArtifacts();
}

async function loadMoreSessions() {
  const sessions = filteredSessions();
  const visible = sessions.slice(0, state.threadLimit);
  if (visible.length < sessions.length) {
    state.threadLimit += sessionPageLimit();
    renderThreadList();
    return;
  }
  if (!state.sessionList.nextCursor || state.sessionList.isLoadingMore) return;
  state.sessionList.isLoadingMore = true;
  state.sessionList.error = null;
  renderThreadList();
  try {
    const page = await fetchSessionPage(state.sessionList.nextCursor);
    state.sessions = mergeSessions(state.sessions, page.sessions, true);
    state.sessionList.nextCursor = page.nextCursor;
    state.sessionList.hasMore = Boolean(page.nextCursor);
    state.sessionList.totalEstimate = page.totalEstimate;
    state.sessionList.lastSyncedAt = new Date().toISOString();
    state.threadLimit += sessionPageLimit();
  } catch (error) {
    state.sessionList.error = error.message || 'More threads failed to load';
    setStatus(state.sessionList.error, 'error');
  } finally {
    state.sessionList.isLoadingMore = false;
    renderThreadList();
  }
}`
}
