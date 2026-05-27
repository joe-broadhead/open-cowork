export function chunkText(input: string, maxLength: number): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 100) {
    throw new Error("maxLength must be an integer >= 100");
  }

  if (input.length <= maxLength) {
    return [input];
  }

  const chunks: string[] = [];
  let remaining = input;
  let startsInsideFence = false;

  while (chunkLengthWithFenceRepair(remaining, startsInsideFence) > maxLength) {
    const prefix = startsInsideFence ? "```\n" : "";
    const maxRawLength = maxLength - prefix.length - "\n```".length;
    const window = remaining.slice(0, maxRawLength);
    const splitAt = findSplitPoint(window, Math.floor(maxLength * 0.65));
    const rawChunk = window.slice(0, splitAt).trimEnd();
    const endsInsideFence = fenceOpenAfter(rawChunk, startsInsideFence);
    const suffix = endsInsideFence ? "\n```" : "";
    chunks.push(`${prefix}${rawChunk}${suffix}`);
    remaining = remaining.slice(splitAt);
    remaining = endsInsideFence ? trimOneLeadingNewline(remaining) : remaining.trimStart();
    startsInsideFence = endsInsideFence;
  }

  if (remaining.length > 0) {
    const prefix = startsInsideFence ? "```\n" : "";
    const closesInsideFence = fenceOpenAfter(remaining, startsInsideFence);
    const suffix = closesInsideFence ? "\n```" : "";
    chunks.push(`${prefix}${remaining}${suffix}`);
  }

  return chunks;
}

export function fitText(input: string, maxLength: number, omission = "\n...[truncated]"): string {
  if (!Number.isInteger(maxLength) || maxLength < 20) {
    throw new Error("maxLength must be an integer >= 20");
  }
  if (input.length <= maxLength) {
    return input;
  }

  const suffix = omission.length < maxLength ? omission : omission.slice(0, maxLength);
  return `${input.slice(0, maxLength - suffix.length).trimEnd()}${suffix}`;
}

function findSplitPoint(window: string, minimum: number): number {
  const candidates = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")];
  for (const candidate of candidates) {
    if (candidate >= minimum) {
      return candidate;
    }
  }
  return window.length;
}

function chunkLengthWithFenceRepair(input: string, startsInsideFence: boolean): number {
  const prefixLength = startsInsideFence ? "```\n".length : 0;
  const suffixLength = fenceOpenAfter(input, startsInsideFence) ? "\n```".length : 0;
  return prefixLength + input.length + suffixLength;
}

function fenceOpenAfter(input: string, startsInsideFence: boolean): boolean {
  let inside = startsInsideFence;
  for (const line of input.split("\n")) {
    if (/^\s*```/.test(line)) {
      inside = !inside;
    }
  }
  return inside;
}

function trimOneLeadingNewline(input: string): string {
  if (input.startsWith("\r\n")) {
    return input.slice(2);
  }
  if (input.startsWith("\n")) {
    return input.slice(1);
  }
  return input;
}
