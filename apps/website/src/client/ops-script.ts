export function cloudWebsiteClientOpsScript() {
  return String.raw`function renderBilling() {
  const billing = state.billing;
  const panel = qs('#billing-summary');
  const entitlements = qs('#billing-entitlements');
  const planSelect = qs('#billing-plan-select');
  if (!panel) return;
  removeChildren(panel);
  if (entitlements) removeChildren(entitlements);
  if (!billing || !billing.enabled) {
    panel.appendChild(pill('billing disabled', 'warn'));
    const text = document.createElement('p');
    text.className = 'empty';
    text.textContent = 'Self-host mode is active. BYOK, desktop tokens, gateway setup, and workbench features remain available without commercial billing.';
    panel.appendChild(text);
    if (entitlements) appendDetails(entitlements, 'Self-host entitlements', billing?.entitlements || {});
    qsa('[data-billing-control="true"]').forEach((element) => { element.disabled = true; });
    return;
  }
  qsa('[data-billing-control="true"]').forEach((element) => { element.disabled = adminLocked(); });
  panel.appendChild(pill(billing.active ? 'active' : 'action required', billing.active ? 'ok' : 'warn'));
  panel.appendChild(pill(billing.mode || 'managed'));
  panel.appendChild(pill(billing.providerId || 'provider'));
  const detail = document.createElement('p');
  const subscription = billing.subscription;
  detail.textContent = subscription
    ? subscription.planKey + ' - ' + subscription.status + ' - ' + subscription.seats + ' seat(s)' + (subscription.currentPeriodEnd ? ' - renews ' + formatDate(subscription.currentPeriodEnd) : '')
    : 'No subscription is attached to this org.';
  panel.appendChild(detail);
  if (planSelect) {
    removeChildren(planSelect);
    for (const plan of normalizeList(billing.plans)) {
      const option = document.createElement('option');
      option.value = plan.planKey;
      option.textContent = plan.label + (plan.default ? ' (default)' : '');
      planSelect.appendChild(option);
    }
  }
  if (entitlements) {
    const plans = normalizeList(billing.plans);
    for (const plan of plans) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const main = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = plan.label || plan.planKey;
      main.appendChild(title);
      const meta = document.createElement('small');
      meta.textContent = plan.planKey + (plan.default ? ' - default' : '');
      main.appendChild(document.createElement('br'));
      main.appendChild(meta);
      row.appendChild(main);
      row.appendChild(pill(plan.default ? 'default' : 'available'));
      appendDetails(row, 'Entitlements', plan.entitlements || {});
      entitlements.appendChild(row);
    }
    if (!plans.length) appendDetails(entitlements, 'Resolved entitlements', billing.entitlements || {});
  }
}

function renderUsage() {
  const list = qs('#usage-list');
  const quotas = qs('#usage-quota-list');
  const totals = qs('#usage-total-list');
  if (!list) return;
  removeChildren(list);
  if (quotas) {
    removeChildren(quotas);
    const quotaRows = normalizeList(state.usageSummary?.quotas);
    if (!quotaRows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No quota windows loaded.';
      quotas.appendChild(empty);
    }
    for (const quota of quotaRows) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const main = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = quota.label || quota.quotaKey;
      main.appendChild(title);
      const meta = document.createElement('small');
      meta.textContent = quota.enabled
        ? quantityLabel(quota.used, quota.unit) + ' of ' + quantityLabel(quota.limit, quota.unit) + ' - resets ' + formatDate(quota.resetAt)
        : 'unlimited or disabled';
      main.appendChild(document.createElement('br'));
      main.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(pill(quota.enabled ? percentLabel(quota.used, quota.limit) : 'unlimited', quota.enabled ? 'warn' : 'ok'));
      row.appendChild(main);
      row.appendChild(actions);
      quotas.appendChild(row);
    }
  }
  if (totals) {
    removeChildren(totals);
    const totalRows = normalizeList(state.usageSummary?.totals);
    const scope = document.createElement('p');
    scope.className = 'empty';
    scope.textContent = 'Recent totals from the latest ' + (state.usageSummary?.eventSampleLimit || 100) + ' usage events.';
    totals.appendChild(scope);
    if (!totalRows.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No usage totals loaded.';
      totals.appendChild(empty);
    }
    for (const total of totalRows) {
      const row = document.createElement('div');
      row.className = 'row compact';
      const strong = document.createElement('strong');
      strong.textContent = total.eventType;
      const span = document.createElement('span');
      span.textContent = quantityLabel(total.quantity, total.unit);
      row.appendChild(strong);
      row.appendChild(span);
      totals.appendChild(row);
    }
  }
  if (!state.usage.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No usage events recorded yet.';
    list.appendChild(empty);
    return;
  }
  for (const event of state.usage.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'row compact';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = event.eventType;
    main.appendChild(title);
    const meta = document.createElement('small');
    meta.textContent = event.quantity + ' ' + event.unit + ' - ' + formatDate(event.createdAt);
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    row.appendChild(main);
    list.appendChild(row);
  }
}

function renderDiagnostics() {
  const health = qs('#diagnostics-health');
  const bundle = qs('#diagnostics-bundle');
  if (!health || !bundle) return;
  removeChildren(health);
  removeChildren(bundle);
  const diagnostics = state.diagnostics;
  if (!diagnostics) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = adminLocked() ? 'Diagnostics require admin or operator privileges.' : 'Diagnostics have not been requested.';
    health.appendChild(empty);
    return;
  }
  const runtime = safeObject(diagnostics.runtime);
  const gateway = safeObject(diagnostics.gateway);
  const byok = safeObject(diagnostics.byok);
  const rows = [
    ['Generated', formatDate(diagnostics.generatedAt)],
    ['Redaction', diagnostics.redaction || 'secrets-redacted'],
    ['Runtime role', runtime.role || 'unknown'],
    ['Command processing', runtime.commandProcessing || 'unknown'],
    ['Worker heartbeats', runtime.heartbeatCount ?? 0],
    ['BYOK providers', byok.configuredProviders ?? 0],
    ['Gateway agents', safeObject(gateway.agents).total ?? 0],
    ['Delivery status sample', 'latest ' + (gateway.deliverySampleLimit || 200) + ' deliveries'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'row compact';
    const strong = document.createElement('strong');
    strong.textContent = label;
    const span = document.createElement('span');
    span.textContent = String(value);
    row.appendChild(strong);
    row.appendChild(span);
    health.appendChild(row);
  }
  appendDetails(bundle, 'Redacted diagnostics JSON', diagnostics);
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(actionButton('Download bundle', () => downloadJson('open-cowork-diagnostics.json', diagnostics), 'primary', false));
  bundle.appendChild(actions);
}`
}
