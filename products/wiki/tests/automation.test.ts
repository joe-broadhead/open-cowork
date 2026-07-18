import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspace } from "@openwiki/repo";
import { OpenWikiWriteInProgressError } from "@openwiki/workflows";
import {
  automationServiceStatus,
  createAutomationServicePlan,
  renderLaunchdPlist,
  renderSystemdService,
  renderSystemdTimer,
} from "../packages/cli/src/commands/service.ts";
import { readAutomationState, runForegroundWatcher } from "../packages/cli/src/commands/watch.ts";

const execFileAsync = promisify(execFile);
const CLI = [process.execPath, "--no-warnings", "--import", "tsx", path.join(process.cwd(), "packages", "cli", "src", "main.ts")];

test("foreground automation watcher records success, busy skips, failures, and backoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-watch-state-"));
  try {
    await createWorkspace(root, "Watcher State Wiki");
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const now = () => new Date(nowMs);
    const sleep = async (milliseconds: number) => {
      nowMs += milliseconds;
    };

    let successRuns = 0;
    const success = await runForegroundWatcher({
      root,
      kind: "sync",
      everySeconds: 60,
      maxRuns: 2,
      jitterRatio: 0,
      now,
      sleep,
      async runOnce() {
        successRuns += 1;
        return { status: "success", message: `ok ${successRuns}` };
      },
    });
    assert.deepEqual(success.runs.map((run) => run.status), ["success", "success"]);
    assert.equal(success.state.consecutive_failures, 0);

    const busy = await runForegroundWatcher({
      root,
      kind: "sync",
      everySeconds: 60,
      once: true,
      now,
      sleep,
      async runOnce() {
        throw new OpenWikiWriteInProgressError({
          backend: "local",
          lock_name: "git-writes",
          actor_id: "actor:user:other",
          operation: "wiki.proposal_apply",
          started_at: now().toISOString(),
          heartbeat_at: now().toISOString(),
          expires_at: new Date(nowMs + 30000).toISOString(),
          metadata: {},
        });
      },
    });
    assert.equal(busy.runs[0]?.status, "skipped_busy");

    let attempts = 0;
    const failed = await runForegroundWatcher({
      root,
      kind: "backup",
      everySeconds: 60,
      maxRuns: 4,
      jitterRatio: 0,
      now,
      sleep,
      async runOnce() {
        attempts += 1;
        throw new Error(`failure ${attempts}`);
      },
    });
    assert.deepEqual(failed.runs.map((run) => run.status), ["failed", "failed", "failed", "skipped_backoff"]);
    assert.equal(failed.state.consecutive_failures, 3);
    assert.ok(failed.state.next_run_at);
    const persisted = await readAutomationState(root, "backup");
    assert.equal(persisted.last_run?.status, "skipped_backoff");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service plans render launchd and systemd automation with logs, jitter, and one-shot watchers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-service-plan-"));
  try {
    await createWorkspace(root, "Service Plan Wiki");
    const macPlan = await createAutomationServicePlan({
      root,
      kind: "sync",
      every: "15m",
      platform: "macos",
      commandPrefix: ["openwiki"],
      workingDirectory: "/repo",
    });
    const plist = renderLaunchdPlist(macPlan);
    assert.match(plist, /<key>StartInterval<\/key>\n  <integer>900<\/integer>/);
    assert.match(plist, /<string>sync<\/string>/);
    assert.match(plist, /<string>watch<\/string>/);
    assert.match(plist, /<string>--once<\/string>/);
    assert.match(plist, /OPENWIKI_AUTOMATION_SERVICE/);
    assert.match(plist, /\.openwiki\/logs\/openwiki-/);

    const linuxPlan = await createAutomationServicePlan({
      root,
      kind: "backup",
      every: "24h",
      platform: "linux",
      commandPrefix: ["openwiki"],
      workingDirectory: "/repo",
    });
    const service = renderSystemdService(linuxPlan);
    const timer = renderSystemdTimer(linuxPlan);
    assert.match(service, /ExecStart="openwiki" "--root"/);
    assert.match(service, /"backup" "watch" "--every" "24h" "--once" "--json"/);
    assert.match(service, /Environment=OPENWIKI_AUTOMATION_SERVICE=1/);
    assert.match(timer, /OnUnitActiveSec=86400s/);
    assert.match(timer, /RandomizedDelaySec=300s/);
    assert.match(timer, /Persistent=true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service install, status, and uninstall manage user-level unit files without activation in tests", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-service-cli-"));
  const root = path.join(temp, "wiki");
  const serviceHome = path.join(temp, "home");
  const previousServiceHome = process.env.OPENWIKI_SERVICE_HOME;
  try {
    process.env.OPENWIKI_SERVICE_HOME = serviceHome;
    await createWorkspace(root, "Service CLI Wiki");
    const env = {
      OPENWIKI_SERVICE_PLATFORM: "linux",
      OPENWIKI_SERVICE_HOME: serviceHome,
      OPENWIKI_SERVICE_SKIP_ACTIVATE: "1",
    };
    const installed = JSON.parse((await runCli(["--root", root, "service", "install", "sync", "--every", "15m", "--json"], env)).stdout) as {
      installed: boolean;
      plan: { systemd_service_path: string; systemd_timer_path: string };
      activation: { status: string };
    };
    assert.equal(installed.installed, true);
    assert.equal(installed.activation.status, "skipped");
    assert.match(await readFile(installed.plan.systemd_service_path, "utf8"), /sync" "watch"/);
    assert.match(await readFile(installed.plan.systemd_timer_path, "utf8"), /OnUnitActiveSec=900s/);

    const status = await automationServiceStatus(root, "linux");
    assert.ok(status.services.some((service) => service.kind === "sync" && service.installed));

    const cliStatus = JSON.parse((await runCli(["--root", root, "service", "status", "--json"], env)).stdout) as {
      services: Array<{ kind: string; installed: boolean }>;
    };
    assert.ok(cliStatus.services.some((service) => service.kind === "sync" && service.installed));

    const uninstalled = JSON.parse((await runCli(["--root", root, "service", "uninstall", "sync", "--json"], env)).stdout) as {
      removed_paths: string[];
    };
    assert.equal(uninstalled.removed_paths.length, 2);
    const after = JSON.parse((await runCli(["--root", root, "service", "status", "--json"], env)).stdout) as {
      services: Array<{ kind: string; installed: boolean }>;
    };
    assert.ok(after.services.some((service) => service.kind === "sync" && !service.installed));
  } finally {
    restoreEnvValue("OPENWIKI_SERVICE_HOME", previousServiceHome);
    await rm(temp, { recursive: true, force: true });
  }
});

test("one-shot sync watcher returns a failing process status for real run failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-watch-exit-"));
  try {
    await createWorkspace(root, "Watcher Exit Wiki");
    let stdout = "";
    await assert.rejects(
      async () => {
        try {
          await runCli(["--root", root, "sync", "watch", "--every", "1h", "--once", "--push", "--json"]);
        } catch (error) {
          stdout = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
          throw error;
        }
      },
      /Command failed/,
    );
    const result = JSON.parse(stdout) as { runs: Array<{ status: string }> };
    assert.equal(result.runs[0]?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runCli(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(CLI[0] ?? process.execPath, [...CLI.slice(1), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024 * 16,
  });
}

function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
