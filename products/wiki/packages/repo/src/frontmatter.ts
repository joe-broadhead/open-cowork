type FrontmatterValue = string | number | boolean | string[] | Record<string, unknown>;
export type Frontmatter = Record<string, FrontmatterValue>;

/** Parse a Markdown document with OpenWiki's small YAML-frontmatter subset. */
export function parseMarkdownWithFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, body: raw };
  }
  const close = raw.indexOf("\n---", 4);
  if (close === -1) {
    throw new Error("Markdown frontmatter was opened but not closed");
  }
  const yaml = raw.slice(4, close);
  const body = raw.slice(close + 4);
  return { frontmatter: parseYamlSubset(yaml), body };
}

/** Parse OpenWiki manifest/proposal YAML without accepting arbitrary YAML features. */
export function parseYamlSubset(raw: string): Frontmatter {
  const result: Frontmatter = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.trim() || line.trimStart().startsWith("#") || /^\s/.test(line)) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const key = match[1] ?? "";
    const rest = match[2] ?? "";
    if (rest.trim()) {
      result[key] = parseScalar(rest.trim());
      continue;
    }

    const nested: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && /^\s+/.test(lines[cursor] ?? "")) {
      nested.push(lines[cursor] ?? "");
      cursor += 1;
    }
    index = cursor - 1;
    result[key] = parseNestedYaml(nested);
  }
  return result;
}

function parseNestedYaml(lines: string[]): string[] | Record<string, unknown> {
  const trimmed = lines.map((line) => line.trim()).filter(Boolean);
  if (trimmed.every((line) => line.startsWith("- "))) {
    return trimmed.map((line) => String(parseScalar(line.slice(2).trim())));
  }

  const object: Record<string, unknown> = {};
  for (const line of trimmed) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) {
      object[match[1] ?? ""] = parseScalar(match[2] ?? "");
    }
  }
  return object;
}

function parseScalar(raw: string): string | number | boolean | string[] {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => stripQuotes(item.trim()))
      .filter(Boolean);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return stripQuotes(value);
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Fall through to the legacy outer-quote strip for hand-written malformed YAML.
    }
    return value.slice(1, -1);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/** Render a scalar safely for OpenWiki's YAML subset. */
export function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value) && !isYamlTypedPlainScalar(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function isYamlTypedPlainScalar(value: string): boolean {
  return /^(?:true|false|null|~|-?\d+(?:\.\d+)?)$/i.test(value.trim());
}
