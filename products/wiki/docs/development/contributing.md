# Contributing

The canonical contributor process lives in the root `CONTRIBUTING.md`. In
short:

- keep changes scoped
- add tests for public behavior
- preserve strict TypeScript
- do not introduce type escape hatches
- document new public operations
- update schemas and fixtures together
- run `pnpm validate` before opening a pull request

Contributor checkouts can run the source CLI with `pnpm openwiki -- ...`.
User-facing docs should prefer the packaged `openwiki` binary.
