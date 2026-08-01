# Visual-regression baselines

Committed baseline PNGs for the monthly `visual-regression.eval.test.ts` flow.
Each file is a key surface captured in a specific color scheme, density, and
(for responsive surfaces) viewport width.

## How baselines are generated

Ordinary eval runs are read-only. A missing baseline fails the suite instead
of silently blessing the current UI. Baselines are created or replaced only
in the explicit review/update mode:

1. Run the eval suite with `OPEN_COWORK_EVAL_UPDATE_BASELINES=1` on a machine
   with a display.
2. Review every added or changed PNG in this directory. The suite covers the
   retained Mercury scheme/density matrix plus Home, Projects, and Knowledge
   states at 800px, 1024px, and 1440px.
3. Commit only accepted images. Run the suite again without the update flag to
   prove the committed baseline set is complete and read-only comparison passes.

To validate committed baselines:

```sh
pnpm test:e2e:evals
```

To intentionally create or replace baselines for review:

```sh
OPEN_COWORK_EVAL_UPDATE_BASELINES=1 pnpm test:e2e:evals
```

The diff runs inside the renderer via canvas (no image-decoding dependency)
and flags only large/structural changes; sub-pixel churn stays under the
threshold in `eval-helpers.ts`.
