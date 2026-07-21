# Visual-regression baselines

Committed baseline PNGs for the nightly `visual-regression.eval.test.ts` flow.
Each file is a key surface captured in a specific color scheme, e.g.
`home-dark.png`, `team-light.png`.

## How baselines are generated

Baselines are **seeded on first run**, not hand-authored:

1. The monthly `Monthly UI Evals` workflow (`.github/workflows/monthly-evals.yml`) runs the eval suite on a display.
2. For any surface with no committed baseline, `compareToBaseline`
   (`apps/desktop/tests/eval-helpers.ts`) writes the current capture here and
   passes the check with a `seeded` note.
3. The workflow uploads the seeded PNGs as the `nightly-eval-visual-baselines`
   artifact. A maintainer reviews them and commits the accepted images into
   this directory so subsequent runs diff against them.

To (re)generate locally on a machine with a display:

```sh
pnpm test:e2e:evals                          # seeds any missing baselines
OPEN_COWORK_EVAL_UPDATE_BASELINES=1 pnpm test:e2e:evals   # force re-seed all
```

The diff runs inside the renderer via canvas (no image-decoding dependency)
and flags only large/structural changes; sub-pixel churn stays under the
threshold in `eval-helpers.ts`.
