/* ============================================================
   OPTION D — Artifacts library + Automations (Schedules & Watches)
   ============================================================ */

const ART_STATUS = {
  draft: { label: 'Draft', c: 'var(--ink-3)' },
  review: { label: 'In review', c: 'var(--warn)' },
  final: { label: 'Final', c: 'var(--ok)' },
};

function ArtifactsView({ go }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState('All');
  const chips = ['All', 'Document', 'Chart', 'Deck', 'Spreadsheet', 'In review'];
  let list = window.D.ARTIFACTS.filter(a => (a.name + a.kind).toLowerCase().includes(q.toLowerCase()));
  if (active === 'In review') list = list.filter(a => a.status === 'review');
  else if (active !== 'All') list = list.filter(a => a.kind === active);

  const proj = id => (window.D.PROJECTS.find(p => p.id === id) || {}).name;

  return (
    <div className="view"><div className="wrap">
      <PageHead title="Artifacts" sub="Everything the team has produced — drafts, charts, decks and data. Each one is linked to the task and conversation that made it, so you can always trace the work."
        action={<button className="btn"><Icon name="download" size={15} /> Export all</button>} />
      <Toolbar q={q} setQ={setQ} placeholder="Search artifacts" chips={chips} active={active} setActive={setActive} />
      <div className="grid">
        {list.map(a => {
          const by = cw(a.by); const st = ART_STATUS[a.status];
          return (
            <div className="card" key={a.id} style={{ cursor: 'default' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                <span className="tile" style={{ background: window.D.grad(a.hue), marginBottom: 0 }}><Icon name={a.icon} size={22} /></span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <h3 style={{ fontSize: 15.5, fontWeight: 650, lineHeight: 1.2 }}>{a.name}</h3>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{a.kind} · {a.size}</div>
                </div>
                <span className="tag dot" style={{ color: st.c, background: `color-mix(in srgb,${st.c} 13%,transparent)`, border: 'none' }}>{st.label}</span>
              </div>
              <div className="ph" style={{ height: 92, marginTop: 14 }}>{a.kind.toLowerCase()} preview</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 13, paddingTop: 13, borderTop: '1px solid var(--line)', fontSize: 11.5, color: 'var(--ink-3)' }}>
                <Avatar person={by} size="s24" /> <span className="faint">{by.name}</span>
                <span className="tag" style={{ marginLeft: 'auto' }}>{proj(a.project)}</span>
                <span className="faint">{a.when}</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn sm" style={{ flex: 1 }}><Icon name="eye" size={14} /> Open</button>
                <button className="btn sm ghost"><Icon name="download" size={14} /></button>
              </div>
            </div>
          );
        })}
      </div>
    </div></div>
  );
}

/* ---------------- AUTOMATIONS (Schedules + Watches) ---------------- */
function AutomationsView() {
  const cadIcon = c => c.includes('webhook') || c.includes('trigger') ? 'link' : 'clock';
  return (
    <div className="view"><div className="wrap">
      <PageHead title="Automations" sub="Time triggers that kick off work on their own, and the updates that get pushed to your channels so you always know where things stand."
        action={<button className="btn primary"><Icon name="plus" size={16} /> New automation</button>} />

      <h3 className="sec-label"><Icon name="clock" size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />Schedules <span className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: 13 }}>— time triggers that start a run</span></h3>
      <div className="auto-list" style={{ marginBottom: 32 }}>
        {window.D.SCHEDULES.map(s => {
          const agent = cw(s.agent); const paused = s.status === 'paused';
          return (
            <div className="auto-row" key={s.id}>
              <span className="auto-ic" style={{ background: window.D.grad(paused ? HUESmute() : 'var(--c-amber)') }}><Icon name={cadIcon(s.cadence)} size={18} /></span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="auto-nm">{s.name}</div>
                <div className="auto-sub">{s.cadence} · next {s.next}</div>
              </div>
              <div className="auto-by"><Avatar person={agent} size="s24" /> <span className="faint">{agent.name}</span></div>
              <span className={`tag dot`} style={paused ? { color: 'var(--ink-3)' } : { color: 'var(--ok)', background: 'color-mix(in srgb,var(--ok) 13%,transparent)', border: 'none' }}>{paused ? 'Paused' : 'Active'}</span>
              <button className="btn sm ghost">{paused ? 'Resume' : 'Pause'}</button>
              <button className="btn sm"><Icon name="play" size={13} /> Run</button>
            </div>
          );
        })}
      </div>

      <h3 className="sec-label"><Icon name="radio" size={13} style={{ verticalAlign: '-2px', marginRight: 6 }} />Watches <span className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400, fontSize: 13 }}>— push progress to a channel</span></h3>
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

function HUESmute() { return 'var(--ink-3)'; }

Object.assign(window, { ArtifactsView, AutomationsView });
