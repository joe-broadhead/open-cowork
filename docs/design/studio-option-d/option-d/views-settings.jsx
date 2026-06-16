/* ============================================================
   OPTION D — Settings
   ============================================================ */

function Toggle({ on, onClick }) {
  return <button className={`toggle ${on ? 'on' : ''}`} onClick={onClick} aria-pressed={on} />;
}

function SettingsView({ theme, setTheme, accent, setAccent, density, setDensity }) {
  const [tab, setTab] = useState('account');
  const [toggles, setToggles] = useState({ voice: true, suggestions: true, digest: false, sound: true, retain: true, share: false });
  const flip = k => setToggles({ ...toggles, [k]: !toggles[k] });

  const tabs = [
    { id: 'account', label: 'Account', icon: 'user' },
    { id: 'brains', label: 'AI providers', icon: 'brain' },
    { id: 'permissions', label: 'Permissions', icon: 'lock' },
    { id: 'appearance', label: 'Appearance', icon: 'sun' },
    { id: 'notifications', label: 'Notifications', icon: 'bell' },
    { id: 'privacy', label: 'Privacy', icon: 'shield' },
  ];
  const [policy, setPolicy] = useState({ bash: 'ask', fileWrite: 'ask', web: 'allow', webSearch: 'allow' });
  const setPol = (k, v) => setPolicy({ ...policy, [k]: v });

  const ACCENTS = [
    { id: 'northwind', c: '#2f6bf0' }, { id: 'indigo', c: '#6f8cc4' }, { id: 'plum', c: '#8b7cf0' },
    { id: 'teal', c: '#3f9a8f' }, { id: 'amber', c: '#e0913a' }, { id: 'rose', c: '#d6587e' },
  ];

  return (
    <div className="view"><div className="settings">
      <nav className="set-nav">
        {tabs.map(t => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={17} /> {t.label}
          </button>
        ))}
      </nav>
      <div>
        {tab === 'account' && (
          <div className="set-sect">
            <h2 className="serif">Account</h2>
            <div className="sd">Your profile and plan.</div>
            <div className="set-group">
              <div className="set-row">
                <span className="av s44" style={{ background: 'linear-gradient(150deg,var(--c-blue),var(--c-violet))' }}>GL</span>
                <div className="lab"><div className="t">Gustavo Lemos</div><div className="d">gustavo.lemos@northwind.com</div></div>
                <button className="btn sm">Edit</button>
              </div>
              <div className="set-row">
                <div className="lab"><div className="t">Plan</div><div className="d">Enterprise · 8 coworkers · unlimited tasks</div></div>
                <button className="btn sm">Manage</button>
              </div>
              <div className="set-row">
                <div className="lab"><div className="t">Workspace</div><div className="d">Northwind · People Team</div></div>
                <span className="tag accent">Owner</span>
              </div>
            </div>
          </div>
        )}

        {tab === 'brains' && (
          <div className="set-sect">
            <h2 className="serif">AI providers</h2>
            <div className="sd">Connect the AI services that power your coworkers. Keys are stored securely and never shared between workspaces.</div>
            <div className="set-group">
              {window.D.PROVIDERS.map(p => (
                <div className="prov-row" key={p.id}>
                  <span className="pg" style={{ background: window.D.grad(p.hue) }}>{p.initials}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="pn">{p.name}
                      {p.connected
                        ? <span className="tag dot" style={{ color: 'var(--ok)', background: 'color-mix(in srgb,var(--ok) 14%,transparent)', border: 'none' }}>Connected</span>
                        : <span className="tag dot" style={{ color: 'var(--ink-3)' }}>Not connected</span>}
                    </div>
                    <div className="ps">{p.connected ? `${p.models.length} model${p.models.length !== 1 ? 's' : ''} available` : 'Add a key to enable'}</div>
                  </div>
                  <button className={`btn sm ${p.connected ? '' : 'primary'}`}>{p.connected ? 'Manage' : 'Connect'}</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'permissions' && (
          <div className="set-sect">
            <h2 className="serif">Permissions</h2>
            <div className="sd">Workspace-wide guardrails for what coworkers may do. These are the ceiling — each coworker can be stricter, never looser. Maps to OpenCode's runtime policy.</div>
            <div className="set-group">
              {[['bash', 'Run shell commands', 'Execute commands on the machine', 'bash'],
                ['fileWrite', 'Create & edit files', 'Write to files in a project', 'fileWrite'],
                ['web', 'Open web pages', 'Fetch pages and code search', 'web']].map(([k, t, d, key]) => (
                <div className="set-row" key={k}>
                  <div className="lab"><div className="t">{t} <code className="param">{key}</code></div><div className="d">{d}</div></div>
                  <div className="seg">
                    {['allow', 'ask', 'deny'].map(v => (
                      <button key={v} className={`${v} ${policy[k] === v ? 'on' : ''}`} onClick={() => setPol(k, v)} style={{ textTransform: 'capitalize' }}>{v}</button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="set-row">
                <div className="lab"><div className="t">Web search <code className="param">websearch</code></div><div className="d">Let coworkers search the web</div></div>
                <Toggle on={policy.webSearch === 'allow'} onClick={() => setPol('webSearch', policy.webSearch === 'allow' ? 'deny' : 'allow')} />
              </div>
            </div>
            <h2 className="serif" style={{ marginTop: 26 }}>Review gates</h2>
            <div className="sd">Where a human must sign off before work continues.</div>
            <div className="set-group">
              <div className="set-row"><div className="lab"><div className="t">Require approval before sending</div><div className="d">Emails, messages and posts pause for you</div></div><Toggle on={true} onClick={() => {}} /></div>
              <div className="set-row"><div className="lab"><div className="t">Knowledge needs review</div><div className="d">Edits become proposals before they publish</div></div><Toggle on={true} onClick={() => {}} /></div>
            </div>
          </div>
        )}

        {tab === 'appearance' && (
          <div className="set-sect">
            <h2 className="serif">Appearance</h2>
            <div className="sd">Make the studio yours. These also live in the Tweaks panel.</div>
            <div className="set-group">
              <div className="set-row">
                <div className="lab"><div className="t">Theme</div><div className="d">Cream paper, or the Mercury dark theme.</div></div>
                <div className="seg">
                  <button className={theme === 'light' ? 'on ask' : ''} onClick={() => setTheme('light')} style={{ fontWeight: 600 }}>Day</button>
                  <button className={theme === 'dark' ? 'on ask' : ''} onClick={() => setTheme('dark')} style={{ fontWeight: 600 }}>Mercury</button>
                </div>
              </div>
              <div className="set-row">
                <div className="lab"><div className="t">Accent colour</div><div className="d">The signature tone across the app.</div></div>
                <div className="swatches">
                  {ACCENTS.map(a => (
                    <button key={a.id} className={`swatch ${accent === a.id ? 'on' : ''}`} style={{ background: a.c }} onClick={() => setAccent(a.id)} aria-label={a.id} />
                  ))}
                </div>
              </div>
              <div className="set-row">
                <div className="lab"><div className="t">Density</div><div className="d">How much breathing room.</div></div>
                <div className="seg">
                  {['compact', 'regular', 'comfy'].map(d => (
                    <button key={d} className={density === d ? 'on ask' : ''} onClick={() => setDensity(d)} style={{ fontWeight: 600, textTransform: 'capitalize' }}>{d}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'notifications' && (
          <div className="set-sect">
            <h2 className="serif">Notifications</h2>
            <div className="sd">Decide when the team reaches out.</div>
            <div className="set-group">
              {[['voice', 'Voice replies', 'Let coworkers answer out loud when you ask'],
                ['suggestions', 'Smart suggestions', 'Show task ideas on the home screen'],
                ['digest', 'Daily digest', 'A morning summary of what the team did'],
                ['sound', 'Sounds', 'Play a chime when a task finishes']].map(([k, t, d]) => (
                <div className="set-row" key={k}>
                  <div className="lab"><div className="t">{t}</div><div className="d">{d}</div></div>
                  <Toggle on={toggles[k]} onClick={() => flip(k)} />
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'privacy' && (
          <div className="set-sect">
            <h2 className="serif">Privacy</h2>
            <div className="sd">You’re in control of your data.</div>
            <div className="set-group">
              <div className="set-row">
                <div className="lab"><div className="t">Keep conversation history</div><div className="d">Store past tasks so the team has context</div></div>
                <Toggle on={toggles.retain} onClick={() => flip('retain')} />
              </div>
              <div className="set-row">
                <div className="lab"><div className="t">Help improve the product</div><div className="d">Share anonymized usage — never your content</div></div>
                <Toggle on={toggles.share} onClick={() => flip('share')} />
              </div>
              <div className="set-row">
                <div className="lab"><div className="t">Export everything</div><div className="d">Download all your data as a file</div></div>
                <button className="btn sm"><Icon name="download" size={14} /> Export</button>
              </div>
              <div className="set-row">
                <div className="lab"><div className="t" style={{ color: 'var(--err)' }}>Delete workspace</div><div className="d">Permanently remove all coworkers and history</div></div>
                <button className="btn sm" style={{ color: 'var(--err)', borderColor: 'color-mix(in srgb,var(--err) 40%,var(--line))' }}><Icon name="trash" size={14} /> Delete</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div></div>
  );
}

Object.assign(window, { SettingsView, Toggle });
