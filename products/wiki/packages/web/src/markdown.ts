import { escapeHtml } from "./html.ts";
import type { MarkdownRenderOptions, MarkdownRenderResult, TocItem } from "./types.ts";
import { cssToken, escapeAttribute, safeDocumentHref } from "./utils.ts";

interface MarkdownListItem {
  text: string;
  checked?: boolean;
  children?: MarkdownListFrame[];
}

interface MarkdownListFrame {
  type: "ul" | "ol";
  indent: number;
  items: MarkdownListItem[];
}

export function renderMarkdown(markdown: string, options: MarkdownRenderOptions = {}): MarkdownRenderResult {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  const toc: TocItem[] = [];
  let paragraph: string[] = [];
  let listStack: MarkdownListFrame[] = [];
  let code: { lang: string; lines: string[] } | undefined;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      output.push(`<p>${renderInline(paragraph.join(" "), options)}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (listStack.length > 0) {
      output.push(renderMarkdownList(listStack[0]!, options));
      listStack = [];
    }
  };
  const addListItem = (type: "ul" | "ol", indent: number, item: MarkdownListItem) => {
    if (listStack.length === 0) {
      listStack.push({ type, indent, items: [] });
    } else {
      while (listStack.length > 0 && indent < listStack[listStack.length - 1]!.indent) {
        listStack.pop();
      }
      const current = listStack[listStack.length - 1];
      if (current === undefined) {
        listStack.push({ type, indent, items: [] });
      } else if (indent > current.indent) {
        const parentItem = current.items[current.items.length - 1];
        if (parentItem === undefined) {
          current.indent = indent;
          current.type = type;
        } else {
          const childFrame: MarkdownListFrame = { type, indent, items: [] };
          parentItem.children = [...(parentItem.children ?? []), childFrame];
          listStack.push(childFrame);
        }
      } else if (current.type !== type) {
        if (listStack.length === 1) {
          flushList();
          listStack.push({ type, indent, items: [] });
        } else {
          listStack.pop();
          const parent = listStack[listStack.length - 1];
          const parentItem = parent?.items[parent.items.length - 1];
          const siblingFrame: MarkdownListFrame = { type, indent, items: [] };
          if (parentItem === undefined) {
            listStack.push(siblingFrame);
          } else {
            parentItem.children = [...(parentItem.children ?? []), siblingFrame];
            listStack.push(siblingFrame);
          }
        }
      }
    }
    listStack[listStack.length - 1]!.items.push(item);
  };
  const flushQuote = () => {
    if (quote.length > 0) {
      output.push(`<blockquote>${quote.map((line) => `<p>${renderInline(line, options)}</p>`).join("")}</blockquote>`);
      quote = [];
    }
  };
  const flushCode = () => {
    if (code !== undefined) {
      const language = cssToken(code.lang || "text");
      output.push(`<pre class="ow-code" data-language="${escapeAttribute(code.lang || "text")}"><button type="button" class="ow-code-copy" data-openwiki-copy-code aria-label="Copy code">Copy</button><code class="language-${escapeAttribute(language)}">${escapeHtml(code.lines.join("\n"))}</code></pre>`);
      code = undefined;
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = /^```([A-Za-z0-9_-]+)?\s*$/.exec(line);
    if (fence) {
      if (code !== undefined) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        flushQuote();
        code = { lang: fence[1] ?? "", lines: [] };
      }
      continue;
    }
    if (code !== undefined) {
      code.lines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      output.push("<hr>");
      continue;
    }
    const table = parseMarkdownTable(lines, index);
    if (table !== undefined) {
      flushParagraph();
      flushList();
      flushQuote();
      output.push(renderMarkdownTable(table, options));
      index = table.endIndex;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      const level = heading[1]?.length ?? 1;
      const text = stripInlineSyntax(heading[2] ?? "");
      const id = uniqueSlug(text, toc);
      toc.push({ id, level, text });
      output.push(`<h${level} id="${escapeAttribute(id)}">${renderInline(text, options)}<a class="ow-heading-anchor" href="#${escapeAttribute(id)}" aria-label="Link to ${escapeAttribute(text)}">#</a></h${level}>`);
      continue;
    }
    const quoteMatch = /^>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1] ?? "");
      continue;
    }
    const unordered = /^(\s*)[-*]\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(line);
    if (unordered) {
      flushParagraph();
      flushQuote();
      const checked = unordered[2] === undefined ? undefined : unordered[2].toLowerCase() === "x";
      addListItem("ul", markdownIndentLevel(unordered[1] ?? ""), { text: unordered[3] ?? "", ...(checked === undefined ? {} : { checked }) });
      continue;
    }
    const ordered = /^(\s*)\d+\.\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      flushQuote();
      addListItem("ol", markdownIndentLevel(ordered[1] ?? ""), { text: ordered[2] ?? "" });
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }
  flushCode();
  flushParagraph();
  flushList();
  flushQuote();
  return { html: `<div class="ow-prose">${output.join("\n")}</div>`, toc };
}

function markdownIndentLevel(spaces: string): number {
  return Math.floor(spaces.replace(/\t/g, "  ").length / 2);
}

function renderMarkdownList(frame: MarkdownListFrame, options: MarkdownRenderOptions): string {
  const listClass = frame.items.some((item) => item.checked !== undefined) ? ` class="contains-task-list"` : "";
  return `<${frame.type}${listClass}>${frame.items.map((item) => renderListItem(item, options)).join("")}</${frame.type}>`;
}

function renderListItem(item: MarkdownListItem, options: MarkdownRenderOptions): string {
  const children = item.children?.map((child) => renderMarkdownList(child, options)).join("") ?? "";
  if (item.checked === undefined) {
    return `<li>${renderInline(item.text, options)}${children}</li>`;
  }
  return `<li class="task-list-item"><input class="task-list-item-checkbox" type="checkbox" aria-label="${escapeAttribute(item.text)}" disabled${item.checked ? " checked" : ""}> ${renderInline(item.text, options)}${children}</li>`;
}

interface MarkdownTable {
  headers: string[];
  rows: string[][];
  endIndex: number;
}

function parseMarkdownTable(lines: string[], startIndex: number): MarkdownTable | undefined {
  const header = lines[startIndex] ?? "";
  const separator = lines[startIndex + 1] ?? "";
  if (!looksLikeTableRow(header) || !isTableSeparator(separator)) {
    return undefined;
  }
  const headers = splitTableRow(header);
  if (headers.length === 0) {
    return undefined;
  }
  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && looksLikeTableRow(lines[index] ?? "") && !isTableSeparator(lines[index] ?? "")) {
    rows.push(splitTableRow(lines[index] ?? ""));
    index += 1;
  }
  return { headers, rows, endIndex: index - 1 };
}

function looksLikeTableRow(line: string): boolean {
  return line.includes("|") && splitTableRow(line).length > 1;
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function renderMarkdownTable(table: MarkdownTable, options: MarkdownRenderOptions): string {
  const width = table.headers.length;
  const header = `<thead><tr>${table.headers.map((cell) => `<th>${renderInline(cell, options)}</th>`).join("")}</tr></thead>`;
  const body = table.rows.length === 0
    ? ""
    : `<tbody>${table.rows
        .map((row) => `<tr>${Array.from({ length: width }, (_value, index) => `<td>${renderInline(row[index] ?? "", options)}</td>`).join("")}</tr>`)
        .join("")}</tbody>`;
  return `<table>${header}${body}</table>`;
}

function renderInline(raw: string, options: MarkdownRenderOptions): string {
  const replacements: string[] = [];
  const token = (html: string): string => {
    const index = replacements.push(html) - 1;
    return `\u0000${index}\u0000`;
  };
  let value = raw
    .replace(/`([^`]+)`/g, (_match, code: string) => token(`<code>${escapeHtml(code)}</code>`))
    .replace(/<((?:https?:\/\/)[^>\s]+)>/g, (_match, href: string) => {
      const resolved = options.resolveLink?.(href) ?? safeHref(href);
      return token(resolved ? renderInlineLink(resolved, href) : escapeHtml(href));
    })
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label: string | undefined) => {
      const href = options.resolveWikiLink?.(target.trim());
      const text = label?.trim() || target.trim();
      return token(href ? `<a class="ow-link ow-link--wiki" href="${escapeAttribute(href)}">${escapeHtml(text)}</a>` : `<span class="ow-link ow-link--unresolved">${escapeHtml(text)}</span>`);
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
      const resolved = options.resolveLink?.(href) ?? safeHref(href);
      return token(resolved ? renderInlineLink(resolved, label) : escapeHtml(label));
    })
    .replace(/\[(\d+)\]/g, (_match, reference: string) => {
      const id = `ref-${reference}`;
      return token(`<sup class="ow-citation"><a href="#${escapeAttribute(id)}">[${escapeHtml(reference)}]</a></sup>`);
    });
  value = escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return value.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => replacements[Number(index)] ?? "");
}

function renderInlineLink(href: string, label: string): string {
  const rel = /^https?:\/\//i.test(href) ? ` rel="noopener noreferrer"` : "";
  return `<a class="ow-link" href="${escapeAttribute(href)}"${rel}>${escapeHtml(label)}</a>`;
}

function safeHref(href: string): string | undefined {
  return safeDocumentHref(href);
}

function stripInlineSyntax(value: string): string {
  return value
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

function uniqueSlug(text: string, toc: TocItem[]): string {
  const base = cssToken(text) || "section";
  const existing = new Set(toc.map((item) => item.id));
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function renderToc(toc: TocItem[]): string {
  if (toc.length === 0) {
    return `<p class="ow-muted">No headings yet.</p>`;
  }
  return `<nav class="ow-toc" aria-label="Page outline">${toc
    .map((item) => `<a class="ow-toc__item ow-toc__item--${item.level}" href="#${escapeAttribute(item.id)}">${escapeHtml(item.text)}</a>`)
    .join("")}</nav>`;
}
