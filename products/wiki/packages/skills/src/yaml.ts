export type OpenWikiYamlScalar = string | number | boolean | null;
export type OpenWikiYamlValue = OpenWikiYamlScalar | OpenWikiYamlValue[] | { [key: string]: OpenWikiYamlValue };

interface YamlLine {
  indent: number;
  content: string;
  line: number;
}

interface ParseState {
  lines: YamlLine[];
  index: number;
  sourcePath: string;
}

export class OpenWikiYamlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenWikiYamlError";
  }
}

export function parseOpenWikiYaml(input: string, sourcePath = "inline.yaml"): Record<string, OpenWikiYamlValue> {
  const lines = tokenizeYaml(input, sourcePath);
  if (lines.length === 0) {
    return {};
  }
  const state: ParseState = { lines, index: 0, sourcePath };
  const value = parseBlock(state, lines[0]?.indent ?? 0);
  if (state.index < lines.length) {
    const line = lines[state.index];
    throw yamlError(state, line, "Unexpected trailing YAML content");
  }
  if (!isYamlObject(value)) {
    throw new OpenWikiYamlError(`${sourcePath}: YAML document must be an object`);
  }
  return value;
}

export function yamlObject(value: OpenWikiYamlValue | undefined, label: string): Record<string, OpenWikiYamlValue> {
  if (value === undefined || !isYamlObject(value)) {
    throw new OpenWikiYamlError(`${label} must be an object`);
  }
  return value;
}

export function yamlString(value: OpenWikiYamlValue | undefined, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OpenWikiYamlError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function yamlOptionalString(value: OpenWikiYamlValue | undefined, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return yamlString(value, label);
}

export function yamlStringArray(value: OpenWikiYamlValue | undefined, label: string, options: { minItems?: number } = {}): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new OpenWikiYamlError(`${label} must be an array of non-empty strings`);
  }
  const values = value.map((item) => String(item).trim());
  if (values.length < (options.minItems ?? 0)) {
    throw new OpenWikiYamlError(`${label} must contain at least ${options.minItems} item(s)`);
  }
  return values;
}

export function yamlOptionalStringArray(value: OpenWikiYamlValue | undefined, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return yamlStringArray(value, label);
}

export function assertYamlKnownKeys(record: Record<string, OpenWikiYamlValue>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new OpenWikiYamlError(`${label} contains unsupported field '${key}'`);
    }
  }
}

function tokenizeYaml(input: string, sourcePath: string): YamlLine[] {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((raw, index): YamlLine | undefined => {
      if (raw.includes("\t")) {
        throw new OpenWikiYamlError(`${sourcePath}:${index + 1}: tabs are not supported in OpenWiki YAML`);
      }
      const withoutComment = stripYamlComment(raw).trimEnd();
      if (withoutComment.trim().length === 0) {
        return undefined;
      }
      const indent = withoutComment.match(/^ */)?.[0].length ?? 0;
      if (indent % 2 !== 0) {
        throw new OpenWikiYamlError(`${sourcePath}:${index + 1}: indentation must use two-space steps`);
      }
      return { indent, content: withoutComment.trimStart(), line: index + 1 };
    })
    .filter((line): line is YamlLine => line !== undefined);
}

function parseBlock(state: ParseState, indent: number): OpenWikiYamlValue {
  const line = state.lines[state.index];
  if (line === undefined) {
    return {};
  }
  if (line.indent < indent) {
    return {};
  }
  if (line.indent > indent) {
    throw yamlError(state, line, `Expected indentation ${indent}, got ${line.indent}`);
  }
  return line.content.startsWith("- ") ? parseArray(state, indent) : parseObject(state, indent);
}

function parseObject(state: ParseState, indent: number): Record<string, OpenWikiYamlValue> {
  const output = yamlRecord();
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw yamlError(state, line, `Unexpected indentation ${line.indent}`);
    }
    if (line.content.startsWith("- ")) {
      break;
    }
    const [key, rest] = splitYamlKey(line.content, state, line);
    if (Object.prototype.hasOwnProperty.call(output, key)) {
      throw yamlError(state, line, `Duplicate YAML key '${key}'`);
    }
    state.index += 1;
    if (rest.length === 0) {
      const next = state.lines[state.index];
      output[key] = next !== undefined && next.indent > indent ? parseBlock(state, indent + 2) : {};
    } else {
      output[key] = parseInlineValue(rest, state, line);
    }
  }
  return output;
}

function parseArray(state: ParseState, indent: number): OpenWikiYamlValue[] {
  const output: OpenWikiYamlValue[] = [];
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined || line.indent < indent) {
      break;
    }
    if (line.indent > indent) {
      throw yamlError(state, line, `Unexpected indentation ${line.indent}`);
    }
    if (!line.content.startsWith("- ")) {
      break;
    }
    const rest = line.content.slice(2).trim();
    state.index += 1;
    if (rest.length === 0) {
      output.push(parseBlock(state, indent + 2));
      continue;
    }
    if (/^[A-Za-z0-9_.-]+:/.test(rest)) {
      const [key, value] = splitYamlKey(rest, state, line);
      const item = yamlRecord();
      item[key] = value.length === 0 ? {} : parseInlineValue(value, state, line);
      const next = state.lines[state.index];
      if (next !== undefined && next.indent > indent) {
        const nested = parseBlock(state, indent + 2);
        if (!isYamlObject(nested)) {
          throw yamlError(state, next, "Array object continuation must be an object");
        }
        for (const [nestedKey, nestedValue] of Object.entries(nested)) {
          if (Object.prototype.hasOwnProperty.call(item, nestedKey)) {
            throw yamlError(state, next, `Duplicate YAML key '${nestedKey}'`);
          }
          item[nestedKey] = nestedValue;
        }
      }
      output.push(item);
    } else {
      output.push(parseInlineValue(rest, state, line));
    }
  }
  return output;
}

function splitYamlKey(content: string, state: ParseState, line: YamlLine): [string, string] {
  const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(content);
  if (match === null) {
    throw yamlError(state, line, "Expected 'key: value' YAML entry");
  }
  const key = match[1]?.trim() ?? "";
  if (key.length === 0) {
    throw yamlError(state, line, "YAML key cannot be empty");
  }
  if (isUnsafeYamlKey(key)) {
    throw yamlError(state, line, `YAML key '${key}' is not supported`);
  }
  return [key, (match[2] ?? "").trim()];
}

function yamlRecord(): Record<string, OpenWikiYamlValue> {
  return Object.create(null) as Record<string, OpenWikiYamlValue>;
}

function isUnsafeYamlKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function parseInlineValue(raw: string, state: ParseState, line: YamlLine): OpenWikiYamlValue {
  if (raw === "null" || raw === "~") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return splitInlineArray(inner).map((item) => parseInlineValue(item, state, line));
  }
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return unquoteYamlString(raw);
  }
  if (raw.startsWith("{") || raw.startsWith("[") || raw.includes(": ")) {
    throw yamlError(state, line, "Unsupported inline YAML structure");
  }
  return raw;
}

function splitInlineArray(raw: string): string[] {
  const values: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === "\"" || char === "'") && raw[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
    }
    if (char === "," && quote === undefined) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  values.push(current.trim());
  return values;
}

function stripYamlComment(raw: string): string {
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if ((char === "\"" || char === "'") && raw[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
    }
    if (char === "#" && quote === undefined && (index === 0 || /\s/.test(raw[index - 1] ?? ""))) {
      return raw.slice(0, index);
    }
  }
  return raw;
}

function unquoteYamlString(raw: string): string {
  const quote = raw[0];
  const inner = raw.slice(1, -1);
  if (quote === "\"") {
    return inner.replace(/\\"/g, "\"").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  return inner.replace(/''/g, "'");
}

function isYamlObject(value: OpenWikiYamlValue): value is Record<string, OpenWikiYamlValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function yamlError(state: ParseState, line: YamlLine | undefined, message: string): OpenWikiYamlError {
  return new OpenWikiYamlError(`${state.sourcePath}${line === undefined ? "" : `:${line.line}`}: ${message}`);
}
