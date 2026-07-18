import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { runLocalJob } from "@openwiki/jobs";
import { createWorkspace, loadRepository, readProposalDetail } from "@openwiki/repo";
import { searchWiki } from "@openwiki/search";
import { exportStaticSite } from "@openwiki/static-export";
import { askWithCitations, commentOnProposal, proposeEdit, reviewProposal, thinkWithCitations } from "@openwiki/workflows";

test("OpenWiki JSON Schemas are parseable and cover current runtime fields", async () => {
  const schemaRoot = path.join(process.cwd(), "schemas", "openwiki", "v0");
  const files = (await readdir(schemaRoot)).filter((file) => file.endsWith(".schema.json"));
  assert.ok(files.length >= 10);
  const schemas = new Map<string, Record<string, unknown>>();
  for (const file of files) {
    const schema = JSON.parse(await readFile(path.join(schemaRoot, file), "utf8")) as Record<string, unknown>;
    assert.equal(schema["$schema"], "https://json-schema.org/draft/2020-12/schema");
    assert.match(String(schema["$id"]), new RegExp("^https://raw\\.githubusercontent\\.com/joe-broadhead/open-wiki/v0\\.0\\.0/schemas/openwiki/v0/"));
    schemas.set(file, schema);
  }

  const eventProperties = (schemas.get("event.schema.json")?.properties ?? {}) as Record<string, unknown>;
  assert.ok(eventProperties.subject_ids);
  assert.ok(eventProperties.subject_paths);
  assert.ok(eventProperties.sensitivity);

  const runProperties = (schemas.get("run.schema.json")?.properties ?? {}) as Record<string, unknown>;
  assert.ok(runProperties.subject_ids);
  assert.ok(runProperties.subject_paths);
  assert.ok(runProperties.sensitivity);

  const openwiki = schemas.get("openwiki.schema.json") as { properties?: Record<string, unknown> };
  const runtime = ((openwiki.properties?.runtime as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  assert.ok(runtime.git);
  assert.ok(runtime.sync);
  assert.ok(runtime.backups);
  const sync = ((runtime.sync as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  assert.ok(sync.interval_seconds);
  assert.ok(sync.conflict_policy);
  const backups = ((runtime.backups as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  assert.ok(backups.destinations);
  assert.ok(backups.retention);
  assert.ok(backups.default_destination_id);
  const controls = ((runtime.controls as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  const rateLimits = ((controls.rate_limits as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  assert.ok(rateLimits.enabled);
  assert.ok(rateLimits.mcp_limit);
  assert.ok(rateLimits.proposal_limit);
  assert.ok(rateLimits.policy_limit);
  assert.ok(rateLimits.inbox_limit);
  assert.ok(rateLimits.job_limit);
  const sourceFetch = ((controls.source_fetch as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  assert.ok(sourceFetch.default_max_bytes);
  assert.ok(sourceFetch.max_bytes);
  assert.ok(sourceFetch.default_timeout_ms);
  assert.ok(sourceFetch.max_timeout_ms);
  const operationalState = ((controls.operational_state as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  assert.ok(operationalState.backend);
  const storage = ((runtime.storage as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  assert.ok(storage.endpoint_url);
  assert.ok(storage.bucket);
  assert.ok(storage.access_key_id_env);
  assert.ok(storage.secret_access_key_env);
  const auth = ((openwiki.properties?.auth as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  const serviceAccounts = auth.service_accounts as { items?: { properties?: Record<string, unknown> } };
  assert.ok(serviceAccounts.items?.properties?.principals);
  assert.ok(serviceAccounts.items?.properties?.tokens);
  const search = ((openwiki.properties?.search as { properties?: Record<string, unknown> }).properties ?? {}) as Record<string, unknown>;
  assert.ok(search.embedding);
  const enabledRetrievers = (search.enabled_retrievers as { properties?: Record<string, unknown> }).properties ?? {};
  assert.ok(enabledRetrievers.vector);
});

test("OpenWiki JSON Schemas validate generated repository and API records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-schema-contract-"));
  try {
    const validators = await loadSchemaValidators();
    await createWorkspace(root, "Schema Contract Wiki");
    const proposal = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      body: "# Agent Memory\n\nSchema validation keeps public contracts executable.",
      actorId: "actor:user:schema",
      rationale: "Exercise proposal schema.",
    });
    await commentOnProposal({
      root,
      proposalId: proposal.proposal.id,
      body: "Schema contract review comment.",
      actorId: "actor:user:commenter",
    });
    await reviewProposal({
      root,
      proposalId: proposal.proposal.id,
      decision: "accepted",
      rationale: "Schema contract proposal is valid.",
      actorId: "actor:user:reviewer",
    });
    await runLocalJob({ root, runType: "lint", actorId: "actor:user:schema" });

    const repo = await loadRepository(root);
    assertValid(validators, "openwiki.schema.json", JSON.parse(await readFile(path.join(root, "openwiki.json"), "utf8")));
    for (const page of repo.pages) {
      assertValid(validators, "page.schema.json", page);
    }
    for (const source of repo.sources) {
      assertValid(validators, "source.schema.json", source);
    }
    for (const claim of repo.claims) {
      assertValid(validators, "claim.schema.json", claim);
    }
    assertValid(validators, "fact.schema.json", {
      id: "fact:2026-07-05-schema",
      uri: "openwiki://fact/2026-07-05-schema",
      type: "fact",
      kind: "summary",
      text: "Schema fixtures cover fact records.",
      subject_ids: ["page:concept:agent-memory"],
      page_ids: ["page:concept:agent-memory"],
      source_ids: [],
      claim_ids: [],
      confidence: "high",
      sensitivity: "public",
      status: "active",
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
      path: "facts/facts.jsonl",
    });
    assertValid(validators, "take.schema.json", {
      id: "take:2026-07-05-schema",
      uri: "openwiki://take/2026-07-05-schema",
      type: "take",
      statement: "Production hardening should be tracked as executable schema contracts.",
      rationale: "Public consumers depend on these shapes.",
      probability: 0.9,
      confidence: "high",
      status: "open",
      page_ids: ["page:concept:agent-memory"],
      source_ids: [],
      claim_ids: [],
      created_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
      path: "takes/takes.jsonl",
    });
    assertValid(validators, "inbox-item.schema.json", {
      id: "inbox:2026-07-05-schema",
      uri: "openwiki://inbox/2026-07-05-schema",
      type: "inbox",
      title: "Schema fixture inbox item",
      inbox_kind: "document",
      provider: "manual",
      status: "received",
      owner_actor_id: "actor:user:schema",
      received_at: "2026-07-05T00:00:00.000Z",
      updated_at: "2026-07-05T00:00:00.000Z",
      idempotency_key: "schema-fixture",
      payload: {
        kind: "git",
        path: "inbox/payloads/schema-fixture.txt",
        media_type: "text/plain",
      },
      path: "inbox/items.jsonl",
    });
    for (const proposalRecord of repo.proposals) {
      assertValid(validators, "proposal.schema.json", proposalRecord);
    }
    for (const comment of repo.comments) {
      assertValid(validators, "proposal-comment.schema.json", comment);
    }
    for (const decision of repo.decisions) {
      assertValid(validators, "decision.schema.json", decision);
    }
    for (const event of repo.events) {
      assertValid(validators, "event.schema.json", event);
    }
    for (const run of repo.runs) {
      assertValid(validators, "run.schema.json", run);
    }

    const detail = await readProposalDetail(root, proposal.proposal.id);
    assert.ok(detail.validation_report);
    assertValid(validators, "validation-report.schema.json", detail.validation_report);

    const search = await searchWiki(root, { query: "agent memory", limit: 3 });
    assertValid(validators, "search.schema.json", search);

    const answer = await askWithCitations({ root, question: "How does OpenWiki store agent memory?", limit: 3 });
    assertValid(validators, "answer.schema.json", answer);

    const thought = await thinkWithCitations({ root, question: "How does OpenWiki store agent memory?", limit: 3 });
    assertValid(validators, "think.schema.json", thought);

    const exported = await exportStaticSite({ root, outDir: "schema-public" });
    await assertJsonlMatchesSchema(validators, "page.schema.json", path.join(exported.outDir, "pages.jsonl"));
    await assertJsonlMatchesSchema(validators, "source.schema.json", path.join(exported.outDir, "sources.jsonl"));
    await assertJsonlMatchesSchema(validators, "claim.schema.json", path.join(exported.outDir, "claims.jsonl"));
    await assertJsonlMatchesSchema(validators, "proposal.schema.json", path.join(exported.outDir, "proposals.jsonl"));
    await assertJsonlMatchesSchema(validators, "proposal-comment.schema.json", path.join(exported.outDir, "proposal-comments.jsonl"));
    await assertJsonlMatchesSchema(validators, "decision.schema.json", path.join(exported.outDir, "decisions.jsonl"));
    await assertJsonlMatchesSchema(validators, "event.schema.json", path.join(exported.outDir, "events.jsonl"));
    await assertJsonlMatchesSchema(validators, "run.schema.json", path.join(exported.outDir, "runs.jsonl"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol record examples validate against public schemas", async () => {
  const validators = await loadSchemaValidators();
  const protocol = await readFile(path.join(process.cwd(), "docs", "spec", "protocol", "records.md"), "utf8");
  const examples = [
    { heading: "### 9.1 Page Record", schema: "page.schema.json" },
    { heading: "### 9.2 Source Record", schema: "source.schema.json" },
    { heading: "### 9.4 Proposal Record", schema: "proposal.schema.json" },
    { heading: "### 9.6 Decision Record", schema: "decision.schema.json" },
  ];

  for (const example of examples) {
    assertValid(validators, example.schema, JSON.parse(jsonExampleAfterHeading(protocol, example.heading)));
  }
});

async function loadSchemaValidators(): Promise<Map<string, ValidateFunction>> {
  const schemaRoot = path.join(process.cwd(), "schemas", "openwiki", "v0");
  const files = (await readdir(schemaRoot)).filter((file) => file.endsWith(".schema.json")).sort();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", {
    type: "string",
    validate: (value: string) => !Number.isNaN(Date.parse(value)),
  });
  const schemas = new Map<string, Record<string, unknown>>();
  for (const file of files) {
    const schema = JSON.parse(await readFile(path.join(schemaRoot, file), "utf8")) as Record<string, unknown>;
    schemas.set(file, schema);
    ajv.addSchema(schema);
  }
  return new Map([...schemas].map(([file, schema]) => [file, ajv.getSchema(String(schema["$id"])) ?? ajv.compile(schema)]));
}

function jsonExampleAfterHeading(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `Missing heading ${heading}`);
  const match = /```json\n([\s\S]*?)\n```/.exec(markdown.slice(start));
  assert.ok(match?.[1], `Missing JSON example after ${heading}`);
  return match[1];
}

function assertValid(validators: Map<string, ValidateFunction>, schemaFile: string, value: unknown): void {
  const validate = validators.get(schemaFile);
  assert.ok(validate, `Missing validator for ${schemaFile}`);
  const valid = validate(value);
  assert.equal(valid, true, `${schemaFile} validation failed: ${JSON.stringify(validate.errors, null, 2)}`);
}

async function assertJsonlMatchesSchema(validators: Map<string, ValidateFunction>, schemaFile: string, filePath: string): Promise<void> {
  const lines = (await readFile(filePath, "utf8")).trim().split("\n").filter(Boolean);
  for (const line of lines) {
    assertValid(validators, schemaFile, JSON.parse(line));
  }
}
