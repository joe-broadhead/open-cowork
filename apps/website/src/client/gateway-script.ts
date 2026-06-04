export function cloudWebsiteClientGatewayScript() {
  return String.raw`function renderGateway() {
  const agents = qs('#agent-list');
  const bindings = qs('#binding-list');
  const deliveries = qs('#delivery-list');
  const setup = qs('#gateway-setup-guide');
  const select = qs('#binding-agent');
  if (!agents || !bindings || !select) return;
  removeChildren(agents);
  removeChildren(bindings);
  removeChildren(select);
  const gatewayLocked = adminLocked();
  const gatewayAdminReason = adminSurfaceText('gateway', 'disabledReason', 'Gateway administration requires an org owner or admin role.');
  if (deliveries) removeChildren(deliveries);
  if (setup) {
    removeChildren(setup);
    const steps = [
      'Create or rotate a gateway-scoped service token in Connections.',
      'Deploy the gateway with OPEN_COWORK_CLOUD_BASE_URL and OPEN_COWORK_GATEWAY_SERVICE_TOKEN.',
      'Telegram: set OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN and bind the bot workspace.',
      'Slack: set OPEN_COWORK_GATEWAY_SLACK_BOT_TOKEN plus signing secret and bind the team/channel.',
      'Email: configure inbound secret plus SMTP settings, then bind the inbound address/domain.',
      'Webhook: set OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET and a HTTPS delivery URL.',
      'Use the delivery backlog below to retry or dead-letter stuck outbound messages.',
    ];
    for (const step of steps) {
      const row = document.createElement('div');
      row.className = 'row compact';
      row.appendChild(pill(String(setup.children.length + 1)));
      const text = document.createElement('span');
      text.textContent = step;
      row.appendChild(text);
      setup.appendChild(row);
    }
  }
  if (!state.agents.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No headless agents configured.';
    agents.appendChild(empty);
  }
  for (const agent of state.agents) {
    const option = document.createElement('option');
    option.value = agent.agentId;
    option.textContent = agent.name;
    select.appendChild(option);
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = agent.name;
    main.appendChild(title);
    main.appendChild(document.createTextNode(' - ' + agent.profileName));
    row.appendChild(main);
    row.appendChild(pill(agent.status, agent.status === 'active' ? 'ok' : 'warn'));
    agents.appendChild(row);
  }
  if (!state.bindings.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No channel bindings configured.';
    bindings.appendChild(empty);
  }
  for (const binding of state.bindings) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = binding.displayName;
    main.appendChild(title);
    main.appendChild(document.createTextNode(' - ' + binding.provider));
    const meta = document.createElement('small');
    meta.textContent = [binding.externalWorkspaceId || 'tenant-wide channel', bindingSettingsLabel(binding.settings)].filter(Boolean).join(' - ');
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    row.appendChild(main);
    row.appendChild(pill(binding.status, binding.status === 'active' ? 'ok' : 'warn'));
    bindings.appendChild(row);
  }
  if (deliveries) {
    const backlog = normalizeList(state.deliveries);
    if (!backlog.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No gateway deliveries loaded.';
      deliveries.appendChild(empty);
    }
    for (const delivery of backlog.slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'row';
      const main = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = delivery.eventType || delivery.deliveryId || 'delivery';
      main.appendChild(title);
      const meta = document.createElement('small');
      meta.textContent = [
        delivery.provider,
        delivery.channelBindingId,
        'attempts ' + (delivery.attemptCount || 0),
        delivery.lastError ? safeOperationalText(delivery.lastError) : null,
        'next ' + formatDate(delivery.nextAttemptAt),
      ].filter(Boolean).join(' - ');
      main.appendChild(document.createElement('br'));
      main.appendChild(meta);
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.appendChild(pill(delivery.status || 'unknown', deliveryPillKind(delivery.status)));
      actions.appendChild(actionButton('Retry', () => retryDelivery(delivery.deliveryId), 'secondary', gatewayLocked || !delivery.deliveryId || delivery.status === 'sent', gatewayLocked ? gatewayAdminReason : ''));
      actions.appendChild(actionButton('Dead-letter', () => deadLetterDelivery(delivery.deliveryId), 'danger', gatewayLocked || !delivery.deliveryId || delivery.status === 'dead', gatewayLocked ? gatewayAdminReason : ''));
      row.appendChild(main);
      row.appendChild(actions);
      appendDetails(row, 'Redacted delivery payload', {
        target: safeOperationalMetadata(delivery.target),
        payload: safeOperationalMetadata(delivery.payload),
      });
      deliveries.appendChild(row);
    }
  }
}`
}
