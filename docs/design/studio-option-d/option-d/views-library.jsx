/* ============================================================
   OPTION D — Team, Abilities, Connections, Playbooks
   ============================================================ */

function TeamView({ go }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState('Everyone');
  const chips = ['Everyone', 'Leads', 'Specialists', 'Custom'];
  let list = window.D.COWORKERS.filter(c =>
    (c.name + c.role + c.bio).toLowerCase().includes(q.toLowerCase()));
  if (active === 'Leads') list = list.filter(c => c.mode === 'primary');
  if (active === 'Specialists') list = list.filter(c => c.mode === 'subagent');
  if (active === 'Custom') list = list.filter(c => !c.builtin);

  return (
    <div className="view"><div className="wrap">
      <PageHead title="Your team" sub="The coworkers you've hired. Leads take conversations directly; specialists get brought in when a lead delegates. Each one is a saved configuration you can edit any time."
        action={<button className="btn primary" onClick={() => go('onboard')}><Icon name="plus" size={16} /> Hire a coworker</button>} />
      <Toolbar q={q} setQ={setQ} placeholder="Search the team" chips={chips} active={active} setActive={setActive} />
      <div className="grid">
        {list.map(c => (
          <div className="cw-card" key={c.id} onClick={() => go('onboard')}>
            <div className="top">
              <Avatar person={c} size="s64" />
              <div style={{ minWidth: 0 }}>
                <div className="nm">{c.name}</div>
                <div className="role">{c.role}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 7, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <ModeBadge mode={c.mode} />
              <Tag>{c.builtin ? 'Built-in' : 'Custom'}</Tag>
              {c.agentId && <code className="param">{c.agentId}</code>}
              {c.readonly && <Tag>read-only</Tag>}
            </div>
            <div className="bio">{c.bio}</div>
            <ConfigSpec person={c} />
            <div className="foot">
              <span className="m"><Icon name="bolt" size={14} /> {c.abilities.length} abilities</span>
              <span className="m"><Icon name="link" size={14} /> {c.connections.length} connections</span>
              <span className="sep m"><Icon name="chat" size={14} /> {c.jobs} jobs</span>
            </div>
          </div>
        ))}
      </div>
    </div></div>
  );
}

function GalleryGrid({ items, render }) {
  return <div className="grid">{items.map(render)}</div>;
}

function AbilitiesView({ embed }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState('All');
  const chips = ['All', 'Everyday', 'Writing', 'Research', 'Data'];
  let list = window.D.ABILITIES.filter(a => (a.name + a.desc).toLowerCase().includes(q.toLowerCase()));
  if (active !== 'All') list = list.filter(a => a.cat === active);
  const inner = (
    <>
      <Toolbar q={q} setQ={setQ} placeholder="Search abilities" chips={chips} active={active} setActive={setActive} />
      <GalleryGrid items={list} render={a => (
        <div className="card" key={a.id}>
          <span className="tile" style={{ background: window.D.grad(a.hue) }}><Icon name={a.icon} size={22} /></span>
          <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>{a.name}</h3>
          <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 8, lineHeight: 1.55, minHeight: 42 }}>{a.desc}</div>
          <div className="cw-card" style={{ all: 'unset', display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)', fontSize: 12, color: 'var(--ink-3)' }}>
            <Tag accent>{a.cat}</Tag>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="team" size={14} /> used by {a.used}</span>
          </div>
        </div>
      )} />
    </>
  );
  if (embed) return inner;
  return (
    <div className="view"><div className="wrap">
      <PageHead title="Abilities" sub="Reusable know-how your coworkers can apply — like summarizing, fact-checking, or making a chart. Mix and match them when you hire someone."
        action={<button className="btn primary"><Icon name="plus" size={16} /> New ability</button>} />
      {inner}
    </div></div>
  );
}

function ConnectionsView({ embed }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState('All');
  const chips = ['All', 'Connected', 'Available'];
  let list = window.D.CONNECTIONS.filter(c => (c.name + c.kind).toLowerCase().includes(q.toLowerCase()));
  if (active === 'Connected') list = list.filter(c => c.connected);
  if (active === 'Available') list = list.filter(c => !c.connected);
  const inner = (
    <>
      <Toolbar q={q} setQ={setQ} placeholder="Search connections" chips={chips} active={active} setActive={setActive} />
      <GalleryGrid items={list} render={c => (
        <div className="card" key={c.id} style={{ cursor: 'default' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <span className="tile" style={{ background: window.D.grad(c.hue), marginBottom: 0 }}><Icon name={c.icon} size={22} /></span>
            <div>
              <h3 style={{ fontSize: 16, fontWeight: 700 }}>{c.name}</h3>
              <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{c.kind}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
            {c.connected
              ? <span className="tag dot accent" style={{ color: 'var(--ok)', background: 'color-mix(in srgb,var(--ok) 14%,transparent)' }}>Connected</span>
              : <span className="tag dot" style={{ color: 'var(--ink-3)' }}>Available</span>}
            {c.connected && <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{c.scope}</span>}
            <button className={`btn sm ${c.connected ? '' : 'primary'}`} style={{ marginLeft: 'auto' }}>{c.connected ? 'Manage' : 'Connect'}</button>
          </div>
        </div>
      )} />
    </>
  );
  if (embed) return inner;
  return (
    <div className="view"><div className="wrap">
      <PageHead title="Connections" sub="The apps and data your team is allowed to use — email, calendar, files and more. You decide what they can touch."
        action={<button className="btn primary"><Icon name="plus" size={16} /> Add a connection</button>} />
      {inner}
    </div></div>
  );
}

function CapabilitiesView() {
  const [tab, setTab] = useState('abilities');
  return (
    <div className="view"><div className="wrap">
      <PageHead title="Tools & Skills" sub="What your coworkers know how to do, and the apps and data they can reach. Skills are reusable judgement; connections are external tools and MCPs."
        action={<button className="btn primary"><Icon name="plus" size={16} /> {tab === 'abilities' ? 'New ability' : 'Add a connection'}</button>} />
      <div className="seg" style={{ marginBottom: 18 }}>
        <button className={tab === 'abilities' ? 'on ask' : ''} onClick={() => setTab('abilities')} style={{ fontWeight: 600, padding: '8px 16px' }}>Abilities · {window.D.ABILITIES.length}</button>
        <button className={tab === 'connections' ? 'on ask' : ''} onClick={() => setTab('connections')} style={{ fontWeight: 600, padding: '8px 16px' }}>Connections · {window.D.CONNECTIONS.length}</button>
      </div>
      {tab === 'abilities' ? <AbilitiesView embed /> : <ConnectionsView embed />}
    </div></div>
  );
}

function PlaybooksView() {
  const trigIcon = { schedule: 'clock', webhook: 'link', manual: 'play' };
  return (
    <div className="view"><div className="wrap">
      <PageHead title="Playbooks" sub="Routines your team runs for you — on a schedule, from a webhook, or whenever you ask. Each one runs as a real OpenCode session with a chosen agent."
        action={<button className="btn primary"><Icon name="plus" size={16} /> New playbook</button>} />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))' }}>
        {window.D.PLAYBOOKS.map(p => {
          const agent = cw(p.agent);
          const paused = p.status === 'paused';
          return (
          <div className="card" key={p.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
              <span className="tile" style={{ background: window.D.grad(p.hue), marginBottom: 0 }}><Icon name={p.icon} size={22} /></span>
              <h3 style={{ fontFamily: 'var(--serif)', fontSize: 21, fontWeight: 400, lineHeight: 1.12, display: 'block' }}>{p.name}</h3>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <span className="tag accent" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name={trigIcon[p.trigger]} size={12} /> {p.schedule}</span>
              <span className={`tag dot`} style={paused ? { color: 'var(--ink-3)' } : { color: 'var(--ok)', background: 'color-mix(in srgb,var(--ok) 14%,transparent)', border: 'none' }}>{paused ? 'Paused' : 'Active'}</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.55, marginTop: 12 }}>{p.desc}</div>
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {p.steps.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, color: 'var(--ink-2)' }}>
                  <span style={{ width: 20, height: 20, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontSize: 10.5, fontWeight: 700, background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--ink-3)' }}>{i + 1}</span>
                  {s}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, fontSize: 11.5, color: 'var(--ink-3)' }}>
              <Avatar person={agent} size="s24" /> Runs as {agent.name} · last run {p.lastRun}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{p.runs} runs</span>
              <button className="btn sm ghost">{paused ? 'Resume' : 'Pause'}</button>
              <button className="btn sm" style={{ marginLeft: 'auto' }}><Icon name="play" size={13} /> Run now</button>
            </div>
          </div>
          );
        })}
      </div>
    </div></div>
  );
}

Object.assign(window, { TeamView, AbilitiesView, ConnectionsView, PlaybooksView, CapabilitiesView });
