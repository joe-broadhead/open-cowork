## Summary

- What changed?
- Why did it change?

## Validation

- [ ] `pnpm test`
- [ ] `pnpm test:gateway` (when Durable Gateway / `products/gateway` or shared security primitives change)
- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm perf:check` (if touched runtime, projection, or performance-sensitive code)
- [ ] `git diff --check`

## Dual-channel security checklist

Required when this PR touches **channel security or protocol** (signatures, SSRF/webhook URLs, auth tokens, rate limits, constant-time compares, trusted-target allowlists). See `docs/product-channel-ownership.md`.

CI gate (JOE-932): `scripts/check-dual-channel-pr-checklist.mjs` runs on PRs that touch Durable channels, monorepo providers, or shared channel-security kernels. Unrelated PRs skip. Satisfy by ticking below, or put `Dual-stack checklist: exempt` in Notes with a one-line rationale.

- [ ] N/A — not a channel security/protocol change
- [ ] Reviewed **monorepo providers** (`packages/gateway-provider-*`, `packages/gateway-channel`, `apps/channel-gateway`)
- [ ] Reviewed **Durable Gateway channels** (`products/gateway/src/channels/*` and related security)
- [ ] Shared primitives preferred (`@open-cowork/shared`, `gateway-channel`) over copy-paste
- [ ] Both stacks fixed **or** explicit single-stack ownership noted in Notes with follow-up

## User-visible impact

- [ ] No user-visible behavior change
- [ ] UI change
- [ ] Runtime behavior change
- [ ] Packaging / release change
- [ ] Docs change

## Notes

- Risks, caveats, or follow-up work:
