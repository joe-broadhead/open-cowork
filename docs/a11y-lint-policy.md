# jsx-a11y lint policy (JOE-893)

## Hard-fail (error)

Rules at `error` in `eslint.a11y.config.mjs` fail CI via `pnpm lint:a11y`.

Includes ARIA validity, click-events-have-key-events, label-has-associated-control.

## Accepted warns

These stay **warn** by policy (community/product disagreement or SPA patterns):

- `no-noninteractive-element-interactions`
- `no-static-element-interactions`
- `alt-text` / `heading-has-content` / `no-redundant-roles` (warn until zero)
- SPA-router-sensitive anchor rules where documented

Do not promote to error without an explicit cleanup PR that clears the
baseline. When promoting, set `pnpm lint:a11y` to `--max-warnings 0` so new
warnings cannot re-land silently.
