import { randomUUID } from "node:crypto";
import { MCP_PROTOCOL_VERSION, type McpToolMode } from "@openwiki/mcp-server";
import {
  deletePostgresMcpHttpSession,
  expirePostgresMcpHttpSessions,
  readPostgresMcpHttpSession,
  touchPostgresMcpHttpSession,
  upsertPostgresMcpHttpSession,
} from "@openwiki/postgres-runtime";
import type { HttpPolicyOptions, HttpRequestContext } from "./types.ts";
import {
  checkRateLimit,
  operationalStateBackend,
  recordHttpRequestMetric,
  recordMcpToolMetric,
  recordRateLimitRejection,
  type OperationalRoute,
  type RateLimitDecision,
} from "./operational.ts";

export const MCP_HTTP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MCP_HTTP_STREAM_RETRY_MS = 15_000;

export interface McpHttpSession {
  id: string;
  root: string;
  toolMode: McpToolMode;
  protocolVersion: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpSessionStore {
  create(root: string, toolMode: McpToolMode): Promise<McpHttpSession>;
  read(root: string, sessionId: string): Promise<McpHttpSession | undefined>;
  touch(root: string, session: McpHttpSession): Promise<void>;
  delete(root: string, sessionId: string): Promise<void>;
  expire(root: string): Promise<void>;
}

export interface McpHttpRateLimiter {
  check(root: string, route: OperationalRoute, policy: HttpPolicyOptions, context: HttpRequestContext): Promise<RateLimitDecision>;
  recordRejection(route: OperationalRoute, decision: RateLimitDecision): void;
}

export interface McpHttpMetricsSink {
  recordRequest(route: OperationalRoute, status: number, durationMs: number): void;
  recordTool(tool: string, mode: McpToolMode, status: string, durationMs: number): void;
}

export interface McpHttpStreamRuntime {
  retryMs: number;
  heartbeat(now: Date): string;
}

export interface McpHttpRuntime {
  sessionStore?: McpSessionStore;
  rateLimiter?: McpHttpRateLimiter;
  metrics?: McpHttpMetricsSink;
  stream?: McpHttpStreamRuntime;
}

export async function resolveMcpHttpRuntime(root: string, runtime: McpHttpRuntime = {}): Promise<Required<McpHttpRuntime>> {
  return {
    sessionStore: runtime.sessionStore ?? await defaultMcpSessionStore(root),
    rateLimiter: runtime.rateLimiter ?? defaultMcpHttpRateLimiter,
    metrics: runtime.metrics ?? defaultMcpHttpMetricsSink,
    stream: runtime.stream ?? defaultMcpHttpStreamRuntime,
  };
}

export function createMemoryMcpSessionStore(input: { protocolVersion: string; now?: () => number } = { protocolVersion: MCP_PROTOCOL_VERSION }): McpSessionStore {
  const sessions = new Map<string, McpHttpSession>();
  const now = input.now ?? Date.now;
  return {
    async create(root, toolMode) {
      const session = newMcpHttpSession(root, toolMode, input.protocolVersion, now());
      sessions.set(session.id, session);
      return session;
    },
    async read(root, sessionId) {
      const session = sessions.get(sessionId);
      if (session !== undefined && (session.root !== root || mcpHttpSessionExpired(session, now()))) {
        sessions.delete(session.id);
        return undefined;
      }
      return session;
    },
    async touch(_root, session) {
      session.updatedAt = now();
    },
    async delete(_root, sessionId) {
      sessions.delete(sessionId);
    },
    async expire() {
      for (const session of sessions.values()) {
        if (mcpHttpSessionExpired(session, now())) {
          sessions.delete(session.id);
        }
      }
    },
  };
}

export function createPostgresMcpSessionStore(input: { protocolVersion: string; now?: () => number } = { protocolVersion: MCP_PROTOCOL_VERSION }): McpSessionStore {
  const now = input.now ?? Date.now;
  return {
    async create(root, toolMode) {
      const session = newMcpHttpSession(root, toolMode, input.protocolVersion, now());
      await upsertPostgresMcpHttpSession({ root, session, ttlMs: MCP_HTTP_SESSION_TTL_MS });
      return session;
    },
    async read(root, sessionId) {
      return readPostgresMcpHttpSession({ root, sessionId });
    },
    async touch(root, session) {
      const updatedAt = now();
      session.updatedAt = updatedAt;
      await touchPostgresMcpHttpSession({ root, sessionId: session.id, updatedAt, ttlMs: MCP_HTTP_SESSION_TTL_MS });
    },
    async delete(root, sessionId) {
      await deletePostgresMcpHttpSession({ root, sessionId });
    },
    async expire(root) {
      await expirePostgresMcpHttpSessions({ root });
    },
  };
}

export function mcpHttpSessionExpired(session: McpHttpSession, now = Date.now()): boolean {
  return now - session.updatedAt > MCP_HTTP_SESSION_TTL_MS;
}

async function defaultMcpSessionStore(root: string): Promise<McpSessionStore> {
  return (await operationalStateBackend(root)) === "postgres" ? postgresMcpSessionStore : memoryMcpSessionStore;
}

function newMcpHttpSession(root: string, toolMode: McpToolMode, protocolVersion: string, now: number): McpHttpSession {
  return { id: randomUUID(), root, toolMode, protocolVersion, createdAt: now, updatedAt: now };
}

const memoryMcpSessionStore = createMemoryMcpSessionStore({ protocolVersion: MCP_PROTOCOL_VERSION });
const postgresMcpSessionStore = createPostgresMcpSessionStore({ protocolVersion: MCP_PROTOCOL_VERSION });

const defaultMcpHttpRateLimiter: McpHttpRateLimiter = {
  check: checkRateLimit,
  recordRejection: recordRateLimitRejection,
};

const defaultMcpHttpMetricsSink: McpHttpMetricsSink = {
  recordRequest: recordHttpRequestMetric,
  recordTool: recordMcpToolMetric,
};

const defaultMcpHttpStreamRuntime: McpHttpStreamRuntime = {
  retryMs: MCP_HTTP_STREAM_RETRY_MS,
  heartbeat: (now) => `: heartbeat ${now.toISOString()}\n\n`,
};
