#!/usr/bin/env node
import { openWikiCliExitCodeForError } from "@openwiki/core";
import { parseArgs } from "./args.ts";
import { printCommandHelp, printHelp } from "./output.ts";
import { cliErrorMessage, installCliProcessHandlers } from "./process-lifecycle.ts";

async function main(argv: string[]): Promise<void> {
  const { command, args, options } = parseArgs(argv);
  if (command === "help") {
    printCommandHelp(args[0]);
    return;
  }
  if (command !== undefined && command !== "--help" && command !== "-h" && (args.includes("--help") || args.includes("-h"))) {
    printCommandHelp(command);
    return;
  }

  switch (command) {
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return;
    case "version":
      await (await import("./commands/version.ts")).versionCommand(args, options);
      return;
    case "--version":
    case "-v":
      await (await import("./commands/version.ts")).versionCommand(["--short", ...args], options);
      return;
    case "upgrade":
      await (await import("./commands/version.ts")).versionCommand(["--check"], options);
      return;
    case "self-check":
      await (await import("./commands/self-check.ts")).selfCheckCommand(options);
      return;
    case "doctor":
      await (await import("./commands/doctor.ts")).doctorCommand(options);
      return;
    case "completion":
      await (await import("./commands/completion.ts")).completionCommand(args, options);
      return;
    case "setup":
      await (await import("./commands/agent.ts")).setupCommand(args, options);
      return;
    case "agent":
      await (await import("./commands/agent.ts")).agentCommand(args, options);
      return;
    case "deploy":
      await (await import("./commands/agent.ts")).deployCommand(args, options);
      return;
    case "init":
      await (await import("./commands/basic.ts")).initCommand(args, options);
      return;
    case "index":
      await (await import("./commands/basic.ts")).indexCommand(options);
      return;
    case "db":
      await (await import("./commands/basic.ts")).dbCommand(args, options);
      return;
    case "search":
      await (await import("./commands/basic.ts")).searchCommand(args, options);
      return;
    case "recall":
      await (await import("./commands/memory.ts")).recallCommand(args, options);
      return;
    case "ask":
      await (await import("./commands/basic.ts")).askCommand(args, options);
      return;
    case "think":
      await (await import("./commands/basic.ts")).thinkCommand(args, options);
      return;
    case "page":
      await (await import("./commands/basic.ts")).pageCommand(args, options);
      return;
    case "pages":
      await (await import("./commands/basic.ts")).pagesCommand(args, options);
      return;
    case "source":
      await (await import("./commands/basic.ts")).sourceCommand(args, options);
      return;
    case "topics":
      await (await import("./commands/basic.ts")).topicsCommand(options);
      return;
    case "schema-pack":
      await (await import("./commands/schema-pack.ts")).schemaPackCommand(args, options);
      return;
    case "questions":
    case "open-questions":
      await (await import("./commands/basic.ts")).questionsCommand(options);
      return;
    case "dream":
      await (await import("./commands/dream.ts")).dreamCommand(args, options);
      return;
    case "graph":
      await (await import("./commands/graph-audit.ts")).graphCommand(args, options);
      return;
    case "history":
      await (await import("./commands/graph-audit.ts")).historyCommand(args, options);
      return;
    case "diff":
      await (await import("./commands/graph-audit.ts")).diffCommand(args, options);
      return;
    case "changes":
      await (await import("./commands/graph-audit.ts")).changesCommand(options);
      return;
    case "git":
      await (await import("./commands/graph-audit.ts")).gitCommand(args, options);
      return;
    case "sync":
      await (await import("./commands/sync.ts")).syncCommand(args, options);
      return;
    case "inbox":
      await (await import("./commands/inbox.ts")).inboxCommand(args, options);
      return;
    case "service":
      await (await import("./commands/service.ts")).serviceCommand(args, options);
      return;
    case "commit":
      await (await import("./commands/graph-audit.ts")).commitCommand(options);
      return;
    case "events":
      await (await import("./commands/graph-audit.ts")).eventsCommand(options);
      return;
    case "audit":
      await (await import("./commands/graph-audit.ts")).auditCommand(args, options);
      return;
    case "governance":
      await (await import("./commands/basic.ts")).governanceCommand(args, options);
      return;
    case "runs":
      await (await import("./commands/runs.ts")).runsCommand(args, options);
      return;
    case "run":
      await (await import("./commands/runs.ts")).runCommand(args, options);
      return;
    case "validate":
      await (await import("./commands/runs.ts")).runCommand(["lint"], options);
      return;
    case "worker":
      await (await import("./commands/runs.ts")).workerCommand(options);
      return;
    case "publish":
      await (await import("./commands/export-backup.ts")).publishCommand(args, options);
      return;
    case "backup":
      await (await import("./commands/export-backup.ts")).backupCommand(args, options);
      return;
    case "claim":
      await (await import("./commands/basic.ts")).claimCommand(args, options);
      return;
    case "facts":
    case "fact":
      await (await import("./commands/memory.ts")).factsCommand(args, options);
      return;
    case "takes":
    case "take":
      await (await import("./commands/memory.ts")).takesCommand(args, options);
      return;
    case "trajectory":
      await (await import("./commands/memory.ts")).trajectoryCommand(args, options);
      return;
    case "decision":
      await (await import("./commands/basic.ts")).decisionCommand(args, options);
      return;
    case "propose-edit":
      await (await import("./commands/workflows.ts")).proposeEditCommand(args, options);
      return;
    case "synthesize":
      await (await import("./commands/workflows.ts")).synthesizeCommand(options);
      return;
    case "proposal":
      await (await import("./commands/workflows.ts")).proposalCommand(args, options);
      return;
    case "policy":
      await (await import("./commands/workflows.ts")).policyCommand(args, options);
      return;
    case "spaces":
      await (await import("./commands/workflows.ts")).spacesCommand(args, options);
      return;
    case "auth":
      await (await import("./commands/workflows.ts")).authCommand(args, options);
      return;
    case "workspace":
    case "workspaces":
      await (await import("./commands/workflows.ts")).workspaceCommand(args, options);
      return;
    case "maintainer":
      await (await import("./commands/ops.ts")).maintainerCommand(args, options);
      return;
    case "integrate":
      await (await import("./commands/ops.ts")).integrateCommand(args, options);
      return;
    case "mcp":
      await (await import("./commands/ops.ts")).mcpCommand(args, options);
      return;
    case "serve":
      await (await import("./commands/ops.ts")).serveCommand(args, options);
      return;
    case "export":
      await (await import("./commands/export-backup.ts")).exportCommand(args, options);
      return;
    default:
      throw new Error(`Unknown command '${command}'. Run openwiki --help.`);
  }
}

installCliProcessHandlers();

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(`openwiki: ${cliErrorMessage(error)}`);
  process.exitCode = openWikiCliExitCodeForError(error);
});
