/* ============================================================
   OPTION D — shared primitives (exported to window)
   ============================================================ */
const { useState, useEffect, useRef } = React;

function Icon({ name, w = 1.8, size, style, className }) {
  const path = (window.D.ICONS[name]) || '';
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w}
      strokeLinecap="round" strokeLinejoin="round"
      className={className}
      style={{ width: size || '1em', height: size || '1em', flex: 'none', ...style }}
      dangerouslySetInnerHTML={{ __html: path }} />
  );
}

function Avatar({ person, size = 's34', running, square, style }) {
  const cls = `av ${square ? 'sq' : ''} ${size}`;
  return (
    <span className={cls} style={{ background: window.D.grad(person.hue), ...style }}>
      {person.initials}
      {running && <span className="presence work" />}
    </span>
  );
}

// coworker lookup
function cw(id) { return window.D.COWORKERS.find(c => c.id === id); }

// Working-style mini bars
function StyleBars({ style }) {
  return (
    <div style={{ marginTop: 4 }}>
      {Object.entries(style).map(([k, v]) => (
        <div className="style-row" key={k}>
          <span className="k">{k}</span>
          <span className="bar"><i style={{ width: (v * 100) + '%' }} /></span>
        </div>
      ))}
    </div>
  );
}

function Tag({ children, accent, dot }) {
  return <span className={`tag ${accent ? 'accent' : ''} ${dot ? 'dot' : ''}`}>{children}</span>;
}

// Mode = real OpenCode agent mode (primary = Lead, subagent = Specialist)
function ModeBadge({ mode }) {
  const label = window.D.MODE_LABEL[mode];
  return <span className={`mode-badge ${mode}`}>{mode === 'primary' ? '◆' : '◇'} {label}</span>;
}

// Real config facts for a coworker (maps to OpenCode AgentConfig)
function ConfigSpec({ person }) {
  const rows = [
    ['Brain', person.modelLabel],
    ['Temperature', person.temperature.toFixed(2)],
    ['Max steps', person.steps],
  ];
  return (
    <div className="spec">
      {rows.map(([k, v]) => (
        <div className="spec-row" key={k}><span className="sk">{k}</span><span className="sv">{v}</span></div>
      ))}
    </div>
  );
}

// Generic empty-state
function EmptyState({ icon, title, children }) {
  return (
    <div className="empty">
      <div className="eg"><Icon name={icon} size={28} /></div>
      <h3>{title}</h3>
      <div style={{ maxWidth: '40ch' }}>{children}</div>
    </div>
  );
}

// A labeled page header with optional action
function PageHead({ title, sub, action }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

// search + filter toolbar
function Toolbar({ q, setQ, placeholder, chips, active, setActive }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 22 }}>
      <label className="field" style={{ minWidth: 280 }}>
        <Icon name="search" size={16} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} />
      </label>
      {chips && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {chips.map(c => (
            <button key={c} className={`chip ${active === c ? 'on' : ''}`} onClick={() => setActive(c)}>{c}</button>
          ))}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { Icon, Avatar, cw, StyleBars, Tag, ModeBadge, ConfigSpec, EmptyState, PageHead, Toolbar });
