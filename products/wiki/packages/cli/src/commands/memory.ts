import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { FactRecord, FactStatus, TakeRecord, TakeResolution, TakeStatus } from "@openwiki/core";
import {
  findTrajectory,
  forgetFact,
  listFacts,
  listTakes,
  proposeFact,
  proposeTake,
  readFactWorkflow,
  readTakeWorkflow,
  recallWiki,
  resolveTake,
  takesScorecard,
} from "@openwiki/workflows";
import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import { resolveRoot } from "../utils.ts";

export async function recallCommand(args: string[], options: CliOptions): Promise<void> {
  const resolved = await splitOptionalPositionalRoot(args, options);
  const query = resolved.args.join(" ").trim();
  if (!query) {
    throw new Error("Usage: openwiki [--root <path>] recall <query> [--json] [--limit N] [--type fact] [--explain] [--highlights]");
  }
  const result = await recallWiki({
    root: await resolveRoot(resolved.options),
    query,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    includeExplain: options.explain,
    includeHighlights: options.highlights,
    ...(options.types.length === 0 ? {} : { types: options.types }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  for (const memory of result.hot_memory) {
    console.log(`${memory.type}\t${memory.id}\t${memory.title}`);
  }
  for (const resultItem of result.response.results.filter((candidate) => !result.hot_memory.some((memory) => memory.id === candidate.id))) {
    console.log(`${resultItem.type}\t${resultItem.id}\t${resultItem.title}`);
  }
}

export async function factsCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, id] = args;
  const root = await resolveRoot(options);
  if (subcommand === "list" || subcommand === undefined) {
    const result = await listFacts({
      root,
      ...(options.statuses.length === 0 ? {} : { statuses: options.statuses.map(factStatusOption) }),
      ...(options.kind === undefined ? {} : { kinds: [options.kind] }),
      ...(options.subjectIds.length === 0 ? {} : { subjectIds: options.subjectIds }),
      ...(options.pageIds.length === 0 ? {} : { pageIds: options.pageIds }),
      ...(options.sourceIds.length === 0 ? {} : { sourceIds: options.sourceIds }),
      ...(options.claimIds.length === 0 ? {} : { claimIds: options.claimIds }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    for (const fact of result.facts) {
      console.log(`${fact.id}\t${fact.status}\t${fact.kind}\t${fact.text}`);
    }
    return;
  }
  if (subcommand === "read" && id) {
    const result = await readFactWorkflow({ root, id });
    if (options.json) {
      printJson(result);
      return;
    }
    printFact(result.fact);
    return;
  }
  if (subcommand === "propose") {
    const text = await factTextFromOptions(options);
    if (!text) {
      throw new Error("Usage: openwiki [--root <path>] facts propose --text text [--kind kind] [--subject id] [--page page:id] [--source source:id] [--claim claim:id] [--confidence low|medium|high] [--sensitivity public|internal|private] [--json]");
    }
    const result = await proposeFact({
      root,
      ...(options.targetId === undefined ? {} : { id: options.targetId }),
      ...(options.kind === undefined ? {} : { kind: options.kind }),
      text,
      ...(options.subjectIds.length === 0 ? {} : { subjectIds: options.subjectIds }),
      ...(options.pageIds.length === 0 ? {} : { pageIds: options.pageIds }),
      ...(options.sourceIds.length === 0 ? {} : { sourceIds: options.sourceIds }),
      ...(options.claimIds.length === 0 ? {} : { claimIds: options.claimIds }),
      ...(options.confidence === undefined ? {} : { confidence: confidenceOption(options.confidence) }),
      ...(options.sensitivity === undefined ? {} : { sensitivity: options.sensitivity }),
      ...(options.statuses[0] === undefined ? {} : { status: factStatusOption(options.statuses[0]) }),
      ...(options.validFrom === undefined ? {} : { validFrom: options.validFrom }),
      ...(options.validTo === undefined ? {} : { validTo: options.validTo }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Created fact proposal ${result.proposal.id}`);
    console.log(result.fact.id);
    console.log(result.validation.status);
    return;
  }
  if (subcommand === "forget" && id) {
    const result = await forgetFact({
      root,
      id,
      ...(options.validTo === undefined ? {} : { validTo: options.validTo }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Created forget-fact proposal ${result.proposal.id}`);
    console.log(result.fact.id);
    console.log(result.validation.status);
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] facts list|read <id>|propose|forget <id> [--json]");
}

export async function takesCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, id] = args;
  const root = await resolveRoot(options);
  if (subcommand === "list" || subcommand === undefined) {
    const result = await listTakes({
      root,
      ...(options.statuses.length === 0 ? {} : { statuses: options.statuses.map(takeStatusOption) }),
      ...(options.pageIds.length === 0 ? {} : { pageIds: options.pageIds }),
      ...(options.sourceIds.length === 0 ? {} : { sourceIds: options.sourceIds }),
      ...(options.claimIds.length === 0 ? {} : { claimIds: options.claimIds }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    for (const take of result.takes) {
      console.log(`${take.id}\t${take.status}\tp=${take.probability}\t${take.statement}`);
    }
    return;
  }
  if (subcommand === "read" && id) {
    const result = await readTakeWorkflow({ root, id });
    if (options.json) {
      printJson(result);
      return;
    }
    printTake(result.take);
    return;
  }
  if (subcommand === "scorecard") {
    const result = await takesScorecard({ root });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`takes=${result.total} scored=${result.scored} brier=${result.brier_score ?? "n/a"}`);
    for (const bucket of result.by_confidence) {
      console.log(`${bucket.confidence}\tscored=${bucket.scored}\tbrier=${bucket.brier_score ?? "n/a"}`);
    }
    return;
  }
  if (subcommand === "propose") {
    const statement = options.statement ?? options.text;
    if (!statement) {
      throw new Error("Usage: openwiki [--root <path>] takes propose --statement text [--probability 0.7] [--page page:id] [--source source:id] [--claim claim:id] [--json]");
    }
    const result = await proposeTake({
      root,
      ...(options.targetId === undefined ? {} : { id: options.targetId }),
      statement,
      ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
      ...(options.probability === undefined ? {} : { probability: options.probability }),
      ...(options.confidence === undefined ? {} : { confidence: confidenceOption(options.confidence) }),
      ...(options.statuses[0] === undefined ? {} : { status: takeStatusOption(options.statuses[0]) }),
      ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt }),
      ...(options.pageIds.length === 0 ? {} : { pageIds: options.pageIds }),
      ...(options.sourceIds.length === 0 ? {} : { sourceIds: options.sourceIds }),
      ...(options.claimIds.length === 0 ? {} : { claimIds: options.claimIds }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Created take proposal ${result.proposal.id}`);
    console.log(result.take.id);
    console.log(result.validation.status);
    return;
  }
  if (subcommand === "resolve" && id) {
    if (options.resolution === undefined) {
      throw new Error("Usage: openwiki [--root <path>] takes resolve <take-id> --resolution correct|incorrect|partial|unresolvable [--json]");
    }
    const result = await resolveTake({
      root,
      id,
      resolution: takeResolutionOption(options.resolution),
      ...(options.validTo === undefined ? {} : { resolvedAt: options.validTo }),
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      ...(options.rationale === undefined ? {} : { rationale: options.rationale }),
    });
    if (options.json) {
      printJson(result);
      return;
    }
    console.log(`Created resolve-take proposal ${result.proposal.id}`);
    console.log(result.take.id);
    console.log(`score=${result.take.score ?? "n/a"}`);
    return;
  }
  throw new Error("Usage: openwiki [--root <path>] takes list|read <id>|scorecard|propose|resolve <id> [--json]");
}

export async function trajectoryCommand(args: string[], options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const raw = args.join(" ").trim();
  const id = options.targetId ?? (looksLikeOpenWikiId(raw) ? raw : undefined);
  const query = id === undefined ? raw : undefined;
  const result = await findTrajectory({
    root,
    ...(id === undefined ? {} : { id }),
    ...(query === undefined || query.length === 0 ? {} : { query }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  for (const item of result.items) {
    console.log(`${item.at || "(unknown)"}\t${item.type}\t${item.id}\t${item.title}`);
  }
}

async function splitOptionalPositionalRoot(args: string[], options: CliOptions): Promise<{ args: string[]; options: CliOptions }> {
  if (options.root !== undefined || args.length < 2) {
    return { args, options };
  }
  const [candidate, ...rest] = args;
  if (candidate === undefined) {
    return { args, options };
  }
  const root = path.resolve(candidate);
  try {
    await access(path.join(root, "openwiki.json"));
    return { args: rest, options: { ...options, root } };
  } catch {
    return { args, options };
  }
}

async function factTextFromOptions(options: CliOptions): Promise<string | undefined> {
  if (options.text !== undefined) {
    return options.text;
  }
  if (options.bodyFile !== undefined) {
    return readFile(path.resolve(options.bodyFile), "utf8");
  }
  return undefined;
}

function factStatusOption(value: string): FactStatus {
  if (value === "active" || value === "stale" || value === "disputed" || value === "forgotten" || value === "archived") {
    return value;
  }
  throw new Error(`Invalid fact status '${value}'`);
}

function takeStatusOption(value: string): TakeStatus {
  if (value === "open" || value === "resolved" || value === "archived") {
    return value;
  }
  throw new Error(`Invalid take status '${value}'`);
}

function takeResolutionOption(value: string): TakeResolution {
  if (value === "correct" || value === "incorrect" || value === "partial" || value === "unresolvable") {
    return value;
  }
  throw new Error(`Invalid take resolution '${value}'`);
}

function confidenceOption(value: string): FactRecord["confidence"] & TakeRecord["confidence"] {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error(`Invalid confidence '${value}'`);
}

function printFact(fact: FactRecord): void {
  console.log(`${fact.id}  ${fact.status}  ${fact.kind}`);
  console.log(fact.text);
  if (fact.subject_ids.length > 0) {
    console.log(`subjects=${fact.subject_ids.join(",")}`);
  }
  if (fact.source_ids.length > 0) {
    console.log(`sources=${fact.source_ids.join(",")}`);
  }
}

function printTake(take: TakeRecord): void {
  console.log(`${take.id}  ${take.status}  p=${take.probability}`);
  console.log(take.statement);
  if (take.rationale) {
    console.log(take.rationale);
  }
  if (take.resolution !== undefined) {
    console.log(`resolution=${take.resolution} score=${take.score ?? "n/a"}`);
  }
}

function looksLikeOpenWikiId(value: string): boolean {
  return /^[a-z_]+:[^\s]+$/u.test(value);
}
