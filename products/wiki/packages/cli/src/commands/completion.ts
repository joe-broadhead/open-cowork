import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";

const COMMANDS = [
  "help",
  "version",
  "upgrade",
  "doctor",
  "setup",
  "agent",
  "deploy",
  "init",
  "index",
  "db",
  "search",
  "ask",
  "think",
  "page",
  "pages",
  "source",
  "topics",
  "questions",
  "graph",
  "history",
  "diff",
  "changes",
  "git",
  "sync",
  "service",
  "commit",
  "events",
  "audit",
  "governance",
  "runs",
  "run",
  "worker",
  "publish",
  "backup",
  "claim",
  "decision",
  "propose-edit",
  "synthesize",
  "proposal",
  "policy",
  "spaces",
  "auth",
  "workspace",
  "maintainer",
  "integrate",
  "mcp",
  "serve",
  "export",
  "completion",
];

const COMMON_FLAGS = [
  "--root",
  "--json",
  "--help",
  "--version",
  "--limit",
  "--offset",
  "--title",
  "--template",
  "--host",
  "--port",
  "--out-dir",
  "--base-url",
  "--actor",
  "--message",
  "--every",
  "--destination",
  "--token-env",
  "--token-file",
  "--tools",
  "--role",
  "--scope",
];

type CompletionShell = "bash" | "zsh" | "fish";

export async function completionCommand(args: string[], options: CliOptions): Promise<void> {
  const shell = parseCompletionShell(args[0]);
  const script = shell === "bash" ? bashCompletion() : shell === "zsh" ? zshCompletion() : fishCompletion();
  if (options.json) {
    printJson({ shell, script });
    return;
  }
  console.log(script);
}

function parseCompletionShell(value: string | undefined): CompletionShell {
  if (value === "bash" || value === "zsh" || value === "fish") {
    return value;
  }
  throw new Error("Usage: openwiki completion bash|zsh|fish");
}

function bashCompletion(): string {
  const words = [...COMMANDS, ...COMMON_FLAGS].join(" ");
  return [
    "_openwiki_completion() {",
    "  local cur prev",
    "  COMPREPLY=()",
    "  cur=\"${COMP_WORDS[COMP_CWORD]}\"",
    "  prev=\"${COMP_WORDS[COMP_CWORD-1]}\"",
    "  if [[ \"$prev\" == \"--root\" || \"$prev\" == \"--out-dir\" || \"$prev\" == \"--body-file\" || \"$prev\" == \"--content-file\" || \"$prev\" == \"--token-file\" ]]; then",
    "    COMPREPLY=( $(compgen -f -- \"$cur\") )",
    "    return 0",
    "  fi",
    `  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )`,
    "  return 0",
    "}",
    "complete -F _openwiki_completion openwiki",
    "",
  ].join("\n");
}

function zshCompletion(): string {
  const commandWords = COMMANDS.join(" ");
  const flagWords = COMMON_FLAGS.join(" ");
  return [
    "#compdef openwiki",
    "_openwiki() {",
    "  local -a commands flags",
    `  commands=(${commandWords})`,
    `  flags=(${flagWords})`,
    "  if (( CURRENT == 2 )); then",
    "    _describe 'openwiki command' commands",
    "  else",
    "    _describe 'openwiki option' flags",
    "    _files",
    "  fi",
    "}",
    "_openwiki \"$@\"",
    "",
  ].join("\n");
}

function fishCompletion(): string {
  return [
    "complete -c openwiki -f",
    ...COMMANDS.map((command) => `complete -c openwiki -n __fish_use_subcommand -a ${fishEscape(command)}`),
    ...COMMON_FLAGS.map((flag) => `complete -c openwiki -l ${flag.slice(2)}`),
    "",
  ].join("\n");
}

function fishEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
