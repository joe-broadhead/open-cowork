export const READ_INBOX_TOOL_DEFINITIONS = [
  {
    name: "wiki.inbox_list",
    title: "List OpenWiki Inbox Items",
    description: "List permission-filtered inbox items for incoming knowledge, transcripts, and agent submissions.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        statuses: { type: "array", items: { type: "string", enum: ["received", "queued", "processing", "proposed", "applied", "ignored", "failed", "superseded"] } },
        owner_actor_id: { type: "string" },
        provider: { type: "string" },
        kind: { type: "string" },
        target_space_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "wiki.inbox_read",
    title: "Read OpenWiki Inbox Item",
    description: "Read one permission-filtered inbox item, optionally including its payload.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        include_content: { type: "boolean" },
        max_bytes: { type: "integer", minimum: 0, maximum: 1048576 },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
];

export const PROPOSAL_INBOX_TOOL_DEFINITIONS = [
  {
    name: "wiki.inbox_submit",
    title: "Submit OpenWiki Inbox Item",
    description: "Submit incoming knowledge to an owned or shared OpenWiki inbox without directly mutating wiki pages.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1 },
        content: { type: "string" },
        kind: { type: "string" },
        provider: { type: "string" },
        adapter: { type: "string" },
        owner_actor_id: { type: "string" },
        target_space_id: { type: "string" },
        target_path: { type: "string" },
        external_id: { type: "string" },
        source_url: { type: "string" },
        idempotency_key: { type: "string" },
        metadata: { type: "object" },
      },
      required: ["title"],
    },
    annotations: { readOnlyHint: false },
  },
];

export const WRITE_INBOX_TOOL_DEFINITIONS = [
  {
    name: "wiki.inbox_process",
    title: "Process OpenWiki Inbox Item",
    description: "Process an inbox item into wiki source material, optionally as a dry run.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        actor_id: { type: "string" },
        dry_run: { type: "boolean" },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "wiki.inbox_ignore",
    title: "Ignore OpenWiki Inbox Item",
    description: "Mark an inbox item ignored without deleting its audit trail.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        actor_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "wiki.inbox_retry",
    title: "Retry OpenWiki Inbox Item",
    description: "Return a failed or ignored inbox item to the received queue for another processing attempt.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
        actor_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["id"],
    },
    annotations: { readOnlyHint: false },
  },
];
