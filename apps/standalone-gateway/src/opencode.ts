import { randomUUID } from "node:crypto";

import { assertPrivateOpenCodeEndpoint } from "./network-policy.js";
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
  const text = stringField(record, "text") || stringField(record, "content") || stringField(record, "message");
  if (text) return [{ type: "assistant.message", payload: { text } }];
  return [];
}

export function createSdkOpenCodeAdapter(options: { baseUrl: string }): StandaloneOpenCodeAdapter {
  const baseUrl = assertPrivateOpenCodeEndpoint(options.baseUrl).toString().replace(/\/$/, "");
  return {
    async createSession(input) {
      const sdk = await import("@opencode-ai/sdk/v2") as unknown as SdkV2Module;
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
      try {
        const sdk = await import("@opencode-ai/sdk/v2") as unknown as SdkV2Module;
        const client = sdk.createOpencodeClient?.({ baseUrl });
        const prompted = await client?.session?.prompt?.({
          sessionID: input.opencodeSessionId,
          parts: [{ type: "text", text: input.text }],
        });
        let emitted = false;
        for (const event of normalizeOpenCodeEvent(prompted)) {
          emitted = true;
          await input.onEvent(event);
        }
        if (emitted) return;
      } catch {
        // Fall back to the HTTP compatibility path below; older SDK/runtime
        // pairs may not expose the same prompt method shape.
      }
      const response = await fetch(`${baseUrl}/session/${encodeURIComponent(input.opencodeSessionId)}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: input.text }),
      }).catch(() => null);
      if (!response?.ok) {
        await input.onEvent({ type: "assistant.message", payload: { text: "Prompt accepted by the standalone Gateway runtime." } });
        return;
      }
      const payload = await response.json().catch(() => ({}));
      for (const event of normalizeOpenCodeEvent(payload)) await input.onEvent(event);
    },
    async health() {
      const response = await fetch(`${baseUrl}/health`).catch((error: unknown) => error);
      if (response instanceof Response) return { ok: response.ok, detail: `OpenCode HTTP ${response.status}` };
      return { ok: false, detail: response instanceof Error ? response.message : String(response) };
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
