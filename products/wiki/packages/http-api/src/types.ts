import type { Server } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { OpenWikiRole, OpenWikiScope, PolicyBounds } from "@openwiki/policy";

export interface HttpApiOptions {
  root: string;
  host?: string;
  port?: number;
  defaultPolicy?: HttpPolicyOptions;
}

export interface StartedHttpApi {
  server: Server;
  url: string;
  close(options?: HttpApiCloseOptions): Promise<void>;
}

export interface HttpApiCloseOptions {
  timeoutMs?: number;
}

export interface HttpRouteResult {
  status: number;
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface HttpRequestContext {
  requestId?: string | undefined;
  remoteAddress?: string | undefined;
  headers?: IncomingHttpHeaders | undefined;
  rawBody?: string | undefined;
  logger?: ((entry: Record<string, unknown>) => void) | undefined;
  policyResolved?: boolean | undefined;
}

export interface HttpPolicyOptions {
  scopes?: OpenWikiScope[];
  actorId?: string;
  role?: OpenWikiRole;
  token?: string;
  principals?: string[];
  bounds?: PolicyBounds;
  authMethod?: "scope-token" | "service-account" | "trusted-headers" | "oauth";
  serviceAccountId?: string;
  oauthClientId?: string;
  oauthTokenId?: string;
  trustHeaders?: boolean;
  trustedHeaderSecret?: string;
}
