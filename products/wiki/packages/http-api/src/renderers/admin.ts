import type { HttpPolicyOptions } from "../types.ts";
import { gitRemoteStatus, readGitSyncState, type GitRemoteStatusResponse, type GitSyncState } from "@openwiki/git";
import { type OpenWikiRole, type PermissionPreview, previewPermissions } from "@openwiki/policy";
import { loadRepository, type LoadedOpenWikiRepo } from "@openwiki/repo";
import { escapeHtml, renderBadge, renderBreadcrumb, renderFormActions, renderSelect, renderTextarea, renderTextInput } from "@openwiki/web";
import { listServiceAccountTokens, type SanitizedServiceAccount } from "@openwiki/workflows";
import { canSeeAdminSurface, identityLabelForPolicy, permissionPreviewContextFromUrl, permissionPreviewOperationsFromUrl, permissionPreviewPathsFromUrl, permissionPreviewRecordsFromUrl } from "../auth.ts";
import { htmlLayout } from "./layout.ts";

export async function renderAdminPage(root: string, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  const [gitStatus, syncState] = await Promise.all([
    gitRemoteStatus(root),
    readGitSyncState(root),
  ]);
  return htmlLayout(
    "Admin",
    "admin",
    `
    <section class="ow-toolbar">
      <div>
        ${renderBreadcrumb([
          { label: "Home", href: "/" },
          { label: "Admin" },
        ])}
        <h1>Admin</h1>
        <p class="ow-muted">Advanced tools for Spaces, operations, API contracts, and agent integrations.</p>
      </div>
    </section>
    <section class="ow-grid">
      <div class="ow-panel">
        <div class="ow-panel__head"><h2>Spaces & Permissions</h2><span>${repo.policy.sections.length} spaces</span></div>
        <p class="ow-muted">Manage who can read, propose, review, maintain, and administer sensitive knowledge.</p>
        <div class="ow-record-actions">
          <a class="button" href="/spaces">Open Spaces</a>
          <a class="button secondary" href="/api/v1/policy">Policy JSON</a>
          <a class="button secondary" href="/api/v1/policy/identities">Identity JSON</a>
        </div>
      </div>
      <div class="ow-panel">
        <div class="ow-panel__head"><h2>Operations</h2><span>advanced</span></div>
        <div class="ow-record-actions">
          <a class="button secondary" href="/graph">Graph</a>
          <a class="button secondary" href="/runs">Runs</a>
          <a class="button secondary" href="/livez">Liveness</a>
          <a class="button secondary" href="/readyz">Readiness</a>
          <a class="button secondary" href="/metrics">Metrics</a>
        </div>
      </div>
      ${renderSyncAdminPanel(repo, gitStatus, syncState)}
      <div class="ow-panel">
        <div class="ow-panel__head"><h2>Agent & API Surface</h2><span>contracts</span></div>
        <div class="ow-record-actions">
          <a class="button secondary" href="/api/v1/capabilities">Capabilities</a>
          <a class="button secondary" href="/openapi.json">OpenAPI</a>
          <a class="button secondary" href="/mcp-manifest.json">MCP manifest</a>
        </div>
      </div>
      <div class="ow-panel">
        <div class="ow-panel__head"><h2>Trusted Identity</h2><span>${escapeHtml(identityLabelForPolicy(policy))}</span></div>
        <p class="ow-muted">OpenWiki does not provide native password login in this mode. It receives trusted identity from your organization's SSO or reverse proxy, or from scoped service-account bearer tokens.</p>
        <div class="ow-record-actions">
          <a class="button secondary" href="/admin/service-accounts">Service Accounts</a>
          <a class="button secondary" href="/api/v1/auth/service-accounts">Service Account JSON</a>
        </div>
      </div>
    </section>
  `,
    { policy },
  );
}

function renderSyncAdminPanel(repo: LoadedOpenWikiRepo, gitStatus: GitRemoteStatusResponse, syncState: GitSyncState): string {
  const sync = repo.config.runtime?.sync;
  const remote = sync?.remote ?? gitStatus.remote ?? repo.config.runtime?.git?.remote ?? "origin";
  const branch = sync?.branch ?? gitStatus.branch ?? repo.config.runtime?.git?.branch ?? "main";
  const conflict = gitStatus.conflict_state === "conflicted" || syncState.conflict?.has_conflicts === true;
  return `
    <div class="ow-panel">
      <div class="ow-panel__head"><h2>Git Sync</h2><span>${escapeHtml(sync?.mode ?? "manual")}</span></div>
      <dl class="ow-meta-list">
        <dt>Remote</dt><dd>${escapeHtml(remote)}</dd>
        <dt>Branch</dt><dd>${escapeHtml(branch)}</dd>
        <dt>State</dt><dd>${escapeHtml(gitStatus.clean ? "clean" : "dirty")} · ahead=${gitStatus.ahead} behind=${gitStatus.behind}</dd>
        <dt>Conflict</dt><dd>${escapeHtml(conflict ? "requires repair" : "none")}</dd>
        <dt>Last Success</dt><dd>${escapeHtml(syncState.last_success?.occurred_at ?? "none")}</dd>
        <dt>Last Failure</dt><dd>${escapeHtml(syncState.last_failure?.occurred_at ?? "none")}</dd>
      </dl>
      <p class="ow-muted">Use the CLI for sync changes so write coordination can protect agents, humans, and Git operations.</p>
      <pre>${escapeHtml("openwiki --root /data/wiki sync status --json")}</pre>
    </div>
  `;
}

export async function renderServiceAccountsPage(root: string, policy: HttpPolicyOptions): Promise<string> {
  const result = await listServiceAccountTokens({ root });
  return htmlLayout(
    "Service Accounts",
    "admin",
    `
    <section class="ow-toolbar">
      <div>
        ${renderBreadcrumb([
          { label: "Home", href: "/" },
          { label: "Admin", href: "/admin" },
          { label: "Service Accounts" },
        ])}
        <h1>Service Accounts</h1>
        <p class="ow-muted">Scoped bearer tokens for agents and automation. Token values are only returned by create and rotate API calls, never by this page.</p>
      </div>
      <div class="ow-record-actions">
        <a class="button secondary" href="/api/v1/auth/service-accounts">JSON</a>
      </div>
    </section>
    <section class="ow-record-layout">
      <div class="ow-record-main">
        ${renderServiceAccountCards(result.service_accounts)}
      </div>
      <aside class="ow-panel ow-record-side">
        <h2>Create Or Rotate</h2>
        <p class="ow-muted">Use the CLI or JSON API for create and rotate so the raw token can be captured exactly once.</p>
        <pre>${escapeHtml("openwiki --root /data/wiki auth token create --profile proposal-agent --expires-in-days 30")}</pre>
        <h2>Profiles</h2>
        <dl class="ow-meta-list">
          <dt>hosted-readonly-agent</dt><dd>Read, search, and ask.</dd>
          <dt>inbox-submitter</dt><dd>Submit and read owned inbox items.</dd>
          <dt>inbox-curator</dt><dd>Read, submit, and process Space inbox items.</dd>
          <dt>proposal-agent</dt><dd>Read plus propose edits.</dd>
          <dt>maintainer-automation</dt><dd>Trusted write workflows only.</dd>
        </dl>
      </aside>
    </section>
  `,
    { policy },
  );
}

function renderServiceAccountCards(accounts: SanitizedServiceAccount[]): string {
  if (accounts.length === 0) {
    return `<section class="ow-panel"><h2>No Service Accounts</h2><p class="ow-muted">Create a service-account token before connecting hosted agents over HTTP MCP.</p></section>`;
  }
  return accounts
    .map(
      (account) => `
        <section class="ow-panel">
          <div class="ow-panel__head">
            <div>
              <p class="ow-eyebrow">${escapeHtml(account.id)}</p>
              <h2>${escapeHtml(account.actor_id)}</h2>
            </div>
            ${renderBadge(account.role ?? "custom", account.role ?? "custom")}
          </div>
          ${account.description === undefined ? "" : `<p class="ow-muted">${escapeHtml(account.description)}</p>`}
          <dl class="ow-meta-list">
            <dt>Scopes</dt><dd>${account.scopes.length === 0 ? `<span class="ow-muted">None</span>` : account.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(", ")}</dd>
            <dt>Principals</dt><dd>${account.principals.length === 0 ? `<span class="ow-muted">None</span>` : account.principals.map((principal) => `<code>${escapeHtml(principal)}</code>`).join(", ")}</dd>
            <dt>Tokens</dt><dd>active=${account.active_token_count} revoked=${account.revoked_token_count} expired=${account.expired_token_count}</dd>
            ${account.created_at === undefined ? "" : `<dt>Created</dt><dd>${escapeHtml(account.created_at)}</dd>`}
            ${account.updated_at === undefined ? "" : `<dt>Updated</dt><dd>${escapeHtml(account.updated_at)}</dd>`}
            ${account.expires_at === undefined ? "" : `<dt>Account Expires</dt><dd>${escapeHtml(account.expires_at)}</dd>`}
          </dl>
          <details>
            <summary>Token Metadata</summary>
            ${renderServiceAccountTokenRows(account)}
          </details>
          <details>
            <summary>Revoke Token</summary>
            <form class="ow-stacked-form" method="post" action="/admin/service-accounts/revoke">
              <input type="hidden" name="id" value="${escapeHtml(account.id)}">
              ${renderTextInput("token_id", "Token ID", account.tokens.find((token) => token.status === "active")?.id ?? "")}
              ${renderTextarea("reason", "Reason", "Routine service-account token cleanup.", { rows: 2 })}
              ${renderFormActions("Revoke Token")}
            </form>
          </details>
        </section>
      `,
    )
    .join("");
}

function renderServiceAccountTokenRows(account: SanitizedServiceAccount): string {
  if (account.tokens.length === 0) {
    return `<p class="ow-muted">No token metadata is available for this account. Legacy token hashes may still be counted above.</p>`;
  }
  return `
    <dl class="ow-meta-list">
      ${account.tokens
        .map(
          (token) => `
            <dt>${escapeHtml(token.id)}</dt>
            <dd>
              ${renderBadge(token.status, token.status)}
              created=${escapeHtml(token.created_at ?? "unknown")}
              ${token.expires_at === undefined ? "" : ` expires=${escapeHtml(token.expires_at)}`}
              ${token.revoked_at === undefined ? "" : ` revoked=${escapeHtml(token.revoked_at)}`}
              ${token.description === undefined ? "" : ` ${escapeHtml(token.description)}`}
            </dd>
          `,
        )
        .join("")}
    </dl>
  `;
}

export async function renderSpacesPage(root: string, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  return htmlLayout(
    "Spaces & Permissions",
    "spaces",
    `
    <section class="ow-toolbar">
      <div>
        ${renderBreadcrumb([
          { label: "Home", href: "/" },
          ...(canSeeAdminSurface(policy) ? [{ label: "Admin", href: "/admin" }] : []),
          { label: "Spaces" },
        ])}
        <h1>Spaces & Permissions</h1>
        <p class="ow-muted">Spaces turn path-based policy into a human workflow for sensitive team knowledge.</p>
      </div>
      <div class="ow-record-actions">
        <a class="button secondary" href="/api/v1/policy">Policy JSON</a>
        <a class="button secondary" href="/api/v1/policy/identities">Identity JSON</a>
      </div>
    </section>
    <section class="ow-record-layout">
      <div class="ow-record-main">
        ${renderSpaceCards(repo.policy)}
        <details class="ow-panel ow-advanced-panel">
          <summary>Advanced Policy JSON</summary>
          ${renderPolicyFilePanel("sections", repo.policy.sections)}
          ${renderPolicyFilePanel("grants", repo.policy.grants)}
          ${renderPolicyFilePanel("approval-rules", repo.policy.approval_rules)}
        </details>
      </div>
      <aside class="ow-panel ow-record-side">
        <h2>Permission Preview</h2>
        <form class="ow-stacked-form" method="get" action="/spaces/preview">
          ${renderTextInput("actor_id", "Actor ID", "actor:user:example")}
          ${renderSelect(
            "role",
            "Role",
            ["viewer", "contributor", "researcher", "reviewer", "maintainer", "admin", "agent"].map((role) => ({
              value: role,
              label: role,
              selected: role === "viewer",
            })),
          )}
          ${renderTextInput("principal", "Principal", "group:all-users")}
          ${renderTextInput("target_path", "Path", "wiki/concepts/agent-memory.md")}
          ${renderTextInput("target_id", "Record ID", "")}
          ${renderTextInput("operation", "Operation", "wiki.read_page")}
          ${renderFormActions("Preview Access")}
        </form>
        <h2>Create Space</h2>
        <form class="ow-stacked-form" method="post" action="/policy/sections/propose">
          ${renderTextInput("section_id", "Space ID", "section:hr")}
          ${renderTextInput("title", "Space Name", "HR")}
          ${renderTextarea("paths", "Paths", "wiki/hr/**\nsources/hr/**\nclaims/hr/**", {
            rows: 3,
            hint: "One path expression per line.",
          })}
          ${renderSelect(
            "visibility",
            "Visibility",
            ["private", "internal", "public"].map((visibility) => ({
              value: visibility,
              label: visibility,
              selected: visibility === "private",
            })),
          )}
          ${renderTextInput("owner_principal", "Owner Principal", "group:hr-admins")}
          ${renderTextarea("viewer_principals", "Viewers", "group:hr", { rows: 2 })}
          ${renderTextarea("contributor_principals", "Contributors", "group:hr-contributors", { rows: 2 })}
          ${renderTextarea("reviewer_principals", "Reviewer Principals", "group:hr-reviewers", { rows: 2 })}
          ${renderTextarea("maintainer_principals", "Maintainers", "group:hr-maintainers", { rows: 2 })}
          ${renderTextarea("admin_principals", "Admin Principals", "group:hr-admins", { rows: 2 })}
          ${renderTextInput("actor_id", "Actor ID", "actor:user:policy-admin")}
          ${renderTextarea("rationale", "Rationale", "Create governed space policy.", { required: true })}
          ${renderFormActions("Create Space Proposal")}
        </form>
        <h2>Edit Advanced Policy</h2>
        <form class="ow-stacked-form" method="post" action="/policy/propose">
          ${renderSelect("policy_file", "Policy File", [
            { value: "sections", label: "sections.json", selected: true },
            { value: "grants", label: "grants.json" },
            { value: "approval-rules", label: "approval-rules.json" },
          ])}
          ${renderTextInput("actor_id", "Actor ID", "actor:user:policy-admin")}
          ${renderTextarea("body", "JSON Body", JSON.stringify(repo.policy.sections, null, 2), {
            required: true,
            rows: 14,
            controlClassName: "json-editor",
          })}
          ${renderTextarea("rationale", "Rationale", "", { required: true })}
          ${renderFormActions("Create Advanced Policy Proposal")}
        </form>
      </aside>
    </section>
  `,
    { policy },
  );
}

export async function renderSpacesPreviewPage(root: string, url: URL, policy: HttpPolicyOptions): Promise<string> {
  const repo = await loadRepository(root);
  const preview = previewPermissions(repo.policy, permissionPreviewContextFromUrl(url), {
    repo,
    paths: permissionPreviewPathsFromUrl(url),
    recordIds: permissionPreviewRecordsFromUrl(url),
    operations: permissionPreviewOperationsFromUrl(url),
  });
  return htmlLayout(
    "Permission Preview",
    "spaces",
    `
    <section class="ow-toolbar">
      <div>
        ${renderBreadcrumb([
          { label: "Home", href: "/" },
          ...(canSeeAdminSurface(policy) ? [{ label: "Admin", href: "/admin" }] : []),
          { label: "Spaces", href: "/spaces" },
          { label: "Preview" },
        ])}
        <h1>Permission Preview</h1>
        <p class="ow-muted">Dry-run access for an actor, group, path, record, and operation without changing policy.</p>
      </div>
      <div class="ow-record-actions">
        <a class="button secondary" href="${escapeHtml(`/api/v1/policy/preview?${url.searchParams.toString()}`)}">JSON</a>
      </div>
    </section>
    <section class="ow-record-layout">
      <div class="ow-record-main">
        ${renderPermissionPreview(preview)}
      </div>
      <aside class="ow-panel ow-record-side">
        <h2>Try Another Preview</h2>
        <form class="ow-stacked-form" method="get" action="/spaces/preview">
          ${renderTextInput("actor_id", "Actor ID", preview.actor_id ?? "actor:user:example")}
          ${renderSelect(
            "role",
            "Role",
            ["viewer", "contributor", "researcher", "reviewer", "maintainer", "admin", "agent"].map((role) => ({
              value: role,
              label: role,
              selected: role === (preview.role ?? "viewer"),
            })),
          )}
          ${renderTextInput("principal", "Principal", preview.principals.find((principal) => principal !== "group:all-users" && !principal.startsWith("role:")) ?? "group:all-users")}
          ${renderTextInput("target_path", "Path", preview.paths[0]?.path ?? "wiki/concepts/agent-memory.md")}
          ${renderTextInput("target_id", "Record ID", preview.records[0]?.id ?? "")}
          ${renderTextInput("operation", "Operation", preview.operations[0]?.operation ?? "wiki.read_page")}
          ${renderFormActions("Preview Access")}
        </form>
      </aside>
    </section>
  `,
    { policy },
  );
}

function renderPermissionPreview(preview: PermissionPreview): string {
  const principalText = preview.principals.length === 0 ? "None" : preview.principals.join(", ");
  const scopeText = preview.scopes.length === 0 ? "None" : preview.scopes.join(", ");
  return `
    <section class="ow-panel">
      <div class="ow-panel__head"><h2>Identity</h2><span>${escapeHtml(preview.role ?? "viewer")}</span></div>
      <dl class="ow-meta-list">
        <dt>Actor</dt><dd>${escapeHtml(preview.actor_id ?? "anonymous/local")}</dd>
        <dt>Principals</dt><dd>${escapeHtml(principalText)}</dd>
        <dt>Scopes</dt><dd>${escapeHtml(scopeText)}</dd>
      </dl>
    </section>
    ${renderPermissionPathPreview(preview)}
    ${renderPermissionRecordPreview(preview)}
    ${renderPermissionOperationPreview(preview)}
  `;
}

function renderPermissionPathPreview(preview: PermissionPreview): string {
  if (preview.paths.length === 0) {
    return "";
  }
  return preview.paths
    .map(
      (entry) => `
        <section class="ow-panel">
          <div class="ow-panel__head"><h2>${escapeHtml(entry.path)}</h2><span>${escapeHtml(entry.role ?? "no access")}</span></div>
          <dl class="ow-meta-list">
            <dt>Visibility</dt><dd>${escapeHtml(entry.visibility)}</dd>
            <dt>Matching Spaces</dt><dd>${entry.matching_sections.length === 0 ? `<span class="ow-muted">None</span>` : entry.matching_sections.map((section) => `<code>${escapeHtml(section.id)}</code>`).join(", ")}</dd>
            <dt>Allowed Operations</dt><dd>${entry.allowed_operations.length === 0 ? `<span class="ow-muted">None</span>` : entry.allowed_operations.map((operation) => `<code>${escapeHtml(operation)}</code>`).join(", ")}</dd>
          </dl>
        </section>
      `,
    )
    .join("");
}

function renderPermissionRecordPreview(preview: PermissionPreview): string {
  if (preview.records.length === 0) {
    return "";
  }
  return preview.records
    .map(
      (record) => `
        <section class="ow-panel">
          <div class="ow-panel__head"><h2>${escapeHtml(record.id)}</h2><span>${record.visible ? "visible" : "hidden"}</span></div>
          <dl class="ow-meta-list">
            ${record.type === undefined ? "" : `<dt>Type</dt><dd>${escapeHtml(record.type)}</dd>`}
            ${record.path === undefined ? "" : `<dt>Path</dt><dd><code>${escapeHtml(record.path)}</code></dd>`}
            ${record.visibility === undefined ? "" : `<dt>Visibility</dt><dd>${escapeHtml(record.visibility)}</dd>`}
            ${record.role === undefined ? "" : `<dt>Role</dt><dd>${escapeHtml(record.role)}</dd>`}
            <dt>Decision</dt><dd>${escapeHtml(record.reason)}</dd>
            ${record.matching_sections === undefined || record.matching_sections.length === 0 ? "" : `<dt>Matching Spaces</dt><dd>${record.matching_sections.map((section) => `<code>${escapeHtml(section.id)}</code>`).join(", ")}</dd>`}
          </dl>
        </section>
      `,
    )
    .join("");
}

function renderPermissionOperationPreview(preview: PermissionPreview): string {
  if (preview.operations.length === 0) {
    return "";
  }
  return `
    <section class="ow-panel">
      <div class="ow-panel__head"><h2>Operations</h2><span>${preview.operations.filter((operation) => operation.allowed).length} allowed</span></div>
      <dl class="ow-meta-list">
        ${preview.operations
          .map(
            (operation) => `
              <dt>${escapeHtml(operation.operation)}</dt>
              <dd>
                ${operation.allowed ? "allowed" : "denied"}
                ${operation.path === undefined ? "" : ` on <code>${escapeHtml(operation.path)}</code>`}
                ${operation.scope_allowed ? "" : ` · missing scopes: ${escapeHtml(operation.missing_scopes.join(", "))}`}
                ${operation.path_allowed === false ? ` · needs ${escapeHtml(operation.required_section_role ?? "viewer")} access` : ""}
              </dd>
            `,
          )
          .join("")}
      </dl>
    </section>
  `;
}

function renderSpaceCards(policy: Awaited<ReturnType<typeof loadRepository>>["policy"]): string {
  if (policy.sections.length === 0) {
    return `<section class="ow-panel"><h2>No Spaces Yet</h2><p class="ow-muted">Create a Space to define who can access a path range.</p></section>`;
  }
  return policy.sections
    .map((section) => {
      const grants = policy.grants.filter((grant) => grant.section === section.id);
      const visibility = section.visibility ?? "private";
      return `
        <section class="ow-panel ow-space-card">
          <div class="ow-panel__head">
            <div>
              <p class="ow-eyebrow">${escapeHtml(section.id)}</p>
              <h2>${escapeHtml(section.title)}</h2>
            </div>
            ${renderBadge(visibility, visibility)}
          </div>
          ${section.description ? `<p class="ow-muted">${escapeHtml(section.description)}</p>` : ""}
          <dl class="ow-meta-list">
            <dt>Paths</dt><dd>${section.paths.map((repoPath) => `<code>${escapeHtml(repoPath)}</code>`).join(", ")}</dd>
            <dt>Viewers</dt><dd>${renderSpacePrincipals(grants, "viewer")}</dd>
            <dt>Contributors</dt><dd>${renderSpacePrincipals(grants, "contributor")}</dd>
            <dt>Reviewers</dt><dd>${renderSpacePrincipals(grants, "reviewer")}</dd>
            <dt>Maintainers</dt><dd>${renderSpacePrincipals(grants, "maintainer")}</dd>
            <dt>Admins</dt><dd>${renderSpacePrincipals(grants, "admin")}</dd>
          </dl>
          <details>
            <summary>Edit Space Proposal</summary>
            <form class="ow-stacked-form" method="post" action="/policy/sections/propose">
              <input type="hidden" name="replace_grants" value="true">
              ${renderTextInput("section_id", "Space ID", section.id)}
              ${renderTextInput("title", "Space Name", section.title)}
              ${renderTextarea("paths", "Paths", section.paths.join("\n"), { rows: 3 })}
              ${renderSelect(
                "visibility",
                "Visibility",
                ["private", "internal", "public"].map((candidate) => ({
                  value: candidate,
                  label: candidate,
                  selected: candidate === visibility,
                })),
              )}
              ${renderTextInput("owner_principal", "Owner Principal", section.owner_principal ?? "")}
              ${renderTextarea("viewer_principals", "Viewers", spacePrincipalsText(grants, "viewer"), { rows: 2 })}
              ${renderTextarea("contributor_principals", "Contributors", spacePrincipalsText(grants, "contributor"), { rows: 2 })}
              ${renderTextarea("reviewer_principals", "Reviewers", spacePrincipalsText(grants, "reviewer"), { rows: 2 })}
              ${renderTextarea("maintainer_principals", "Maintainers", spacePrincipalsText(grants, "maintainer"), { rows: 2 })}
              ${renderTextarea("admin_principals", "Admins", spacePrincipalsText(grants, "admin"), { rows: 2 })}
              ${renderTextInput("actor_id", "Actor ID", "actor:user:policy-admin")}
              ${renderTextarea("rationale", "Rationale", `Update ${section.title} Space policy.`, { required: true })}
              ${renderFormActions("Create Edit Proposal")}
            </form>
          </details>
        </section>
      `;
    })
    .join("");
}

function renderSpacePrincipals(grants: Array<{ principal: string; role: OpenWikiRole }>, role: OpenWikiRole): string {
  const principals = grants.filter((grant) => grant.role === role).map((grant) => grant.principal);
  return principals.length === 0 ? `<span class="ow-muted">None</span>` : principals.map((principal) => `<code>${escapeHtml(principal)}</code>`).join(", ");
}

function spacePrincipalsText(grants: Array<{ principal: string; role: OpenWikiRole }>, role: OpenWikiRole): string {
  return grants.filter((grant) => grant.role === role).map((grant) => grant.principal).join("\n");
}

function renderPolicyFilePanel(name: string, records: unknown): string {
  return `
    <section class="ow-panel">
      <div class="ow-panel__head"><h2>${escapeHtml(name)}.json</h2><span>${Array.isArray(records) ? records.length : 0} records</span></div>
      <pre>${escapeHtml(JSON.stringify(records, null, 2))}</pre>
    </section>
  `;
}
