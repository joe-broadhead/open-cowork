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
  const source = parseEvent(event);
  const envelope = objectRecord(source);
  const nested = objectRecord(envelope.data);
  const properties = Object.keys(objectRecord(envelope.properties)).length > 0
    ? objectRecord(envelope.properties)
    : nested;
  const type = stringField(envelope, "type") || stringField(nested, "type") || "";

  if (type === "permission.v2.asked" || type === "permission.asked") {
    return [{
      type: "permission.requested",
      entityId: stringField(properties, "id") || stringField(envelope, "id"),
      payload: publicPayload(properties),
    }];
  }
  if (type === "question.v2.asked" || type === "question.asked") {
    return [{
      type: "question.asked",
      entityId: stringField(properties, "id") || stringField(envelope, "id"),
      payload: publicPayload(properties),
    }];
  }
  if (type === "session.next.tool.called") {
    return [{
      type: "tool.started",
      entityId: stringField(properties, "callID") || stringField(envelope, "id"),
      payload: publicPayload(properties),
    }];
  }
  if (type === "session.next.tool.success") {
    return [{
      type: "tool.completed",
      entityId: stringField(properties, "callID") || stringField(envelope, "id"),
      payload: publicPayload(properties),
    }];
  }
  if (type === "session.next.tool.failed") {
    return [{
      type: "tool.failed",
      entityId: stringField(properties, "callID") || stringField(envelope, "id"),
      payload: publicPayload(properties),
    }];
  }
  if (type === "session.next.text.ended") {
    const text = stringField(properties, "text");
    return text ? [{ type: "assistant.message", payload: { text } }] : [];
  }
  if (type === "session.next.step.failed" || type === "session.error") {
    return [{ type: "session.error", payload: publicPayload(properties) }];
  }

  // Reasoning and streaming deltas are intentionally private. The durable text-ended
  // event contains the complete assistant text and avoids duplicate channel replies.
  return [];
}

export function createSdkOpenCodeAdapter(options: {
  baseUrl: string;
  loadSdk?: () => Promise<SdkV2Module>;
}): StandaloneOpenCodeAdapter {
  const baseUrl = assertPrivateOpenCodeEndpoint(options.baseUrl).toString().replace(/\/$/, "");
  const loadSdk = options.loadSdk || (async () => await import("@opencode-ai/sdk/v2") as unknown as SdkV2Module);

  const createClient = async (): Promise<SdkV2Client> => {
    const sdk = await loadSdk();
    if (typeof sdk.createOpencodeClient !== "function") {
      throw new Error("OpenCode SDK v2 is unavailable.");
    }
    const client = sdk.createOpencodeClient({ baseUrl });
    if (!client?.v2?.session || !client.v2.event || !client.v2.health) {
      throw new Error("OpenCode SDK v2 client is missing required native APIs.");
    }
    return client;
  };

  return {
    async createSession(input) {
      void input.title; // Native sessions derive their title from the first prompt.
      try {
        const client = await createClient();
        const created = await client.v2.session.create({}, { throwOnError: true });
        const session = unwrapNestedData(created);
        const id = stringField(session, "id");
        if (!id) throw new Error("OpenCode returned a session without an id.");
        return { opencodeSessionId: id };
      } catch (error) {
        throw new Error(`OpenCode SDK session creation failed: ${redactOpenCodeError(error)}`, { cause: error });
      }
    },

    async prompt(input) {
      const client = await createClient();
      const controller = new AbortController();
      let subscription: SdkEventSubscription;
      try {
        // Connect before admitting the prompt so fast events cannot be missed.
        subscription = await client.v2.event.subscribe({ signal: controller.signal });
        await client.v2.session.prompt({
          sessionID: input.opencodeSessionId,
          prompt: { text: input.text },
          delivery: "queue",
          resume: true,
        }, { throwOnError: true });

        for await (const raw of subscription.stream) {
          const event = parseEvent(raw);
          if (!belongsToSession(event, input.opencodeSessionId)) continue;
          for (const projected of normalizeOpenCodeEvent(event)) {
            await input.onEvent(projected);
          }
          if (isTerminalOpenCodeEvent(event)) return;
        }
        throw new Error("OpenCode event stream ended before the session completed.");
      } catch (error) {
        throw new Error(`OpenCode SDK prompt failed: ${redactOpenCodeError(error)}`, { cause: error });
      } finally {
        controller.abort();
      }
    },

    async abort(opencodeSessionId) {
      try {
        const client = await createClient();
        await client.v2.session.interrupt({ sessionID: opencodeSessionId }, { throwOnError: true });
      } catch (error) {
        throw new Error(`OpenCode SDK interrupt failed: ${redactOpenCodeError(error)}`, { cause: error });
      }
    },

    async health() {
      try {
        const client = await createClient();
        const result = await client.v2.health.get({ throwOnError: true });
        const health = unwrapNestedData(result);
        return health.healthy === true
          ? { ok: true, detail: "OpenCode native API ready" }
          : { ok: false, detail: "OpenCode native API reported unhealthy" };
      } catch (error) {
        return { ok: false, detail: redactOpenCodeError(error) };
      }
    },
  };
}

type SdkRequestOptions = { throwOnError?: boolean };

type SdkEventSubscription = {
  stream: AsyncIterable<unknown>;
};

type SdkV2Client = {
  v2: {
    health: {
      get: (options?: SdkRequestOptions) => Promise<unknown>;
    };
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => Promise<SdkEventSubscription>;
    };
    session: {
      create: (input?: Record<string, never>, options?: SdkRequestOptions) => Promise<unknown>;
      prompt: (input: {
        sessionID: string;
        prompt: { text: string };
        delivery: "queue";
        resume: true;
      }, options?: SdkRequestOptions) => Promise<unknown>;
      interrupt: (input: { sessionID: string }, options?: SdkRequestOptions) => Promise<unknown>;
    };
  };
};

type SdkV2Module = {
  createOpencodeClient?: (config: { baseUrl: string }) => SdkV2Client;
};

function belongsToSession(event: unknown, sessionId: string): boolean {
  const envelope = objectRecord(parseEvent(event));
  const data = objectRecord(envelope.data);
  const properties = objectRecord(envelope.properties);
  return stringField(data, "sessionID") === sessionId
    || stringField(properties, "sessionID") === sessionId;
}

function isTerminalOpenCodeEvent(event: unknown): boolean {
  const envelope = objectRecord(parseEvent(event));
  const data = Object.keys(objectRecord(envelope.data)).length > 0
    ? objectRecord(envelope.data)
    : objectRecord(envelope.properties);
  const type = stringField(envelope, "type") || stringField(data, "type") || "";
  if (type === "session.next.step.failed" || type === "session.error") return true;
  if (type !== "session.next.step.ended") return false;
  return stringField(data, "finish") !== "tool-calls";
}

function parseEvent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function redactOpenCodeError(error: unknown): string {
  const message = error instanceof Error ? error.message : errorMessage(error);
  return redactSecretText(message, 500);
}

function errorMessage(error: unknown): string {
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

function unwrapNestedData(value: unknown): Record<string, unknown> {
  let current = objectRecord(value);
  for (let index = 0; index < 3; index += 1) {
    const next = objectRecord(current.data);
    if (Object.keys(next).length === 0) break;
    current = next;
  }
  return current;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
