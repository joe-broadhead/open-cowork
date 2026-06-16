/* ============================================================
   OPTION D — Home + Conversation views
   ============================================================ */

function Composer({ big, value, onChange, onSend, assignTo, setAssignTo }) {
  const leads = window.D.COWORKERS.filter((c) => c.mode === 'primary').
  sort((a, b) => (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0));
  const [menu, setMenu] = useState(false);
  const taRef = useRef(null);
  useEffect(() => {
    const el = taRef.current;if (!el) return;
    el.style.height = 'auto';el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [value]);
  const assignee = cw(assignTo) || cw('sol');
  return (
    <div className="composer">
      <textarea ref={taRef} rows={1} value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {e.preventDefault();onSend();}}}
      placeholder={big ? 'Ask your team to do something\u2026' : 'Reply, or give the team another task\u2026'} />
      <div className="composer-bar">
        <button className="round" title="Attach"><Icon name="paperclip" size={18} /></button>
        <div className="assign" style={{ position: 'relative' }}>
          <span className="lab">Assign to</span>
          <button className="pill" onClick={() => setMenu((m) => !m)} data-comment-anchor="764ab1247d-button-24-11">
            <Avatar person={assignee} size="s24" /> <b>{assignee.name}</b>
            {assignee.isDefault && <span className="faint" style={{ fontWeight: 500 }}>· default</span>}
            <Icon name="chevD" size={13} />
          </button>
          {menu &&
          <div className="assign-menu">
              {leads.map((c) =>
            <button key={c.id} className="thread assign-opt" onClick={() => {setAssignTo(c.id);setMenu(false);}}>
                  <Avatar person={c} size="s28" />
                  <span className="ao-text"><b>{c.name}</b> <small className="faint">{c.role}</small></span>
                  {c.isDefault ? <span className="tag accent">Default</span> :
              c.builtin ? <span className="tag">Built-in</span> : null}
                  {c.agentId && <code className="param">{c.agentId}</code>}
                </button>
            )}
              <div style={{ fontSize: 11, color: 'var(--ink-3)', padding: '8px 10px 4px', lineHeight: 1.45, borderTop: '1px solid var(--line)', marginTop: 4 }}>
                Specialists (Vega, Blaze, Astra) are brought in automatically when a lead delegates.
              </div>
            </div>
          }
        </div>
        <span className="grow" />
        <button className="round" title="Dictate"><Icon name="mic" size={18} /></button>
        <button className="send" disabled={!value.trim()} onClick={onSend}><Icon name="send" size={19} /></button>
      </div>
    </div>);

}

function Home({ onSend, draft, setDraft, assignTo, setAssignTo, go, openBoard }) {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const team = window.D.COWORKERS;
  const running = [];
  window.D.PROJECTS.filter(p => p.kind === 'project').forEach(p => (p.tasks || []).filter(t => t.col === 'doing').forEach(t => running.push({ ...t, project: p })));
  const approvals = window.D.APPROVALS;
  const artifacts = window.D.ARTIFACTS.slice(0, 3);
  return (
    <div className="view">
      <div className="home">
        <div className="home-inner">
          <div className="greet">
            <div className="hi serif">{part}, <em>Gustavo</em>.</div>
            <div className="ask">What should the team take on today?</div>
          </div>
          <Composer big value={draft} onChange={setDraft} onSend={onSend} assignTo={assignTo} setAssignTo={setAssignTo} />
          <div className="suggest">
            {window.D.SUGGESTIONS.map((s, i) => {
              const person = cw(s.by);
              return (
                <button className="sug" key={i} onClick={() => {setDraft(s.d);setAssignTo(person.mode === 'primary' ? s.by : 'sol');}}>
                  <span className="ic" style={{ background: window.D.grad(s.hue) }}><Icon name={s.icon} size={18} /></span>
                  <span className="tx">
                    <div className="t">{s.t}</div>
                    <div className="d">{s.d}</div>
                    <div className="by"><Avatar person={person} size="s24" /> {person.name} can take this</div>
                  </span>
                </button>);

            })}
          </div>

          <div className="motion">
            <div className="motion-head"><span>In motion</span><span className="ln" /></div>
            <div className="motion-grid">
              <div className="mcol">
                <div className="mcol-head"><span className="status-live" style={{ '--lc': 'var(--accent)' }}><span className="dot" /> In progress</span><span className="mcount">{running.length}</span></div>
                {running.map((t, i) => (
                  <button className="mrow" key={i} onClick={() => openBoard(t.project.id)}>
                    {t.assignee ? <Avatar person={cw(t.assignee)} size="s24" /> : <span className="av s24" style={{ background: 'var(--surface-2)' }} />}
                    <span className="mrow-tx"><span className="mt">{t.title}</span><span className="mp">{t.project.name}</span></span>
                  </button>
                ))}
              </div>
              <div className="mcol">
                <div className="mcol-head"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Icon name="inbox" size={14} /> Waiting on you</span><span className="mcount alert">{approvals.length}</span></div>
                {approvals.slice(0, 3).map(a => (
                  <button className="mrow" key={a.id} onClick={() => go('approvals')}>
                    <Avatar person={cw(a.who)} size="s24" />
                    <span className="mrow-tx"><span className="mt">{a.kind === 'permission' ? a.detail : a.detail}</span><span className="mp">{cw(a.who).name} · {a.kind}</span></span>
                  </button>
                ))}
              </div>
              <div className="mcol">
                <div className="mcol-head"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Icon name="artifact" size={14} /> Fresh artifacts</span><span className="mcount">{artifacts.length}</span></div>
                {artifacts.map(a => (
                  <button className="mrow" key={a.id} onClick={() => go('artifacts')}>
                    <span className="mart" style={{ background: window.D.grad(a.hue) }}><Icon name={a.icon} size={13} /></span>
                    <span className="mrow-tx"><span className="mt">{a.name}</span><span className="mp">{a.kind} · {a.when}</span></span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button className="team-strip" onClick={() => go('team')}>
            <span className="lab">Your team</span>
            <div className="avstack">{team.map((c) => <Avatar key={c.id} person={c} size="s28" />)}</div>
            <span className="lab">{team.length} coworkers · manage</span>
          </button>
        </div>
      </div>
    </div>);

}

/* ---- Conversation ---- */
function Activity({ a, hue }) {
  return (
    <div className={`activity ${a.done ? 'done' : ''}`}>
      <span className="ai"><Icon name={a.icon} size={14} /></span>
      <span className="av-verb">{a.verb}</span>
      <span className="obj">{a.obj}</span>
      {a.rt && <span className="rt">{a.rt}</span>}
      {!a.done && <span className="spin" style={{ '--lc': hue }} />}
    </div>);

}

function Lane({ lane, openByDefault }) {
  const person = cw(lane.who);
  const [open, setOpen] = useState(openByDefault ?? lane.state === 'live');
  const delegatedBy = lane.delegatedBy ? cw(lane.delegatedBy) : null;
  return (
    <div className="lane" style={{ '--lc': person.hue }}>
      <div className={`lane-card ${lane.state === 'live' ? 'live' : ''} ${open ? 'open' : ''}`}>
        <div className="lane-head" onClick={() => setOpen((o) => !o)}>
          <Avatar person={person} size="s34" running={lane.state === 'live'} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="nm">{person.name} <span className="role">{person.role}</span></div>
            <div className="task">{lane.task}</div>
          </div>
          <div className="meta">
            {delegatedBy && <span className="handoff" style={{ '--lc': person.hue }}><Icon name="handoff" size={13} /> {delegatedBy.name}</span>}
            <span className="brain"><Icon name="brain" size={12} /> {person.modelLabel}</span>
            {lane.state === 'live' ?
            <span className="status-live" style={{ '--lc': person.hue }}><span className="dot" /> working · {lane.time}</span> :
            <span className="status-done"><Icon name="check" size={13} /> {lane.time}</span>}
            <span className="chev"><Icon name="chevR" size={15} /></span>
          </div>
        </div>
        <div className="lane-body">
          {lane.activity.map((a, i) => <Activity key={i} a={a} hue={person.hue} />)}
          {lane.result && <div className="handoff" style={{ '--lc': person.hue, marginTop: 6 }}><Icon name="check" size={13} /> {lane.result}</div>}
        </div>
      </div>
    </div>);

}

function Deliverable({ d }) {
  const [captured, setCaptured] = useState(false);
  return (
    <div className="deliv">
      <div className="dh">
        <span className="di" style={{ background: window.D.grad(d.hue) }}><Icon name={d.icon} size={16} /></span>
        <div style={{ minWidth: 0 }}>
          <div className="dt">{d.title}</div>
          <div className="dm">{d.meta}</div>
        </div>
      </div>
      <div className="preview"><div className="ph">{d.ph}</div></div>
      <div className="dact">
        <button className="btn sm"><Icon name="eye" size={14} /> Open</button>
        <button className="btn sm ghost"><Icon name="download" size={14} /> Export</button>
      </div>
      {captured
        ? <div className="captured"><Icon name="check" size={13} /> Proposed to the knowledge base — pending review</div>
        : <button className="capture-btn" onClick={() => setCaptured(true)}><Icon name="book" size={13} /> Capture to knowledge</button>}
    </div>);

}

function Conversation({ draft, setDraft, onSend, showReview, goBoard }) {
  const C = window.D.CONVO;
  const lead = cw(C.leadId);
  return (
    <div className="view" style={{ overflow: 'hidden', display: 'flex' }}>
      <div className={`convo ${showReview ? '' : 'solo'}`} style={{ flex: 1 }}>
        <div className="thread-col">
          <div className="thread-scroll">
            <div className="thread-inner">
              <div className="convo-context">
                <button className="cc-chip" onClick={() => goBoard && goBoard('engagement')}><Icon name="kanban" size={13} /> Engagement 2026</button>
                <Icon name="chevR" size={12} style={{ color: 'var(--ink-3)' }} />
                <span className="cc-task"><Icon name="check" size={12} /> Task: Draft the leadership readout</span>
                <span className="cc-sand">Sandbox · outputs become artifacts</span>
              </div>
              <div className="bubble user">
                <Avatar person={{ initials: 'JD', hue: 'var(--c-blue)' }} size="s34" style={{ background: 'linear-gradient(150deg,var(--c-blue),var(--c-violet))' }} />
                <div className="body">
                  <div className="who">You</div>
                  <div className="text">{C.userMsg}</div>
                </div>
              </div>

              <div className="bubble">
                <Avatar person={lead} size="s34" />
                <div className="body">
                  <div className="who">{lead.name} · {lead.role} · leading</div>
                  <div className="text"><p>{C.intro}</p></div>
                  <div style={{ marginTop: 14 }}>
                    {C.lanes.map((l, i) => <Lane key={i} lane={l} />)}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="convo-foot">
            <Composer value={draft} onChange={setDraft} onSend={onSend} assignTo={null} setAssignTo={() => {}} />
          </div>
        </div>

        {showReview &&
        <aside className="review">
            <div className="review-head">
              <h3>Deliverables</h3>
              <p>What the team is producing for you to review.</p>
            </div>
            <div className="review-body">
              {C.deliverables.map((d, i) => <Deliverable key={i} d={d} />)}
              <div style={{ fontSize: 12, color: 'var(--ink-3)', textAlign: 'center', padding: '6px 0' }}>
                Nothing ships until you approve it.
              </div>
            </div>
          </aside>
        }
      </div>
    </div>);

}

Object.assign(window, { Home, Conversation, Composer });
