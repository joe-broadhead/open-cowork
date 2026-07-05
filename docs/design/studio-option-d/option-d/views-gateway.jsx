/* ============================================================
   OPTION D — Channels (Gateway) + Approvals
   ============================================================ */

const PERM_LABEL = {
  bash: 'Run a command', edit: 'Edit a file', read: 'Read a file',
  send: 'Send on your behalf', webfetch: 'Open a web page', websearch: 'Search the web',
};

function channel(id) { return window.D.CHANNELS.find(c => c.id === id); }

function ViaChip({ via }) {
  if (!via) return <span className="via-chip"><Icon name="home" size={12} /> in the app</span>;
  const ch = channel(via);
  return <span className="via-chip"><Icon name={ch.icon} size={12} /> via {ch.name}</span>;
}

/* ---------------- CHANNELS ---------------- */
function ChannelsView() {
  const [chans, setChans] = useState(window.D.CHANNELS);
  const connected = chans.filter(c => c.connected);
  const available = chans.filter(c => !c.connected);
  const toggle = id => setChans(chans.map(c => c.id === id ? { ...c, connected: !c.connected } : c));

  return (
    <div className="view"><div className="wrap">
      <PageHead title="Channels" sub="Reach your team from the apps you already use. Message a coworker from WhatsApp, Telegram or Slack and keep work moving while you’re away from your desk." />

      <div className="reach-row">
        {[['plane', 'Start work', 'Send a task from any chat app and a coworker picks it up.'],
          ['radio', 'Get updates', 'Subscribe to a job and progress is pushed back to your channel.'],
          ['shield', 'Approve on the go', 'Permission requests and questions reach you wherever you are.']].map(([ic, t, d]) => (
          <div className="reach" key={t}>
            <span className="reach-ic"><Icon name={ic} size={18} /></span>
            <div><div className="reach-t">{t}</div><div className="reach-d">{d}</div></div>
          </div>
        ))}
      </div>

      <h3 className="sec-label">Connected</h3>
      <div className="grid" style={{ marginBottom: 30 }}>
        {connected.map(c => (
          <div className="card" key={c.id} style={{ cursor: 'default' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <span className="tile" style={{ background: window.D.grad(c.hue), marginBottom: 0 }}><Icon name={c.icon} size={22} /></span>
              <div style={{ minWidth: 0 }}>
                <h3 style={{ fontSize: 16, fontWeight: 700 }}>{c.name}</h3>
                <div style={{ fontSize: 12, color: 'var(--ink-2)', marginTop: 2, fontFamily: 'var(--mono,ui-monospace)' }}>{c.handle}</div>
              </div>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--ink-2)', marginTop: 13 }}>{c.summary}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 15, paddingTop: 13, borderTop: '1px solid var(--line)' }}>
              <span className="tag dot accent" style={{ color: 'var(--ok)', background: 'color-mix(in srgb,var(--ok) 14%,transparent)' }}>Connected</span>
              <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => toggle(c.id)}>Disconnect</button>
            </div>
          </div>
        ))}
      </div>

      <h3 className="sec-label">Add a channel</h3>
      <div className="grid">
        {available.map(c => (
          <div className="card" key={c.id} style={{ cursor: 'default' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <span className="tile" style={{ background: window.D.grad(c.hue), marginBottom: 0 }}><Icon name={c.icon} size={22} /></span>
              <div style={{ minWidth: 0 }}>
                <h3 style={{ fontSize: 16, fontWeight: 700 }}>{c.name}</h3>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{c.summary}</div>
              </div>
              <button className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={() => toggle(c.id)}>Connect</button>
            </div>
          </div>
        ))}
      </div>

      <h3 className="sec-label" style={{ marginTop: 34 }}>People <span className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: 13 }}>— who can message the team, and what they can do</span></h3>
      <div className="people">
        {window.D.PEOPLE.map((p, i) => (
          <div className="person" key={i}>
            <span className="av s34" style={{ background: window.D.grad(p.hue) }}>{p.initials}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="pn">{p.name}</div>
              <div className="ph"><ViaChip via={p.via} /> <span className="faint" style={{ fontFamily: 'var(--mono,ui-monospace)' }}>{p.handle}</span></div>
            </div>
            <div className="role-cell">
              <span className={`role-badge ${p.role}`}>{window.D.CHANNEL_ROLES[p.role]}</span>
              <span className="role-desc">{window.D.CHANNEL_ROLE_DESC[p.role]}</span>
            </div>
          </div>
        ))}
        <button className="person add"><span className="av s34" style={{ background: 'var(--surface-2)', color: 'var(--ink-3)', boxShadow: 'none' }}><Icon name="plus" size={16} /></span> Invite someone to message the team</button>
      </div>

      <h3 className="sec-label" style={{ marginTop: 34 }}><Icon name="radio" size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />Watches <span className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: 13 }}>— progress pushed to a channel so you stay in the loop</span></h3>
      <div className="auto-list">
        {window.D.WATCHES.map(w => {
          const ch = window.D.CHANNELS.find(c => c.id === w.via);
          return (
            <div className="auto-row" key={w.id}>
              <span className="auto-ic" style={{ background: window.D.grad('var(--c-teal)') }}><Icon name="radio" size={18} /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="auto-nm">{w.target} <span className="tag" style={{ marginLeft: 4 }}>{w.kind}</span></div>
                <div className="auto-sub">{w.events} · for {w.who}</div>
              </div>
              <span className="via-chip"><Icon name={ch.icon} size={12} /> {ch.name}</span>
              <button className="btn sm ghost"><Icon name="trash" size={13} /></button>
            </div>
          );
        })}
        <button className="person add" style={{ borderRadius: 'var(--r3)' }}><span className="av s28" style={{ background: 'var(--surface-2)', color: 'var(--ink-3)', boxShadow: 'none' }}><Icon name="plus" size={15} /></span> Watch a project, conversation or playbook</button>
      </div>
    </div></div>
  );
}

/* ---------------- APPROVALS ---------------- */
function ApprovalsView() {
  const [items, setItems] = useState(window.D.APPROVALS);
  const resolve = id => setItems(items.filter(a => a.id !== id));

  if (items.length === 0) {
    return (
      <div className="view"><div className="wrap">
        <PageHead title="Approvals" sub="Decisions waiting on you — permission requests and questions from the team." />
        <EmptyState icon="check" title="All clear">Nothing needs your sign-off right now. New requests show up here and on your connected channels.</EmptyState>
      </div></div>
    );
  }

  return (
    <div className="view"><div className="wrap narrow">
      <PageHead title="Approvals" sub="Decisions waiting on you. Answer here, or reply from any connected channel — it’s the same queue." />
      <div className="appr-list">
        {items.map(a => {
          const who = cw(a.who);
          return (
            <div className="appr" key={a.id}>
              <div className="appr-top">
                <Avatar person={who} size="s34" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="appr-who">{who.name} <span className="faint">· {who.role}</span></div>
                  <div className="appr-meta">
                    <span className={`kind ${a.kind}`}>{a.kind === 'permission' ? 'Permission' : 'Question'}</span>
                    <span className="faint">in {a.thread}</span>
                    <span className="faint">· {a.when}</span>
                  </div>
                </div>
                <ViaChip via={a.via} />
              </div>

              {a.kind === 'permission' ? (
                <>
                  <div className="appr-ask">
                    <span className="ask-label">{PERM_LABEL[a.permKey] || a.permKey}</span>
                    <code className="cmd">{a.detail}</code>
                  </div>
                  <div className="appr-actions">
                    <button className="btn sm" onClick={() => resolve(a.id)}>Allow once</button>
                    <button className="btn sm" onClick={() => resolve(a.id)}>Always allow</button>
                    <button className="btn sm deny-btn" onClick={() => resolve(a.id)}>Deny</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="appr-q">{a.detail}</div>
                  <div className="appr-actions">
                    {a.options
                      ? a.options.map(o => <button key={o} className="btn sm" onClick={() => resolve(a.id)}>{o}</button>)
                      : null}
                    <div className="reply-row">
                      <input className="inp" placeholder="Type a reply…" onKeyDown={e => { if (e.key === 'Enter') resolve(a.id); }} />
                      <button className="btn sm primary" onClick={() => resolve(a.id)}><Icon name="send" size={14} /></button>
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div></div>
  );
}

Object.assign(window, { ChannelsView, ApprovalsView });
