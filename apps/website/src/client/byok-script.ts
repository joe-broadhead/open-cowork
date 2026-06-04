export function cloudWebsiteClientByokScript() {
  return String.raw`function renderByok() {
  const list = qs('#byok-list');
  const policyNote = qs('#byok-policy-note');
  if (!list) return;
  if (policyNote) {
    const byokPolicy = state.admin.policy?.byok || {};
    const providers = normalizeList(byokPolicy.allowedProviderIds);
    const parts = [
      providers.length ? 'Allowed providers: ' + providers.join(', ') : 'Allowed providers: profile defaults',
      byokPolicy.kmsRefsEnabled ? 'KMS refs enabled' : 'KMS refs disabled',
      byokPolicy.envRefsEnabled ? 'env: refs enabled' : 'env: refs disabled',
    ];
    policyNote.textContent = parts.join(' - ');
  }
  removeChildren(list);
  const byokLocked = adminLocked();
  const byokAdminReason = adminSurfaceText('byok', 'disabledReason', 'BYOK management requires an org owner or admin role.');
  if (!state.byok.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No provider keys configured.';
    list.appendChild(empty);
    return;
  }
  for (const secret of state.byok) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = secret.providerId;
    main.appendChild(title);
    main.appendChild(document.createTextNode(' ' + (secret.credentialKind === 'kms_ref' ? 'KMS ref' : 'key') + ' ending ' + secret.last4));
    const meta = document.createElement('small');
    meta.textContent = [
      'Updated ' + formatDate(secret.updatedAt),
      secret.lastValidatedAt ? 'validated ' + formatDate(secret.lastValidatedAt) : 'not validated',
      secret.validationError ? 'validation: ' + secret.validationError : null,
    ].filter(Boolean).join(' - ');
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(pill(secret.status, secret.status === 'active' ? 'ok' : 'warn'));
    actions.appendChild(actionButton('Validate', () => validateByok(secret.providerId), 'secondary', byokLocked, byokLocked ? byokAdminReason : ''));
    actions.appendChild(actionButton('Disable', () => deleteByok(secret.providerId), 'danger', byokLocked, byokLocked ? byokAdminReason : ''));
    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

function renderTokens() {
  const list = qs('#token-list');
  if (!list) return;
  removeChildren(list);
  const tokenLocked = adminLocked();
  const tokenAdminReason = adminSurfaceText('connections', 'disabledReason', 'Connection token issuance requires an org owner or admin role.');
  if (state.revealToken) {
    const reveal = document.createElement('div');
    reveal.className = 'secret-reveal';
    const label = document.createElement('label');
    label.textContent = 'New token';
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = state.revealToken;
    label.appendChild(input);
    const note = document.createElement('small');
    note.textContent = 'Shown once. It is not stored by this dashboard.';
    reveal.appendChild(label);
    reveal.appendChild(note);
    list.appendChild(reveal);
  }
  if (!state.tokens.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No API tokens issued.';
    list.appendChild(empty);
    return;
  }
  for (const token of state.tokens) {
    const row = document.createElement('div');
    row.className = 'row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = token.name;
    main.appendChild(title);
    main.appendChild(document.createTextNode(' ending ' + token.last4));
    const meta = document.createElement('small');
    meta.textContent = scopeLabel(token.scopes) + ' - last used ' + formatDate(token.lastUsedAt);
    main.appendChild(document.createElement('br'));
    main.appendChild(meta);
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(pill(token.revokedAt ? 'revoked' : 'active', token.revokedAt ? 'warn' : 'ok'));
    if (!token.revokedAt) actions.appendChild(actionButton('Revoke', () => revokeToken(token.tokenId), 'danger', tokenLocked, tokenLocked ? tokenAdminReason : ''));
    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }
}`
}
