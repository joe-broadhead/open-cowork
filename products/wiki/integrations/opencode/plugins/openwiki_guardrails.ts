export interface OpenWikiGuardrailDecision {
  allowed: boolean;
  reason: string;
}

const CANONICAL_PAGE_PATTERN = /(^|\/)wiki\/.+\.md$/;

export function reviewOpenWikiWrite(path: string, mode: "client" | "maintainer"): OpenWikiGuardrailDecision {
  if (mode === "maintainer") {
    return { allowed: true, reason: "Maintainer mode may edit isolated worktrees before validation." };
  }
  if (CANONICAL_PAGE_PATTERN.test(path)) {
    return {
      allowed: false,
      reason: "Client mode should create an OpenWiki proposal instead of editing canonical pages directly.",
    };
  }
  return { allowed: true, reason: "Path is outside canonical wiki page content." };
}
