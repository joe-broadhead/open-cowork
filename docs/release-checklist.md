# Release Checklist

This checklist is intended for the first public tagged releases and later release dry runs.

## Before tagging

### Repository quality

- [ ] `pnpm test`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm perf:check`
- [ ] `git diff --check`
- [ ] working tree is clean

### Documentation

- [ ] `mkdocs build --strict`
- [ ] README matches current product behavior
- [ ] config docs match `open-cowork.config.json`
- [ ] packaging and release docs match the workflows
- [ ] `SECURITY.md` and `SUPPORT.md` are current
- [ ] medium-severity `pnpm audit --prod` output has been reviewed manually if CI stayed green

### Desktop app

- [ ] packaged app launches cleanly from a fresh build
- [ ] startup window appears reliably
- [ ] login/setup flow works
- [ ] home dashboard loads
- [ ] charts render in packaged builds
- [ ] sandbox artifacts work
- [ ] custom MCP add/test flow works
- [ ] custom agent flow works

### Release configuration

- [ ] version numbers are correct
- [ ] release workflows point at the correct package names and scripts
- [ ] macOS and Linux packaging scripts still match Electron Builder config
- [ ] release workflow is still tag-driven only
- [ ] release assets still include `SHA256SUMS.txt` and provenance attestation
- [ ] release notes or changelog summary is ready

## Tagged release

1. Create a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

2. Wait for the `Release` workflow to finish.
3. Verify the GitHub Release contains:
   - macOS zip artifacts
   - macOS dmg artifacts
   - Linux AppImage artifacts
   - Linux deb artifacts
   - `SHA256SUMS.txt`
4. Smoke-test at least one macOS build and one Linux build.

## After release

- [ ] sanity-check downloads from the GitHub Release page
- [ ] verify checksums against `SHA256SUMS.txt`
- [ ] update any milestone or release tracking issue
- [ ] document known caveats if signing/notarization is still pending
