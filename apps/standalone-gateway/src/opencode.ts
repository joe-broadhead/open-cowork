import { randomUUID } from "node:crypto";

import { assertPrivateOpenCodeEndpoint } from "./network-policy.js";
import { redactSecretText } from "./redaction.js";
import type { StandaloneRuntimeEvent } from "./types.js";

export interface StandaloneOpenCodeAdapter {
  createSession(input: { title: string }): Promise<{ opencodeSessionId: string }>;
  prompt(input: {
    opencodeSessionId: string;
    text: string;
    onEvent(event: StandaloneRuntimeEvent): Promise<void> | void;
  }): Promise<void>;
  abort?(opencodeSessionId: string): Promise<void>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export function normalizeOpenCodeEvent(event: unknown): StandaloneRuntimeEvent[] {
  if (!event || typeof event !== "object") return [];
  const record = event as Record<string, unknown>;
  const type = String(record.type || record.event || "");
  if (type.includes("permission") && (type.includes("request") || type.includes("ask"))) {
    return [{ type: "permission.requested", entityId: stringField(record, "id"), payload: publicPayload(record) }];
  }
  if (type.includes("question") && (type.includes("ask") || type.includes("request"))) {
    return [{ type: "question.asked", entityId: stringField(record, "id"), payload: publicPayload(record) }];
  }
  if (type.includes("tool") && (type.includes("start") || type.includes("call"))) {
    return [{ type: "tool.started", entityId: stringField(record, "id"), payload: publicPayload(record) }];
  }
  if (type.includes("tool") && (type.includes("complete") || type.includes("finish"))) {
    return [{ type: "tool.completed", entityId: stringField(record, "id"), payload: publicPayload(record) }];
  }
  if (type.includes("tool") && type.includes("fail")) {
    return [{ type: "tool.failed", entityId: stringField(record, "id"), payload: publicPayload(record) }];
  }
  if (type.includes("reasoning") || type.includes("thought")) return [];
  const text = stringField(record, "text") || stringField(record, "content") || stringField(record, "message");
  if (text) return [{ type: "assistant.message", payload: { text } }];
  return [];
}

export function createSdkOpenCodeAdapter(options: {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  loadSdk?: () => Promise<SdkV2Module>;
}): StandaloneOpenCodeAdapter {
  const baseUrl = assertPrivateOpenCodeEndpoint(options.baseUrl).toString().replace(/\/$/, "");
  const fetchImpl = options.fetch || globalThis.fetch;
  const loadSdk = options.loadSdk || (async () => await import("@opencode-ai/sdk/v2") as unknown as SdkV2Module);
  return {
    async createSession(input) {
      const sdk = await loadSdk();
      const clientFactory = sdk.createOpencodeClient;
      if (typeof clientFactory === "function") {
        const client = clientFactory({ baseUrl });
        const created = await client.session?.create?.({ title: input.title });
        const data = unwrapData(created);
        return { opencodeSessionId: stringField(data, "id") || stringField(data, "sessionID") || randomUUID() };
      }
      return { opencodeSessionId: randomUUID() };
    },
    async prompt(input) {
      const sdk = await loadSdk();
      const clientFactory = sdk.createOpencodeClient;
      if (typeof clientFactory === "function") {
        const client = clientFactory({ baseUrl });
        if (typeof client?.session?.prompt === "function") {
          let prompted: unknown;
          try {
            prompted = await client.session.prompt({
              sessionID: input.opencodeSessionId,
              parts: [{ type: "text", text: input.text }],
            });
          } catch (error) {
            throw new Error(`OpenCode SDK prompt failed: ${redactOpenCodeError(error)}`, { cause: error });
          }
          const error = sdkPromptError(prompted);
          if (error) throw error;
          for (const event of normalizeOpenCodePromptResult(prompted)) {
            await input.onEvent(event);
          }
          return;
        }
      }
      await promptViaHttp(baseUrl, fetchImpl, input);
    },
    async health() {
      return healthViaHttp(baseUrl, fetchImpl);
    },
  };
}

type SdkV2Module = {
  createOpencodeClient?: (config: { baseUrl: string }) => {
    session?: {
      create?: (input: { title: string }) => Promise<unknown>;
      prompt?: (input: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

async function promptViaHttp(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch,
  input: Parameters<StandaloneOpenCodeAdapter["prompt"]>[0],
): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/session/${encodeURIComponent(input.opencodeSessionId)}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: input.text }),
  }).catch((error: unknown) => {
    throw new Error(`OpenCode prompt request failed: ${redactOpenCodeError(error)}`);
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`OpenCode prompt request returned HTTP ${response.status}${detail ? `: ${redactOpenCodeText(detail)}` : ""}`);
  }
  if (response.status === 204) return;
  const payload = await response.json().catch(() => ({}));
  for (const event of normalizeOpenCodeEvent(payload)) await input.onEvent(event);
}

async function healthViaHttp(baseUrl: string, fetchImpl: typeof globalThis.fetch): Promise<{ ok: boolean; detail: string }> {
  const response = await fetchImpl(`${baseUrl}/health`).catch((error: unknown) => error);
  if (response instanceof Response) return { ok: response.ok, detail: `OpenCode HTTP ${response.status}` };
  return { ok: false, detail: response instanceof Error ? redactOpenCodeText(response.message) : redactOpenCodeText(String(response)) };
}

function redactOpenCodeError(error: unknown): string {
  return redactOpenCodeText(error instanceof Error ? error.message : String(error));
}

function redactOpenCodeText(value: string): string {
  return redactSecretText(value, 500);
}

function normalizeOpenCodePromptResult(result: unknown): StandaloneRuntimeEvent[] {
  const events = [...normalizeOpenCodeEvent(result)];
  const record = objectRecord(result);
  const data = unwrapData(result);
  if (data !== record) events.push(...normalizeOpenCodeEvent(data));
  for (const value of arrayField(data, "parts")) events.push(...normalizeOpenCodePart(value));
  for (const value of arrayField(data, "events")) events.push(...normalizeOpenCodeEvent(value));
  for (const value of arrayField(data, "messages")) events.push(...normalizeOpenCodeEvent(value));
  return events;
}

function normalizeOpenCodePart(value: unknown): StandaloneRuntimeEvent[] {
  const record = objectRecord(value);
  const type = String(record.type || "");
  if (type && type !== "text") return [];
  return normalizeOpenCodeEvent(record);
}

function sdkPromptError(result: unknown): Error | null {
  const record = objectRecord(result);
  const error = record.error;
  if (error) {
    return new Error(`OpenCode SDK prompt failed: ${redactOpenCodeText(errorMessage(error))}`);
  }
  const response = objectRecord(record.response);
  const status = typeof response.status === "number" ? response.status : null;
  if (status !== null && status >= 400) {
    return new Error(`OpenCode SDK prompt returned HTTP ${status}.`);
  }
  return null;
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const record = objectRecord(error);
  return stringField(record, "message")
    || stringField(record, "detail")
    || JSON.stringify(record);
}

export class FakeStandaloneOpenCodeAdapter implements StandaloneOpenCodeAdapter {
  readonly prompts: Array<{ opencodeSessionId: string; text: string }> = [];

  async createSession(): Promise<{ opencodeSessionId: string }> {
    return { opencodeSessionId: `oc-${randomUUID()}` };
  }

  async prompt(input: { opencodeSessionId: string; text: string; onEvent(event: StandaloneRuntimeEvent): Promise<void> | void }): Promise<void> {
    this.prompts.push({ opencodeSessionId: input.opencodeSessionId, text: input.text });
    await input.onEvent({ type: "assistant.message", payload: { text: `Standalone response: ${input.text}` } });
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "fake opencode ready" };
  }
}

function publicPayload(record: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !/token|secret|password|key/i.test(key)));
}

function unwrapData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  return record;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
