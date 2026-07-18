import { isOpenWikiRole, isOpenWikiScope, type OpenWikiRole, type OpenWikiScope } from "@openwiki/core";

export function parseScopes(value: string | undefined): OpenWikiScope[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(isOpenWikiScope)
    .filter((scope, index, scopes) => scopes.indexOf(scope) === index);
}

export function parseRole(value: string | undefined): OpenWikiRole | undefined {
  return isOpenWikiRole(value) ? value : undefined;
}
