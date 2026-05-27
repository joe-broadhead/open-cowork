import type { CloudRuntimePolicy } from './cloud-config.ts'

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function cloudBrowserAppHtml(policy: CloudRuntimePolicy) {
  const bootstrap = {
    role: policy.role,
    profileName: policy.profileName,
    features: policy.features,
  }
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Open Cowork Cloud</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --panel: #ffffff;
      --line: #d9ded6;
      --text: #17211b;
      --muted: #66746b;
      --accent: #1f7a5a;
      --accent-strong: #155e46;
      --warn: #946200;
      --danger: #a43d37;
      --shadow: 0 10px 30px rgba(23, 33, 27, 0.08);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
    }
    button, textarea {
      font: inherit;
    }
    button {
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      border-radius: 6px;
      min-height: 36px;
      padding: 0 12px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }
    button.primary:hover {
      background: var(--accent-strong);
      border-color: var(--accent-strong);
    }
    button.danger {
      color: var(--danger);
      border-color: #d9b2ae;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .shell {
      display: grid;
      grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
      min-height: 100vh;
    }
    .sidebar {
      border-right: 1px solid var(--line);
      background: #eef2eb;
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .brand {
      padding: 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .mark {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: var(--text);
      color: white;
      display: grid;
      place-items: center;
      font-weight: 700;
      flex: 0 0 auto;
    }
    .brand-title {
      font-weight: 700;
      line-height: 1.1;
    }
    .brand-meta {
      color: var(--muted);
      font-size: 12px;
      margin-top: 2px;
    }
    .sidebar-actions {
      padding: 12px;
      display: grid;
      grid-template-columns: 1fr 40px;
      gap: 8px;
    }
    .sessions {
      overflow: auto;
      padding: 0 8px 12px;
    }
    .session-row {
      width: 100%;
      min-height: 44px;
      display: block;
      text-align: left;
      margin: 4px 0;
      background: transparent;
      overflow: hidden;
    }
    .session-row.active {
      background: var(--panel);
      border-color: var(--accent);
      box-shadow: var(--shadow);
    }
    .session-title {
      display: block;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-meta {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .main {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      min-width: 0;
      min-height: 100vh;
      background: var(--panel);
    }
    .topbar {
      min-height: 60px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 18px;
      gap: 12px;
    }
    .status {
      color: var(--muted);
      font-size: 13px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status.warn { color: var(--warn); }
    .status.error { color: var(--danger); }
    .transcript {
      overflow: auto;
      padding: 20px clamp(16px, 4vw, 48px);
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: linear-gradient(#ffffff, #fbfcfa);
    }
    .empty {
      margin: auto;
      color: var(--muted);
      text-align: center;
      max-width: 420px;
      line-height: 1.5;
    }
    .message {
      max-width: min(760px, 92%);
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .message.user {
      align-self: flex-end;
      background: #edf7f1;
      border-color: #b9ddca;
    }
    .message.assistant {
      align-self: flex-start;
      background: white;
      box-shadow: var(--shadow);
    }
    .message.system {
      align-self: center;
      color: var(--muted);
      background: #f7f4ed;
    }
    .composer {
      border-top: 1px solid var(--line);
      padding: 12px clamp(12px, 3vw, 24px);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 10px;
      align-items: end;
      background: #f8faf7;
    }
    textarea {
      width: 100%;
      min-height: 44px;
      max-height: 180px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text);
      background: white;
    }
    textarea:focus, button:focus-visible {
      outline: 2px solid rgba(31, 122, 90, 0.3);
      outline-offset: 2px;
    }
    @media (max-width: 760px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .sidebar {
        min-height: 220px;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .main {
        min-height: calc(100vh - 220px);
      }
      .composer {
        grid-template-columns: 1fr;
      }
      .message {
        max-width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="mark" aria-hidden="true">OC</div>
        <div>
          <div class="brand-title">Open Cowork Cloud</div>
          <div class="brand-meta">${escapeHtml(policy.profileName)} - ${escapeHtml(policy.role)}</div>
        </div>
      </div>
      <div class="sidebar-actions">
        <button class="primary" id="new-session" type="button">+ New</button>
        <button id="refresh" type="button" aria-label="Refresh sessions">R</button>
      </div>
      <div class="sessions" id="sessions"></div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div>
          <div class="brand-title" id="session-title">No session selected</div>
          <div class="brand-meta" id="runtime-status">Checking runtime</div>
        </div>
        <button id="signin" type="button" hidden>Sign in</button>
      </header>
      <section class="transcript" id="transcript">
        <div class="empty">No active session.</div>
      </section>
      <form class="composer" id="composer">
        <textarea id="prompt" rows="2" placeholder="Ask Open Cowork"></textarea>
        <button class="danger" id="abort" type="button">Stop</button>
        <button class="primary" id="send" type="submit">Send</button>
      </form>
    </main>
  </div>
  <script id="open-cowork-cloud-bootstrap" type="application/json">${escapeHtml(JSON.stringify(bootstrap))}</script>
  <script>
    const bootstrap = JSON.parse(document.getElementById('open-cowork-cloud-bootstrap').textContent);
    const state = {
      sessions: [],
      activeSessionId: null,
      csrfToken: null,
      eventSource: null,
      lastSequenceBySession: new Map(),
    };
    const $ = (id) => document.getElementById(id);
    const sessionsEl = $('sessions');
    const transcriptEl = $('transcript');
    const titleEl = $('session-title');
    const statusEl = $('runtime-status');
    const promptEl = $('prompt');
    const signinEl = $('signin');
    const sendEl = $('send');
    const abortEl = $('abort');

    function headers(json) {
      const next = json ? { 'content-type': 'application/json' } : {};
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
      if (response.status === 401) signinEl.hidden = false;
      if (!response.ok) {
        let message = 'Request failed';
        try {
          message = (await response.json()).error || message;
        } catch {}
        throw new Error(message);
      }
      return response.json();
    }

    function setStatus(message, kind = '') {
      statusEl.textContent = message;
      statusEl.className = 'brand-meta status' + (kind ? ' ' + kind : '');
    }

    function messageText(message) {
      return String(message.content || '').trim();
    }

    function renderTranscript(view) {
      const messages = Array.isArray(view?.messages) ? view.messages : [];
      titleEl.textContent = view?.title || 'New session';
      transcriptEl.innerHTML = '';
      if (messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No messages yet.';
        transcriptEl.appendChild(empty);
        return;
      }
      for (const message of messages) {
        const item = document.createElement('div');
        const role = message.role === 'assistant' || message.role === 'system' ? message.role : 'user';
        item.className = 'message ' + role;
        item.textContent = messageText(message);
        transcriptEl.appendChild(item);
      }
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }

    function renderSessions() {
      sessionsEl.innerHTML = '';
      for (const session of state.sessions) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'session-row' + (session.sessionId === state.activeSessionId ? ' active' : '');
        row.innerHTML = '<span class="session-title"></span><span class="session-meta"></span>';
        row.querySelector('.session-title').textContent = session.title || 'New session';
      row.querySelector('.session-meta').textContent = session.status + ' - ' + session.profileName;
        row.addEventListener('click', () => activateSession(session.sessionId));
        sessionsEl.appendChild(row);
      }
    }

    function onRuntimeEvent(sessionId, event) {
      try {
        const parsed = JSON.parse(event.data);
        state.lastSequenceBySession.set(sessionId, parsed.sequence || 0);
      } catch {}
      refreshActiveSession().catch((error) => setStatus(error.message, 'error'));
    }

    function connectEvents(sessionId) {
      if (state.eventSource) state.eventSource.close();
      const after = state.lastSequenceBySession.get(sessionId) || 0;
      state.eventSource = new EventSource('/api/sessions/' + encodeURIComponent(sessionId) + '/events?after=' + after);
      const handle = (event) => onRuntimeEvent(sessionId, event);
      state.eventSource.onmessage = handle;
      state.eventSource.addEventListener('prompt.submitted', handle);
      state.eventSource.addEventListener('assistant.message', handle);
      state.eventSource.addEventListener('session.idle', handle);
      state.eventSource.addEventListener('session.status', handle);
      state.eventSource.addEventListener('runtime.error', handle);
      state.eventSource.onerror = () => setStatus('Reconnecting', 'warn');
      state.eventSource.addEventListener('open', () => setStatus('Connected'));
    }

    async function refreshActiveSession() {
      if (!state.activeSessionId) return;
      const view = await api('/api/sessions/' + encodeURIComponent(state.activeSessionId));
      renderTranscript(view.projection?.view || {});
      const session = view.session;
      const index = state.sessions.findIndex((entry) => entry.sessionId === session.sessionId);
      if (index >= 0) state.sessions[index] = session;
      else state.sessions.unshift(session);
      renderSessions();
      setStatus((view.projection?.view?.isGenerating ? 'Running' : 'Ready'));
    }

    async function activateSession(sessionId) {
      state.activeSessionId = sessionId;
      renderSessions();
      const view = await api('/api/sessions/' + encodeURIComponent(sessionId) + '/activate', { method: 'POST' });
      renderTranscript(view.projection?.view || {});
      connectEvents(sessionId);
      setStatus('Connected');
    }

    async function loadSessions() {
      const response = await api('/api/sessions');
      state.sessions = response.sessions || [];
      renderSessions();
      if (!state.activeSessionId && state.sessions[0]) await activateSession(state.sessions[0].sessionId);
    }

    async function createSession() {
      const response = await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ profileName: bootstrap.profileName }),
      });
      const session = response.session;
      state.sessions.unshift(session);
      await activateSession(session.sessionId);
    }

    async function sendPrompt(event) {
      event.preventDefault();
      const text = promptEl.value.trim();
      if (!text || !state.activeSessionId) return;
      promptEl.value = '';
      sendEl.disabled = true;
      try {
        const response = await api('/api/sessions/' + encodeURIComponent(state.activeSessionId) + '/prompt', {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        renderTranscript(response.view?.projection?.view || {});
        setStatus(response.processed ? 'Ready' : 'Queued');
      } catch (error) {
        setStatus(error.message || 'Prompt failed', 'error');
      } finally {
        sendEl.disabled = false;
      }
    }

    async function abortSession() {
      if (!state.activeSessionId) return;
      const response = await api('/api/sessions/' + encodeURIComponent(state.activeSessionId) + '/abort', { method: 'POST' });
      renderTranscript(response.view?.projection?.view || {});
      setStatus(response.processed ? 'Stopped' : 'Stop queued');
    }

    async function loadIdentity() {
      try {
        const response = await api('/auth/me');
        state.csrfToken = response.csrfToken || null;
        signinEl.hidden = true;
      } catch {
        signinEl.hidden = false;
      }
    }

    async function loadRuntimeStatus() {
      const status = await api('/api/runtime/status');
      const mode = status.canExecute ? 'Runtime ready' : 'Runtime delegated';
      setStatus(mode + ' - ' + status.commandProcessing);
    }

    $('new-session').addEventListener('click', () => createSession().catch((error) => setStatus(error.message, 'error')));
    $('refresh').addEventListener('click', () => loadSessions().catch((error) => setStatus(error.message, 'error')));
    $('composer').addEventListener('submit', sendPrompt);
    abortEl.addEventListener('click', () => abortSession().catch((error) => setStatus(error.message, 'error')));
    signinEl.addEventListener('click', () => { window.location.href = '/auth/login'; });

    loadIdentity()
      .then(loadRuntimeStatus)
      .then(loadSessions)
      .catch((error) => setStatus(error.message || 'Cloud app failed to load', 'error'));
  </script>
</body>
</html>`
}
