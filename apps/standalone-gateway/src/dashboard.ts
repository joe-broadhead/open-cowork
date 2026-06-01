import type { StandaloneGatewayDashboardSnapshot } from "./types.js";

export function renderStandaloneGatewayDashboard(snapshot: StandaloneGatewayDashboardSnapshot): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Standalone Gateway</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #e5e7eb; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 28px 0 10px; color: #93c5fd; }
    table { width: 100%; border-collapse: collapse; background: #111827; border: 1px solid #334155; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #1f2937; font-size: 13px; }
    th { color: #cbd5e1; background: #1e293b; }
    code { color: #bfdbfe; }
  </style>
</head>
<body>
<main>
  <h1>Standalone Gateway</h1>
  <p>Generated <code>${escapeHtml(snapshot.generatedAt)}</code>. This dashboard reads Gateway-owned durable state, not Cloud.</p>
  <h2>Sessions</h2>
  ${table(["Title", "Status", "Provider", "Thread", "Updated"], snapshot.sessions.map((session) => [
    session.title,
    session.status,
    `${session.providerKind}:${session.provider}`,
    session.externalThreadId,
    session.updatedAt,
  ]))}
  <h2>Jobs</h2>
  ${table(["Kind", "Status", "Attempts", "Updated"], snapshot.jobs.map((job) => [
    job.kind,
    job.status,
    String(job.attemptCount),
    job.updatedAt,
  ]))}
  <h2>Audit</h2>
  ${table(["Action", "Actor", "Created"], snapshot.audits.map((audit) => [
    audit.action,
    audit.actor,
    audit.createdAt,
  ]))}
</main>
</body>
</html>`;
}

export function renderStandaloneGatewayMetrics(snapshot: StandaloneGatewayDashboardSnapshot): string {
  const sessionsByStatus = countBy(snapshot.sessions.map((session) => session.status));
  const jobsByStatus = countBy(snapshot.jobs.map((job) => job.status));
  return [
    "# HELP open_cowork_standalone_gateway_sessions Standalone Gateway session rows in the operator snapshot.",
    "# TYPE open_cowork_standalone_gateway_sessions gauge",
    `open_cowork_standalone_gateway_sessions ${snapshot.sessions.length}`,
    ...[...sessionsByStatus.entries()].map(([status, count]) =>
      `open_cowork_standalone_gateway_sessions_by_status{status="${escapeLabel(status)}"} ${count}`
    ),
    "# HELP open_cowork_standalone_gateway_jobs Standalone Gateway job rows in the operator snapshot.",
    "# TYPE open_cowork_standalone_gateway_jobs gauge",
    `open_cowork_standalone_gateway_jobs ${snapshot.jobs.length}`,
    ...[...jobsByStatus.entries()].map(([status, count]) =>
      `open_cowork_standalone_gateway_jobs_by_status{status="${escapeLabel(status)}"} ${count}`
    ),
    "# HELP open_cowork_standalone_gateway_audit_events Standalone Gateway audit rows in the operator snapshot.",
    "# TYPE open_cowork_standalone_gateway_audit_events gauge",
    `open_cowork_standalone_gateway_audit_events ${snapshot.audits.length}`,
    "",
  ].join("\n");
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "<p>No rows.</p>";
  return `<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) =>
    `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`
  ).join("")}</tbody></table>`;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char] || char);
}
