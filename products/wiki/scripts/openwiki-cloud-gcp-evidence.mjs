import { performance } from "node:perf_hooks";

export function createGcpEvidenceTools({
  repoRoot,
  execFile,
  sourceCommand,
  sourceGit,
  options,
  terraformVar,
  requiredTerraformVar,
  terraformOutputString,
  jsonHttpCheck,
  redact,
  round,
  addRuntimeRedaction,
  setTerraformVar,
}) {
  let cloudBuildBucketExisted = true;
  let buildImageRequested = false;

  async function prepareEnvironment() {
    const terraformToken = await sourceCommand("gcloud", ["auth", "print-access-token"]);
    if (terraformToken && !terraformToken.startsWith("unavailable:")) {
      process.env.GOOGLE_OAUTH_ACCESS_TOKEN = terraformToken;
      addRedaction(terraformToken);
    }
    if (!process.env.TF_VAR_project_id?.trim()) {
      const projectId = await sourceCommand("gcloud", ["config", "get-value", "project"]);
      if (projectId && !projectId.startsWith("unavailable:")) {
        setTerraformVar("project_id", projectId);
      }
    }
    if (options.apply && !process.env.TF_VAR_name?.trim()) {
      setTerraformVar("name", `ow-${Date.now().toString(36).slice(-8)}`);
    }
    buildImageRequested = shouldBuildImage();
    if (buildImageRequested) {
      const projectId = requiredTerraformVar("project_id");
      cloudBuildBucketExisted = await bucketExists(`${projectId}_cloudbuild`);
      const region = terraformVar("region", "europe-west4");
      const name = terraformVar("name", "openwiki");
      const commit = sourceGit.commit?.slice(0, 12) || Date.now().toString(36);
      setTerraformVar("image", `${region}-docker.pkg.dev/${projectId}/${name}/openwiki:${commit}`);
    }
  }

  function shouldBuildImage() {
    return buildImageRequested || (options.provider === "gcp" && options.apply && (options.gcpBuildImage || !process.env.TF_VAR_image?.trim()));
  }

  function artifactRegistrySetupArgs(moduleDir) {
    return [
      "terraform",
      "-chdir=" + moduleDir,
      "apply",
      "-auto-approve",
      "-input=false",
      "-no-color",
      "-target=google_project_service.required[\"artifactregistry.googleapis.com\"]",
      "-target=google_project_service.required[\"cloudbuild.googleapis.com\"]",
      "-target=google_artifact_registry_repository.openwiki",
      "-target=google_artifact_registry_repository_iam_member.cloud_build_compute_writer",
      "-target=google_artifact_registry_repository_iam_member.cloud_build_legacy_writer",
      "-target=google_project_iam_member.cloud_build_compute_storage_viewer",
      "-target=google_project_iam_member.cloud_build_compute_logging_writer",
    ];
  }

  async function imageDigestCheck(imageTag, projectId) {
    const started = performance.now();
    try {
      const { stdout, stderr } = await execFile("gcloud", ["artifacts", "docker", "images", "describe", imageTag, "--project", projectId, "--format=json"], {
        cwd: repoRoot,
        env: process.env,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const digest = imageDigestFromDescribe(stdout);
      const digestRef = digest === undefined ? undefined : `${imageTagWithoutTag(imageTag)}@${digest}`;
      return {
        name: "gcp_image_digest",
        pass: digestRef !== undefined,
        status: digestRef !== undefined ? "passed" : "failed",
        command: redact(`gcloud artifacts docker images describe ${imageTag} --project ${projectId} --format=json`),
        elapsed_ms: round(performance.now() - started),
        digest_ref: digestRef,
        stdout_sample: redact(`${stdout}${stderr}`.trim()).slice(0, 1000),
      };
    } catch (error) {
      return {
        name: "gcp_image_digest",
        pass: false,
        status: "failed",
        elapsed_ms: round(performance.now() - started),
        error: redact(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async function probeContext(outputs, origin) {
    const projectId = requiredTerraformVar("project_id");
    const region = terraformVar("region", "europe-west4");
    const trustedSecretName = terraformOutputString(outputs, "trusted_auth_headers_secret_name");
    const workerJobName = terraformOutputString(outputs, "worker_job_name");
    const rebuildJobName = terraformOutputString(outputs, "rebuild_job_name");
    if (!trustedSecretName || !workerJobName || !rebuildJobName) {
      throw new Error("GCP Terraform outputs must include trusted_auth_headers_secret_name, worker_job_name, and rebuild_job_name");
    }
    const trustedSecret = await secretValue(projectId, trustedSecretName);
    const identityToken = await identityToken();
    addRedaction(trustedSecret);
    addRedaction(identityToken);
    return {
      projectId,
      region,
      origin,
      trustedSecret,
      identityToken,
      workerJobName,
      rebuildJobName,
    };
  }

  function iamHeaders(context) {
    return {
      authorization: `Bearer ${context.identityToken}`,
    };
  }

  function trustedHeaders(context) {
    return {
      ...iamHeaders(context),
      "x-openwiki-proxy-secret": context.trustedSecret,
      "x-openwiki-actor": "actor:user:gcp-terraform-smoke",
      "x-openwiki-role": "admin",
      origin: context.origin,
    };
  }

  async function queueLintRun(origin, context) {
    const started = performance.now();
    try {
      const response = await fetch(`${origin}/api/v1/runs`, {
        method: "POST",
        headers: {
          ...trustedHeaders(context),
          "content-type": "application/json",
        },
        body: JSON.stringify({ run_type: "lint" }),
      });
      const body = await response.text();
      const json = parseJson(body);
      const runId = typeof json?.run?.id === "string" ? json.run.id : undefined;
      const pass = response.status === 202 && runId !== undefined && json?.run?.status === "queued";
      return {
        runId,
        check: {
          name: "gcp_queue_lint_run",
          pass,
          status: pass ? "passed" : "failed",
          status_code: response.status,
          elapsed_ms: round(performance.now() - started),
          run_id: runId,
          body_sample: redact(body.slice(0, 1000)),
        },
      };
    } catch (error) {
      return {
        runId: undefined,
        check: {
          name: "gcp_queue_lint_run",
          pass: false,
          status: "failed",
          elapsed_ms: round(performance.now() - started),
          error: redact(error instanceof Error ? error.message : String(error)),
        },
      };
    }
  }

  async function runDetailCheck(origin, context, runId) {
    if (!runId) {
      return { name: "gcp_run_detail_post_worker", pass: false, status: "skipped", reason: "No queued run id was captured." };
    }
    return jsonHttpCheck("gcp_run_detail_post_worker", origin, `/api/v1/runs/${encodeURIComponent(runId)}`, {
      headers: trustedHeaders(context),
      validate: (json) => {
        const events = Array.isArray(json?.events) ? json.events : [];
        return json?.run?.status === "succeeded"
          && events.some((event) => event?.data?.queue_backend === "postgres");
      },
    });
  }

  async function postDestroyVerify(outputs, context) {
    const started = performance.now();
    const projectId = context?.projectId ?? terraformVar("project_id", "");
    const region = context?.region ?? terraformVar("region", "europe-west4");
    const checks = [
      await resourceAbsent("service", ["run", "services", "describe", terraformOutputString(outputs, "service_name"), "--project", projectId, "--region", region, "--format=value(metadata.name)"]),
      await resourceAbsent("worker_job", ["run", "jobs", "describe", terraformOutputString(outputs, "worker_job_name"), "--project", projectId, "--region", region, "--format=value(metadata.name)"]),
      await resourceAbsent("rebuild_job", ["run", "jobs", "describe", terraformOutputString(outputs, "rebuild_job_name"), "--project", projectId, "--region", region, "--format=value(metadata.name)"]),
      await resourceAbsent("sql_instance", ["sql", "instances", "describe", terraformOutputString(outputs, "sql_instance_name"), "--project", projectId, "--format=value(name)"]),
      await resourceAbsent("bucket", ["storage", "buckets", "describe", `gs://${terraformOutputString(outputs, "bucket")}`, "--format=value(name)"]),
      await resourceAbsent("artifact_repository", ["artifacts", "repositories", "describe", terraformOutputString(outputs, "artifact_repository"), "--project", projectId, "--location", region, "--format=value(name)"]),
      await resourceAbsent("database_secret", ["secrets", "describe", terraformOutputString(outputs, "database_url_secret_name"), "--project", projectId, "--format=value(name)"]),
      await resourceAbsent("trusted_auth_secret", ["secrets", "describe", terraformOutputString(outputs, "trusted_auth_headers_secret_name"), "--project", projectId, "--format=value(name)"]),
      await resourceAbsent("service_account", ["iam", "service-accounts", "list", "--project", projectId, "--filter", `email:${terraformOutputString(outputs, "service_account_email")}`, "--format=value(email)"]),
      await cloudBuildBucketCleanup(projectId),
    ];
    const budgetName = terraformOutputString(outputs, "budget_name");
    if (budgetName) {
      const billingAccountId = terraformVar("billing_account_id", "");
      checks.push(await resourceAbsent("budget", ["billing", "budgets", "describe", budgetName, "--billing-account", billingAccountId, "--format=value(name)"]));
    }
    const pass = checks.every((check) => check.absent);
    return {
      name: "gcp_post_destroy_verify",
      pass,
      status: pass ? "passed" : "failed",
      elapsed_ms: round(performance.now() - started),
      resources: checks,
    };
  }

  async function secretValue(projectId, secretName) {
    const { stdout } = await execFile("gcloud", ["secrets", "versions", "access", "latest", "--secret", secretName, "--project", projectId], {
      cwd: repoRoot,
      env: process.env,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  async function identityToken() {
    const { stdout } = await execFile("gcloud", ["auth", "print-identity-token"], {
      cwd: repoRoot,
      env: process.env,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  }

  async function bucketExists(bucketName) {
    try {
      await execFile("gcloud", ["storage", "buckets", "describe", `gs://${bucketName}`, "--format=value(name)"], {
        cwd: repoRoot,
        env: process.env,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      return true;
    } catch {
      return false;
    }
  }

  async function cloudBuildBucketCleanup(projectId) {
    const bucketName = `${projectId}_cloudbuild`;
    if (cloudBuildBucketExisted) {
      return { label: "cloud_build_bucket", absent: true, skipped: "bucket existed before this evidence run" };
    }
    try {
      await execFile("gcloud", ["storage", "rm", "--recursive", `gs://${bucketName}`, "--quiet"], {
        cwd: repoRoot,
        env: process.env,
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch {
      // Continue to the absence check; it reports any remaining bucket.
    }
    return resourceAbsent("cloud_build_bucket", ["storage", "buckets", "describe", `gs://${bucketName}`, "--format=value(name)"]);
  }

  async function resourceAbsent(label, args) {
    if (args.some((arg) => arg === undefined || arg === "")) {
      return { label, absent: false, reason: "missing resource identifier" };
    }
    try {
      const { stdout } = await execFile("gcloud", args, {
        cwd: repoRoot,
        env: process.env,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      return { label, absent: stdout.trim().length === 0, stdout_sample: redact(stdout.trim()).slice(0, 500) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const absent = /not[_ -]?found|does not exist|could not be found|Cannot find|BucketNotFound|No URLs matched/i.test(message);
      return { label, absent, error_sample: redact(message).slice(0, 500) };
    }
  }

  function addRedaction(value) {
    if (value) {
      addRuntimeRedaction(value);
    }
  }

  return {
    prepareEnvironment,
    shouldBuildImage,
    artifactRegistrySetupArgs,
    imageDigestCheck,
    probeContext,
    iamHeaders,
    trustedHeaders,
    queueLintRun,
    runDetailCheck,
    postDestroyVerify,
  };
}

function imageDigestFromDescribe(text) {
  try {
    const parsed = JSON.parse(text);
    const found = findDigest(parsed);
    return found?.startsWith("sha256:") ? found : undefined;
  } catch {
    return undefined;
  }
}

function findDigest(value) {
  if (typeof value === "string" && value.startsWith("sha256:")) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findDigest(entry);
      if (found) return found;
    }
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) {
      const found = findDigest(entry);
      if (found) return found;
    }
  }
  return undefined;
}

function imageTagWithoutTag(imageTag) {
  const separator = imageTag.lastIndexOf(":");
  return separator === -1 ? imageTag : imageTag.slice(0, separator);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
