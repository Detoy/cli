# GitHub Actions examples

Copy-paste workflows for `vg scan`. The drift gate needs no token, no
`VIBGRATE_DSN`, and no write permission. `contents: read` is enough.

`vg` and `vibgrate` are the same binary. These workflows install a pinned
`@vibgrate/cli` and call `vg`.

Product notes for SARIF, vulnerability gating, and infrastructure findings:
[`docs/ci/github-actions.md`](../../docs/ci/github-actions.md).

## Add a basic drift gate

Copy [`driftscore-ci.yml`](./driftscore-ci.yml) to
`.github/workflows/driftscore-ci.yml`. The workflow below matches that file.

```yaml
name: DriftScore CI

on:
  pull_request:
  push:
    branches: [ main ]

permissions:
  contents: read

jobs:
  drift-score:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # Pin the release you tested. `npx @vibgrate/cli` with no version
      # installs npm latest on every run, so the scanner itself drifts.
      - name: Install Vibgrate
        run: npm install -g @vibgrate/cli@2026.1005.1

      - name: Run Vibgrate drift gate
        run: |
          vg scan \
            --format json \
            --out vibgrate-report.json \
            --fail-on error \
            --drift-budget 40

      # The JSON is written before the gate exits, including on exit 2.
      - name: Upload report artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: vibgrate-report
          path: vibgrate-report.json
```

What that job does:

- Installs `@vibgrate/cli` at `2026.1005.1` (the release this repository
  currently ships; see [Pins](#pins)).
- Runs `vg scan` on the checkout. DriftScore is 0–100, lower is healthier.
  `--drift-budget 40` exits **2** when the measured score is **above** 40. A
  score equal to 40 passes.
- `--fail-on error` exits **2** when any drift finding has level `error`.
  Warning findings stay in the report and do not fail this flag.
- Writes `vibgrate-report.json` before the exit code is decided, then uploads
  it. `if: always()` keeps the artifact when the gate exits 2.

GitHub Actions fails a step on any non-zero exit. Exit **2** (`GATE_FAILED`)
fails the job. Exit **0** leaves the job green, including when the log prints
a yellow breach line. Exit **1** is a runtime error. Exit **5** is a usage
error (a bad `--fail-on` value fails before the scan). Full table:
[Exit codes](../../DOCS.md#exit-codes).

`--fail-on warn` exits 2 when a finding is `error` or `warning`. Here "warn"
means "fail the job on warnings." A `note` stays in the report under both
`warn` and `error`. To print a budget breach and keep the job green, use
[`driftBudget.mode: warn`](#warn-and-leave-the-job-green) and omit the budget
flags.

## When the job fails

Flags and the project config are separate. Passing `--drift-budget` or
`--drift-worsening` uses the flags and skips `driftBudget` in the project
config for that run, in every mode.

| Control | What trips it | Exit | Job |
| --- | --- | --- | --- |
| `--fail-on error` | A drift finding with level `error` | 2 | fails |
| `--fail-on warn` | A drift finding with level `error` or `warning` | 2 | fails |
| `--fail-on` omitted | Findings are reported and do not gate | 0 from this check | stays green |
| `--drift-budget N` | Measured DriftScore **above** N (`score > N`) | 2 | fails |
| `--drift-budget N` | Measured score equal to N, or lower, including a measured 0 | 0 | stays green |
| `--drift-budget N` | DriftScore is `null` (nothing measured) | 0, budget not compared | stays green |
| `--drift-worsening P` with `--baseline` | Drift got worse by **more than** P percent | 2 | fails |
| `--drift-worsening P` with `--baseline` | Drift is unchanged or improved, or the percent equals P | 0 | stays green |
| `--drift-worsening P` without `--baseline` | A DriftScore was measured | 2 | fails |
| `--drift-worsening P` | DriftScore is `null` | 0, worsening not compared | stays green |
| `driftBudget.mode: enforce` | A limit in that block is breached | 2 | fails |
| `driftBudget.mode: warn` (the default) | A limit is breached | 0, yellow breach line | stays green |
| `driftBudget.mode: shadow` | A limit is breached | 0, breach line only | stays green |
| Invalid `driftBudget` (unknown key, bad number) | Config is reported and not applied | 0 | stays green |
| `maxWorseningPercent` without `--baseline` | Rule is not evaluated, in every mode | 0 from that rule | stays green |

A `null` score is unmeasured. `--drift-budget` skips it and exits 0. A
measured 0 is a real score and is compared.

`agents.maxWorseningPercent` is not evaluated by `vg scan`. The GitHub App
check, which knows who opened the pull request, owns that limit. Locally it
does not fail the job.

The flag messages on stderr are:

- `Failing fitness function: DriftScore <score>/100 exceeds budget <N>.`
- `Failing fitness function: --drift-worsening requires --baseline to compare against previous drift.`
- `Failing fitness function: drift worsened by <percent>% (threshold <P>%).`
- `DriftScore is absent; --drift-budget <N> was not compared.`

Worsening percent is `(head − base) / max(|base|, 0.0001) × 100`, and only
when the score got worse. Same arithmetic as `maxWorseningPercent` in config.
Command reference: [`vg scan`](../../DOCS.md#vg-scan). Config reference:
[Drift budget](../../DOCS.md#drift-budget).

`continue-on-error: true` on the scan step lets the workflow continue after
exit 2. It also continues after exit 1. Prefer `driftBudget.mode: warn` when
the breach should be a log line and the process should exit 0.

## Warn and leave the job green

Commit this next to the workflow. `.vibgrate/config.yml` is the first config
file `vg` reads.

```yaml
# .vibgrate/config.yml
driftBudget:
  mode: warn          # warn (default) | enforce | shadow
  maxScore: 40        # fail only when DriftScore is above this, and only in enforce
```

Then drop the budget flags so the config is actually read:

```yaml
      - name: Run Vibgrate drift gate
        run: |
          vg scan \
            --format json \
            --out vibgrate-report.json \
            --fail-on error
```

On a breach, warn mode prints a yellow line and this follow-up:

`drift budget: warn mode — set driftBudget.mode: enforce in .vibgrate/config.yml to fail the scan.`

The process exits 0, so the job stays green. `mode: enforce` exits 2 on the
same breach. `mode: shadow` prints the breach line, exits 0, and omits the
follow-up that names `enforce`.

`--fail-on error` in that snippet still exits 2 on an error-level finding.
Remove it when findings should not gate.

## Worsening against a baseline

On the branch you want to freeze, run `vg baseline` and commit
`.vibgrate/baseline.json`. In CI, pass that file. Either flag skips the
config block, so put both limits on the command when you want both:

```yaml
      - name: Run Vibgrate drift gate
        run: |
          vg scan \
            --format json \
            --out vibgrate-report.json \
            --baseline .vibgrate/baseline.json \
            --drift-budget 40 \
            --drift-worsening 5 \
            --fail-on error
```

`--drift-worsening` without `--baseline` exits 2 when a score was measured.
In config, `maxWorseningPercent` without `--baseline` is reported as not
evaluated and does not fail, including in `enforce`. See
[Drift baselines](../../DOCS.md#drift-baselines--fitness-functions).

## Pins

`npx @vibgrate/cli` with no version installs whatever is `latest` on npm at
job time. The gate then moves between runs. Pin the release you tested.

| Surface | Pin | What floats if you skip it |
| --- | --- | --- |
| CLI on the runner | `npm install -g @vibgrate/cli@2026.1005.1` then `vg` | `npx @vibgrate/cli` tracks npm `latest` |
| Composite Action, frozen | `uses: vibgrate/cli@vibgrate-action/v2026.1005.1` | — |
| Composite Action, floating major | `uses: vibgrate/cli@v1` | The `v1` tag moves on each Action release |
| Scanner image inside the Action | `image-tag: "2026.1005.1"` | The default in that Action revision's `action.yml` |

`2026.1005.1` is the `version` in this repo's `package.json` and the default
`image-tag` in [`action.yml`](../../action.yml). Bump the pin when you choose
a newer release. The Action tag with a slash is `vibgrate-action/v<version>`
(the Marketplace tag). The npm package and the git tag `v<version>` are the
CLI release; `uses:` needs the Action tag, not the CLI tag.

The same gate through the Action, still credential-free. `args` is appended
to `scan`. `fail-on` left empty does not gate on findings; `--drift-budget`
in `args` still exits 2 on its own.

```yaml
      - name: Run Vibgrate drift gate
        uses: vibgrate/cli@vibgrate-action/v2026.1005.1
        with:
          format: json
          output: vibgrate-report.json
          fail-on: error
          args: --drift-budget 40
          image-tag: "2026.1005.1"
```

The Action runs `ghcr.io/vibgrate/cli` and needs Docker on the runner. The
`npm install` workflow above does not. `upload-sarif: true` needs
`permissions: security-events: write`; the JSON gate does not.

## DriftScore badge

`vg` does not write a badge image. The README badge is a hosted image. The
URL scheme is documented at <https://vibgrate.com/badges>:

```md
[![Vibgrate DriftScore](https://badges.vibgrate.com/OWNER/REPO)](https://dash.vibgrate.com/badges/driftscore/OWNER/REPO)
```

Replace `OWNER` and `REPO` with the GitHub owner and repository. For one
branch, add `?branch=develop` to the image URL only.

A DriftScore badge for a public repository that has not been scanned yet
shows `scanning…` on the first request, then a score. That path does not need
an account. Enabling a badge after your own `vg scan` is a Vibgrate Cloud
setting on the same site (install the CLI, run a scan, enable the public
badge). This workflow does not call that service and does not take a secret.

Badge colours use the same bands as the score: **0–30** low/green, **31–60**
moderate/amber, **61–100** high/red. See
[scoring methodology](../../docs/public/SCORING-METHODOLOGY-PUBLIC.md) and
[DriftScore](https://vibgrate.com/driftscore). The badges page also lists
CVE, RiskScore, and DriftRisk image URLs.

What this job does publish is the JSON artifact. Download `vibgrate-report`
from the run. The headline number is `drift.score` (`null` when nothing was
measured). `drift.riskLevel` is `low`, `moderate`, or `high` when a score
was measured, and `null` when it was not.

```bash
jq '.drift.score' vibgrate-report.json
```

The report includes `timestamp` and `durationMs`, so two scans of one tree
are not byte-identical. Assert on `drift.score` and the process exit code.
Registry lookups run unless you pass `--offline`, so the same commit can
score differently after an upstream release. What the number means:
<https://vibgrate.com/driftscore>.

## Other templates in this folder

| File | Role |
| --- | --- |
| [`driftscore-ci.yml`](./driftscore-ci.yml) | JSON artifact + drift gate (this page) |
| [`driftscore-sarif.yml`](./driftscore-sarif.yml) | SARIF upload to code scanning |
| [`vulnerabilities-sarif.yml`](./vulnerabilities-sarif.yml) | Known-vulnerability gate via `vibgrate/cli@v1` |
| [`vibgrate-review.yml`](./vibgrate-review.yml) | `vg review` on a pull request |
| [`vibgrate-review-sarif.yml`](./vibgrate-review-sarif.yml) | Review security findings as SARIF |

SARIF upload uses `github/codeql-action/upload-sarif` and
`security-events: write`. Details, plus `--fail-on architecture-finding` and
`--fail-on iac-finding`: [`docs/ci/github-actions.md`](../../docs/ci/github-actions.md).
`--junit <file>` writes a second report of the same gates and does not change
the exit code: [JUnit](../../DOCS.md#junit).
