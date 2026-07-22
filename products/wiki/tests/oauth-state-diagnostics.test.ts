import assert from "node:assert/strict";
import test from "node:test";
import {
  oauthFileStateUnsafeReason,
  resolveOAuthStateBackend,
} from "@openwiki/http-api";
import { oauthStateDiagnostic } from "../packages/cli/src/hosted-auth-diagnostics.ts";

test("resolveOAuthStateBackend prefers explicit env then operational postgres", () => {
  assert.equal(resolveOAuthStateBackend({ OPENWIKI_OAUTH_STATE_BACKEND: "postgres" }), "postgres");
  assert.equal(resolveOAuthStateBackend({ OPENWIKI_OAUTH_STATE_BACKEND: "file" }), "file");
  assert.equal(resolveOAuthStateBackend({ OPENWIKI_OPERATIONAL_STATE_BACKEND: "postgres" }), "postgres");
  assert.equal(resolveOAuthStateBackend({}), "file");
  assert.equal(resolveOAuthStateBackend({}, "postgres"), "postgres");
});

test("oauthFileStateUnsafeReason allows loopback file state and blocks hosted/multi-replica", () => {
  assert.equal(
    oauthFileStateUnsafeReason({
      stateBackend: "file",
      runtimeMode: "hosted",
      issuer: "http://localhost:3030",
    }),
    undefined,
  );
  assert.match(
    oauthFileStateUnsafeReason({
      stateBackend: "file",
      runtimeMode: "hosted",
      issuer: "https://wiki.example.com",
    }) ?? "",
    /postgres|single-node/i,
  );
  assert.match(
    oauthFileStateUnsafeReason({
      stateBackend: "file",
      runtimeMode: "team",
      issuer: "https://wiki.example.com",
      env: { OPENWIKI_WEB_REPLICAS: "3" },
    }) ?? "",
    /multi-replica|postgres|single-node/i,
  );
  assert.match(
    oauthFileStateUnsafeReason({
      stateBackend: "file",
      runtimeMode: "team",
      issuer: "https://wiki.example.com",
      env: {
        OPENWIKI_OAUTH_STATE_BACKEND: "file",
        OPENWIKI_OPERATIONAL_STATE_BACKEND: "postgres",
      },
    }) ?? "",
    /postgres|single-node/i,
  );
  assert.equal(
    oauthFileStateUnsafeReason({
      stateBackend: "postgres",
      runtimeMode: "hosted",
      issuer: "https://wiki.example.com",
    }),
    undefined,
  );
});

test("oauthStateDiagnostic fails closed for hosted OAuth with file state", () => {
  const fail = oauthStateDiagnostic(
    {
      auth: {
        oauth: {
          enabled: true,
          issuer: "https://wiki.example.com",
        },
      },
    },
    {
      OPENWIKI_RUNTIME_MODE: "hosted",
      OPENWIKI_OAUTH_STATE_BACKEND: "file",
    },
  );
  assert.equal(fail.name, "oauth-state");
  assert.equal(fail.status, "fail");
  assert.match(fail.message, /postgres|single-node|multi-replica/i);

  const skip = oauthStateDiagnostic({}, {});
  assert.equal(skip.name, "oauth-state");
  assert.equal(skip.status, "skip");

  const pass = oauthStateDiagnostic(
    {
      auth: {
        oauth: {
          enabled: true,
          issuer: "http://127.0.0.1:3030",
        },
      },
    },
    { OPENWIKI_RUNTIME_MODE: "local" },
  );
  assert.equal(pass.name, "oauth-state");
  assert.equal(pass.status, "pass");
  assert.match(pass.message, /single-process|loopback|local/i);

  const postgresPass = oauthStateDiagnostic(
    {
      auth: {
        oauth: { enabled: true, issuer: "https://wiki.example.com" },
      },
    },
    {
      OPENWIKI_RUNTIME_MODE: "hosted",
      OPENWIKI_OAUTH_STATE_BACKEND: "postgres",
      OPENWIKI_DATABASE_URL: "postgres://openwiki:openwiki@127.0.0.1:5432/openwiki",
    },
  );
  assert.equal(postgresPass.status, "pass");
});
