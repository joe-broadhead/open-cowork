/* global window */
/* ============================================================
   OPTION D — mock data (business-user framing)
   Exposed on window.D
   ============================================================ */
(function () {
  // SVG icon paths (Lucide-style, stroke). Rendered by <Icon name>.
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5"/>',
    chat: '<path d="M21 14a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    team: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.9"/><path d="M17.5 14.6A5.5 5.5 0 0 1 20.5 20"/>',
    playbook: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 18.5z"/><path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H19"/><path d="M9 7.5h6M9 11h4"/>',
    ability: '<path d="M13 2 4.5 12.5a.6.6 0 0 0 .46 1H11l-1 8.5 8.5-10.5a.6.6 0 0 0-.46-1H12z"/>',
    artifact: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h5"/><path d="M9 9h1"/>',
    connection: '<path d="M9 15 4.5 19.5a3 3 0 0 1-4-4L5 11"/><path d="M15 9l4.5-4.5a3 3 0 0 1 4 4L19 13"/><path d="M9.5 14.5 14.5 9.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-2.9-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.1-2.9H2a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 3.3 8l-.1-.1A2 2 0 1 1 6 5.1l.1.1A1.7 1.7 0 0 0 9 4V3.8a2 2 0 1 1 4 0V4a1.7 1.7 0 0 0 2.9 1.1l.1-.1A2 2 0 1 1 18.9 8l-.1.1a1.7 1.7 0 0 0-.4 2.8z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.2-4.2"/>',
    send: '<path d="M12 20V5M5 12l7-7 7 7"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    paperclip: '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
    chevR: '<path d="M9 6l6 6-6 6"/>',
    chevD: '<path d="M6 9l6 6 6-6"/>',
    chevL: '<path d="M15 6l-6 6 6 6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
    moon: '<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.5 6.5 0 0 0 9.8 9.8z"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    handoff: '<path d="M8 7h8a3 3 0 0 1 3 3v4"/><path d="M16 11l3 3 3-3"/><path d="M5 4v6a3 3 0 0 0 3 3h3"/>',
    voice: '<path d="M4 10v4M8 6v12M12 3v18M16 6v12M20 10v4"/>',
    // task / activity verbs
    research: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.2-4.2"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M8 13h8M8 17h5"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 14l3-3 3 2 5-6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 3v3M16 3v3"/>',
    sheet: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    slack: '<rect x="4" y="13" width="3.4" height="7" rx="1.7"/><rect x="13" y="16.6" width="7" height="3.4" rx="1.7"/><rect x="16.6" y="4" width="3.4" height="7" rx="1.7"/><rect x="4" y="4" width="7" height="3.4" rx="1.7"/>',
    crm: '<path d="M3 21V8l9-5 9 5v13"/><path d="M3 21h18M9 21v-6h6v6"/>',
    shield: '<path d="M12 2 4 5.5V11c0 5 3.4 7.8 8 9 4.6-1.2 8-4 8-9V5.5z"/><path d="M9 12l2 2 4-4"/>',
    sparkle: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/>',
    pen: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bolt: '<path d="M13 2 4.5 12.5a.6.6 0 0 0 .46 1H11l-1 8.5 8.5-10.5a.6.6 0 0 0-.46-1H12z"/>',
    gauge: '<path d="M12 14 9 9"/><circle cx="12" cy="13" r="9"/><path d="M3 13h2M19 13h2M12 4v2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
    spark: '<path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    brain: '<path d="M8.5 3A3.5 3.5 0 0 0 5 6.5 3 3 0 0 0 4 12a3 3 0 0 0 1.5 5.5A3 3 0 0 0 11 19V4.5A1.5 1.5 0 0 0 9.5 3z"/><path d="M15.5 3A3.5 3.5 0 0 1 19 6.5 3 3 0 0 1 20 12a3 3 0 0 1-1.5 5.5A3 3 0 0 1 13 19V4.5A1.5 1.5 0 0 1 14.5 3z"/>',
    trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5M5 21h14"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    play: '<path d="M7 4.5v15l13-7.5z"/>',
    link: '<path d="M9 15 4.5 19.5a3 3 0 0 1-4-4L5 11"/><path d="M15 9l4.5-4.5a3 3 0 0 1 4 4L19 13"/><path d="M9.5 14.5 14.5 9.5"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    flag: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>',
    phone: '<path d="M5 4h3.5l1.8 4.5-2.2 1.6a11 11 0 0 0 5 5l1.6-2.2L19 18.5V21a1 1 0 0 1-1.1 1A16 16 0 0 1 3 7 1 1 0 0 1 4 5.9z"/>',
    bubble: '<path d="M21 12a8 8 0 0 1-11.7 7.1L4 20.5l1.4-5.2A8 8 0 1 1 21 12z"/>',
    plane: '<path d="M21.5 3 2.5 10.4l6.3 2.4m12.7-9.8-9.2 17.6-2.7-7.4m11.9-10.2L8.8 12.8"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M7.5 7.5a6 6 0 0 0 0 9M16.5 7.5a6 6 0 0 1 0 9M4.5 4.5a10 10 0 0 0 0 15M19.5 4.5a10 10 0 0 1 0 15"/>',
    inbox: '<path d="M4 13h4l1.5 3h5L16 13h4"/><path d="M4 13 6 5h12l2 8v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
    kanban: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v12M15 3v7"/>',
    grip: '<circle cx="9" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="15" cy="18" r="1.3"/>',
    deck: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    activity: '<path d="M3 12h4l2.5 7 5-14L17 12h4"/>',
    book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 18.5z"/><path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H20"/>',
    versions: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M6 8.5v7"/><path d="M18 8.5a3 3 0 0 0-3-3h-3l2-2m-2 2 2 2"/><circle cx="18" cy="6" r="2.5"/>',
    diff: '<path d="M12 4v6M9 7h6M5 17h6M16 4 8 20"/>',
  };

  const HUES = {
    rose: 'var(--c-rose)', amber: 'var(--c-amber)', sage: 'var(--c-sage)',
    teal: 'var(--c-teal)', blue: 'var(--c-blue)', violet: 'var(--c-violet)',
  };
  function grad(hue) { return `linear-gradient(150deg, color-mix(in srgb, ${hue} 78%, white 8%), ${hue})`; }

  // ---- COWORKERS (OpenCode agent configs) ----
  // mode: 'primary' = you can talk to them directly (Build/Plan); 'subagent' = a
  // specialist that others delegate to via the `task` tool. builtin = ships with
  // the product (code-owned); custom = saved by the user. model/temperature/steps
  // are real OpenCode AgentConfig inference overrides.
  const COWORKERS = [
    { id: 'cleo', name: 'Cleo', role: 'Chief of Staff', initials: 'CL', hue: HUES.violet,
      mode: 'primary', builtin: true, agentId: 'chief-of-staff', orchestrator: true,
      bio: 'Turns a People objective into concrete, specced tasks, then brings in the right coworkers to deliver each one — and keeps the whole plan moving.',
      model: 'anthropic/claude-sonnet-4', modelLabel: 'Claude Sonnet', temperature: 0.35, steps: 40,
      abilities: ['outline', 'summarize'], connections: ['docs'], jobs: 51 },
    { id: 'maya', name: 'Nova', role: 'Talent Research', initials: 'NV', hue: HUES.teal,
      mode: 'primary', builtin: false,
      bio: 'Researches talent markets, benchmarks and candidates, and hands back a tidy, cited brief.',
      model: 'anthropic/claude-sonnet-4', modelLabel: 'Claude Sonnet', temperature: 0.30, steps: 24,
      abilities: ['summarize', 'fact-check', 'cite'], connections: ['web', 'docs'], jobs: 128 },
    { id: 'theo', name: 'Lyra', role: 'People Comms', initials: 'LY', hue: HUES.amber,
      mode: 'primary', builtin: false,
      bio: 'Turns rough notes into clear policies, offer letters and team announcements — in Northwind\u2019 voice.',
      model: 'anthropic/claude-sonnet-4', modelLabel: 'Claude Sonnet', temperature: 0.65, steps: 16,
      abilities: ['draft', 'outline', 'tone'], connections: ['docs', 'mail'], jobs: 96 },
    { id: 'ada', name: 'Vega', role: 'People Analytics', initials: 'VG', hue: HUES.blue,
      mode: 'subagent', builtin: false,
      bio: 'Pulls headcount, attrition and engagement numbers from the HRIS and explains what they mean.',
      model: 'openai/gpt-frontier', modelLabel: 'GPT (frontier)', temperature: 0.20, steps: 20,
      abilities: ['chart', 'summarize'], connections: ['hris', 'sheets'], jobs: 74 },
    { id: 'sol', name: 'Atlas', role: 'Generalist', initials: 'AT', hue: HUES.sage,
      mode: 'primary', builtin: true, agentId: 'build', isDefault: true,
      bio: 'The all-rounder that ships the work — drafts, edits and runs People tasks end to end. Your default coworker for most jobs.',
      model: 'anthropic/claude-sonnet-4', modelLabel: 'Claude Sonnet', temperature: 0.40, steps: 30,
      abilities: ['summarize', 'draft'], connections: ['mail', 'calendar', 'docs'], jobs: 212 },
    { id: 'piper', name: 'Sage', role: 'Planner', initials: 'SG', hue: HUES.blue,
      mode: 'primary', builtin: true, agentId: 'plan', readonly: true,
      bio: 'Thinks an approach through and writes a clear plan before anything changes. Read-only — it never edits your files.',
      model: 'anthropic/claude-sonnet-4', modelLabel: 'Claude Sonnet', temperature: 0.30, steps: 24,
      abilities: ['outline', 'summarize'], connections: ['web', 'docs'], jobs: 64 },
    { id: 'rex', name: 'Blaze', role: 'HR Operations', initials: 'BZ', hue: HUES.rose,
      mode: 'subagent', builtin: false,
      bio: 'Keeps an eye on cases and onboarding, flags what needs attention, and writes the recap.',
      model: 'openai/gpt-mini', modelLabel: 'GPT (mini)', temperature: 0.30, steps: 18,
      abilities: ['fact-check', 'summarize'], connections: ['slack', 'hris'], jobs: 41 },
    { id: 'iris', name: 'Astra', role: 'L&D Designer', initials: 'AS', hue: HUES.violet,
      mode: 'subagent', builtin: false,
      bio: 'Shapes training decks, onboarding guides and one-pagers from a brief into something on-brand.',
      model: 'google/gemini-pro', modelLabel: 'Gemini Pro', temperature: 0.70, steps: 20,
      abilities: ['outline', 'chart'], connections: ['docs'], jobs: 58 },
  ];

  const MODE_LABEL = { primary: 'Lead', subagent: 'Specialist' };
  const MODE_DESC = {
    primary: 'You can talk to them directly in a conversation.',
    subagent: 'A specialist other coworkers delegate to.',
  };

  // ---- ABILITIES (skills) ----
  const ABILITIES = [
    { id: 'summarize', name: 'Summarize', icon: 'doc', cat: 'Everyday', hue: HUES.teal,
      desc: 'Condense long policies, survey results or case notes into the essentials.', used: 5 },
    { id: 'draft', name: 'Write a draft', icon: 'pen', cat: 'Writing', hue: HUES.amber,
      desc: 'Produce a first draft of a policy, offer letter or announcement from a short brief.', used: 4 },
    { id: 'fact-check', name: 'Policy-check', icon: 'shield', cat: 'Compliance', hue: HUES.sage,
      desc: 'Check guidance against Northwind policy and local labour law before it goes out.', used: 3 },
    { id: 'cite', name: 'Build citations', icon: 'flag', cat: 'Compliance', hue: HUES.blue,
      desc: 'Collect and format policy and regulation sources with links and dates.', used: 2 },
    { id: 'outline', name: 'Outline', icon: 'playbook', cat: 'Writing', hue: HUES.violet,
      desc: 'Structure a policy, programme or document before drafting begins.', used: 4 },
    { id: 'chart', name: 'Make a chart', icon: 'chart', cat: 'People Data', hue: HUES.rose,
      desc: 'Pick the clearest chart for headcount, attrition or engagement data.', used: 3 },
    { id: 'tone', name: 'Match our tone', icon: 'sparkle', cat: 'Writing', hue: HUES.amber,
      desc: 'Rewrite text to sound like Northwind People comms, from a few samples.', used: 2 },
  ];

  // ---- CONNECTIONS (tools) ----
  const CONNECTIONS = [
    { id: 'hris', name: 'HRIS', icon: 'team', kind: 'Workday · People data', hue: HUES.teal, connected: true, scope: 'Read' },
    { id: 'ats', name: 'Recruiting (ATS)', icon: 'compass', kind: 'Greenhouse', hue: HUES.blue, connected: true, scope: 'Read & update' },
    { id: 'mail', name: 'Email', icon: 'mail', kind: 'Gmail · Outlook', hue: HUES.rose, connected: true, scope: 'Read & draft' },
    { id: 'calendar', name: 'Calendar', icon: 'calendar', kind: 'Google · Microsoft', hue: HUES.amber, connected: true, scope: 'Read & schedule' },
    { id: 'sheets', name: 'Spreadsheets', icon: 'sheet', kind: 'Google Sheets · Excel', hue: HUES.sage, connected: true, scope: 'Read' },
    { id: 'docs', name: 'Documents', icon: 'folder', kind: 'Drive · Notion', hue: HUES.blue, connected: true, scope: 'Read & write' },
    { id: 'web', name: 'Web Search', icon: 'web', kind: 'Live internet', hue: HUES.teal, connected: true, scope: 'Read' },
    { id: 'slack', name: 'Slack', icon: 'slack', kind: 'Messaging', hue: HUES.violet, connected: true, scope: 'Read & post' },
    { id: 'survey', name: 'Engagement surveys', icon: 'chart', kind: 'Culture Amp', hue: HUES.amber, connected: false, scope: '—' },
  ];

  // ---- PLAYBOOKS (workflows) ----
  // trigger: 'schedule' | 'webhook' | 'manual'. agent = execution agent id.
  const PLAYBOOKS = [
    { id: 'p1', name: 'Weekly hiring pipeline', icon: 'chart', hue: HUES.blue, runs: 27,
      desc: 'Every Monday, pull the recruiting funnel, flag stuck candidates and post a summary to #people.',
      steps: ['Vega pulls the funnel', 'Vega charts stage conversion', 'Lyra writes the recap', 'Posted to #people'],
      schedule: 'Weekly · Mon 8am', trigger: 'schedule', agent: 'ada', status: 'active', lastRun: 'Mon \u00b7 summary posted to #people' },
    { id: 'p2', name: 'New-hire onboarding', icon: 'sparkle', hue: HUES.sage, runs: 86,
      desc: 'When an offer is accepted, set up the 30-day onboarding plan and notify the manager.',
      steps: ['Blaze reads the new hire record', 'Atlas builds the 30-day plan', 'Lyra drafts the welcome note', 'Manager notified'],
      schedule: 'On offer accepted', trigger: 'webhook', agent: 'sol', status: 'active', lastRun: '3h ago \u00b7 onboarding set for 2 hires' },
    { id: 'p3', name: 'Monthly attrition report', icon: 'doc', hue: HUES.rose, runs: 14,
      desc: 'On the 1st, pull leavers, compute attrition by team and draft the People leadership update.',
      steps: ['Vega pulls leavers', 'Vega computes attrition by team', 'Lyra drafts the update'],
      schedule: 'Monthly · 1st', trigger: 'schedule', agent: 'ada', status: 'active', lastRun: '1 Jun \u00b7 report ready for review' },
    { id: 'p4', name: 'Policy refresh', icon: 'shield', hue: HUES.amber, runs: 9,
      desc: 'From a policy and a jurisdiction, produce an updated draft checked against local law.',
      steps: ['Nova researches local law', 'Lyra drafts the update', 'Nova policy-checks the result'],
      schedule: 'On demand', trigger: 'manual', agent: 'theo', status: 'paused', lastRun: 'Paused' },
  ];

  // ---- ROLES (agentStarterTemplates) — prefill real AgentConfig fields ----
  const ROLES = [
    { id: 'assistant', name: 'People Assistant', icon: 'sparkle', hue: HUES.sage, desc: 'Everyday help & quick tasks', mode: 'primary',
      instructions: 'You are a helpful People-team assistant. Handle scheduling, reminders, quick lookups and inbox triage for HR. Keep replies short and action-oriented; ask before doing anything irreversible or touching employee data.',
      skills: ['summarize', 'draft'], tools: ['mail', 'calendar'], temperature: 0.40, steps: 12 },
    { id: 'researcher', name: 'Talent Researcher', icon: 'compass', hue: HUES.teal, desc: 'Markets, benchmarks & candidates', mode: 'primary',
      instructions: 'You are a talent research assistant. Gather trustworthy sources on talent markets, comp benchmarks and candidates, cross-check the key facts, and hand back a concise, cited brief. Lead with the answer, then the evidence.',
      skills: ['summarize', 'fact-check', 'cite'], tools: ['web', 'docs'], temperature: 0.30, steps: 24 },
    { id: 'writer', name: 'People Comms', icon: 'pen', hue: HUES.amber, desc: 'Policies & announcements', mode: 'primary',
      instructions: 'You write for the People team. Turn notes and briefs into clear policies, offer letters and announcements in Northwind\u2019 voice. Outline first, then draft. Never send anything without explicit approval.',
      skills: ['draft', 'outline', 'tone'], tools: ['docs', 'mail'], temperature: 0.65, steps: 16 },
    { id: 'analyst', name: 'People Analyst', icon: 'chart', hue: HUES.blue, desc: 'Headcount, attrition & engagement', mode: 'subagent',
      instructions: 'You are a people-analytics coworker. Pull figures from the HRIS and surveys, choose the clearest chart, and explain what changed. Always show your sources and never expose individual employee records.',
      skills: ['chart', 'summarize'], tools: ['hris', 'sheets'], temperature: 0.20, steps: 20 },
    { id: 'operations', name: 'HR Operations', icon: 'gauge', hue: HUES.rose, desc: 'Cases & onboarding', mode: 'subagent',
      instructions: 'You are an HR operations coworker. Watch cases and onboarding for things that need attention, classify them, and write clear recaps. Flag anything sensitive or urgent rather than acting on it.',
      skills: ['fact-check', 'summarize'], tools: ['slack', 'hris'], temperature: 0.30, steps: 18 },
    { id: 'designer', name: 'L&D Designer', icon: 'spark', hue: HUES.violet, desc: 'Training & onboarding decks', mode: 'subagent',
      instructions: 'You design learning materials. Shape briefs into on-brand training decks, onboarding guides and one-pagers. Propose a structure first, then produce the artifact for review.',
      skills: ['outline', 'chart'], tools: ['docs'], temperature: 0.70, steps: 20 },
  ];

  // ---- PROVIDERS / BRAINS ----
  const PROVIDERS = [
    { id: 'anthropic', name: 'Anthropic', initials: 'AN', hue: HUES.amber, connected: true,
      models: [
        { id: 'opus', name: 'Claude Opus', desc: 'Deepest thinking, slower', ctx: '200K', rec: false },
        { id: 'sonnet', name: 'Claude Sonnet', desc: 'Best all-rounder', ctx: '200K', rec: true },
        { id: 'haiku', name: 'Claude Haiku', desc: 'Fast & light', ctx: '200K', rec: false },
      ] },
    { id: 'openai', name: 'OpenAI', initials: 'OA', hue: HUES.sage, connected: true,
      models: [
        { id: 'frontier', name: 'GPT (frontier)', desc: 'Strong reasoning', ctx: '400K', rec: true },
        { id: 'mini', name: 'GPT (mini)', desc: 'Quick & affordable', ctx: '128K', rec: false },
      ] },
    { id: 'google', name: 'Google', initials: 'GO', hue: HUES.blue, connected: true,
      models: [{ id: 'gemini', name: 'Gemini Pro', desc: 'Great with long context', ctx: '1M', rec: false }] },
    { id: 'local', name: 'On your computer', initials: 'PC', hue: HUES.teal, connected: false, models: [] },
  ];

  // ---- PROJECTS + THREADS (sidebar) ----
  // A Project is a coordination container (an objective) — distinct from a
  // local project directory. It holds tasks (kanban), conversations (threads),
  // an assigned team, and a status. Sandbox is loose, ad-hoc work.
  const PROJECTS = [
    { id: 'sandbox', name: 'Quick chats', kind: 'sandbox', path: 'Sandbox · outputs saved as artifacts',
      threads: [
        { id: 't1', title: 'Draft the parental leave update', tm: 'now' },
        { id: 't2', title: 'Summarize the engagement survey', tm: '2h' } ] },
    { id: 'engagement', name: 'Engagement 2026', kind: 'project', path: 'People · Engagement',
      objective: 'Run the Q2 engagement survey across Northwind and turn the results into a clear action plan for leadership.',
      status: 'active', team: ['cleo', 'ada', 'maya', 'theo', 'iris'],
      threads: [
        { id: 't3', title: 'Engagement scores by business unit', tm: '3h' },
        { id: 't4', title: 'Manager talking points', tm: '1d' } ],
      tasks: [
        { id: 'bt1', title: 'Pull engagement results from Culture Amp', col: 'done', assignee: 'ada', priority: 'med',
          spec: 'Pull eNPS, participation and driver scores by business unit. Output a clean table with vs-last-cycle deltas.' },
        { id: 'bt2', title: 'Sanity-check the cuts', col: 'done', assignee: 'maya', priority: 'med',
          spec: 'Cross-check the headline scores against the raw export; note any small-sample teams to suppress.' },
        { id: 'bt3', title: 'Draft the leadership readout', col: 'review', assignee: 'theo', priority: 'high',
          spec: 'Write the People-leadership update in Northwind tone. Lead with the result, then the 3 priority drivers. ~400 words.' },
        { id: 'bt4', title: 'Design the results one-pager', col: 'doing', assignee: 'iris', priority: 'med',
          spec: 'Turn the scores + narrative into an on-brand one-pager with the by-BU chart.' },
        { id: 'bt5', title: 'Prep manager talking points', col: 'planning', assignee: 'theo', priority: 'low',
          spec: 'Three crisp talking points and likely questions for managers cascading results to teams.' },
        { id: 'bt6', title: 'Schedule the leadership readout', col: 'backlog', assignee: null, priority: 'low',
          spec: 'Find a 30-min slot with the People leadership team next week and send invites.' } ] },
    { id: 'grad', name: 'Graduate Hiring 2026', kind: 'project', path: 'Talent · Early Careers',
      objective: 'Run the 2026 graduate hiring round — refresh the funnel, sharpen the careers pack, and prep interviewers.',
      status: 'active', team: ['cleo', 'maya', 'theo', 'ada'],
      threads: [
        { id: 't5', title: 'Benchmark: grad comp in NL & ZA', tm: '1d' },
        { id: 't6', title: 'Draft the careers-page copy', tm: '2d' } ],
      tasks: [
        { id: 'nt1', title: 'Benchmark graduate comp', col: 'done', assignee: 'maya', priority: 'high',
          spec: 'Market ranges for grad roles in Amsterdam and Cape Town, with sources and dates. Cited brief.' },
        { id: 'nt2', title: 'Policy-check the offer terms', col: 'done', assignee: 'maya', priority: 'med',
          spec: 'Verify the proposed grad offer terms against local labour law before they inform the pack.' },
        { id: 'nt3', title: 'Draft the careers-page copy', col: 'review', assignee: 'theo', priority: 'high',
          spec: 'Warm, specific early-careers copy. One clear value prop, one clear call to apply.' },
        { id: 'nt4', title: 'Build the interviewer guide', col: 'doing', assignee: 'theo', priority: 'med',
          spec: 'Structure the interview kit: competencies, questions, scoring rubric, do/don\u2019t.' },
        { id: 'nt5', title: 'Funnel target scenarios', col: 'backlog', assignee: 'ada', priority: 'med',
          spec: 'Three pipeline scenarios with conversion assumptions to hit 40 grad hires.' } ] },
  ];

  // ---- TASK BOARD (kanban) ----
  const TASK_COLUMNS = [
    { id: 'backlog', label: 'Backlog' },
    { id: 'planning', label: 'Planning' },
    { id: 'doing', label: 'In progress' },
    { id: 'review', label: 'Review' },
    { id: 'done', label: 'Done' },
  ];
  const TASK_PRIORITY = { high: 'High', med: 'Medium', low: 'Low' };
  // What the Chief of Staff proposes when planning a fresh objective.
  const PLAN_TEMPLATE = [
    { title: 'Research the landscape', assignee: 'maya', priority: 'high',
      spec: 'Gather context, benchmarks and policy constraints. Hand back a short, cited brief.' },
    { title: 'Define success criteria', assignee: 'cleo', priority: 'med',
      spec: 'Write down what "done" looks like — concrete, measurable People outcomes to aim for.' },
    { title: 'Draft a first version', assignee: 'theo', priority: 'med',
      spec: 'Produce a first draft / one-pager from the brief for the team to react to.' },
    { title: 'Review & refine', assignee: null, priority: 'med',
      spec: 'You review the draft, leave notes, and the team refines to the spec.' },
  ];


  // ---- PERMISSIONS (OpenCode-native) ----
  // Each maps to a real OpenCode permission key. Default is allow | ask | deny.
  // Rules are glob patterns evaluated last-match-wins, overriding the default.
  const PERMISSIONS = [
    { id: 'bash', key: 'bash', name: 'Run commands', icon: 'gauge',
      desc: 'Shell commands on the computer', patternHint: 'command pattern — e.g. git *, npm *, rm *',
      default: 'ask', rules: [['git *', 'allow'], ['rm *', 'deny']] },
    { id: 'edit', key: 'edit', name: 'Edit & create files', icon: 'pen',
      desc: 'Write to files in the project', patternHint: 'file path — e.g. *.env, secrets/*',
      default: 'allow', rules: [['*.env', 'deny']] },
    { id: 'read', key: 'read', name: 'Read files', icon: 'doc',
      desc: 'Open files in the project', patternHint: 'file path',
      default: 'allow', rules: [] },
    { id: 'webfetch', key: 'webfetch', name: 'Open web pages', icon: 'web',
      desc: 'Fetch a page or URL', patternHint: 'domain / URL',
      default: 'ask', rules: [] },
    { id: 'websearch', key: 'websearch', name: 'Search the web', icon: 'search',
      desc: 'Run a web search', patternHint: 'query',
      default: 'allow', rules: [] },
    { id: 'task', key: 'task', name: 'Delegate to other coworkers', icon: 'handoff',
      desc: 'Hand parts of a job to specialist coworkers', patternHint: 'coworker / subagent name',
      default: 'allow', rules: [] },
    { id: 'external_directory', key: 'external_directory', name: 'Files outside the project', icon: 'folder',
      desc: 'Folders beyond this project directory', patternHint: 'path',
      default: 'ask', rules: [] },
  ];
  const PERM_OPTS = [['allow', 'On their own'], ['ask', 'Ask me first'], ['deny', 'Never']];

  // ---- CHANNELS (Gateway) ----
  // Connect chat apps so people can message the team on the move. Maps to the
  // gateway channel providers (telegram, whatsapp, slack, discord, signal,
  // email, webhook). Each binding has identities (people) with a role.
  const CHANNELS = [
    { id: 'whatsapp', name: 'WhatsApp', icon: 'phone', hue: HUES.sage, connected: true,
      handle: '+31 6 ···· 0142', summary: 'Message the team like any contact' },
    { id: 'telegram', name: 'Telegram', icon: 'plane', hue: HUES.blue, connected: true,
      handle: '@northwind_people_bot', summary: 'Bot you can DM or add to a group' },
    { id: 'slack', name: 'Slack', icon: 'slack', hue: HUES.violet, connected: true,
      handle: '#people · Northwind', summary: 'Mention the team in any channel' },
    { id: 'email', name: 'Email', icon: 'mail', hue: HUES.rose, connected: false,
      handle: 'people@northwind.com', summary: 'Email the team, get replies back' },
    { id: 'discord', name: 'Discord', icon: 'bubble', hue: HUES.blue, connected: false,
      handle: '', summary: 'Add the bot to your server' },
    { id: 'signal', name: 'Signal', icon: 'shield', hue: HUES.teal, connected: false,
      handle: '', summary: 'Private, end-to-end encrypted' },
    { id: 'webhook', name: 'Webhook', icon: 'link', hue: HUES.amber, connected: false,
      handle: '', summary: 'Bridge a custom app or tool' },
  ];

  // roles map to gateway identity roles
  const CHANNEL_ROLES = {
    owner: 'Owner', admin: 'Admin', member: 'Member', approver: 'Approver', viewer: 'Viewer',
  };
  const CHANNEL_ROLE_DESC = {
    owner: 'Full control · prompt, approve, manage people',
    admin: 'Prompt, approve, manage people',
    member: 'Can start work from their channel',
    approver: 'Can approve & answer, but not start work',
    viewer: 'Can watch progress only',
  };
  const PEOPLE = [
    { name: 'Gustavo Lemos', initials: 'GL', hue: HUES.blue, via: 'whatsapp', handle: '+31 6 ···· 0142', role: 'owner' },
    { name: 'Priya Shah', initials: 'PS', hue: HUES.rose, via: 'telegram', handle: '@priyas', role: 'admin' },
    { name: 'Marco Reyes', initials: 'MR', hue: HUES.amber, via: 'slack', handle: '@marco', role: 'member' },
    { name: 'Dana Lee', initials: 'DL', hue: HUES.sage, via: 'slack', handle: '@dana', role: 'approver' },
    { name: 'Sam Okoro', initials: 'SO', hue: HUES.violet, via: 'whatsapp', handle: '+44 7··· ···891', role: 'viewer' },
  ];

  // ---- ARTIFACTS (durable outputs of project/task/session work) ----
  const ARTIFACTS = [
    { id: 'ar1', name: 'Engagement leadership readout', kind: 'Document', icon: 'doc', hue: HUES.amber,
      project: 'engagement', task: 'bt3', by: 'theo', when: '12m ago', size: '3 pages', status: 'review' },
    { id: 'ar2', name: 'Engagement by business unit', kind: 'Chart', icon: 'chart', hue: HUES.blue,
      project: 'engagement', task: 'bt1', by: 'ada', when: '1h ago', size: 'Vega-Lite', status: 'final' },
    { id: 'ar3', name: 'Engagement results one-pager', kind: 'Deck', icon: 'deck', hue: HUES.violet,
      project: 'engagement', task: 'bt4', by: 'iris', when: 'just now', size: '1 slide', status: 'draft' },
    { id: 'ar4', name: 'Graduate comp benchmark', kind: 'Document', icon: 'doc', hue: HUES.teal,
      project: 'grad', task: 'nt1', by: 'maya', when: '1d ago', size: '5 pages', status: 'final' },
    { id: 'ar5', name: 'Engagement scores', kind: 'Spreadsheet', icon: 'sheet', hue: HUES.sage,
      project: 'engagement', task: 'bt1', by: 'ada', when: '1h ago', size: '2 tabs', status: 'final' },
    { id: 'ar6', name: 'Careers-page copy', kind: 'Draft', icon: 'mail', hue: HUES.rose,
      project: 'grad', task: 'nt3', by: 'theo', when: '2d ago', size: 'awaiting approval', status: 'review' },
  ];

  // ---- SCHEDULES (time triggers that start runs) ----
  const SCHEDULES = [
    { id: 'sc1', name: 'Weekly hiring pipeline', cadence: 'Weekly · Mon 8:00', next: 'Mon, 8:00am', playbook: 'p1', agent: 'ada', status: 'active' },
    { id: 'sc2', name: 'New-hire onboarding', cadence: 'On offer accepted', next: 'on trigger', playbook: 'p2', agent: 'sol', status: 'active' },
    { id: 'sc3', name: 'Monthly attrition report', cadence: 'Monthly · 1st', next: 'Jul 1', playbook: 'p3', agent: 'ada', status: 'active' },
    { id: 'sc4', name: 'Quarterly comp-equity scan', cadence: 'Quarterly', next: 'paused', playbook: null, agent: 'rex', status: 'paused' },
  ];

  // ---- WATCHES (delivery subscriptions — push progress to a channel) ----
  const WATCHES = [
    { id: 'wt1', target: 'Engagement 2026', kind: 'Project', via: 'slack', events: 'Task moves & reviews', who: 'You' },
    { id: 'wt2', target: 'Draft the parental leave update', kind: 'Conversation', via: 'whatsapp', events: 'When it needs me', who: 'You' },
    { id: 'wt3', target: 'Weekly hiring pipeline', kind: 'Playbook', via: 'telegram', events: 'Each run finishes', who: 'You' },
    { id: 'wt4', target: 'Graduate Hiring 2026', kind: 'Project', via: 'slack', events: 'Daily summary', who: 'Priya Shah' },
  ];

  // ---- APPROVALS (questions + permission requests waiting on a human) ----
  const APPROVALS = [
    { id: 'ap1', kind: 'permission', who: 'sol', permKey: 'edit', detail: 'Update onboarding plan in Workday for 2 new hires',
      thread: 'New-hire onboarding', when: '2m', via: 'whatsapp' },
    { id: 'ap2', kind: 'question', who: 'maya',
      detail: 'Should the graduate comp benchmark cover Amsterdam and Cape Town only, or all EU hubs?',
      thread: 'Benchmark: grad comp in NL & ZA', when: '8m', via: 'telegram',
      options: ['NL & ZA only', 'All EU hubs'] },
    { id: 'ap3', kind: 'permission', who: 'theo', permKey: 'send', detail: 'Send the engagement readout to People leadership',
      thread: 'Draft the leadership readout', when: '15m', via: 'slack' },
    { id: 'ap4', kind: 'permission', who: 'ada', permKey: 'edit', detail: 'Overwrite engagement-scores.xlsx with cleaned data',
      thread: 'Engagement scores by business unit', when: '22m', via: null },
  ];

  // ---- KNOWLEDGE (OpenWiki) ----
  // Git-backed, versioned, permissioned. Humans & agents use the same
  // read -> propose -> review -> accept workflow. Spaces are permission
  // boundaries; every page is versioned and every change is auditable.
  const SPACES = [
    { id: 'company', name: 'Company', icon: 'globe', hue: HUES.teal, visibility: 'company', role: 'Reader' },
    { id: 'peopleops', name: 'People Ops', icon: 'team', hue: HUES.blue, visibility: 'team', role: 'Maintainer' },
    { id: 'talent', name: 'Talent', icon: 'compass', hue: HUES.amber, visibility: 'team', role: 'Maintainer' },
    { id: 'comp', name: 'Comp & Benefits', icon: 'gauge', hue: HUES.violet, visibility: 'team', role: 'Contributor' },
    { id: 'engagement', name: 'Engagement 2026', icon: 'kanban', hue: HUES.rose, visibility: 'private', role: 'Maintainer' },
  ];
  const SPACE_VIS = {
    company: { label: 'Company-wide', icon: 'globe' },
    team: { label: 'Team', icon: 'team' },
    private: { label: 'Private', icon: 'lock' },
  };
  const WIKI_PAGES = [
    { id: 'wp1', space: 'peopleops', title: 'Parental leave policy', updatedBy: 'maya', updated: '1d ago', version: 7,
      links: [{ kind: 'thread', label: 'Draft the parental leave update' }, { kind: 'task', label: 'Policy-check the offer terms' }, { kind: 'artifact', label: 'Careers-page copy' }],
      body: [
        { type: 'callout', text: 'Source of truth for parental leave across Northwind. Maintained by People Ops; checked against local law before each change.' },
        { type: 'h', text: 'Entitlement' },
        { type: 'p', text: 'All employees get 16 weeks fully paid leave for the primary caregiver and 8 weeks for the secondary caregiver, regardless of gender or how they became a parent.' },
        { type: 'h', text: 'How it works' },
        { type: 'list', items: ['Eligible from day one — no minimum tenure', 'Can be taken flexibly within the first 12 months', 'Local top-ups apply in NL and ZA'] },
        { type: 'h', text: 'Recent change' },
        { type: 'p', text: 'Removed the 6-month tenure requirement following the H1 policy review. Verified against Dutch and South African statutory minimums.' },
      ] },
    { id: 'wp2', space: 'engagement', title: 'Engagement 2026 — source of truth', updatedBy: 'ada', updated: '1h ago', version: 12,
      links: [{ kind: 'task', label: 'Sanity-check the cuts' }, { kind: 'artifact', label: 'Engagement scores' }, { kind: 'artifact', label: 'Engagement by business unit' }],
      body: [
        { type: 'callout', text: 'The verified scores behind the engagement readout. Any figure used with leadership must trace back to this page.' },
        { type: 'h', text: 'Headline scores (verified)' },
        { type: 'list', items: ['eNPS +22, up 6 vs last cycle', 'Participation 84%', 'Top driver: career growth (−4)'] },
        { type: 'h', text: 'Notes' },
        { type: 'p', text: 'Teams under 5 respondents suppressed to protect anonymity. One footnote added by Nova on the Cape Town hub.' },
      ] },
    { id: 'wp3', space: 'company', title: 'How the People team works', updatedBy: 'you', updated: '5d ago', version: 23,
      links: [],
      body: [
        { type: 'h', text: 'The loop' },
        { type: 'p', text: 'Objectives become projects. Cleo plans them into tasks. Coworkers do the work and produce artifacts. You review. What we learn lands back here as policy and playbooks.' },
        { type: 'h', text: 'Principles' },
        { type: 'list', items: ['Nothing affecting an employee ships without a human review', 'Every figure traces to the HRIS or survey', 'Capture decisions where the next person will look'] },
      ] },
    { id: 'wp4', space: 'comp', title: 'Pay & levelling framework', updatedBy: 'you', updated: '2h ago', version: 9, links: [],
      body: [{ type: 'h', text: 'Levels' }, { type: 'p', text: 'Five career levels per track. Anchor pay to the market median for the hub; deviate only with a documented reason and People-leadership sign-off.' }] },
    { id: 'wp5', space: 'talent', title: 'Interviewing principles', updatedBy: 'iris', updated: '3d ago', version: 5, links: [],
      body: [{ type: 'h', text: 'What we believe' }, { type: 'list', items: ['Structured beats gut-feel', 'Same rubric for every candidate', 'Decide on evidence, not rapport'] }] },
    { id: 'wp6', space: 'peopleops', title: 'Onboarding checklist', updatedBy: 'rex', updated: '1d ago', version: 18, links: [{ kind: 'task', label: 'Build the 30-day plan' }],
      body: [{ type: 'h', text: 'Before day one' }, { type: 'list', items: ['Workday record complete', 'Laptop & accounts provisioned', 'Buddy assigned', '30-day plan shared with manager'] }] },
  ];
  const WIKI_PROPOSALS = [
    { id: 'pr1', pageTitle: 'Parental leave policy', space: 'peopleops', by: 'maya', when: '12m ago',
      summary: 'Remove the 6-month tenure requirement and add the NL & ZA statutory top-ups.', add: 24, del: 3 },
    { id: 'pr2', pageTitle: 'Engagement 2026 — source of truth', space: 'engagement', by: 'ada', when: '1h ago',
      summary: 'Correct eNPS to the verified +22 and cite the Culture Amp export.', add: 6, del: 6 },
    { id: 'pr3', pageTitle: 'Pay & levelling framework', space: 'comp', by: 'you', when: '2h ago',
      summary: 'Add the graduate band and the hub-median anchoring rule.', add: 40, del: 2 },
    { id: 'pr4', pageTitle: 'Onboarding checklist', space: 'peopleops', by: 'rex', when: '1d ago',
      summary: 'Add a buddy-assignment step before day one.', add: 8, del: 0 },
  ];

  // ---- SUGGESTIONS (home) ----
  const SUGGESTIONS = [
    { icon: 'compass', hue: HUES.teal, t: 'Benchmark a role', d: 'Pull market comp for graduate engineers in Amsterdam and Cape Town.', by: 'maya' },
    { icon: 'chart', hue: HUES.blue, t: 'Explain the engagement scores', d: 'Chart eNPS by business unit and tell me what changed.', by: 'ada' },
    { icon: 'pen', hue: HUES.amber, t: 'Draft a policy update', d: 'Write the parental leave change in Northwind tone for review.', by: 'theo' },
    { icon: 'mail', hue: HUES.sage, t: 'Clear my inbox', d: 'Sort this morning\u2019s People inbox and draft the easy replies.', by: 'sol' },
  ];

  // ---- A SAMPLE CONVERSATION (the signature screen) ----
  // Reframed: outcomes & human language, nested delegation, live + done states.
  const CONVO = {
    title: 'Draft the leadership readout',
    userMsg: 'Refresh our engagement readout for the People leadership — pull the latest scores, double-check the cuts, and write it up in our usual tone. I\u2019ll review before it goes out.',
    leadId: 'theo',
    intro: 'On it. I\u2019ll get Vega to pull and chart the scores and Nova to sanity-check the cuts, then write the readout in your voice for you to review.',
    lanes: [
      { who: 'ada', task: 'Pull and chart the Q3 numbers', state: 'done', time: '38s', delegatedBy: 'theo',
        result: 'eNPS +22, up 6 vs last cycle; participation 84%. Chart ready.',
        activity: [
          { icon: 'sheet', verb: 'Opened', obj: 'Culture Amp export', rt: '2s', done: true },
          { icon: 'chart', verb: 'Built', obj: 'engagement-by-BU chart', rt: '5s', done: true },
        ] },
      { who: 'maya', task: 'Check the cuts', state: 'done', time: '24s', delegatedBy: 'theo',
        result: 'All three headline scores match the source. Small-sample teams suppressed.',
        activity: [
          { icon: 'web', verb: 'Cross-checked', obj: 'eNPS vs. last cycle', rt: '6s', done: true },
          { icon: 'shield', verb: 'Verified', obj: '3 headline scores', rt: '4s', done: true },
        ] },
      { who: 'theo', task: 'Write the leadership readout', state: 'live', time: '12s', delegatedBy: null,
        result: null,
        activity: [
          { icon: 'doc', verb: 'Drafting', obj: 'Engagement readout \u2014 \u201cStrong cycle, growth is the watch-item\u201d', rt: '', done: false },
        ] },
    ],
    deliverables: [
      { icon: 'chart', hue: HUES.blue, title: 'Engagement by business unit', meta: 'Chart · by Vega', ph: 'bar chart preview' },
      { icon: 'doc', hue: HUES.amber, title: 'Engagement leadership readout', meta: 'Draft · by Lyra · in progress', ph: 'document draft' },
    ],
  };

  window.D = { ICONS, HUES, grad, COWORKERS, MODE_LABEL, MODE_DESC, ABILITIES, CONNECTIONS, PLAYBOOKS, ROLES, PROVIDERS, PROJECTS, TASK_COLUMNS, TASK_PRIORITY, PLAN_TEMPLATE, PERMISSIONS, PERM_OPTS, CHANNELS, CHANNEL_ROLES, CHANNEL_ROLE_DESC, PEOPLE, APPROVALS, ARTIFACTS, SCHEDULES, WATCHES, SPACES, SPACE_VIS, WIKI_PAGES, WIKI_PROPOSALS, SUGGESTIONS, CONVO };
})();
