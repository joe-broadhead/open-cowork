import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

test("CI and release workflows expose stable public-release gates", async () => {
  const staticWorkflow = await readFile(".github/workflows/openwiki-static.yml", "utf8");
  assert.match(staticWorkflow, /pnpm build:web/);
  assert.match(staticWorkflow, /pnpm typecheck/);
  assert.match(staticWorkflow, /pnpm test/);
  assert.match(staticWorkflow, /pnpm test:ui/);
  assert.match(staticWorkflow, /pnpm test:ui-quality/);
  assert.match(staticWorkflow, /pnpm check:bundle/);
  assert.match(staticWorkflow, /playwright install --with-deps chromium/);
  assert.match(staticWorkflow, /pnpm screenshots/);
  assert.match(staticWorkflow, /actions\/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405/);
  assert.match(staticWorkflow, /python -m pip install -r docs\/requirements\.txt/);
  assert.match(staticWorkflow, /mkdocs build --strict/);
  assert.match(staticWorkflow, /openwiki-screenshots/);
  assert.match(staticWorkflow, /openwiki-ui-quality/);
  assert.match(staticWorkflow, /export static/);
  assert.match(staticWorkflow, /OPENWIKI_PAGES_BASE_URL/);
  assert.match(staticWorkflow, /github\.io\/\$\{\{ github\.event\.repository\.name \}\}\/demo/);
  assert.match(staticWorkflow, /mkdir -p site\/demo/);
  assert.match(staticWorkflow, /cp -R examples\/basic-wiki\/public\/\. site\/demo\//);
  assert.match(staticWorkflow, /path: site/);
  assert.doesNotMatch(staticWorkflow, /path: examples\/basic-wiki\/public/);
  assert.doesNotMatch(staticWorkflow, /base-url "\$\{\{ github\.server_url \}\}/);
  assert.match(staticWorkflow, /branches:\n      - master\n      - main/);
  assert.match(staticWorkflow, /Detect GitHub Pages configuration/);
  assert.match(staticWorkflow, /GH_REPOSITORY: \$\{\{ github\.repository \}\}/);
  assert.match(staticWorkflow, /gh api "repos\/\$\{GH_REPOSITORY\}\/pages"/);
  assert.doesNotMatch(staticWorkflow, /gh api "repos\/\$\{\{ github\.repository \}\}\/pages"/);
  assert.match(staticWorkflow, /if: needs\.pages-config\.outputs\.enabled == 'true'/);
  assert.match(staticWorkflow, /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128/);
  assert.doesNotMatch(staticWorkflow, /actions\/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e/);

  const buildSiteWorkflow = await readFile(".github/workflows/openwiki-build-site.yml", "utf8");
  assert.match(buildSiteWorkflow, /OpenWiki Build Site/);
  assert.match(buildSiteWorkflow, /workflow_call/);
  assert.match(buildSiteWorkflow, /export static/);
  assert.match(buildSiteWorkflow, /actions\/upload-artifact/);

  const lintWorkflow = await readFile(".github/workflows/openwiki-lint.yml", "utf8");
  assert.match(lintWorkflow, /OpenWiki Lint/);
  assert.match(lintWorkflow, /pull_request/);
  assert.match(lintWorkflow, /pnpm build:web/);
  assert.match(lintWorkflow, /pnpm lint/);
  assert.match(lintWorkflow, /pnpm docs:reference -- --check/);
  assert.match(lintWorkflow, /pnpm test:security/);
  assert.match(lintWorkflow, /pnpm eval:mcp-conformance/);
  assert.match(lintWorkflow, /pnpm eval:opencode-tools -- --setup-only/);
  assert.match(lintWorkflow, /pnpm coverage/);
  assert.match(lintWorkflow, /pnpm test:ui/);
  assert.match(lintWorkflow, /pnpm test:ui-quality/);
  assert.match(lintWorkflow, /pnpm check:bundle/);
  assert.match(lintWorkflow, /playwright install --with-deps chromium/);
  assert.match(lintWorkflow, /pnpm screenshots/);
  assert.match(lintWorkflow, /openwiki-screenshots/);
  assert.match(lintWorkflow, /openwiki-ui-quality/);
  assert.match(lintWorkflow, /openwiki-coverage/);
  assert.match(lintWorkflow, /run lint --json/);
  assert.match(lintWorkflow, /openwiki-lint\.json/);
  assert.match(lintWorkflow, /branches:\n      - master\n      - main/);

  const reviewWorkflow = await readFile(".github/workflows/openwiki-review-proposal.yml", "utf8");
  assert.match(reviewWorkflow, /OpenWiki Review Proposal/);
  assert.match(reviewWorkflow, /proposal_id/);
  assert.match(reviewWorkflow, /proposal detail/);
  assert.match(reviewWorkflow, /proposal validation/);
  assert.match(reviewWorkflow, /openwiki-proposal-review/);

  const postgresWorkflow = await readFile(".github/workflows/openwiki-postgres.yml", "utf8");
  assert.match(postgresWorkflow, /OpenWiki Postgres Runtime/);
  assert.match(postgresWorkflow, /postgres:17@sha256:/);
  assert.match(postgresWorkflow, /DATABASE_URL/);
  assert.match(postgresWorkflow, /pnpm test:postgres/);
  assert.match(postgresWorkflow, /branches:\n      - master\n      - main/);

  const imageWorkflow = await readFile(".github/workflows/openwiki-image.yml", "utf8");
  assert.match(imageWorkflow, /OpenWiki Image/);
  assert.match(imageWorkflow, /\.dockerignore/);
  assert.match(imageWorkflow, /integrations\/\*\*/);
  assert.match(imageWorkflow, /schemas\/\*\*/);
  assert.match(imageWorkflow, /templates\/\*\*/);
  assert.match(imageWorkflow, /permissions:\n  contents: read/);
  assert.match(imageWorkflow, /image-smoke:/);
  assert.match(imageWorkflow, /image-publish:/);
  const imageSmoke = imageWorkflow.slice(imageWorkflow.indexOf("image-smoke:"), imageWorkflow.indexOf("image-publish:"));
  const imagePublish = imageWorkflow.slice(imageWorkflow.indexOf("image-publish:"));
  assert.match(imageSmoke, /permissions:\n      contents: read/);
  assert.doesNotMatch(imageSmoke, /packages: write|id-token: write|attestations: write|security-events: write/);
  assert.match(imagePublish, /if: github\.event_name != 'pull_request'/);
  assert.match(imagePublish, /permissions:\n      contents: read\n      packages: write\n      id-token: write\n      attestations: write\n      security-events: write/);
  assert.match(imageWorkflow, /ghcr\.io\/joe-broadhead\/open-wiki/);
  assert.match(imageWorkflow, /docker build --tag openwiki\/openwiki:ci/);
  assert.match(imageWorkflow, /Build image for pre-publish scan/);
  assert.match(imageWorkflow, /openwiki\/openwiki:prepublish-scan/);
  assert.match(imageWorkflow, /Scan image before publish/);
  assert.match(imageWorkflow, /--read-only/);
  assert.match(imageWorkflow, /--tmpfs \/data\/wiki:uid=1000,gid=1000,mode=0770/);
  assert.match(imageWorkflow, /--user 1000:1000/);
  assert.match(imageWorkflow, /\/readyz/);
  assert.match(imageWorkflow, /\/mcp-manifest\.json/);
  assert.match(imageWorkflow, /docker-context-sentinel\.txt/);
  assert.match(imageWorkflow, /Verify ignored artifacts are absent from image/);
  assert.match(imageWorkflow, /type=raw,value=edge,enable=\{\{is_default_branch\}\}/);
  assert.doesNotMatch(imageWorkflow, /type=raw,value=latest/);
  assert.match(imageWorkflow, /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);
  assert.match(imageWorkflow, /github\/codeql-action\/upload-sarif@8aad20d150bbac5944a9f9d289da16a4b0d87c1e/);
  assert.match(imageWorkflow, /severity: HIGH,CRITICAL/);
  assert.match(imageWorkflow, /format: sarif[\s\S]+output: trivy-published-results\.sarif[\s\S]+severity: HIGH,CRITICAL[\s\S]+limit-severities-for-sarif: true/);
  assert.match(imageWorkflow, /Push candidate image digest/);
  assert.match(imageWorkflow, /outputs: type=image,name=ghcr\.io\/joe-broadhead\/open-wiki,push-by-digest=true,name-canonical=true,push=true/);
  assert.match(imageWorkflow, /provenance: true/);
  assert.match(imageWorkflow, /sbom: true/);
  assert.match(imageWorkflow, /sigstore\/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6/);
  assert.match(imageWorkflow, /cosign sign --yes ghcr\.io\/joe-broadhead\/open-wiki@\$\{\{ steps\.publish\.outputs\.digest \}\}/);
  assert.match(imageWorkflow, /actions\/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32/);
  assert.match(imageWorkflow, /subject-digest: \$\{\{ steps\.publish\.outputs\.digest \}\}/);
  assert.match(imageWorkflow, /Promote scanned image tags[\s\S]+docker buildx imagetools create/);
  assert.ok(imageWorkflow.indexOf("Scan candidate image digest") < imageWorkflow.indexOf("Promote scanned image tags"));
  assert.ok(imageWorkflow.indexOf("Sign image digest") < imageWorkflow.indexOf("Promote scanned image tags"));
  assert.doesNotMatch(imageWorkflow, /tags:\n      - "v\*"/);

  const docsWorkflow = await readFile(".github/workflows/openwiki-docs.yml", "utf8");
  assert.match(docsWorkflow, /OpenWiki Docs/);
  assert.match(docsWorkflow, /python -m pip install -r docs\/requirements\.txt/);
  assert.match(docsWorkflow, /mkdocs build --strict/);
  assert.match(docsWorkflow, /actions\/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405/);

  const releaseWorkflow = await readFile(".github/workflows/openwiki-release.yml", "utf8");
  assert.match(releaseWorkflow, /OpenWiki Release Validation/);
  assert.match(releaseWorkflow, /permissions:\n  contents: read/);
  assert.match(releaseWorkflow, /workflow_dispatch/);
  assert.match(releaseWorkflow, /tags:\n      - "v\*"/);
  assert.match(releaseWorkflow, /verify-version-tag:/);
  assert.match(releaseWorkflow, /Release tag \$\{RELEASE_TAG\} does not match package\.json version/);
  assert.match(releaseWorkflow, /postgres:17@sha256:/);
  assert.match(releaseWorkflow, /package-smoke:/);
  assert.match(releaseWorkflow, /pnpm pack:cli/);
  assert.match(releaseWorkflow, /Resolve packed CLI tarball/);
  assert.match(releaseWorkflow, /OPENWIKI_CLI_PACKAGE_TARBALL/);
  assert.match(releaseWorkflow, /openwiki-npm-package/);
  assert.match(releaseWorkflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(releaseWorkflow, /Download smoke-tested npm package/);
  assert.match(releaseWorkflow, /Verify npm package metadata/);
  assert.match(releaseWorkflow, /Expected exactly one smoke-tested npm package/);
  assert.match(releaseWorkflow, /package_name"\s*!=\s*"@openwiki\/cli"/);
  assert.match(releaseWorkflow, /Release tag \$\{RELEASE_TAG\} does not match npm package version/);
  assert.match(releaseWorkflow, /npm view "@openwiki\/cli@\$\{package_version\}" version/);
  assert.match(releaseWorkflow, /OPENWIKI_NPM_PACKAGE=\$package_file/);
  assert.match(releaseWorkflow, /Verify npm trusted publishing client/);
  assert.match(releaseWorkflow, /require >=11\.5\.1/);
  assert.match(releaseWorkflow, /npm publish "\$OPENWIKI_NPM_PACKAGE" --dry-run --access public/);
  assert.match(releaseWorkflow, /npm publish "\$OPENWIKI_NPM_PACKAGE" --access public/);
  assert.doesNotMatch(releaseWorkflow, /npm whoami/);
  assert.doesNotMatch(releaseWorkflow, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(releaseWorkflow, /secrets\.NPM_TOKEN/);
  assert.doesNotMatch(releaseWorkflow, /npm publish \.\/packages\/cli\/dist/);
  assert.doesNotMatch(releaseWorkflow, /npm publish artifacts\/npm\/\*\.tgz/);
  assert.match(releaseWorkflow, /release-evidence:/);
  assert.match(releaseWorkflow, /pnpm release:evidence/);
  assert.match(releaseWorkflow, /OPENWIKI_RELEASE_EVIDENCE_STRICT: "1"/);
  assert.match(releaseWorkflow, /helm_version="v3\.17\.3"/);
  assert.match(releaseWorkflow, /terraform_version="1\.12\.1"/);
  assert.match(releaseWorkflow, /kustomize_version="v5\.6\.0"/);
  assert.match(releaseWorkflow, /Download scale smoke artifact/);
  assert.match(releaseWorkflow, /name: openwiki-scale-smoke/);
  assert.match(releaseWorkflow, /path: artifacts/);
  assert.match(releaseWorkflow, /if-no-files-found: error/);
  assert.match(releaseWorkflow, /retention-days: 90/);
  assert.match(releaseWorkflow, /release-orchestrator:/);
  assert.match(releaseWorkflow, /Verify release train/);
  assert.match(releaseWorkflow, /release-image:/);
  assert.match(releaseWorkflow, /environment: ghcr-release/);
  assert.match(releaseWorkflow, /permissions:\n      contents: read\n      packages: write\n      id-token: write\n      attestations: write/);
  assert.match(releaseWorkflow, /type=raw,value=latest/);
  assert.match(releaseWorkflow, /Build release image for pre-publish scan/);
  assert.match(releaseWorkflow, /openwiki\/openwiki:release-prepublish-scan/);
  assert.match(releaseWorkflow, /Scan release image before publish/);
  assert.match(releaseWorkflow, /docker\/build-push-action@f9f3042f7e2789586610d6e8b85c8f03e5195baf/);
  assert.match(releaseWorkflow, /Push release candidate image digest/);
  assert.match(releaseWorkflow, /outputs: type=image,name=ghcr\.io\/joe-broadhead\/open-wiki,push-by-digest=true,name-canonical=true,push=true/);
  assert.match(releaseWorkflow, /provenance: true/);
  assert.match(releaseWorkflow, /sbom: true/);
  assert.match(
    releaseWorkflow,
    /format: sarif[\s\S]+output: trivy-release-published-results\.sarif[\s\S]+severity: HIGH,CRITICAL[\s\S]+limit-severities-for-sarif: true/,
  );
  assert.match(releaseWorkflow, /cosign sign --yes ghcr\.io\/joe-broadhead\/open-wiki@\$\{\{ steps\.publish\.outputs\.digest \}\}/);
  assert.match(releaseWorkflow, /actions\/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32/);
  assert.match(releaseWorkflow, /Promote scanned release image tags[\s\S]+docker buildx imagetools create/);
  assert.ok(releaseWorkflow.indexOf("Scan release candidate image digest") < releaseWorkflow.indexOf("Promote scanned release image tags"));
  assert.ok(releaseWorkflow.indexOf("Sign image digest") < releaseWorkflow.indexOf("Promote scanned release image tags"));
  assert.match(releaseWorkflow, /environment: npm-release/);
  assert.match(releaseWorkflow, /permissions:\n      contents: read\n      id-token: write/);
  assert.match(releaseWorkflow, /pnpm release:smoke -- local-personal/);
  assert.match(releaseWorkflow, /pnpm release:smoke -- static-export/);
  assert.match(releaseWorkflow, /pnpm audit --audit-level high/);
  assert.match(releaseWorkflow, /pnpm test:security/);
  assert.match(releaseWorkflow, /pnpm release:smoke -- security-basics/);
  assert.match(releaseWorkflow, /docker compose -f deploy\/compose\/docker-compose\.yml config --quiet/);
  assert.match(releaseWorkflow, /docker build --tag openwiki\/openwiki:release-smoke/);
  assert.match(releaseWorkflow, /aquasecurity\/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25/);
  assert.match(releaseWorkflow, /--read-only/);
  assert.match(releaseWorkflow, /\/readyz/);
  assert.match(releaseWorkflow, /\/mcp-manifest\.json/);
  assert.match(releaseWorkflow, /mkdocs build --strict/);
  assert.match(releaseWorkflow, /tests\/cli-package\.test\.ts/);
  assert.match(releaseWorkflow, /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/);
  assert.match(releaseWorkflow, /actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/);
  assert.match(releaseWorkflow, /actions\/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405/);

  const supplyChainWorkflow = await readFile(".github/workflows/openwiki-supply-chain.yml", "utf8");
  assert.match(supplyChainWorkflow, /OpenWiki Supply Chain/);
  assert.match(supplyChainWorkflow, /pull_request/);
  assert.match(supplyChainWorkflow, /schedule:/);
  assert.match(supplyChainWorkflow, /cron: "31 5 \* \* 2"/);
  assert.match(supplyChainWorkflow, /contents: read/);
  assert.match(supplyChainWorkflow, /pull-requests: read/);
  assert.doesNotMatch(supplyChainWorkflow, /pull-requests: write/);
  assert.match(supplyChainWorkflow, /pnpm audit --audit-level high/);
  assert.match(supplyChainWorkflow, /python -m pip_audit -r docs\/requirements\.txt/);
  assert.match(supplyChainWorkflow, /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/);

  const requiredCiWorkflow = await readFile(".github/workflows/openwiki-ci-required.yml", "utf8");
  assert.match(requiredCiWorkflow, /OpenWiki Required CI/);
  assert.match(requiredCiWorkflow, /ci-required:/);
  assert.match(requiredCiWorkflow, /name: ci-required/);
  assert.match(requiredCiWorkflow, /node compatibility \(\$\{\{ matrix\.node-version \}\}\)/);
  assert.match(requiredCiWorkflow, /"22\.22\.3"/);
  assert.match(requiredCiWorkflow, /"24\.x"/);
  assert.match(requiredCiWorkflow, /pnpm typecheck/);
  assert.match(requiredCiWorkflow, /pnpm test/);
  assert.match(requiredCiWorkflow, /pnpm pack:cli/);
  assert.match(requiredCiWorkflow, /pnpm release:smoke -- local-personal/);
  assert.match(requiredCiWorkflow, /pnpm audit --audit-level high/);
  assert.match(requiredCiWorkflow, /python -m pip_audit -r docs\/requirements\.txt/);
  assert.match(requiredCiWorkflow, /actions\/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294/);
  assert.match(requiredCiWorkflow, /NODE_COMPATIBILITY_RESULT/);
  assert.match(requiredCiWorkflow, /Required CI passed/);
  assert.match(requiredCiWorkflow, /name: Build web assets\n\s+run: pnpm build:web[\s\S]+name: Performance smoke\n\s+run: pnpm perf:check/);

  const codeqlWorkflow = await readFile(".github/workflows/openwiki-codeql.yml", "utf8");
  assert.match(codeqlWorkflow, /OpenWiki CodeQL/);
  assert.match(codeqlWorkflow, /security-events: write/);
  assert.match(codeqlWorkflow, /schedule:/);
  assert.match(codeqlWorkflow, /github\/codeql-action\/init@8aad20d150bbac5944a9f9d289da16a4b0d87c1e/);
  assert.match(codeqlWorkflow, /github\/codeql-action\/analyze@8aad20d150bbac5944a9f9d289da16a4b0d87c1e/);
  assert.match(codeqlWorkflow, /languages: javascript-typescript/);
  assert.match(codeqlWorkflow, /github\.event\.repository\.private == false/);
  assert.match(codeqlWorkflow, /Private repository CodeQL notice/);

  const dependabot = await readFile(".github/dependabot.yml", "utf8");
  assert.match(dependabot, /package-ecosystem: npm/);
  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.match(dependabot, /package-ecosystem: pip/);
  assert.match(dependabot, /directory: \/docs/);
  assert.match(dependabot, /package-ecosystem: docker/);
  assert.match(dependabot, /package-ecosystem: docker-compose/);
  assert.match(dependabot, /directory: \/deploy\/compose/);
  assert.match(dependabot, /package-ecosystem: terraform/);
  assert.match(dependabot, /directory: \/deploy\/terraform\/aws/);
  assert.match(dependabot, /directory: \/deploy\/terraform\/gcp/);

  const perfWorkflow = await readFile(".github/workflows/openwiki-perf.yml", "utf8");
  assert.match(perfWorkflow, /pull_request/);
  assert.match(perfWorkflow, /OPENWIKI_SCALE_MODE: \$\{\{ github\.event_name == 'pull_request' && 'smoke'/);
  assert.match(perfWorkflow, /OPENWIKI_SCALE_STAGE: \$\{\{ github\.event_name == 'pull_request' && '1k'/);
  assert.match(perfWorkflow, /name: Build web assets\n\s+run: pnpm build:web[\s\S]+name: Run scale performance profile/);

  const bundleGate = await readFile("packages/web/scripts/check-bundle.mjs", "utf8");
  assert.match(bundleGate, /src", "client"/);
  assert.match(bundleGate, /assets"\)/);
  assert.match(bundleGate, /--check/);
  assert.match(bundleGate, /Total asset JavaScript/);
  assert.match(bundleGate, /ASSET_JAVASCRIPT_BUDGET_BYTES/);

  const releaseDocs = await readFile("docs/development/release.md", "utf8");
  assert.match(releaseDocs, /PGLite local runtime/);
  assert.match(releaseDocs, /ADR 0009 keeps SQLite\/index-store as the local default/);
  assert.match(releaseDocs, /pnpm eval:opencode-tools -- --setup-only/);
  assert.match(releaseDocs, /PGLite runtime status/);
  assert.match(releaseDocs, /parity, backup\/restore, crash-recovery, migration, package-install, and vector-extension evidence/);

  const testingDocs = await readFile("docs/development/testing.md", "utf8");
  assert.match(testingDocs, /pnpm eval:opencode-tools -- --setup-only/);
  assert.match(testingDocs, /evals\/opencode-tool-coverage\/latest\.json/);
  assert.match(testingDocs, /seed\.recorder_plugin\.skip_category: "setup_only"/);
  assert.match(testingDocs, /OPENCODE_EVAL_RECORDER_PLUGIN/);
  assert.match(testingDocs, /@joe-broadhead\/opencode-tools\/plugins\/opencode_eval_recorder\.ts/);

  const opencodeReadme = await readFile("integrations/opencode/README.md", "utf8");
  assert.match(opencodeReadme, /pnpm eval:opencode-tools -- --setup-only/);
  assert.match(opencodeReadme, /seed\.recorder_plugin\.skipped: true/);
  assert.match(opencodeReadme, /seed\.recorder_plugin\.skip_category: "setup_only"/);
  assert.match(opencodeReadme, /Full evals fail with a setup error/);

  const pgliteAdr = await readFile("docs/adr/0009-pglite-local-runtime-spike.md", "utf8");
  assert.match(pgliteAdr, /## Status[\s\S]+Accepted/);
  assert.match(pgliteAdr, /OpenWiki keeps SQLite\/index-store as the supported local default/);
  assert.match(pgliteAdr, /PGLite is not required for local installs/);
  assert.match(pgliteAdr, /package\/install behavior for the generated `@openwiki\/cli` tarball/);
  assert.match(pgliteAdr, /vector-extension behavior, if claimed/);

  const workflowFiles = [
    staticWorkflow,
    buildSiteWorkflow,
    lintWorkflow,
    reviewWorkflow,
    postgresWorkflow,
    imageWorkflow,
    docsWorkflow,
    releaseWorkflow,
    supplyChainWorkflow,
    requiredCiWorkflow,
    codeqlWorkflow,
    perfWorkflow,
  ];
  assert.equal(workflowFiles.some((file) => /uses: .+@v[0-9]/.test(file)), false);
});
