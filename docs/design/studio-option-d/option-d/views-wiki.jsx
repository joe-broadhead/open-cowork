/* ============================================================
   OPTION D — Knowledge (OpenWiki)
   Versioned, permissioned pages. Humans & agents share one
   read -> propose -> review -> accept workflow. Spaces are
   permission boundaries; every change is auditable.
   ============================================================ */

function spaceById(id) { return window.D.SPACES.find(s => s.id === id); }
function proposer(by) {
  if (by === 'you') return { name: 'You', initials: 'JD', hue: 'var(--c-blue)', you: true };
  return cw(by);
}

function PageBlock({ b }) {
  if (b.type === 'h') return <h3 className="wk-h">{b.text}</h3>;
  if (b.type === 'callout') return <div className="wk-callout"><Icon name="book" size={15} /> <span>{b.text}</span></div>;
  if (b.type === 'list') return <ul className="wk-list">{b.items.map((t, i) => <li key={i}>{t}</li>)}</ul>;
  return <p className="wk-p">{b.text}</p>;
}

function WikiView({ openThread }) {
  const [mode, setMode] = useState('read');           // 'read' | 'review'
  const [pageId, setPageId] = useState('wp1');
  const [q, setQ] = useState('');
  const [props, setProps] = useState(window.D.WIKI_PROPOSALS);

  const page = window.D.WIKI_PAGES.find(p => p.id === pageId);
  const ql = q.trim().toLowerCase();

  return (
    <div className="view">
      <div className="wiki">
        {/* rail */}
        <aside className="wiki-rail">
          <div className="seg" style={{ width: '100%' }}>
            <button className={mode !== 'graph' ? 'on ask' : ''} style={{ flex: 1, fontWeight: 600 }} onClick={() => setMode('read')}>Pages</button>
            <button className={mode === 'graph' ? 'on ask' : ''} style={{ flex: 1, fontWeight: 600 }} onClick={() => setMode('graph')}>Graph</button>
          </div>
          <label className="field" style={{ minWidth: 0, height: 36 }}>
            <Icon name="search" size={15} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search knowledge" />
          </label>
          <button className={`wk-review ${mode === 'review' ? 'on' : ''}`} onClick={() => setMode(mode === 'review' ? 'read' : 'review')}>
            <Icon name="diff" size={16} /> Review queue
            <span className="count alert" style={{ marginLeft: 'auto' }}>{props.length}</span>
          </button>
          <div className="wk-spaces">
            {window.D.SPACES.map(s => {
              const pages = window.D.WIKI_PAGES.filter(p => p.space === s.id && (!ql || p.title.toLowerCase().includes(ql)));
              if (ql && pages.length === 0) return null;
              const vis = window.D.SPACE_VIS[s.visibility];
              return (
                <div className="wk-space" key={s.id}>
                  <div className="wk-space-head">
                    <span className="wk-space-ic" style={{ background: window.D.grad(s.hue) }}><Icon name={s.icon} size={13} /></span>
                    <span className="wk-space-nm">{s.name}</span>
                    <Icon name={vis.icon} size={12} style={{ color: 'var(--ink-3)' }} />
                  </div>
                  {pages.map(p => (
                    <button key={p.id} className={`wk-page-link ${pageId === p.id && mode === 'read' ? 'on' : ''}`}
                      onClick={() => { setPageId(p.id); setMode('read'); }}>{p.title}</button>
                  ))}
                </div>
              );
            })}
          </div>
        </aside>

        {/* main */}
        <div className="wiki-main">
          {mode === 'read' ? <PageReader page={page} openThread={openThread} />
            : mode === 'graph' ? <GraphView onOpen={id => { setPageId(id); setMode('read'); }} />
              : <ReviewQueue props={props} onResolve={id => setProps(props.filter(p => p.id !== id))} openPage={t => { const pg = window.D.WIKI_PAGES.find(p => p.title === t); if (pg) { setPageId(pg.id); setMode('read'); } }} />}
        </div>
      </div>
    </div>
  );
}

function PageReader({ page, openThread }) {
  const space = spaceById(page.space);
  const by = proposer(page.updatedBy);
  const vis = window.D.SPACE_VIS[space.visibility];
  const linkIcon = { task: 'kanban', artifact: 'artifact', thread: 'chat' };
  const [hist, setHist] = useState(false);
  return (
    <div className="wk-reader">
      <div className="wk-crumb">
        <span className="wk-space-ic sm" style={{ background: window.D.grad(space.hue) }}><Icon name={space.icon} size={11} /></span>
        {space.name} <Icon name="chevR" size={12} /> <span className="faint">{page.title}</span>
      </div>
      <div className="wk-head">
        <h1 className="serif">{page.title}</h1>
        <div className="wk-actions">
          <button className="btn sm" onClick={() => setHist(true)}><Icon name="versions" size={14} /> History · v{page.version}</button>
          <button className="btn sm primary"><Icon name="pen" size={14} /> Propose edit</button>
        </div>
      </div>
      <div className="wk-meta">
        <Avatar person={by} size="s24" /> <span className="faint">Updated by {by.name} · {page.updated}</span>
        <span className="tag" style={{ marginLeft: 6 }}><Icon name={vis.icon} size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />{vis.label}</span>
        <span className="tag" style={{ color: space.role === 'Reader' ? 'var(--ink-3)' : 'var(--accent)' }}>{space.role}</span>
      </div>

      <article className="wk-body">
        {page.body.map((b, i) => <PageBlock key={i} b={b} />)}
      </article>

      {page.links.length > 0 && (
        <div className="wk-trail">
          <h5>Knowledge trail <span className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>— the work this page came from, all auditable</span></h5>
          <div className="wk-links">
            {page.links.map((l, i) => (
              <button key={i} className="wk-link" onClick={() => openThread && openThread()}>
                <Icon name={linkIcon[l.kind]} size={13} /> {l.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {hist && <HistoryDrawer page={page} onClose={() => setHist(false)} />}
    </div>
  );
}

function ReviewQueue({ props, onResolve, openPage }) {
  if (props.length === 0) {
    return <div style={{ padding: '24px 28px' }}><EmptyState icon="check" title="Nothing to review">Edit proposals from you and the team land here. Each one is a versioned, auditable change before it becomes knowledge.</EmptyState></div>;
  }
  return (
    <div className="wk-review-q">
      <div className="wk-q-head">
        <h1 className="serif">Review queue</h1>
        <p className="faint">Proposed knowledge changes — from people and agents alike. Accept to publish a new version; everything is recorded.</p>
      </div>
      <div className="appr-list">
        {props.map(p => {
          const by = proposer(p.by); const space = spaceById(p.space);
          return (
            <div className="appr" key={p.id}>
              <div className="appr-top">
                <Avatar person={by} size="s34" />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="appr-who">{by.name} <span className="faint">proposed an edit</span></div>
                  <div className="appr-meta">
                    <button className="link-btn" onClick={() => openPage(p.pageTitle)}>{p.pageTitle}</button>
                    <span className="faint">· {space.name} · {p.when}</span>
                  </div>
                </div>
                <span className="diffstat"><span className="add">+{p.add}</span> <span className="del">−{p.del}</span></span>
              </div>
              <div className="wk-prop-sum">{p.summary}</div>
              <div className="appr-actions">
                <button className="btn sm" onClick={() => openPage(p.pageTitle)}><Icon name="diff" size={14} /> Review diff</button>
                <button className="btn sm primary" onClick={() => onResolve(p.id)}><Icon name="check" size={14} /> Accept</button>
                <button className="btn sm ghost" onClick={() => onResolve(p.id)}>Decline</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- KNOWLEDGE GRAPH (Obsidian-style) ---------------- */
function buildGraph() {
  const spaces = window.D.SPACES, pages = window.D.WIKI_PAGES;
  const cx = 500, cy = 350, nodes = [], edges = [];
  nodes.push({ id: 'root', kind: 'root', label: 'Company OS', x: cx, y: cy, r: 22, hue: 'var(--accent)' });
  const N = spaces.length;
  spaces.forEach((s, i) => {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    const hx = cx + Math.cos(a) * 220, hy = cy + Math.sin(a) * 200;
    nodes.push({ id: 'space:' + s.id, kind: 'space', label: s.name, x: hx, y: hy, r: 14, hue: s.hue });
    edges.push(['root', 'space:' + s.id]);
    const sp = pages.filter(p => p.space === s.id);
    sp.forEach((p, j) => {
      const spread = sp.length > 1 ? (j / (sp.length - 1) - 0.5) : 0;
      const pa = a + spread * 0.95;
      nodes.push({ id: 'page:' + p.id, kind: 'page', label: p.title, x: hx + Math.cos(pa) * 96, y: hy + Math.sin(pa) * 90, r: 8, hue: s.hue, pageId: p.id });
      edges.push(['space:' + s.id, 'page:' + p.id]);
    });
  });
  [['wp1', 'wp4'], ['wp2', 'wp1'], ['wp3', 'wp6'], ['wp5', 'wp3'], ['wp2', 'wp3']].forEach(([a, b]) => edges.push(['page:' + a, 'page:' + b]));
  return { nodes, edges };
}

function GraphView({ onOpen }) {
  const { nodes, edges } = React.useMemo(buildGraph, []);
  const [hover, setHover] = useState(null);
  const nodeMap = {}; nodes.forEach(n => nodeMap[n.id] = n);
  const neighbors = new Set();
  if (hover) { neighbors.add(hover); edges.forEach(([a, b]) => { if (a === hover) neighbors.add(b); if (b === hover) neighbors.add(a); }); }
  const dim = id => hover && !neighbors.has(id);
  const trunc = t => t.length > 26 ? t.slice(0, 25) + '…' : t;

  return (
    <div className="wk-graph">
      <div className="wk-graph-head">
        <div>
          <h2 className="serif" style={{ fontSize: 24 }}>Knowledge graph</h2>
          <p className="faint" style={{ fontSize: 13 }}>Every page, clustered by Space. Hover to trace connections; click a page to open it.</p>
        </div>
        <div className="wk-graph-legend">
          {window.D.SPACES.map(s => (
            <span key={s.id} className="lg"><span className="lg-dot" style={{ background: s.hue }} /> {s.name}</span>
          ))}
        </div>
      </div>
      <svg className="wk-graph-svg" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet">
        {edges.map(([a, b], i) => {
          const na = nodeMap[a], nb = nodeMap[b];
          const active = hover && (a === hover || b === hover);
          return <line key={i} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
            stroke={active ? 'var(--accent)' : 'var(--line-2)'} strokeWidth={active ? 1.6 : 1}
            opacity={hover ? (active ? 0.9 : 0.12) : 0.5} />;
        })}
        {nodes.map(n => (
          <g key={n.id} className={`gnode ${n.kind} ${dim(n.id) ? 'dim' : ''}`}
            onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
            onClick={() => n.pageId && onOpen(n.pageId)} style={{ cursor: n.pageId ? 'pointer' : 'default' }}>
            <circle cx={n.x} cy={n.y} r={n.r} fill={n.hue}
              stroke={n.kind === 'root' ? 'var(--accent)' : 'var(--surface)'} strokeWidth={n.kind === 'page' ? 2 : 2.5} />
            <text x={n.x} y={n.y + n.r + (n.kind === 'page' ? 13 : 16)} textAnchor="middle"
              className="gn-label" fontSize={n.kind === 'page' ? 11 : 12.5} fontWeight={n.kind === 'page' ? 500 : 700}>
              {n.kind === 'page' ? trunc(n.label) : n.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function pageHistory(page) {
  const pool = [
    { by: page.updatedBy, summary: 'Current version' },
    { by: 'maya', summary: 'Verified figures against the source' },
    { by: 'you', summary: 'Restructured headings for clarity' },
    { by: 'theo', summary: 'Reworded the summary' },
    { by: 'cleo', summary: 'Created from task output' },
  ];
  const times = ['just now', '1d ago', '4d ago', '1w ago', '3w ago'];
  const n = Math.min(5, Math.max(2, page.version));
  return Array.from({ length: n }, (_, i) => ({ v: page.version - i, by: pool[i % pool.length].by, summary: pool[i % pool.length].summary, when: times[i] || (i + 'w ago') }));
}

function HistoryDrawer({ page, onClose }) {
  const versions = pageHistory(page);
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <Icon name="versions" size={16} style={{ color: 'var(--accent)' }} />
          <span className="faint" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700 }}>Version history</span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><Icon name="chevR" size={18} /></button>
        </div>
        <h2 className="serif" style={{ fontSize: 22, lineHeight: 1.1, marginTop: 6 }}>{page.title}</h2>
        <p className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>Git-backed — every version is preserved and attributable.</p>
        <div className="hist-list">
          {versions.map((v, i) => {
            const who = proposer(v.by);
            return (
              <div className={`hist-row ${i === 0 ? 'current' : ''}`} key={v.v}>
                <div className="hist-line"><span className="hist-dot" /></div>
                <div className="hist-body">
                  <div className="hist-top"><span className="hist-v">v{v.v}</span>{i === 0 && <span className="tag accent">Current</span>}<span className="faint" style={{ marginLeft: 'auto', fontSize: 11 }}>{v.when}</span></div>
                  <div className="hist-sum">{v.summary}</div>
                  <div className="hist-by"><Avatar person={who} size="s24" /> <span className="faint">{who.name}</span>
                    {i !== 0 && <button className="link-btn" style={{ marginLeft: 'auto', fontSize: 12 }}>Restore</button>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

Object.assign(window, { WikiView });
