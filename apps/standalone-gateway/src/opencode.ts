import { createHash, randomUUID } from "node:crypto";
import {
  sanitizeRuntimeEventRecord,
  sanitizeRuntimeEventValue,
} from "@open-cowork/shared";

import { assertPrivateOpenCodeEndpoint } from "./network-policy.js";
import { redactSecretText } from "./redaction.js";
import { normalizeStandaloneRuntimeRoot } from "./runtime-root.js";
import type { StandaloneRuntimeEvent } from "./types.js";

export interface StandaloneOpenCodeAdapter {
  createSession(input: { title: string }): Promise<{ opencodeSessionId: string }>;
  prompt(input: {
    opencodeSessionId: string;
    admissionId: string;
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
  if (type === "permission.v2.replied" || type === "permission.replied") {
    return [{
      type: "permission.resolved",
      entityId: stringField(properties, "requestID") || stringField(envelope, "id"),
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
  if (
    type === "question.v2.replied"
    || type === "question.v2.rejected"
    || type === "question.replied"
    || type === "question.rejected"
  ) {
    return [{
      type: "question.resolved",
      entityId: stringField(properties, "requestID") || stringField(envelope, "id"),
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
  runtimeRoot: string;
  allowPrivateDns?: boolean;
  eventConnectionTimeoutMs?: number;
  executionTimeoutMs?: number;
  interruptSettlementTimeoutMs?: number;
  loadSdk?: () => Promise<SdkV2Module>;
}): StandaloneOpenCodeAdapter {
  const baseUrl = assertPrivateOpenCodeEndpoint(options.baseUrl, {
    allowPrivateDns: options.allowPrivateDns,
  }).toString().replace(/\/$/, "");
  const runtimeRoot = normalizeStandaloneRuntimeRoot(options.runtimeRoot);
  const loadSdk = options.loadSdk || (async () => await import("@opencode-ai/sdk/v2") as unknown as SdkV2Module);
  const pendingInterrupts = new Map<string, Promise<void>>();

  const createClient = async (): Promise<SdkV2Client> => {
    const sdk = await loadSdk();
    if (typeof sdk.createOpencodeClient !== "function") {
      throw new Error("OpenCode SDK v2 is unavailable.");
    }
    // V2 event subscriptions are directory-scoped GET requests. Supplying the
    // client default makes the SDK attach location[directory] so this gateway
    // cannot silently subscribe to the OpenCode server's unrelated cwd.
    const client = sdk.createOpencodeClient({ baseUrl, directory: runtimeRoot });
    if (!client?.v2?.session || !client.v2.health) {
      throw new Error("OpenCode SDK v2 client is missing required native APIs.");
    }
    return client;
  };

  return {
    async createSession(input) {
      void input.title; // Native sessions derive their title from the first prompt.
      try {
        const client = await createClient();
        // OpenCode v2 requires an object body for POST /api/session. Its
        // generated SDK strips an empty object, so the explicit location is
        // both the execution boundary and what keeps the native body present.
        const created = await client.v2.session.create({
          location: { directory: runtimeRoot },
        }, { throwOnError: true });
        const session = unwrapNestedData(created);
        const id = stringField(session, "id");
        if (!id) throw new Error("OpenCode returned a session without an id.");
        return { opencodeSessionId: id };
      } catch (error) {
        throw new Error(`OpenCode SDK session creation failed: ${redactOpenCodeError(error)}`, { cause: error });
      }
    },

    async prompt(input) {
      if (pendingInterrupts.has(input.opencodeSessionId)) {
        throw new Error("OpenCode SDK prompt failed: a previous timed-out interrupt has not settled for this session.");
      }
      const controller = new AbortController();
      let controlTask: Promise<void> | null = null;
      let client: SdkV2Client | null = null;
      let promptRequestStarted = false;
      let terminalObserved = false;
      let interruptFenced = false;
      try {
        const activeClient = await createClient();
        client = activeClient;
        const sessionEvents = activeClient.v2.session.events;
        if (typeof sessionEvents !== "function") {
          throw new Error("OpenCode SDK v2 client is missing durable session events.");
        }
        const controlSubscribe = activeClient.v2.event?.subscribe;
        if (typeof controlSubscribe !== "function") {
          throw new Error("OpenCode SDK v2 client is missing the native control-plane event stream.");
        }

        // Permission and question requests are process-level control events in
        // OpenCode v2; they are not guaranteed to be present in the
        // per-session transcript. Establish this connection before admitting
        // the prompt so a fast request cannot fall into an HTTP-to-SSE gap.
        const controlSubscription = await waitForEventConnection(
          controlSubscribe.call(activeClient.v2.event, { signal: controller.signal }),
          options.eventConnectionTimeoutMs,
        );
        const controlIterator = controlSubscription.stream[Symbol.asyncIterator]();
        // The generated SDK's SSE body is lazy: subscribe() returns before its
        // iterator issues the HTTP request. OpenCode emits server.connected as
        // the initial native event, so prime one event under the connection
        // deadline before the prompt POST and hand that exact result to the
        // consumer rather than dropping it.
        const firstControlEvent = await waitForEventConnection(
          controlIterator.next().then(requireConnectedEvent("control-plane")),
          options.eventConnectionTimeoutMs,
        );
        const deliveredControlEvents = new Set<string>();
        let deliveryTail = Promise.resolve();
        const deliver = (event: StandaloneRuntimeEvent) => {
          const next = deliveryTail.then(async () => await input.onEvent(event));
          deliveryTail = next.then(() => undefined, () => undefined);
          return next;
        };
        controlTask = consumeControlPlaneEvents({
          firstEvent: firstControlEvent,
          iterator: controlIterator,
          sessionId: input.opencodeSessionId,
          delivered: deliveredControlEvents,
          signal: controller.signal,
          deliver,
        });

        const transcriptTask = (async () => {
          const promptId = stableOpenCodePromptId(input.admissionId);
          // Once the POST starts, the server may admit this stable prompt ID
          // even if its HTTP response never reaches us. Any later observation
          // failure must therefore interrupt conservatively.
          promptRequestStarted = true;
          const response = await activeClient.v2.session.prompt({
            sessionID: input.opencodeSessionId,
            id: promptId,
            prompt: { text: input.text },
            delivery: "queue",
            resume: true,
          }, { throwOnError: true, signal: controller.signal });
          const admitted = unwrapNestedData(response);
          const admittedSequence = numberField(admitted, "admittedSeq");
          if (!Number.isInteger(admittedSequence) || admittedSequence < 0) {
            throw new Error("OpenCode returned a prompt admission without a valid sequence.");
          }
          // V2 prompt is admission-only. Subscribe to the session's durable
          // aggregate from the admitted input sequence so a fast completion or
          // a process retry is replayed rather than lost between HTTP and SSE.
          const subscription = await sessionEvents.call(activeClient.v2.session, {
            sessionID: input.opencodeSessionId,
            ...(admittedSequence > 0 ? { after: String(admittedSequence - 1) } : {}),
          }, { signal: controller.signal });
          const iterator = subscription.stream[Symbol.asyncIterator]();
          const firstEvent = await waitForEventConnection(
            iterator.next().then(requireConnectedEvent("durable")),
            options.eventConnectionTimeoutMs,
          );

          let next: IteratorResult<unknown> = firstEvent;
          while (!next.done) {
            const raw = next.value;
            const event = parseEvent(raw);
            if (belongsToSession(event, input.opencodeSessionId)) {
              // Replayable transcript events have exactly one owner. Control
              // events are projected only by the already-connected global
              // stream, avoiding duplicates between two independent SSE tails.
              if (!isControlPlaneOpenCodeEvent(event)) {
                for (const projected of normalizeOpenCodeEvent(event)) {
                  await deliver(projected);
                }
              }
              if (isFailedOpenCodeEvent(event)) {
                terminalObserved = true;
                throw new Error(terminalOpenCodeFailureMessage(event));
              }
              if (isTerminalOpenCodeEvent(event)) {
                terminalObserved = true;
                return;
              }
            }
            next = await iterator.next();
          }
          throw new Error("OpenCode event stream ended before the session completed.");
        })();
        await withExecutionDeadline(Promise.race([transcriptTask, controlTask]), options.executionTimeoutMs, async () => {
          controller.abort();
          interruptFenced = true;
          await interruptWithSettlementFence({
            client: activeClient,
            sessionId: input.opencodeSessionId,
            pendingInterrupts,
            timeoutMs: options.interruptSettlementTimeoutMs,
          });
        });
      } catch (error) {
        // Once admission succeeds, losing either observation stream can leave
        // native execution running invisibly. Stop it through the same bounded
        // fail-closed fence used by the execution deadline before releasing the
        // caller's serialized session lane.
        if (client && promptRequestStarted && !terminalObserved && !interruptFenced) {
          controller.abort();
          await interruptWithSettlementFence({
            client,
            sessionId: input.opencodeSessionId,
            pendingInterrupts,
            timeoutMs: options.interruptSettlementTimeoutMs,
          });
        }
        throw new Error(`OpenCode SDK prompt failed: ${redactOpenCodeError(error)}`, { cause: error });
      } finally {
        controller.abort();
        if (controlTask) {
          await waitForTaskSettlement(controlTask, options.eventConnectionTimeoutMs).catch(() => undefined);
        }
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

type SdkRequestOptions = { throwOnError?: boolean; signal?: AbortSignal };

type SdkEventSubscription = {
  stream: AsyncIterable<unknown>;
};

type SdkV2Client = {
  v2: {
    health: {
      get: (options?: SdkRequestOptions) => Promise<unknown>;
    };
    event?: {
      subscribe: (options?: SdkRequestOptions) => Promise<SdkEventSubscription>;
    };
    session: {
      create: (input: { location: { directory: string } }, options?: SdkRequestOptions) => Promise<unknown>;
      prompt: (input: {
        sessionID: string;
        id: string;
        prompt: { text: string };
        delivery: "queue";
        resume: true;
      }, options?: SdkRequestOptions) => Promise<unknown>;
      events?: (
        input: { sessionID: string; after?: string },
        options?: SdkRequestOptions,
      ) => Promise<SdkEventSubscription>;
      interrupt: (input: { sessionID: string }, options?: SdkRequestOptions) => Promise<unknown>;
    };
  };
};

type SdkV2Module = {
  createOpencodeClient?: (config: SdkV2ClientConfig) => SdkV2Client;
};

type SdkV2ClientConfig = {
  baseUrl: string;
  directory: string;
};

async function waitForEventConnection<T>(
  connection: Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      connection,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out connecting to the OpenCode event stream.")),
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withExecutionDeadline<T>(
  execution: Promise<T>,
  timeoutMs = 15 * 60 * 1000,
  onTimeout: () => Promise<void>,
): Promise<T> {
  const timeoutMarker = Symbol("execution-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      execution,
      new Promise<typeof timeoutMarker>((resolve) => {
        timer = setTimeout(() => {
          resolve(timeoutMarker);
        }, Math.max(1, timeoutMs));
      }),
    ]);
    if (result !== timeoutMarker) return result;
    // The prompt's serialized caller must not advance until the native
    // interrupt has either settled or reached its own finite cancellation
    // boundary. The per-session fence below blocks any still-late request from
    // overlapping a subsequent prompt.
    await onTimeout();
    throw new Error("OpenCode session execution exceeded its configured deadline.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requireConnectedEvent(label: string) {
  return (result: IteratorResult<unknown>): IteratorYieldResult<unknown> => {
    if (result.done) {
      throw new Error(`OpenCode ${label} event stream ended before the subscription connected.`);
    }
    return result;
  };
}

async function consumeControlPlaneEvents(input: {
  firstEvent: IteratorYieldResult<unknown>;
  iterator: AsyncIterator<unknown>;
  sessionId: string;
  delivered: Set<string>;
  signal: AbortSignal;
  deliver: (event: StandaloneRuntimeEvent) => Promise<void>;
}): Promise<void> {
  let next: IteratorResult<unknown> = input.firstEvent;
  while (!input.signal.aborted) {
    if (next.done) break;
    const event = parseEvent(next.value);
    if (belongsToSession(event, input.sessionId) && isControlPlaneOpenCodeEvent(event)) {
      const key = controlPlaneEventKey(event);
      if (!key || !input.delivered.has(key)) {
        if (key) input.delivered.add(key);
        for (const projected of normalizeOpenCodeEvent(event)) {
          await input.deliver(projected);
        }
      }
    }
    next = await input.iterator.next();
  }
  if (!input.signal.aborted) {
    throw new Error("OpenCode control-plane event stream ended before the session completed.");
  }
}

function isControlPlaneOpenCodeEvent(event: unknown): boolean {
  const envelope = objectRecord(parseEvent(event));
  const nested = objectRecord(envelope.data);
  const type = stringField(envelope, "type") || stringField(nested, "type") || "";
  return type === "permission.v2.asked"
    || type === "permission.v2.replied"
    || type === "permission.asked"
    || type === "permission.replied"
    || type === "question.v2.asked"
    || type === "question.v2.replied"
    || type === "question.v2.rejected"
    || type === "question.asked"
    || type === "question.replied"
    || type === "question.rejected";
}

function controlPlaneEventKey(event: unknown): string | null {
  const envelope = objectRecord(parseEvent(event));
  const properties = Object.keys(objectRecord(envelope.properties)).length > 0
    ? objectRecord(envelope.properties)
    : objectRecord(envelope.data);
  const type = stringField(envelope, "type") || stringField(properties, "type");
  if (!type) return null;
  const entityId = stringField(properties, "id")
    || stringField(properties, "requestID")
    || stringField(envelope, "id");
  return entityId ? `${type}:${entityId}` : null;
}

async function interruptWithSettlementFence(input: {
  client: SdkV2Client;
  sessionId: string;
  pendingInterrupts: Map<string, Promise<void>>;
  timeoutMs?: number;
}): Promise<void> {
  const operation = Promise.resolve()
    .then(async () => {
      await input.client.v2.session.interrupt(
        { sessionID: input.sessionId },
        { throwOnError: true },
      );
      return true;
    })
    // The execution deadline remains the public failure. A rejected or hung
    // interrupt leaves the native session in an uncertain state, so it must
    // remain fenced rather than allowing another prompt to race a late abort.
    .then(() => true, () => false);
  const fence = operation.then(() => undefined);
  input.pendingInterrupts.set(input.sessionId, fence);
  void operation.then((succeeded) => {
    if (succeeded && input.pendingInterrupts.get(input.sessionId) === fence) {
      input.pendingInterrupts.delete(input.sessionId);
    }
  });

  await waitForTaskSettlement(operation, input.timeoutMs ?? 5_000);
}

async function waitForTaskSettlement(
  task: Promise<unknown>,
  timeoutMs = 10_000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task.then(() => true, () => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stableOpenCodePromptId(admissionId: string): string {
  const normalized = admissionId.trim();
  if (!normalized) throw new Error("OpenCode prompt admission id is required.");
  const digest = createHash("sha256")
    .update("open-cowork-standalone-prompt\0")
    .update(normalized)
    .digest("hex")
    .slice(0, 24);
  return `msg_${digest}`;
}

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

function isFailedOpenCodeEvent(event: unknown): boolean {
  const envelope = objectRecord(parseEvent(event));
  const data = Object.keys(objectRecord(envelope.data)).length > 0
    ? objectRecord(envelope.data)
    : objectRecord(envelope.properties);
  const type = stringField(envelope, "type") || stringField(data, "type") || "";
  return type === "session.next.step.failed" || type === "session.error";
}

function terminalOpenCodeFailureMessage(event: unknown): string {
  const envelope = objectRecord(parseEvent(event));
  const data = Object.keys(objectRecord(envelope.data)).length > 0
    ? objectRecord(envelope.data)
    : objectRecord(envelope.properties);
  const error = objectRecord(data.error);
  const message = stringField(data, "message")
    || stringField(data, "error")
    || stringField(error, "message")
    || "OpenCode runtime reported a terminal session failure.";
  const sanitized = sanitizeRuntimeEventValue(message);
  return typeof sanitized === "string" && sanitized
    ? sanitized
    : "OpenCode runtime reported a terminal session failure.";
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
  readonly prompts: Array<{ opencodeSessionId: string; admissionId: string; text: string }> = [];

  async createSession(): Promise<{ opencodeSessionId: string }> {
    return { opencodeSessionId: `oc-${randomUUID()}` };
  }

  async prompt(input: { opencodeSessionId: string; admissionId: string; text: string; onEvent(event: StandaloneRuntimeEvent): Promise<void> | void }): Promise<void> {
    this.prompts.push({ opencodeSessionId: input.opencodeSessionId, admissionId: input.admissionId, text: input.text });
    await input.onEvent({ type: "assistant.message", payload: { text: `Standalone response: ${input.text}` } });
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "fake opencode ready" };
  }
}

function publicPayload(record: Record<string, unknown>) {
  return sanitizeRuntimeEventRecord(record);
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

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}
