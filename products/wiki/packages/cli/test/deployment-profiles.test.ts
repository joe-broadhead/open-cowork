import assert from "node:assert/strict";
import test from "node:test";
import { DEPLOYMENT_PROFILE_NAMES, deploymentProfileFor } from "../src/deployment-profiles.ts";

test("deployment profile aliases resolve through the CLI command module", () => {
  assert.equal(deploymentProfileFor("k8s").name, "kubernetes-enterprise");
  assert.equal(deploymentProfileFor("cloud-run-read-mostly").name, "cloud-run-readmostly");
  assert.equal(deploymentProfileFor("compose").name, "docker-private");
});

test("deployment profiles keep hosted-scale backends explicit", () => {
  assert.ok(DEPLOYMENT_PROFILE_NAMES.includes("kubernetes-enterprise"));
  const enterprise = deploymentProfileFor("kubernetes-enterprise");
  assert.equal(enterprise.postgres, "required");
  assert.equal(enterprise.objectStorageBackup, "required");
  assert.equal(enterprise.writeCoordinator, "required");
  assert.equal(enterprise.rateLimits, "required");
  assert.throws(() => deploymentProfileFor("unknown-profile"), /Invalid deployment profile/);
});
