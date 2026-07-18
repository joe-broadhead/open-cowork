export function normalizeOpenWikiHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function isBlockedOpenWikiHost(hostname: string): boolean {
  const normalized = normalizeOpenWikiHost(hostname);
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".home.arpa") ||
    normalized === "metadata.google.internal" ||
    normalized === "169.254.169.254"
  ) {
    return true;
  }

  const ipv4 = parseOpenWikiIPv4Literal(normalized);
  if (ipv4 !== undefined) {
    return isBlockedOpenWikiIPv4(ipv4);
  }

  if (normalized.includes(":")) {
    return isBlockedOpenWikiIPv6(normalized);
  }

  return false;
}

export function parseOpenWikiIPv4Literal(hostname: string): number | undefined {
  const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (dotted) {
    const octets = dotted.slice(1).map((value) => Number(value));
    if (octets.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
      return ((octets[0] ?? 0) << 24) >>> 0 | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    }
    return undefined;
  }

  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    const parsed = Number.parseInt(hostname.slice(2), 16);
    return parsed >= 0 && parsed <= 0xffffffff ? parsed : undefined;
  }

  if (/^\d+$/.test(hostname)) {
    const parsed = Number(hostname);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffffff ? parsed : undefined;
  }

  return undefined;
}

export function openWikiIPv4ToDotted(ip: number): string {
  return `${(ip >>> 24) & 255}.${(ip >>> 16) & 255}.${(ip >>> 8) & 255}.${ip & 255}`;
}

function isBlockedOpenWikiIPv4(ip: number): boolean {
  const first = (ip >>> 24) & 255;
  const second = (ip >>> 16) & 255;
  if (first === 0 || first === 10 || first === 127 || first >= 224) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  return first === 198 && (second === 18 || second === 19);
}

function isBlockedOpenWikiIPv6(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  const words = parseOpenWikiIPv6Words(lower);
  if (words === undefined) {
    return true;
  }
  if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) {
    return true;
  }
  if (isIPv4MappedIPv6(words)) {
    return isBlockedOpenWikiIPv4(((words[6] ?? 0) << 16) | (words[7] ?? 0));
  }
  if (isIPv4TranslationPrefix(words)) {
    return true;
  }
  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) {
    return true;
  }
  return (
    first === 0x0100 && words.slice(1, 4).every((word) => word === 0) ||
    first === 0x2002 ||
    (first === 0x2001 && second === 0x0000) ||
    (first === 0x2001 && second === 0x0002) ||
    (first === 0x2001 && second === 0x0db8)
  );
}

function parseOpenWikiIPv6Words(hostname: string): number[] | undefined {
  const withoutZone = hostname.split("%", 1)[0] ?? hostname;
  const value = withoutZone.includes(".") ? replaceEmbeddedIPv4(withoutZone) : withoutZone;
  const sections = value.split("::");
  if (sections.length > 2) {
    return undefined;
  }
  const left = parseIPv6Parts(sections[0] ?? "");
  const right = sections.length === 2 ? parseIPv6Parts(sections[1] ?? "") : [];
  if (left === undefined || right === undefined) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  if (sections.length === 1 && missing !== 0 || sections.length === 2 && missing < 1) {
    return undefined;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function parseIPv6Parts(value: string): number[] | undefined {
  if (value.length === 0) {
    return [];
  }
  const words = value.split(":").map((part) => /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : Number.NaN);
  return words.some((word) => !Number.isFinite(word) || word < 0 || word > 0xffff) ? undefined : words;
}

function replaceEmbeddedIPv4(value: string): string {
  const lastColon = value.lastIndexOf(":");
  if (lastColon < 0) {
    return value;
  }
  const mapped = parseOpenWikiIPv4Literal(value.slice(lastColon + 1));
  if (mapped === undefined) {
    return value;
  }
  return `${value.slice(0, lastColon)}:${((mapped >>> 16) & 0xffff).toString(16)}:${(mapped & 0xffff).toString(16)}`;
}

function isIPv4MappedIPv6(words: number[]): boolean {
  return words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
}

function isIPv4TranslationPrefix(words: number[]): boolean {
  return (
    words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0 ||
    words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001
  );
}
