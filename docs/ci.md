# Running CloudFault in CI

`cloudfault ci` is the CI entry point. In one invocation it:

1. replays every pinned regression in the corpus (`cloudfault-regressions/`),
2. runs the systematic search for every config it is given or finds,
3. writes per-suite JSON/JUnit/HTML reports plus a combined `summary.json`,
   `summary.md`, and `junit.xml`,
4. appends `summary.md` to `$GITHUB_STEP_SUMMARY` and prints `::error`
   annotations when running under GitHub Actions, and
5. exits with a code that says what happened.

```bash
npx cloudfault ci                          # every cloudfault.config.{mjs,js} under .
npx cloudfault ci apps/api apps/web        # directories are searched, files run as-is
npx cloudfault ci 'workers/*/cloudfault.config.mjs' --strict --seed 42
```

Configs import `@gmacko/cloudfault`, so the project must already depend on it.
Install it as a dev dependency (`npm install -D @gmacko/cloudfault`) and run the
CLI that comes with it.

## Repos without a config: `--starter`

`cloudfault ci --starter` uses the configs it finds. When there are none, it
runs the starter plan that `cloudfault init` would generate, for every Wrangler
config under the targets (default `.`), in-process. You don't need a
`cloudfault.config.mjs`. This is what ForgeGraph's default advisory check runs
on Cloudflare Workers apps.

- Each Worker becomes a `starter:<worker-name>` suite. It is started from its
  Wrangler config, KV and Queue producer bindings are routed through nemesis
  Workers, and `GET /` is sent while the starter faults are applied. The check
  fails on 5xx responses and failed scheduled runs.
- Scenarios whose faults can only be applied inside the Worker are not run.
  They are counted as `unsupportedScenarios` in `summary.json`.
- A Worker that can't start (missing build output, unresolved imports, a bad
  config) is `not-runnable`. It shows up in the summary and as a skipped JUnit
  case, and it does **not** fail CI, even with `--strict`.
- Starter failures write an artifact but have no replay module, so they can't
  be pinned. Run `cloudfault init` to get a config you can replay and extend.
- `wrangler` and `miniflare` are peer dependencies. They are loaded from the
  project under test (`CLOUDFAULT_PROJECT_ROOT`, or else the working directory)
  when it has a Wrangler with `createTestHarness()`. Otherwise the copy
  installed next to CloudFault is used, so `npx -y @gmacko/cloudfault ci
  --starter` works in a checkout that has no CloudFault dependency.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Every search passed and every pinned regression stayed fixed. |
| `1` | An invariant failed (including a failing baseline with no faults injected) or a pinned regression reproduced. |
| `2` | `--strict` only: a budget (`--max-runs`, `--time-budget`, or the config's `budget`) left scenarios unexplored. |
| `3` | A config failed to load or crashed, or the command was misused (for example no configs found). |

If several apply, `1` wins over `3`, and `3` wins over `2`. Without `--strict`, a
budget-truncated search is reported as `INCOMPLETE` and still exits `0`.
Scenarios skipped because the search already stopped on a failure never count
as incomplete.

## Options

| Flag | Effect |
|------|--------|
| `--seed <n>` | Seed every search. The seed is printed and recorded in `summary.json` so the failure can be replayed. |
| `--max-scenarios <n>` | Cap the planned scenarios per config. |
| `--max-runs <n>` | Run budget per config, merged into the config's `budget`. |
| `--time-budget <dur>` | Wall-time budget per config (`90s`, `5m`, `1h`, `500ms`; a bare number is seconds). |
| `--concurrency <n>` | Scenarios run in parallel per config. |
| `--reports-dir <dir>` | Where reports go (default `.cloudfault/reports`). |
| `--failures-dir <dir>` | Where failure artifacts go (default `.cloudfault/failures`). |
| `--regressions-dir <dir>` | The pinned regression corpus (default `cloudfault-regressions`). |
| `--no-regressions` | Skip replaying the corpus. |
| `--strict` | Exit `2` on incomplete searches. |
| `--starter` | Run the config-free starter plan when no configs are found (see above). |

`cloudfault run <config>` takes the same search flags (`--seed`, `--max-scenarios`,
`--max-runs`, `--time-budget`, `--concurrency`, `--reports-dir`, `--failures-dir`,
`--strict`) for running a single suite.

Discovery skips `node_modules`, `.git`, `.cloudfault`, `.wrangler`, and `dist`.
Glob patterns need Node 22 or later.

## Outputs

In the reports directory:

- `summary.json` (`schema: "cloudfault.ci"`): overall `status`, `exitCode`,
  `totals`, and one entry per search or pin. Each entry has its minimal failure
  set, failed checkers, skipped-scenario counts, seed, and artifact path.
- `summary.md`: the same content as a Markdown table (the text appended to the
  job summary).
- `junit.xml`: one `<testsuites>` document holding every search's suite, an
  error suite for each config that crashed, and a `cloudfault/regressions`
  suite for the pins. Point your CI's test-report integration at this file.
- `<suite>.json`, `<suite>.junit.xml`, and on failure `<suite>.html`.

Each failing search also writes a replayable artifact to the failures directory.

## The regression corpus

A bug found once should stay found. When a search fails:

```bash
npx cloudfault replay .cloudfault/failures/<artifact>.json   # reproduce locally
npx cloudfault pin .cloudfault/failures/<artifact>.json      # add it to the corpus
git add cloudfault-regressions && git commit
```

`pin` copies the minimized failure into `cloudfault-regressions/`. The file name
is derived from the test name and the minimal failure set, so pinning the same
bug twice overwrites the first pin. A replay module that is a file is rewritten
relative to the corpus, so pins replay from any working directory. Replays use
the module's `runScenario` export, or the config's `execute()` when there is no
such export (generated starter configs have none).

On every `cloudfault ci`, pins replay **before** the search:

- `REPRODUCED`: the minimal failure set still breaks an invariant. CI fails (exit `1`).
- `RESOLVED`: the fix holds. Keep the pin; it now guards against the bug coming back.

The corpus lives outside `.cloudfault/` on purpose, because `.cloudfault/` holds
run output and is usually gitignored. You can pin a failure before it is fixed
to record a known bug, but CI stays red until it is fixed.

## GitHub Actions

This repository ships a composite action that wraps `cloudfault ci` and uploads
the reports and failure artifacts, including on failure:

```yaml
jobs:
  cloudfault:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      # Optional: carry coverage guidance and the scenario cache between runs
      # (configs opt in with persistGuidance / cache: "file").
      - uses: actions/cache@v4
        with:
          path: |
            .cloudfault/coverage-guidance.json
            .cloudfault/scenario-cache.json
          key: cloudfault-${{ github.ref_name }}-${{ github.run_id }}
          restore-keys: |
            cloudfault-${{ github.ref_name }}-
            cloudfault-main-
      - uses: gmackie/cloudfault@v0.3.0
        with:
          seed: ${{ github.run_number }}
          time-budget: 10m
          strict: "true"
```

Action inputs: `targets`, `working-directory`, `seed`, `strict`, `max-scenarios`,
`max-runs`, `time-budget`, `concurrency`, `reports-dir`, `failures-dir`,
`regressions-dir`, `upload-reports` (default `true`), and `artifact-name`. Outputs:
`exit-code` and `summary` (the path to `summary.json`). See [`action.yml`](../action.yml).

Without the action:

```yaml
      - run: npx cloudfault ci --seed ${{ github.run_number }} --strict
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: cloudfault-reports
          path: .cloudfault/
```

### Choosing a seed

The planners don't use the seed: a config gives the same scenario plan on every
run. The seed is passed to `execute()` as `scenario.seed`, for workloads that
generate randomized traffic (for example fast-check workloads). A fixed seed (or
none) repeats identical runs. `--seed ${{ github.run_number }}` changes the
workload on every run while still printing each seed and recording it in
`summary.json` and the failure artifact, so `cloudfault replay` reproduces the
failing run.

## Forgejo Actions (git.forgegraf.com)

Forgejo runners accept the same workflow syntax and set `GITHUB_ACTIONS`, so
`::error` annotations are printed. Depending on the Forgejo version, the job
summary may not be rendered and `actions/upload-artifact@v4` may be rejected.
`summary.md` is always written to the reports directory, and v3 of the artifact
action works:

```yaml
      - run: npx cloudfault ci --seed ${{ github.run_number }} --strict
      - if: always()
        uses: actions/upload-artifact@v3
        with:
          name: cloudfault-reports
          path: .cloudfault/
```

## Publishing results to ForgeGraph

To gate ForgeGraph delivery lanes on CloudFault, push the same search as evidence
after the gate:

```yaml
      - if: always()
        env:
          FORGEGRAPH_TOKEN: ${{ secrets.FORGEGRAPH_TOKEN }}
        run: npx cloudfault evidence run ./cloudfault.config.mjs --app <slug>
```

`evidence` re-runs the search (it does not read `summary.json`) and pushes unless
given `--dry-run`. Read the dispatch guard in the README before pushing from a
workflow that runs on merged commits.

## Troubleshooting

- **`cloudfault ci: No CloudFault configs found`** (exit 3): pass the config
  paths, or name them `cloudfault.config.mjs`.
- **A crashing config shows up as `ERROR`** in the summary and as a JUnit
  `<error>`, and the remaining configs still run. Set `CLOUDFAULT_DEBUG=1` to
  print stack traces for tool errors.
- **Unserializable state.** Values in a run's state or history that can't be
  serialized (for example a Miniflare RPC stub used after the harness closed)
  are written as `"[unserializable: …]"` placeholders and don't crash the run.
  To keep the real data, convert it to plain values before closing the harness.
