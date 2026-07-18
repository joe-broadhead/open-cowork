import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace, loadRepository } from "@openwiki/repo";
import {
  buildMeetingCurationPlan,
  proposeSynthesis,
  validateMeetingCurationPlan,
  type MeetingCurationPlan,
} from "@openwiki/workflows";

test("personal wiki template scaffolds meeting knowledge families", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-meeting-template-"));
  try {
    await createWorkspace(root, { template: "personal-wiki", title: "Meeting Wiki" });
    const repo = await loadRepository(root);
    const pages = new Map(repo.pages.map((page) => [page.id, page]));
    assert.equal(pages.get("page:meeting:meetings")?.path, "wiki/meetings/meetings.md");
    assert.equal(pages.get("page:person:people")?.path, "wiki/people/people.md");
    assert.equal(pages.get("page:organization:organizations")?.path, "wiki/organizations/organizations.md");
    assert.equal(pages.get("page:project:active-projects")?.path, "wiki/projects/active-projects.md");
    assert.equal(pages.get("page:topic:open-questions")?.path, "wiki/topics/open-questions.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("synthetic transcript fixture produces a deduped meeting curation plan", () => {
  const plan = syntheticMeetingPlan();
  assert.equal(plan.schema_version, "openwiki.meeting_curation_plan.v1");
  assert.equal(plan.inbox_item_id, "inbox:2026-05-31-001");
  assert.equal(plan.source_id, "source:2026-05-31-001");
  assert.ok(plan.page_creations.some((page) => page.page_type === "meeting" && page.target_path === "wiki/meetings/acme-launch-sync.md"));
  assert.ok(plan.page_creations.some((page) => page.page_type === "person" && page.target_path === "wiki/people/bob.md"));
  assert.equal(plan.page_creations.filter((page) => page.page_type === "person" && page.title === "Bob").length, 1);
  assert.ok(plan.page_updates.some((page) => page.target_id === "page:person:alice"));
  const aliceUpdate = plan.page_updates.find((page) => page.target_id === "page:person:alice");
  assert.match(aliceUpdate?.proposed_sections[0]?.body ?? "", /## Transcript Facts/);
  assert.match(aliceUpdate?.proposed_sections[0]?.body ?? "", /## Agent Interpretation/);
  assert.ok(plan.merge_candidates.some((candidate) => candidate.existing_page_id === "page:person:alice"));
  assert.ok(plan.entity_candidates.some((candidate) => candidate.page_type === "organization" && candidate.title === "Acme"));
  assert.ok(plan.unresolved_ambiguities.includes("Bob's due date was not stated."));
  assert.equal(validateMeetingCurationPlan(plan).status, "passed");
});

test("meeting curation plan validation catches missing source IDs and unsupported page types", () => {
  const plan = syntheticMeetingPlan();
  const invalid: MeetingCurationPlan = {
    ...plan,
    source_id: "",
    page_creations: [
      {
        ...plan.page_creations[0]!,
        page_type: "unsupported" as MeetingCurationPlan["page_creations"][number]["page_type"],
        source_ids: [],
      },
    ],
  };
  const validation = validateMeetingCurationPlan(invalid);
  assert.equal(validation.status, "failed");
  assert.ok(validation.issues.some((issue) => issue.code === "meeting_plan.source_id.invalid"));
  assert.ok(validation.issues.some((issue) => issue.code === "meeting_plan.page_type.unsupported"));
  assert.ok(validation.issues.some((issue) => issue.code === "meeting_plan.source_ids.empty"));
});

test("meeting plan output can drive a proposal with meeting links and source context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-meeting-proposal-"));
  try {
    await createWorkspace(root, { template: "personal-wiki", title: "Meeting Wiki" });
    const plan = syntheticMeetingPlan("source:2026-05-21-001");
    const meetingPage = plan.page_creations.find((page) => page.page_type === "meeting");
    assert.ok(meetingPage);
    const proposed = await proposeSynthesis({
      root,
      title: meetingPage.title,
      body: meetingPage.body,
      pageType: meetingPage.page_type,
      summary: meetingPage.summary,
      sourceIds: meetingPage.source_ids,
      actorId: "actor:agent:meeting-curator",
      rationale: `Transcript-derived meeting curation plan for ${plan.inbox_item_id}.`,
    });
    assert.equal(proposed.proposal.target_path, "wiki/meetings/acme-launch-sync.md");
    assert.equal(proposed.validation.status, "passed");
    assert.ok(proposed.page.source_ids.includes("source:2026-05-21-001"));
    const snapshot = await readFile(path.join(root, proposed.proposal.snapshot_path ?? ""), "utf8");
    assert.match(snapshot, /\[\[Alice\]\]/);
    assert.match(snapshot, /\[\[Acme\]\]/);
    assert.match(snapshot, /## Transcript Facts/);
    assert.match(snapshot, /## Agent Interpretation/);
    assert.match(snapshot, /Bob's due date was not stated/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function syntheticMeetingPlan(sourceId = "source:2026-05-31-001"): MeetingCurationPlan {
  return buildMeetingCurationPlan({
    inboxItemId: "inbox:2026-05-31-001",
    sourceId,
    title: "Acme Launch Sync",
    date: "2026-05-31",
    summary: "Alice and Bob discussed transcript import for the Acme launch.",
    transcriptFacts: [
      "Alice from Acme attended the launch sync.",
      "Bob from OpenWiki owns documenting the sync workflow.",
      "Alice decided to send weekly transcript exports.",
    ],
    agentInterpretation: ["This appears to be a launch operations meeting."],
    entities: [
      { page_type: "person", title: "Alice", organization: "Acme", evidence: "Alice from Acme attended." },
      { page_type: "person", title: "Alice", organization: "Acme", evidence: "Duplicate mention should merge." },
      { page_type: "person", title: "Bob", organization: "OpenWiki", evidence: "Bob owns documenting the sync workflow." },
      { page_type: "organization", title: "Acme", evidence: "Acme was represented by Alice." },
      { page_type: "project", title: "Transcript Import", evidence: "The sync workflow imports transcript exports." },
      { page_type: "topic", title: "Meeting Automation", evidence: "The meeting discussed transcript automation." },
    ],
    decisions: [{ title: "Send Weekly Transcript Exports", summary: "Alice decided to send weekly transcript exports." }],
    actions: [{ title: "Document Transcript Sync Workflow", owner: "Bob" }],
    ambiguities: ["Bob's due date was not stated."],
    existingPages: [
      {
        id: "page:person:alice",
        page_type: "person",
        title: "Alice",
        path: "wiki/people/alice.md",
        aliases: ["Alice from Acme"],
      },
    ],
  });
}
