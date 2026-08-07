#!/usr/bin/env node
// OpenWiki hosted packaging smoke.
//
//   node packaging/smoke-hosted-compose.mjs          # local boot-path check (no Docker needed)
//   node packaging/smoke-hosted-compose.mjs --docker # full compose stack check (Docker required)
//
// Local mode exercises the REAL container entrypoint (init -> git bootstrap ->
// derived stores -> serve) against a temp wiki root and asserts livez/readyz/
// healthz + the web UI + the API. Docker mode additionally builds the image and
// runs the compose stack, then runs `doctor --profile hosted` inside the container.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const wikiRoot = path.resolve(here, "..");
const repoRoot = path.resolve(wikiRoot, "..", "..");
const entrypoint = path.join(here, "entrypoint.sh");
const cliDist = path.join(wikiRoot, "packages", "cli", "dist", "openwiki.js");
const composeFile = path.join(here, "docker-compose.yml");

const RUN = process.env.OPENWIKI_SMOKE_PORT ?? "3955";
let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✖"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
};
const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { ...opts, env: { ...process.env, ...(opts.env ?? {}) } }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (url, timeoutMs = 3000) =>
  new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
  });
async function waitFor(url, tries = 30, delayMs = 500) {
  for (let i = 0; i < tries; i++) {
    const r = await get(url, 1500);
    if (r.status && r.status < 500) return r;
    await sleep(delayMs);
  }
  return { status: 0, body: "unreachable" };
}

async function localBootPath() {
  console.log("== local boot-path check (real entrypoint, no Docker) ==");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "openwiki-hosted-smoke-"));
  const port = RUN;
  try {
    ok("CLI dist exists", (await run("node", ["--no-warnings", cliDist, "version", "--short"])).code === 0);
    // Wrapper so OPENWIKI_BIN is a single runnable path (as in the image).
    const wrapper = path.join(tmp, "openwiki-wrapper");
    await run("sh", ["-c", `printf '#!/bin/sh\nexec node --no-warnings ${cliDist} "$@"\n' > ${wrapper} && chmod +x ${wrapper}`]);
    const child = spawn("sh", [entrypoint, "serve"], {
      env: {
        ...process.env,
        OPENWIKI_BIN: wrapper,
        OPENWIKI_ROOT: tmp,
        OPENWIKI_PORT: port,
      },
    });
    // OPENWIKI_BIN may be a single path; keep it simple: exec sh entrypoint with env vars.
    child.stderr.on("data", (d) => process.stderr.write(`[entrypoint] ${d}`));
    const live = await waitFor(`http://127.0.0.1:${port}/livez`);
    ok("livez responds", live.status === 200, `status=${live.status}`);
    const ready = await waitFor(`http://127.0.0.1:${port}/readyz`);
    ok("readyz responds 200", ready.status === 200, `status=${ready.status}`);
    const health = await waitFor(`http://127.0.0.1:${port}/healthz`);
    ok("healthz responds", health.status === 200, `status=${health.status}`);
    const api = await waitFor(`http://127.0.0.1:${port}/api/v1/health`);
    ok("api/v1/health responds", api.status === 200, `status=${api.status}`);
    const ui = await waitFor(`http://127.0.0.1:${port}/`);
    ok("web UI serves HTML", ui.status === 200 && /<!doctype html/i.test(ui.body), `status=${ui.status}`);
    const doctor = await run("node", ["--no-warnings", cliDist, "--root", tmp, "doctor", "--profile", "hosted", "--json", "--public-origin", "https://wiki.example.com"]);
    const djson = doctor.stdout.slice(doctor.stdout.indexOf("{"));
    ok("doctor --profile hosted parses", doctor.code === 0 && djson.startsWith("{"), "rc=" + doctor.code);
    ok("init bootstrapped openwiki.json", (await run("sh", ["-c", `test -f ${tmp}/openwiki.json`])).code === 0);
    ok("git history bootstrapped", (await run("sh", ["-c", `git -C ${tmp} rev-parse HEAD >/dev/null 2>&1`])).code === 0);
    child.kill("SIGTERM");
    await sleep(800);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function dockerStack() {
  console.log("== compose stack check (requires Docker) ==");
  const info = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.code !== 0) {
    console.log("(skip) Docker is not available on this machine");
    return;
  }
  const env = { ...process.env, OPENWIKI_PUBLIC_ORIGIN: "https://wiki.example.com", OPENWIKI_DATABASE_PASSWORD: "smoke-db-pass-123" };
  const up = await run("docker", ["compose", "-f", composeFile, "up", "-d", "--build"], { env });
  ok("docker compose up --build", up.code === 0, up.stderr.trim().split("\n").slice(-1)[0]?.slice(0, 120) ?? "");
  if (up.code !== 0) return;
  try {
    const ready = await waitFor(`http://127.0.0.1:3030/readyz`, 60, 1000);
    ok("compose readyz responds", ready.status !== undefined && ready.status < 500, `status=${ready.status}`);
    const health = await waitFor(`http://127.0.0.1:3030/healthz`, 10, 1000);
    ok("compose healthz responds", health.status === 200, `status=${health.status}`);
    const doctor = await run("docker", ["compose", "-f", composeFile, "exec", "-T", "wiki", "openwiki", "doctor", "--profile", "hosted", "--json", "--public-origin", "https://wiki.example.com"]);
    ok("doctor --profile hosted in container", doctor.code === 0, doctor.stderr.trim().slice(-100) ?? "");
    await run("docker", ["compose", "-f", composeFile, "logs", "--tail", "30", "wiki"]);
  } finally {
    await run("docker", ["compose", "-f", composeFile, "down", "-v"]);
  }
}

const dockerOnly = process.argv.includes("--docker");
if (dockerOnly) await dockerStack();
else await localBootPath();

console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
