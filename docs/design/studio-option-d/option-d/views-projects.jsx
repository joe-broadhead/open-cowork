/* ============================================================
   OPTION D — Projects (coordination) + Kanban task board
   Objective -> planned by Cleo (Chief of Staff) -> specced tasks
   -> assigned to coworkers -> reviewed by you.
   ============================================================ */

const PRIO_COLOR = { high: 'var(--err)', med: 'var(--warn)', low: 'var(--ink-3)' };
const RUN_STEPS = ['Queued', 'Running', 'Review', 'Done'];
function runForCol(col) {
  return ({
    backlog: { label: 'Not started', idx: -1, live: false, meta: 'No run yet' },
    planning: { label: 'Queued', idx: 0, live: false, meta: 'Waiting to start' },
    doing: { label: 'Running now', idx: 1, live: true, meta: '4m elapsed · 12 steps' },
    review: { label: 'Done — awaiting your review', idx: 2, live: false, meta: 'Ran in 5m · 18 steps' },
    done: { label: 'Completed', idx: 3, live: false, meta: 'Ran in 3m · 14 steps' },
  })[col];
}

function projectById(id) { return window.D.PROJECTS.find(p => p.id === id); }
function taskProgress(tasks) {
  const done = tasks.filter(t => t.col === 'done').length;
  return { done, total: tasks.length, pct: tasks.length ? Math.round(done / tasks.length * 100) : 0 };
}

/* ---------------- PROJECTS LIST ---------------- */
function ProjectsView({ open, go }) {
  const projects = window.D.PROJECTS.filter(p => p.kind === 'project');
  return (
    <div className="view"><div className="wrap">
      <PageHead title="Projects" sub="Each project is an objective. Define what you want, let Cleo plan it into tasks, and watch the team deliver. Under the hood, every task runs as a real OpenCode session."
        action={<button className="btn primary"><Icon name="plus" size={16} /> New project</button>} />
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))' }}>
        {projects.map(p => {
          const prog = taskProgress(p.tasks);
          return (
            <button className="proj-card" key={p.id} onClick={() => open(p.id)}>
              <div className="pc-head">
                <h3 className="serif">{p.name}</h3>
                <span className="tag dot" style={{ color: 'var(--ok)', background: 'color-mix(in srgb,var(--ok) 14%,transparent)', border: 'none' }}>Active</span>
              </div>
              <div className="pc-obj">{p.objective}</div>
              <div className="pc-bar"><i style={{ width: prog.pct + '%' }} /></div>
              <div className="pc-foot">
                <div className="avstack">{p.team.map(id => <Avatar key={id} person={cw(id)} size="s28" />)}</div>
                <span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{prog.done}/{prog.total} tasks done</span>
              </div>
            </button>
          );
        })}
      </div>
    </div></div>
  );
}

/* ---------------- TASK CARD ---------------- */
function TaskCard({ task, onOpen, onDragStart }) {
  const a = task.assignee ? cw(task.assignee) : null;
  return (
    <div className="task" draggable onDragStart={onDragStart} onClick={onOpen}>
      <div className="task-top">
        <span className="prio" style={{ background: PRIO_COLOR[task.priority] }} />
        <span className="task-title">{task.title}</span>
      </div>
      <div className="task-foot">
        {a ? <><Avatar person={a} size="s24" /> <span className="faint">{a.name}</span></>
          : <span className="unassigned"><Icon name="user" size={13} /> Unassigned</span>}
        {task.col === 'doing' && <span className="run-pill"><span className="dot" /> running</span>}
        <Icon name="grip" size={15} style={{ marginLeft: 'auto', color: 'var(--ink-3)', opacity: .6 }} />
      </div>
    </div>
  );
}

/* ---------------- BOARD ---------------- */
function ProjectBoard({ projectId, back, openThread }) {
  const project = projectById(projectId);
  const [tasks, setTasks] = useState(project.tasks.map(t => ({ ...t })));
  const [dragId, setDragId] = useState(null);
  const [overCol, setOverCol] = useState(null);
  const [detail, setDetail] = useState(null);
  const [planning, setPlanning] = useState(false);
  const [objective, setObjective] = useState(project.objective);
  const [planned, setPlanned] = useState(false);

  const move = (id, col) => setTasks(ts => ts.map(t => t.id === id ? { ...t, col } : t));
  const drop = (col) => { if (dragId) move(dragId, col); setDragId(null); setOverCol(null); };

  const runPlan = () => {
    const base = tasks.length;
    const newTasks = window.D.PLAN_TEMPLATE.map((t, i) => ({ ...t, id: 'plan' + base + i, col: 'planning' }));
    setTasks(ts => [...ts, ...newTasks]);
    setPlanned(true); setPlanning(false);
  };

  const prog = taskProgress(tasks);

  return (
    <div className="view">
      <div className="board-wrap">
        {/* header */}
        <div className="board-head">
          <button className="btn ghost sm" onClick={back}><Icon name="chevL" size={15} /> Projects</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="serif" style={{ fontSize: 30, lineHeight: 1.05 }}>{project.name}</h1>
            <div className="board-obj">{project.objective}</div>
          </div>
          <div className="avstack" style={{ flex: 'none' }}>{project.team.map(id => <Avatar key={id} person={cw(id)} size="s34" />)}</div>
        </div>
        <div className="board-sub">
          <span className="faint">{prog.done}/{prog.total} done · {prog.pct}%</span>
          <span className="board-bar"><i style={{ width: prog.pct + '%' }} /></span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => openThread(project)}><Icon name="chat" size={14} /> Open conversation</button>
          <button className="btn sm primary" onClick={() => setPlanning(p => !p)}><Avatar person={cw('cleo')} size="s24" /> Plan with Cleo</button>
        </div>

        {/* plan-with-chief-of-staff panel */}
        {planning && (
          <div className="plan-panel">
            <div className="plan-head"><Avatar person={cw('cleo')} size="s34" /><div><div className="pp-nm">Cleo · Chief of Staff</div><div className="faint" style={{ fontSize: 12 }}>Describe the objective and I'll break it into specced tasks and assign the right coworkers.</div></div></div>
            <textarea className="ta" value={objective} onChange={e => setObjective(e.target.value)} style={{ minHeight: 80, marginTop: 12 }} />
            <div style={{ display: 'flex', gap: 9, marginTop: 12, justifyContent: 'flex-end' }}>
              <button className="btn sm ghost" onClick={() => setPlanning(false)}>Cancel</button>
              <button className="btn sm primary" onClick={runPlan}><Icon name="sparkle" size={14} /> Plan into tasks</button>
            </div>
          </div>
        )}
        {planned && !planning && (
          <div className="plan-note"><Avatar person={cw('cleo')} size="s24" /> Cleo added {window.D.PLAN_TEMPLATE.length} tasks to Planning and assigned coworkers. Drag them as the work progresses.</div>
        )}

        {/* kanban */}
        <div className="kanban">
          {window.D.TASK_COLUMNS.map(col => {
            const colTasks = tasks.filter(t => t.col === col.id);
            return (
              <div key={col.id} className={`col ${overCol === col.id ? 'over' : ''}`}
                onDragOver={e => { e.preventDefault(); setOverCol(col.id); }}
                onDragLeave={() => setOverCol(c => c === col.id ? null : c)}
                onDrop={() => drop(col.id)}>
                <div className="col-head"><span className="col-label">{col.label}</span><span className="col-count">{colTasks.length}</span></div>
                <div className="col-body">
                  {colTasks.map(t => (
                    <TaskCard key={t.id} task={t} onOpen={() => setDetail(t)} onDragStart={() => setDragId(t.id)} />
                  ))}
                  {colTasks.length === 0 && <div className="col-empty">Drop here</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* task detail */}
      {detail && <TaskDetail task={detail} onClose={() => setDetail(null)}
        onMove={col => { move(detail.id, col); setDetail({ ...detail, col }); }}
        onAssign={id => { setTasks(ts => ts.map(t => t.id === detail.id ? { ...t, assignee: id } : t)); setDetail({ ...detail, assignee: id }); }}
        openConvo={openThread} project={project} />}
    </div>
  );
}

function TaskDetail({ task, onClose, onMove, onAssign, project, openConvo }) {
  const a = task.assignee ? cw(task.assignee) : null;
  const assignable = window.D.COWORKERS;
  const [pickOpen, setPickOpen] = useState(false);
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <span className="prio" style={{ background: PRIO_COLOR[task.priority] }} />
          <span className="faint" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700 }}>{window.D.TASK_PRIORITY[task.priority]} priority</span>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><Icon name="chevR" size={18} /></button>
        </div>
        <h2 className="serif" style={{ fontSize: 26, lineHeight: 1.1, marginTop: 6 }}>{task.title}</h2>
        <div className="drawer-spec">{task.spec}</div>

        <div className="drawer-sect">
          <h5>Run</h5>
          {(() => {
            const r = runForCol(task.col); const completed = r.idx === 3;
            return (
              <div className="run-box">
                <div className="run-state">
                  {r.live ? <span className="live"><span className="dot" /> {r.label}</span>
                    : <span style={{ color: completed ? 'var(--ok)' : 'var(--ink)' }}>{completed && '✓ '}{r.label}</span>}
                </div>
                {r.idx >= 0 && (
                  <div className="run-steps">
                    {RUN_STEPS.map((s, i) => (
                      <div key={s} className={`run-step ${completed || i < r.idx ? 'done' : i === r.idx ? 'current' : ''}`}>
                        <span className="rs-dot" /><span className="rs-l">{s}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="run-meta"><span className="sid">session a3f9c1</span> {r.meta}</div>
              </div>
            );
          })()}
        </div>

        <div className="drawer-sect">
          <h5>Assigned to</h5>
          <div style={{ position: 'relative' }}>
            <button className="assign-pick" onClick={() => setPickOpen(o => !o)}>
              {a ? <><Avatar person={a} size="s28" /> <b>{a.name}</b> <span className="faint">{a.role}</span></>
                : <><span className="unassigned"><Icon name="user" size={14} /> Unassigned</span></>}
              <Icon name="chevD" size={14} style={{ marginLeft: 'auto' }} />
            </button>
            {pickOpen && (
              <div className="pick-menu">
                {assignable.map(c => (
                  <button key={c.id} className="thread" style={{ display: 'flex', alignItems: 'center', gap: 9 }} onClick={() => { onAssign(c.id); setPickOpen(false); }}>
                    <Avatar person={c} size="s24" /> <span><b>{c.name}</b> <small className="faint">{c.role}</small></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="drawer-sect">
          <h5>Stage</h5>
          <div className="stage-row">
            {window.D.TASK_COLUMNS.map(col => (
              <button key={col.id} className={`stage-chip ${task.col === col.id ? 'on' : ''}`} onClick={() => onMove(col.id)}>{col.label}</button>
            ))}
          </div>
        </div>

        <div className="drawer-actions">
          <button className="btn" style={{ flex: 1 }} onClick={() => openConvo(project)}><Icon name="chat" size={15} /> Open the work</button>
          {a && <button className="btn primary" style={{ flex: 1 }} onClick={() => onMove('doing')}><Icon name="play" size={14} /> Hand to {a.name}</button>}
        </div>
      </aside>
    </div>
  );
}

Object.assign(window, { ProjectsView, ProjectBoard });
