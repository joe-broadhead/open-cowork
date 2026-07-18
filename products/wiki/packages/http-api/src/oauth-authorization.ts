import type { OpenWikiRole, OpenWikiScope } from "@openwiki/core";
import { scopesForRole, uniqueScopes } from "@openwiki/policy";
import type { HttpPolicyOptions } from "./types.ts";

export function policyEffectiveScopes(policy: HttpPolicyOptions): OpenWikiScope[] {
  return uniqueScopes(policy.scopes ?? (policy.role === undefined ? scopesForRole("viewer") : scopesForRole(policy.role)));
}

export function scopesAllowedByPolicy(scopes: OpenWikiScope[], policyScopes: OpenWikiScope[]): boolean {
  const allowed = new Set(policyScopes);
  return scopes.every((scope) => allowed.has(scope) || allowed.has("wiki:admin"));
}

export function oauthAuthorizationRole(clientRole: OpenWikiRole | undefined, policyRole: OpenWikiRole | undefined): OpenWikiRole | undefined {
  if (clientRole === undefined) {
    return policyRole;
  }
  if (policyRole === undefined) {
    return undefined;
  }
  return roleLevel(clientRole) <= roleLevel(policyRole) ? clientRole : policyRole;
}

export function oauthAuthorizationPrincipals(
  client: { principals?: string[] },
  policy: Pick<HttpPolicyOptions, "principals">,
  policyScopes: OpenWikiScope[],
): string[] {
  if (policyScopes.includes("wiki:admin")) {
    return [...(client.principals ?? []), ...(policy.principals ?? [])];
  }
  const policyPrincipals = new Set(policy.principals ?? []);
  return [
    ...(policy.principals ?? []),
    ...(client.principals ?? []).filter((principal) => policyPrincipals.has(principal)),
  ];
}

function roleLevel(role: OpenWikiRole): number {
  switch (role) {
    case "admin":
      return 6;
    case "maintainer":
      return 5;
    case "reviewer":
      return 4;
    case "researcher":
    case "contributor":
    case "agent":
      return 3;
    case "viewer":
      return 1;
  }
}
