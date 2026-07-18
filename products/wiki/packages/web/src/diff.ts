import { escapeHtml } from "./html.ts";

interface DiffRenderOptions {
  before?: string;
  after?: string;
  patch?: string;
  beforeLabel?: string;
  afterLabel?: string;
  contextLines?: number;
}

type DiffRowKind = "ctx" | "add" | "del" | "hunk" | "meta" | "fold";

interface DiffRow {
  kind: DiffRowKind;
  text: string;
  oldLine?: number;
  newLine?: number;
  html?: string;
  section?: string;
  foldedLines?: number;
}

interface DiffLineOp {
  kind: "equal" | "add" | "del";
  value: string;
}

const DEFAULT_CONTEXT_LINES = 4;
const MIN_FOLD_LINES = 8;

export function renderDiff(input: string | DiffRenderOptions): string {
  const options = typeof input === "string" ? { patch: input } : input;
  const patch = options.patch ?? unifiedPatchFromTexts(options.before ?? "", options.after ?? "", options.beforeLabel ?? "before", options.afterLabel ?? "after");
  if (patch.trim().length === 0) {
    return `<div class="ow-diff ow-diff--empty" data-mode="unified" data-granularity="word"><p>No changes.</p></div>`;
  }
  const rows = foldContextRows(annotateHunkSections(decorateIntralineDiffs(parseUnifiedDiff(patch))), options.contextLines ?? DEFAULT_CONTEXT_LINES);
  const additions = rows.filter((row) => row.kind === "add").length;
  const deletions = rows.filter((row) => row.kind === "del").length;
  if (rows.length === 0) {
    return `<div class="ow-diff ow-diff--empty" data-mode="unified" data-granularity="word"><p>No changes.</p></div>`;
  }
  return `<div class="ow-diff" data-mode="unified" data-granularity="word">
    <div class="ow-diff__head">
      <div><span class="ow-badge">Unified diff</span><span class="ow-diff__stat">+${additions} -${deletions}</span></div>
      <div class="ow-diff__actions" role="group" aria-label="Diff actions">
        <button type="button" class="secondary is-active" data-openwiki-diff-mode="unified" aria-pressed="true">Unified</button>
        <button type="button" class="secondary" data-openwiki-diff-mode="split" aria-pressed="false">Split</button>
        <button type="button" class="secondary" data-openwiki-copy-diff>Copy patch</button>
      </div>
    </div>
    <div class="ow-diff__view ow-diff__view--unified">${renderUnifiedDiffRows(rows)}</div>
    <div class="ow-diff__view ow-diff__view--split">${renderSplitDiffRows(rows)}</div>
    <template data-openwiki-diff-patch>${escapeHtml(patch)}</template>
  </div>`;
}

function unifiedPatchFromTexts(before: string, after: string, beforeLabel: string, afterLabel: string): string {
  const beforeLines = splitDiffText(before);
  const afterLines = splitDiffText(after);
  const ops = diffLineOps(beforeLines, afterLines);
  const lines = [`--- ${beforeLabel}`, `+++ ${afterLabel}`, `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`];
  for (const op of ops) {
    const marker = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
    lines.push(marker + op.value);
  }
  return lines.join("\n");
}

function splitDiffText(value: string): string[] {
  if (value.length === 0) return [];
  return value.split(/\r?\n/);
}

function diffLineOps(before: string[], after: string[]): DiffLineOp[] {
  const table = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0) as number[]);
  for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex]![newIndex] = before[oldIndex] === after[newIndex]
        ? table[oldIndex + 1]![newIndex + 1]! + 1
        : Math.max(table[oldIndex + 1]![newIndex]!, table[oldIndex]![newIndex + 1]!);
    }
  }
  const ops: DiffLineOp[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < before.length || newIndex < after.length) {
    if (oldIndex < before.length && newIndex < after.length && before[oldIndex] === after[newIndex]) {
      ops.push({ kind: "equal", value: before[oldIndex] ?? "" });
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex >= after.length || (oldIndex < before.length && table[oldIndex + 1]![newIndex]! >= table[oldIndex]![newIndex + 1]!)) {
      ops.push({ kind: "del", value: before[oldIndex] ?? "" });
      oldIndex += 1;
    } else {
      ops.push({ kind: "add", value: after[newIndex] ?? "" });
      newIndex += 1;
    }
  }
  return ops;
}

function parseUnifiedDiff(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("\\ No newline")) {
      rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newLine });
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldLine });
      oldLine += 1;
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({ kind: "ctx", text, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }
  return rows;
}

function decorateIntralineDiffs(rows: DiffRow[]): DiffRow[] {
  for (let index = 0; index < rows.length;) {
    if (rows[index]?.kind !== "del") {
      index += 1;
      continue;
    }
    const deletions: DiffRow[] = [];
    while (rows[index]?.kind === "del") {
      deletions.push(rows[index]!);
      index += 1;
    }
    const additions: DiffRow[] = [];
    const addStart = index;
    while (rows[index]?.kind === "add") {
      additions.push(rows[index]!);
      index += 1;
    }
    if (additions.length === 0) {
      index = addStart;
      continue;
    }
    const pairCount = Math.min(deletions.length, additions.length);
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
      const [beforeHtml, afterHtml] = renderTokenDiffPair(deletions[pairIndex]!.text, additions[pairIndex]!.text);
      deletions[pairIndex]!.html = beforeHtml;
      additions[pairIndex]!.html = afterHtml;
    }
  }
  return rows;
}

function annotateHunkSections(rows: DiffRow[]): DiffRow[] {
  let previousSection = "";
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind === "hunk") {
      const section = nearestHunkSection(rows, index, previousSection);
      if (section !== undefined) {
        row.section = section;
      }
      continue;
    }
    const heading = markdownHeadingText(row.text);
    if (heading !== undefined && row.kind !== "del") {
      previousSection = heading;
    }
  }
  return rows;
}

function nearestHunkSection(rows: DiffRow[], hunkIndex: number, previousSection: string): string | undefined {
  for (let index = hunkIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.kind === "hunk") {
      break;
    }
    const heading = markdownHeadingText(row.text);
    if (heading !== undefined) {
      return heading;
    }
  }
  return previousSection || undefined;
}

function markdownHeadingText(value: string): string | undefined {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(value);
  return match?.[2]?.trim();
}

function foldContextRows(rows: DiffRow[], contextLines: number): DiffRow[] {
  const context = Math.max(Math.floor(contextLines), 0);
  if (context === 0) {
    return rows;
  }
  const folded: DiffRow[] = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index]?.kind !== "ctx") {
      folded.push(rows[index]!);
      index += 1;
      continue;
    }
    const start = index;
    while (rows[index]?.kind === "ctx") {
      index += 1;
    }
    const run = rows.slice(start, index);
    const hiddenCount = run.length - context * 2;
    if (hiddenCount >= MIN_FOLD_LINES) {
      folded.push(...run.slice(0, context));
      folded.push({ kind: "fold", text: `${hiddenCount} unchanged lines`, foldedLines: hiddenCount });
      folded.push(...run.slice(run.length - context));
    } else {
      folded.push(...run);
    }
  }
  return folded;
}

function renderTokenDiffPair(before: string, after: string): [string, string] {
  const beforeTokens = diffTokens(before);
  const afterTokens = diffTokens(after);
  const ops = diffLineOps(beforeTokens, afterTokens);
  const beforeHtml: string[] = [];
  const afterHtml: string[] = [];
  for (const op of ops) {
    if (op.kind === "equal") {
      beforeHtml.push(escapeHtml(op.value));
      afterHtml.push(escapeHtml(op.value));
    } else if (op.kind === "del") {
      beforeHtml.push(`<del class="ow-diff__del">${escapeHtml(op.value)}</del>`);
    } else {
      afterHtml.push(`<ins class="ow-diff__ins">${escapeHtml(op.value)}</ins>`);
    }
  }
  return [beforeHtml.join("") || " ", afterHtml.join("") || " "];
}

function diffTokens(value: string): string[] {
  return value.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]+/g) ?? [];
}

function renderUnifiedDiffRows(rows: DiffRow[]): string {
  return `<table class="ow-diff__table"><tbody>${rows.map((row) => {
    if (row.kind === "hunk") {
      return `<tr class="ow-diff__row ow-diff__row--hunk"><td colspan="4" class="ow-diff__hunkhead">${escapeHtml(hunkLabel(row))}</td></tr>`;
    }
    if (row.kind === "fold") {
      return `<tr class="ow-diff__row ow-diff__row--fold"><td colspan="4" class="ow-diff__fold"><span>${escapeHtml(row.text)}</span></td></tr>`;
    }
    if (row.kind === "meta") {
      return `<tr class="ow-diff__row ow-diff__row--meta"><td class="ow-diff__gutter"></td><td class="ow-diff__gutter"></td><td class="ow-diff__marker"></td><td class="ow-diff__code"><code>${escapeHtml(row.text || " ")}</code></td></tr>`;
    }
    const marker = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
    const label = row.kind === "add" ? "Added line" : row.kind === "del" ? "Removed line" : "Unchanged line";
    return `<tr class="ow-diff__row ow-diff__row--${row.kind}"><td class="ow-diff__gutter">${row.oldLine ?? ""}</td><td class="ow-diff__gutter ow-diff__gutter--new">${row.newLine ?? ""}</td><td class="ow-diff__marker" aria-label="${label}">${marker}</td><td class="ow-diff__code"><code>${row.html ?? escapeHtml(row.text || " ")}</code></td></tr>`;
  }).join("")}</tbody></table>`;
}

function renderSplitDiffRows(rows: DiffRow[]): string {
  const output: string[] = [];
  for (let index = 0; index < rows.length;) {
    const row = rows[index]!;
    if (row.kind === "hunk") {
      output.push(`<tr class="ow-diff__row ow-diff__row--hunk"><td colspan="4" class="ow-diff__hunkhead">${escapeHtml(hunkLabel(row))}</td></tr>`);
      index += 1;
      continue;
    }
    if (row.kind === "fold") {
      output.push(`<tr class="ow-diff__row ow-diff__row--fold"><td colspan="4" class="ow-diff__fold"><span>${escapeHtml(row.text)}</span></td></tr>`);
      index += 1;
      continue;
    }
    if (row.kind === "meta") {
      output.push(`<tr class="ow-diff__row ow-diff__row--meta"><td colspan="4" class="ow-diff__code"><code>${escapeHtml(row.text || " ")}</code></td></tr>`);
      index += 1;
      continue;
    }
    if (row.kind === "del") {
      const deletions: DiffRow[] = [];
      while (rows[index]?.kind === "del") {
        deletions.push(rows[index]!);
        index += 1;
      }
      const additions: DiffRow[] = [];
      while (rows[index]?.kind === "add") {
        additions.push(rows[index]!);
        index += 1;
      }
      const max = Math.max(deletions.length, additions.length);
      for (let pairIndex = 0; pairIndex < max; pairIndex += 1) {
        output.push(renderSplitDiffPair(deletions[pairIndex], additions[pairIndex]));
      }
      continue;
    }
    if (row.kind === "add") {
      output.push(renderSplitDiffPair(undefined, row));
      index += 1;
      continue;
    }
    output.push(renderSplitDiffPair(row, row));
    index += 1;
  }
  return `<table class="ow-diff__table ow-diff__table--split"><tbody>${output.join("")}</tbody></table>`;
}

function renderSplitDiffPair(before: DiffRow | undefined, after: DiffRow | undefined): string {
  const beforeClass = before?.kind === "del" ? " ow-diff__side--del" : before?.kind === "ctx" ? " ow-diff__side--ctx" : "";
  const afterClass = after?.kind === "add" ? " ow-diff__side--add" : after?.kind === "ctx" ? " ow-diff__side--ctx" : "";
  return `<tr class="ow-diff__row ow-diff__row--split">
    <td class="ow-diff__gutter">${before?.oldLine ?? ""}</td>
    <td class="ow-diff__side ow-diff__side--before${beforeClass}"><code>${before === undefined ? "" : before.html ?? escapeHtml(before.text || " ")}</code></td>
    <td class="ow-diff__gutter ow-diff__gutter--new">${after?.newLine ?? ""}</td>
    <td class="ow-diff__side ow-diff__side--after${afterClass}"><code>${after === undefined ? "" : after.html ?? escapeHtml(after.text || " ")}</code></td>
  </tr>`;
}

function hunkLabel(row: DiffRow): string {
  return row.section === undefined ? row.text : `${row.text} / ${row.section}`;
}
