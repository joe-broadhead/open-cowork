/* ============================================================
   OPTION D — App shell, routing, theme + Tweaks
   ============================================================ */

const ACCENTS = {
  northwind: ['#2f6bf0', '#5a8cf5'],
  indigo: ['#6f8cc4', '#8aa3d6'],
  plum: ['#8b7cf0', '#a594f5'],
  teal: ['#3f9a8f', '#5bb4a8'],
  amber: ['#e0913a', '#f0a955'],
  rose: ['#d6587e', '#e87b9c'],
};

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "accent": "northwind",
  "density": "regular",
  "reviewPanel": true,
  "userName": "Gustavo"
}/*EDITMODE-END*/;

const NAV = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'projects', label: 'Projects', icon: 'kanban', count: () => window.D.PROJECTS.filter(p => p.kind === 'project').length },
  { id: 'knowledge', label: 'Knowledge', icon: 'book', count: () => window.D.WIKI_PAGES.length },
  { id: 'approvals', label: 'Approvals', icon: 'inbox', count: () => window.D.APPROVALS.length, alert: true },
];
const LIB = [
  { id: 'team', label: 'Team', icon: 'team', count: () => window.D.COWORKERS.length },
  { id: 'playbooks', label: 'Playbooks', icon: 'playbook', count: () => window.D.PLAYBOOKS.length },
  { id: 'channels', label: 'Channels', icon: 'radio', count: () => window.D.CHANNELS.filter(c => c.connected).length },
  { id: 'capabilities', label: 'Tools & Skills', icon: 'ability', count: () => window.D.ABILITIES.length + window.D.CONNECTIONS.length },
  { id: 'artifacts', label: 'Artifacts', icon: 'artifact', count: () => window.D.ARTIFACTS.length },
];

const CRUMBS = {
  home: ['Home'], projects: ['Projects'], knowledge: ['Knowledge'], approvals: ['Approvals'], channels: ['Channels'],
  capabilities: ['Tools & Skills'], artifacts: ['Artifacts'],
  team: ['Team'], onboard: ['Team', 'Hire a coworker'], playbooks: ['Playbooks'],
  abilities: ['Abilities'], connections: ['Connections'], settings: ['Settings'],
};

function threadInfo(id) {
  for (const p of window.D.PROJECTS) {
    const t = p.threads.find(x => x.id === id);
    if (t) return { project: p, thread: t };
  }
  return null;
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = useState('home');
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const [assignTo, setAssignTo] = useState('sol');
  const [boardId, setBoardId] = useState('engagement');
  const [libOpen, setLibOpen] = useState(false);
  const [activeThread, setActiveThread] = useState('t1');

  // apply theme / density / accent
  useEffect(() => {
    const r = document.documentElement;
    r.setAttribute('data-theme', t.theme);
    r.setAttribute('data-density', t.density);
    const pal = ACCENTS[t.accent] || ACCENTS.terracotta;
    r.style.setProperty('--accent', pal[0]);
    r.style.setProperty('--accent-2', pal[1]);
  }, [t.theme, t.density, t.accent]);

  const go = (v) => { setView(v); };
  const send = () => { setView('chat'); setDraft(''); };

  const info = threadInfo(activeThread);
  const crumb = view === 'chat'
    ? [info ? info.project.name : 'Conversations', info ? info.thread.title : 'Conversation']
    : view === 'board'
      ? ['Projects', (window.D.PROJECTS.find(p => p.id === boardId) || {}).name || 'Board']
      : (CRUMBS[view] || ['Home']);

  const openProjectThread = (project) => {
    const first = project.threads && project.threads[0];
    if (first) setActiveThread(first.id);
    setView('chat');
  };

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      {/* SIDEBAR */}
      <aside className="sb">
        <div className="sb-top">
          <div className="brand">
            <span className="mark"><svg viewBox="0 0 24 24" fill="none"><path d="M5 19V8.5L12 4l7 4.5V19" stroke="currentColor" strokeWidth="2.1" strokeLinejoin="round"/><path d="M12 4v15" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round"/><path d="M5 12.5 12 16l7-3.5" stroke="currentColor" strokeWidth="2.1" strokeLinejoin="round"/></svg></span>
            <span className="wm"><div className="nm serif">Northwind</div><div className="sub">People · Cowork</div></span>
          </div>
        </div>
        <button className="newchat" onClick={() => go('home')}>
          <Icon name="plus" size={18} /><span className="lbl">New conversation</span>
        </button>
        <nav className="nav">
          {NAV.map(n => (
            <button key={n.id} className={`nav-item ${view === n.id || (n.id === 'projects' && view === 'board') ? 'on' : ''}`} onClick={() => go(n.id)}>
              <Icon name={n.icon} size={19} /><span className="lbl">{n.label}</span>
              {n.count && <span className={`count ${n.alert && n.count() > 0 ? 'alert' : ''}`}>{n.count()}</span>}
            </button>
          ))}
        </nav>
        <div className="sb-sect"><span>Chats</span><span className="ln" /><button className="sb-add" title="New conversation" onClick={() => go('home')}><Icon name="plus" size={14} /></button></div>
        <div className="threads">
          {window.D.PROJECTS.map(p => (
            <div className="proj" key={p.id}>
              <div className="proj-head">
                <Icon name={p.kind === 'sandbox' ? 'sparkle' : 'folder'} size={15} />
                <span className="proj-nm">{p.name}</span>
                {p.kind === 'sandbox' && <span className="proj-kind">sandbox</span>}
              </div>
              {p.threads.map(it => (
                <button key={it.id} className={`thread ${activeThread === it.id && view === 'chat' ? 'on' : ''}`}
                  onClick={() => { setActiveThread(it.id); go('chat'); }}>
                  {it.title}<span className="tm">{it.tm}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        {(() => { const libActive = LIB.some(n => n.id === view); const open = libOpen || libActive; return (
          <div className="lib-wrap lbl">
            <button className={`lib-toggle ${libActive ? 'active' : ''}`} onClick={() => setLibOpen(o => !o)}>
              <Icon name={open ? 'chevD' : 'chevR'} size={14} /> Manage
              <span className="lib-hint">{libActive ? (LIB.find(n => n.id === view) || {}).label : 'Team · Playbooks · Tools'}</span>
            </button>
            {open && (
              <nav className="nav">
                {LIB.map(n => (
                  <button key={n.id} className={`nav-item ${view === n.id ? 'on' : ''}`} onClick={() => go(n.id)}>
                    <Icon name={n.icon} size={18} /><span className="lbl">{n.label}</span>
                    {n.count && <span className="count">{n.count()}</span>}
                  </button>
                ))}
              </nav>
            )}
          </div>
        ); })()}
        <div className="sb-foot">
          <span className="av">GL</span>
          <span className="who"><div className="nm">Gustavo Lemos</div><div className="pl">Northwind · People Team</div></span>
          <button className="icon-btn" title="Settings" onClick={() => go('settings')}><Icon name="settings" size={18} /></button>
        </div>
      </aside>

      {/* MAIN */}
      <main className="main">
        <div className="topbar">
          <button className="icon-btn" onClick={() => setCollapsed(c => !c)} title="Toggle sidebar"><Icon name="sidebar" size={18} /></button>
          <div className="crumb">
            {crumb.map((c, i) => (
              <React.Fragment key={i}>
                {i > 0 && <Icon name="chevR" size={14} />}
                <span className={i === crumb.length - 1 ? 'here' : ''}>{c}</span>
              </React.Fragment>
            ))}
          </div>
          <span className="grow" />
          <button className="icon-btn" title="Theme" onClick={() => setTweak('theme', t.theme === 'light' ? 'dark' : 'light')}>
            <Icon name={t.theme === 'light' ? 'moon' : 'sun'} size={18} />
          </button>
        </div>

        {view === 'home' && <Home onSend={send} draft={draft} setDraft={setDraft} assignTo={assignTo} setAssignTo={setAssignTo} go={go} openBoard={id => { setBoardId(id); setView('board'); }} />}
        {view === 'chat' && <Conversation draft={draft} setDraft={setDraft} onSend={() => setDraft('')} showReview={t.reviewPanel} goBoard={id => { setBoardId(id); setView('board'); }} />}
        {view === 'approvals' && <ApprovalsView />}
        {view === 'channels' && <ChannelsView />}
        {view === 'projects' && <ProjectsView open={id => { setBoardId(id); setView('board'); }} go={go} />}
        {view === 'board' && <ProjectBoard projectId={boardId} back={() => setView('projects')} openThread={openProjectThread} />}
        {view === 'artifacts' && <ArtifactsView go={go} />}
        {view === 'capabilities' && <CapabilitiesView />}
        {view === 'knowledge' && <WikiView openThread={() => { setActiveThread('t5'); setView('chat'); }} />}
        {view === 'team' && <TeamView go={go} />}
        {view === 'onboard' && <Onboard go={go} />}
        {view === 'abilities' && <AbilitiesView />}
        {view === 'connections' && <ConnectionsView />}
        {view === 'playbooks' && <PlaybooksView />}
        {view === 'settings' && <SettingsView
          theme={t.theme} setTheme={v => setTweak('theme', v)}
          accent={t.accent} setAccent={v => setTweak('accent', v)}
          density={t.density} setDensity={v => setTweak('density', v)} />}
      </main>

      {/* TWEAKS */}
      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio label="Mode" value={t.theme} options={['light', 'dark']} onChange={v => setTweak('theme', v)} />
        <TweakColor label="Accent" value={ACCENTS[t.accent][0]}
          options={Object.values(ACCENTS).map(p => p[0])}
          onChange={hex => { const id = Object.keys(ACCENTS).find(k => ACCENTS[k][0] === hex) || 'terracotta'; setTweak('accent', id); }} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={['compact', 'regular', 'comfy']} onChange={v => setTweak('density', v)} />
        <TweakToggle label="Deliverables panel" value={t.reviewPanel} onChange={v => setTweak('reviewPanel', v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
