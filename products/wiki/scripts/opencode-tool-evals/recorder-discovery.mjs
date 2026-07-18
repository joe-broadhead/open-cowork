import { existsSync } from "node:fs";
import path from "node:path";

export function openCodeEvalRecorderPluginCandidates(repoRoot, env = process.env) {
  const candidates = [];
  const configured = env.OPENCODE_EVAL_RECORDER_PLUGIN?.trim();
  if (configured) {
    candidates.push({
      kind: "env",
      label: "OPENCODE_EVAL_RECORDER_PLUGIN",
      path: path.resolve(configured),
    });
  }
  candidates.push(
    {
      kind: "project",
      label: ".opencode/plugins/opencode_eval_recorder.ts",
      path: path.join(repoRoot, ".opencode", "plugins", "opencode_eval_recorder.ts"),
    },
    {
      kind: "sibling",
      label: "../opencode-tools/plugins/opencode_eval_recorder.ts",
      path: path.join(repoRoot, "..", "opencode-tools", "plugins", "opencode_eval_recorder.ts"),
    },
    {
      kind: "package",
      label: "@joe-broadhead/opencode-tools/plugins/opencode_eval_recorder.ts",
      path: path.join(repoRoot, "node_modules", "@joe-broadhead", "opencode-tools", "plugins", "opencode_eval_recorder.ts"),
    },
  );
  return candidates;
}

export function resolveOpenCodeEvalRecorderPlugin(repoRoot, options = {}) {
  const exists = options.exists ?? existsSync;
  const candidates = openCodeEvalRecorderPluginCandidates(repoRoot, options.env ?? process.env);
  const checked = candidatesWithAvailability(candidates, exists);
  const explicit = checked.find((candidate) => candidate.kind === "env");
  if (explicit !== undefined && !explicit.exists) {
    throw new Error(
      `OpenCode eval recorder plugin configured by ${explicit.label} does not exist: ${explicit.path}`,
    );
  }
  const found = checked.find((candidate) => candidate.exists);
  if (found !== undefined) {
    return {
      path: found.path,
      source: found.kind,
      label: found.label,
      candidates: checked,
    };
  }
  throw new Error(
    [
      "OpenCode eval recorder plugin not found.",
      "Install it with `npx github:joe-broadhead/opencode-tools install plugin opencode_eval_recorder --target .` or set OPENCODE_EVAL_RECORDER_PLUGIN.",
      "Checked: " + checked.map((candidate) => `${candidate.label} (${candidate.path})`).join(", "),
    ].join(" "),
  );
}

export function resolveOpenCodeEvalRecorderPluginPath(repoRoot, options = {}) {
  return resolveOpenCodeEvalRecorderPlugin(repoRoot, options).path;
}

export function describeOpenCodeEvalRecorderAvailability(repoRoot, options = {}) {
  const exists = options.exists ?? existsSync;
  const candidates = openCodeEvalRecorderPluginCandidates(repoRoot, options.env ?? process.env);
  try {
    const resolution = resolveOpenCodeEvalRecorderPlugin(repoRoot, { ...options, exists });
    return {
      available: true,
      path: resolution.path,
      source: resolution.source,
      label: resolution.label,
      candidates: resolution.candidates,
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      candidates: candidatesWithAvailability(candidates, exists),
    };
  }
}

function candidatesWithAvailability(candidates, exists) {
  return candidates.map((candidate) => ({
    ...candidate,
    exists: exists(candidate.path),
  }));
}
