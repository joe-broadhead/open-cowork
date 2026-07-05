/* ============================================================
   OPTION D — Onboard a coworker (friendly Agent Builder)
   Every control maps to a real OpenCode AgentConfig field:
   instructions, skillNames, toolIds, model, temperature, top_p,
   steps, mode, and allow/ask/deny permission patterns.
   ============================================================ */

const VARIANTS = [
  { id: 'none', name: 'Standard', desc: 'Normal responses' },
  { id: 'reasoning', name: 'Extra thinking', desc: 'Reasons step-by-step before acting (variant: reasoning)' },
];

function Onboard({ go }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [role, setRole] = useState('researcher');
  const roleObj = window.D.ROLES.find(r => r.id === role);

  const [instructions, setInstructions] = useState(roleObj.instructions);
  const [abilities, setAbilities] = useState(new Set(roleObj.skills));
  const [conns, setConns] = useState(new Set(roleObj.tools));
  const [prov, setProv] = useState('anthropic');
  const [model, setModel] = useState('sonnet');
  const [temp, setTemp] = useState(roleObj.temperature);
  const [steps, setSteps] = useState(roleObj.steps);
  const [topP, setTopP] = useState(1.0);
  const [variant, setVariant] = useState('none');
  const [mode, setMode] = useState(roleObj.mode);
  const [advanced, setAdvanced] = useState(false);
  // permissions: { [permId]: { def, rules:[[pattern,opt]] } }
  const [perms, setPerms] = useState(() => {
    const o = {}; window.D.PERMISSIONS.forEach(p => { o[p.id] = { def: p.default, rules: p.rules.map(r => [...r]) }; }); return o;
  });

  function applyRole(r) {
    const ro = window.D.ROLES.find(x => x.id === r);
    setRole(r);
    setInstructions(ro.instructions);
    setAbilities(new Set(ro.skills));
    setConns(new Set(ro.tools));
    setTemp(ro.temperature);
    setSteps(ro.steps);
    setMode(ro.mode);
  }

  const person = { initials: named && name ? name.slice(0, 2).toUpperCase() : roleObj.name.slice(0, 2).toUpperCase(), hue: roleObj.hue };
  const toggle = (set, setSet, id) => { const n = new Set(set); n.has(id) ? n.delete(id) : n.add(id); setSet(n); };

  const provObj = window.D.PROVIDERS.find(p => p.id === prov);
  const modelObj = provObj.models.find(m => m.id === model);
  const modelLabel = modelObj ? modelObj.name : '—';

  const ready = {
    name: named && !!name.trim(),
    instructions: instructions.trim().length > 20,
    skills: abilities.size + conns.size > 0,
    brain: !!modelObj,
  };
  const canCreate = ready.name && ready.instructions && ready.skills && ready.brain;

  const steps_ = [
    { label: 'Role', },
    { label: 'Abilities', },
    { label: 'Brain', },
    { label: 'Permissions', },
  ];

  // summary config spec (real fields)
  const specPerson = { modelLabel, temperature: temp, steps };

  return (
    <div className="view"><div className="builder">
      {/* summary */}
      <aside className="cw-summary">
        <div className="hero">
          <Avatar person={person} size="s84" />
          <div className="nm" contentEditable suppressContentEditableWarning spellCheck={false}
            data-ph="Name your coworker"
            onInput={e => { const v = e.currentTarget.textContent.trim(); setName(v); setNamed(!!v); }}
            style={{ marginTop: 14 }}></div>
          <div className="role">{roleObj.name} · <span style={{ color: 'var(--ink-3)' }}>{window.D.MODE_LABEL[mode]}</span></div>
        </div>
        <div className="sect">
          <h5>Configuration</h5>
          <ConfigSpec person={specPerson} />
        </div>
        <div className="sect">
          <h5>Abilities & connections</h5>
          <div className="eqchips">
            {[...abilities].map(id => { const a = window.D.ABILITIES.find(x => x.id === id); return a ? <span className="chip on" key={id} style={{ height: 28 }}><Icon name={a.icon} size={13} /> {a.name}</span> : null; })}
            {[...conns].map(id => { const c = window.D.CONNECTIONS.find(x => x.id === id); return c ? <span className="chip" key={id} style={{ height: 28 }}><Icon name={c.icon} size={13} /> {c.name}</span> : null; })}
            {abilities.size + conns.size === 0 && <span className="none">Nothing yet</span>}
          </div>
        </div>
        <div className="sect readiness">
          <h5>Before they start</h5>
          {[['name', 'Has a name'], ['instructions', 'Instructions written'], ['skills', 'At least one ability or connection'], ['brain', 'Brain selected']].map(([k, lbl]) => (
            <div className={`ck ${ready[k] ? 'done' : ''}`} key={k}>
              <span className="bx"><Icon name="check" w={3} size={12} /></span> {lbl}
            </div>
          ))}
        </div>
      </aside>

      {/* panel */}
      <section className="panel">
        <div className="steps">
          {steps_.map((s, i) => (
            <button key={s.label} className={step === i ? 'on' : ''} onClick={() => setStep(i)}>
              <span className="n">{i + 1}</span>{s.label}
            </button>
          ))}
        </div>

        {step === 0 && (
          <div className="step-pane">
            <h3>What should they do?</h3>
            <p className="hint">Pick a starting role, then fine-tune the instructions. The role sets sensible defaults for abilities, brain settings and whether they lead or specialise.</p>
            <div className="role-grid">
              {window.D.ROLES.map(r => (
                <button key={r.id} className={`role-opt ${role === r.id ? 'on' : ''}`} onClick={() => applyRole(r.id)}>
                  <span className="ic" style={{ background: window.D.grad(r.hue) }}><Icon name={r.icon} size={19} /></span>
                  <span><div className="nm">{r.name}</div><div className="ds">{r.desc}</div></span>
                </button>
              ))}
            </div>
            <div className="form-row" style={{ marginTop: 22 }}>
              <label>Instructions <small>— the system prompt OpenCode runs with</small></label>
              <textarea className="ta" value={instructions} onChange={e => setInstructions(e.target.value)} style={{ minHeight: 130 }} />
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="step-pane">
            <h3>What can they do?</h3>
            <p className="hint">Abilities are reusable skills; connections are the apps and data they can reach. These become the agent\u2019s linked skills and tools.</p>
            <div className="tb-h" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 12px' }}>
              <strong style={{ fontSize: 14 }}>Abilities <span className="faint" style={{ fontWeight: 400 }}>· skills</span></strong><span className="faint" style={{ fontSize: 12 }}>{abilities.size} added</span>
            </div>
            <div className="pick-grid">
              {window.D.ABILITIES.map(a => (
                <button key={a.id} className={`pick ${abilities.has(a.id) ? 'on' : ''}`} onClick={() => toggle(abilities, setAbilities, a.id)}>
                  <span className="ck"><Icon name="check" w={3} size={12} /></span>
                  <span className="ic"><Icon name={a.icon} size={17} /></span>
                  <span><div className="nm">{a.name}</div><div className="ds">{a.desc}</div></span>
                </button>
              ))}
            </div>
            <div className="tb-h" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '22px 0 12px' }}>
              <strong style={{ fontSize: 14 }}>Connections <span className="faint" style={{ fontWeight: 400 }}>· tools & MCPs</span></strong><span className="faint" style={{ fontSize: 12 }}>{conns.size} added</span>
            </div>
            <div className="pick-grid">
              {window.D.CONNECTIONS.filter(c => c.connected).map(c => (
                <button key={c.id} className={`pick ${conns.has(c.id) ? 'on' : ''}`} onClick={() => toggle(conns, setConns, c.id)}>
                  <span className="ck"><Icon name="check" w={3} size={12} /></span>
                  <span className="ic"><Icon name={c.icon} size={17} /></span>
                  <span><div className="nm">{c.name}</div><div className="ds">{c.kind}</div></span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="step-pane">
            <h3>Brain & behaviour</h3>
            <p className="hint">Choose the model and tune how it behaves. Every setting here is a real OpenCode inference override.</p>
            <div className="prov-tabs">
              {window.D.PROVIDERS.map(p => (
                <button key={p.id} className={`chip ${prov === p.id ? 'on' : ''}`} onClick={() => { if (!p.connected) return; setProv(p.id); if (p.models[0]) setModel(p.models[0].id); }}
                  style={p.connected ? {} : { opacity: .5 }}>
                  {p.name}{!p.connected && ' · not connected'}
                </button>
              ))}
            </div>
            {provObj.models.length === 0
              ? <div className="empty" style={{ padding: '30px 20px' }}><div className="faint">Connect this provider in Settings to use its models.</div></div>
              : <div className="brain-list" style={{ marginBottom: 24 }}>
                {provObj.models.map(m => (
                  <button key={m.id} className={`brain-row ${model === m.id ? 'on' : ''}`} onClick={() => setModel(m.id)}>
                    <span style={{ width: 18, height: 18, borderRadius: '50%', flex: 'none', border: '2px solid ' + (model === m.id ? 'var(--accent)' : 'var(--line-2)'), display: 'grid', placeItems: 'center' }}>
                      {model === m.id && <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)' }} />}
                    </span>
                    <div><div className="bn">{m.name}</div><div className="bd">{m.desc}</div></div>
                    <div className="meta">
                      {m.rec && <span className="mtag rec">Recommended</span>}
                      <span className="mtag">{m.ctx} memory</span>
                    </div>
                  </button>
                ))}
              </div>}

            <div className="trait">
              <div className="l"><span className="n"><Icon name="spark" size={16} /> Creativity <code className="param">temperature</code></span><span className="v">{temp.toFixed(2)}</span></div>
              <input type="range" min="0" max="100" value={Math.round(temp * 100)} style={{ '--p': Math.round(temp * 100) + '%' }} onChange={e => setTemp(+e.target.value / 100)} />
              <div className="ends"><span>0.00 · focused & consistent</span><span>1.00 · creative & varied</span></div>
            </div>
            <div className="trait">
              <div className="l"><span className="n"><Icon name="clock" size={16} /> Works on its own <code className="param">steps</code></span><span className="v">{steps} steps</span></div>
              <input type="range" min="5" max="60" value={steps} style={{ '--p': ((steps - 5) / 55 * 100) + '%' }} onChange={e => setSteps(+e.target.value)} />
              <div className="ends"><span>5 · checks in sooner</span><span>60 · long independent runs</span></div>
            </div>

            <button className="adv-toggle" onClick={() => setAdvanced(a => !a)}>
              <Icon name={advanced ? 'chevD' : 'chevR'} size={14} /> Advanced
            </button>
            {advanced && (
              <div className="adv">
                <div className="form-row">
                  <label>Can they lead a conversation? <small>— agent mode</small></label>
                  <div className="seg" style={{ display: 'inline-flex' }}>
                    <button className={mode === 'primary' ? 'on ask' : ''} onClick={() => setMode('primary')} style={{ fontWeight: 600 }}>Lead (primary)</button>
                    <button className={mode === 'subagent' ? 'on ask' : ''} onClick={() => setMode('subagent')} style={{ fontWeight: 600 }}>Specialist (subagent)</button>
                  </div>
                </div>
                <div className="trait" style={{ marginTop: 18 }}>
                  <div className="l"><span className="n">Nucleus sampling <code className="param">top_p</code></span><span className="v">{topP.toFixed(2)}</span></div>
                  <input type="range" min="0" max="100" value={Math.round(topP * 100)} style={{ '--p': Math.round(topP * 100) + '%' }} onChange={e => setTopP(+e.target.value / 100)} />
                </div>
                <div className="form-row" style={{ marginTop: 8 }}>
                  <label>Thinking <small>— model variant</small></label>
                  <div className="brain-list">
                    {VARIANTS.map(v => (
                      <button key={v.id} className={`brain-row ${variant === v.id ? 'on' : ''}`} onClick={() => setVariant(v.id)} style={{ padding: '11px 13px' }}>
                        <span style={{ width: 16, height: 16, borderRadius: '50%', flex: 'none', border: '2px solid ' + (variant === v.id ? 'var(--accent)' : 'var(--line-2)'), display: 'grid', placeItems: 'center' }}>
                          {variant === v.id && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} />}
                        </span>
                        <div><div className="bn" style={{ fontSize: 13 }}>{v.name}</div><div className="bd">{v.desc}</div></div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="step-pane">
            <h3>What can they do on their own?</h3>
            <p className="hint">These map to OpenCode permissions. Set a default, then add specific rules with patterns like <code className="param">git *</code> or <code className="param">*.env</code>. The most specific matching rule wins.</p>
            {window.D.PERMISSIONS.map(p => (
              <PermissionRow key={p.id} perm={p} state={perms[p.id]}
                onDef={d => setPerms({ ...perms, [p.id]: { ...perms[p.id], def: d } })}
                onRules={rules => setPerms({ ...perms, [p.id]: { ...perms[p.id], rules } })} />
            ))}
          </div>
        )}

        {/* footer nav */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 24px', borderTop: '1px solid var(--line)' }}>
          <button className="btn ghost" onClick={() => go('team')}>Cancel</button>
          <span style={{ flex: 1 }} />
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}><Icon name="chevL" size={15} /> Back</button>}
          {step < 3
            ? <button className="btn primary" onClick={() => setStep(step + 1)}>Continue <Icon name="chevR" size={15} /></button>
            : <button className="btn primary" disabled={!canCreate} onClick={() => go('team')}><Icon name="check" size={15} /> Hire {named && name ? name : 'coworker'}</button>}
        </div>
      </section>
    </div></div>
  );
}

function PermissionRow({ perm, state, onDef, onRules }) {
  const [open, setOpen] = useState(state.rules.length > 0);
  const setRule = (i, idx, val) => { const r = state.rules.map(x => [...x]); r[i][idx] = val; onRules(r); };
  const addRule = () => { onRules([...state.rules, ['', 'ask']]); setOpen(true); };
  const rmRule = i => onRules(state.rules.filter((_, j) => j !== i));
  return (
    <div className="perm">
      <div className="perm-head">
        <span className="gi"><Icon name={perm.icon} size={18} /></span>
        <div className="gx">
          <div className="gn">{perm.name} <code className="param">{perm.key}</code></div>
          <div className="gd">{perm.desc}</div>
        </div>
        <div className="seg">
          {window.D.PERM_OPTS.map(([val, lbl]) => (
            <button key={val} className={`${val} ${state.def === val ? 'on' : ''}`} onClick={() => onDef(val)}>{lbl}</button>
          ))}
        </div>
      </div>
      <button className="perm-rules-toggle" onClick={() => setOpen(o => !o)}>
        <Icon name={open ? 'chevD' : 'chevR'} size={13} /> {state.rules.length ? `${state.rules.length} specific rule${state.rules.length > 1 ? 's' : ''}` : 'Add a specific rule'}
      </button>
      {open && (
        <div className="perm-rules">
          {state.rules.map((r, i) => (
            <div className="prule" key={i}>
              <input className="pp" value={r[0]} placeholder={perm.patternHint} onChange={e => setRule(i, 0, e.target.value)} />
              <div className="seg sm">
                {window.D.PERM_OPTS.map(([val]) => (
                  <button key={val} className={`${val} ${r[1] === val ? 'on' : ''}`} onClick={() => setRule(i, 1, val)}>{val}</button>
                ))}
              </div>
              <button className="prm" onClick={() => rmRule(i)} aria-label="Remove rule"><Icon name="trash" size={14} /></button>
            </div>
          ))}
          <button className="btn sm ghost" onClick={addRule} style={{ alignSelf: 'flex-start' }}><Icon name="plus" size={13} /> Add rule</button>
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Onboard });
