export type OpenWikiPrincipalKind = "group" | "user" | "agent" | "service_account" | "role" | "actor" | "principal";

export function openWikiPrincipalTypeForId(id: string): OpenWikiPrincipalKind {
  if (id.startsWith("group:")) {
    return "group";
  }
  if (id.startsWith("service:")) {
    return "service_account";
  }
  if (id.startsWith("actor:user:")) {
    return "user";
  }
  if (id.startsWith("actor:agent:")) {
    return "agent";
  }
  if (id.startsWith("actor:")) {
    return "actor";
  }
  if (id.startsWith("role:")) {
    return "role";
  }
  return "principal";
}

export function openWikiPrincipalTitle(id: string): string {
  const parts = id.split(":");
  return parts[parts.length - 1]?.replace(/[-_]/g, " ") ?? id;
}
