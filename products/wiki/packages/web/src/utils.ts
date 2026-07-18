import { escapeHtml } from "./html.ts";

function escapeAttribute(value: string | number | undefined | null): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

export function safeExternalHref(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function safeDocumentHref(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const href = value.trim();
  if (href.length === 0 || /[\u0000-\u001f\u007f]/.test(href) || href.startsWith("//") || href.startsWith("\\") || href.startsWith("/\\")) {
    return undefined;
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    return href;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return undefined;
  }
  return href.startsWith("#") || href.startsWith("/") || href.startsWith("./") || href.startsWith("../") || /^[A-Za-z0-9._~!$&'()*+,;=:@/%?#-]+$/.test(href)
    ? href
    : undefined;
}

function cssToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

export { cssToken, escapeAttribute };
