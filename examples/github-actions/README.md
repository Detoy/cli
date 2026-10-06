# GitHub Actions examples

Copy-paste workflows for `vg scan`. The drift gate needs no token, no
`VIBGRATE_DSN`, and no write permission. `contents: read` is enough.

`vg` and `vibgrate` are the same binary. These workflows install a pinned
`@vibgrate/cli` and call `vg`. `npx @vibgrate/cli@<version>` runs that same
binary when you would rather not install globally. Do not put a trailing `.`
on `vg` or `vg scan` — the current directory is the default.

Product notes for SARIF, vulnerability gating, `max-score`, and infrastructure
findings: [`docs/ci/github-actions.md`](../../docs/ci/github-actions.md).

## Add a basic drift gate

Copy [`driftscore-ci.yml`](./driftscore-ci.yml) to
`.github/workflows/driftscore-ci.yml`. The job below is that file.

```yaml
name: DriftScore CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  drift-score:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      # Published npm release. Do not use @latest on a gate.
      - name: Install Vibgrate CLI
        run: npm install -g @vibgrate/cli@2026.1005.1

      - name: Drift gate
        run: vg scan --format json --out vibgrate-report.json --fail-on error --drift-budget 40

      # --out is written before a failing gate exits. always() keeps the report.
      - name: Upload report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: vibgrate-report
          path: vibgrate-report.json
```

What that job does:

- Installs `@vibgrate/cli` at `2026.1005.1`. That release is on npm and the
  matching scanner image is on `ghcr.io/vibgrate/cli`. See [Pins](#pins).
- Runs `vg scan` on the checkout. DriftScore is 0–100, lower is healthier.
  `--drift-budget 40` exits **2** when the measured score is **above** 40. A
  score equal to 40 passes.
- `--fail-on error` exits **2** when any drift finding has level `error`.
  Warning findings stay in the report and do not fail this flag.
- Writes `vibgrate-report.json` before the exit code is decided, then uploads
  it. `if: always()` keeps the artifact when the gate exits 2.
- `persist-credentials: false` keeps the job token out of `.git/config`.

The same flags without a global install:

```bash
npx @vibgrate/cli@2026.1005.1 scan --format json --out vibgrate-report.json --fail-on error --drift-budget 40
```

GitHub Actions fails a step on any non-zero exit. Exit **2** (`GATE_FAILED`)
fails the job. Exit **0** leaves the job green, including when the log prints
a yellow breach line. Exit **1** is a runtime error (bad manifest, unreadable
path). Exit **5** is a usage error (a bad `--fail-on` value fails before the
scan). Exit **6** means a required module is missing and could not be fetched.
That is not a gate verdict. Full table: [Exit codes](../../DOCS.md#exit-codes).

`--fail-on warn` exits 2 when a finding is `error` or `warning`. Here "warn"
means "fail the job on warnings." A `note` stays in the report under both
`warn` and `error`. To print a budget breach and keep the job green, use
[`driftBudget.mode: warn`](#warn-and-leave-the-job-green) and omit the budget
flags.

Do not set `continue-on-error` on this gate step. That turns exit 2 into a
green job, and it also continues after exit 1. `vibgrate-review-sarif.yml`
uses `continue-on-error` only because that file is not the gate.

## When the job fails

Flags and the project config are separate. Passing `--drift-budget` or
`--drift-worsening` uses the flags and skips `driftBudget` in the project
config for that run, in every mode.

| Control | What trips it | Exit | Job |
| --- | --- | --- | --- |
| `--fail-on error` | A drift finding with level `error` | 2 | fails |
| `--fail-on error` | No error-level finding | 0 | stays green. Warnings do not fail this gate. |
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
| Unknown `--fail-on` value | Usage error, before the scan | 5 | fails |
| Architecture or infrastructure gate requested, tree not evaluated | An unevaluated gate is not a pass | 2 | fails |
| A required module is missing and could not be fetched | Engine unavailable | 6 | fails. Not a budget verdict. |

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

## Warn and leave the job green

Commit this next to the workflow. `.vibgrate/config.yml` is the first config
file `vg` reads.

```yaml
# .vibgrate/config.yml
driftBudget:
  mode: warn          # warn (default) | enforce | shadow
  maxScore: 40        # fail only when DriftScore is above this, and only in enforce
  maxWorseningPercent: 5
```

Then drop the budget flags so the config is actually read:

```bash
vg scan --format json --out vibgrate-report.json
```

On a breach, warn mode prints a yellow line and this follow-up:

`drift budget: warn mode — set driftBudget.mode: enforce in .vibgrate/config.yml to fail the scan.`

The process exits 0, so the job stays green. `mode: enforce` exits 2 on the
same breach. `mode: shadow` prints the breach line, exits 0, and omits the
follow-up that names `enforce`.

`maxWorseningPercent` needs `--baseline`. Without one it is reported as not
evaluated and does not fail the scan, including in `enforce`.

Passing either flag uses the flag and ignores that file, whatever `mode` says:

```bash
vg scan --format json --out vibgrate-report.json --drift-budget 40
```

That exits 2 when the measured score is above 40.

### Worsening against a baseline

On the branch you want to freeze, run `vg baseline` and commit
`.vibgrate/baseline.json`. In CI, pass that file. Either flag skips the
config block, so put both limits on the command when you want both:

```bash
vg scan \
  --format json \
  --out vibgrate-report.json \
  --baseline .vibgrate/baseline.json \
  --drift-budget 40 \
  --drift-worsening 5 \
  --fail-on error
```

`--drift-worsening` without `--baseline` exits 2 when a score was measured.
See [Drift baselines](../../DOCS.md#drift-baselines--fitness-functions).

### GitHub App check

The **Vibgrate DriftScore** check on a pull request is not this workflow. It
reads `driftBudget` from the base branch (`.vibgrate/config.yml` or
`vibgrate.config.json`). Conclusions:

| Mode | Within the limit | Breach |
| --- | --- | --- |
| `enforce` | success | failure |
| `warn` | success | neutral (not green, and it does not fail the check) |
| `shadow` | neutral | neutral |

A missing or invalid budget is neutral. The check does not block the merge
unless you mark it required, and even then only an `enforce` breach is a
failure. `agents.maxWorseningPercent` is judged there, not by `vg scan`.

### JUnit

`--junit vibgrate.junit.xml` writes that file before the process exits,
including on exit 2. A warn-mode or shadow breach is `<skipped>` and does not
fail the scan. An enforced budget breach is `<failure>`. The exit code is
unchanged. See [JUnit](../../DOCS.md#junit).

## Pins

`npx @vibgrate/cli` with no version installs whatever is `latest` on npm at
job time. The gate then moves between runs. Pin the release you tested. Do
not use `@latest` on a gate.

| Surface | Pin | What floats if you skip it |
| --- | --- | --- |
| Node.js | `actions/setup-node@v4` with `node-version: 22` (22 or newer) | — |
| Checkout, setup-node, upload-artifact, CodeQL upload | These examples use major tags (`@v4`, `@v3`). In a repository you keep, pin each `uses:` to a full commit SHA. | The major tag moves |
| CLI on the runner | `npm install -g @vibgrate/cli@2026.1005.1` then `vg` | `npx @vibgrate/cli` tracks npm `latest` |
| Composite Action, frozen | `uses: vibgrate/cli@vibgrate-action/v2026.1005.1` | — |
| Composite Action, floating major | `uses: vibgrate/cli@v1` | The `v1` tag moves on each Action release |
| Scanner image inside the Action | `image-tag: "2026.1005.1"` | The default in that Action revision's `action.yml` |

`2026.1005.1` is the calendar version published to npm and as
`ghcr.io/vibgrate/cli:2026.1005.1`. This checkout's `package.json` `version`
and the default `image-tag` in [`action.yml`](../../action.yml) are
`2026.1006.1`. The Action git tag `vibgrate-action/v2026.1006.1` exists for
that stamp. Move the npm pin and `image-tag` to `2026.1006.1` together once
that package and image are published. `uses:` needs the Action tag
(`vibgrate-action/v<version>`), not the CLI git tag `v<version>`.

The same gate through the Action, still credential-free. `max-score` maps to
`--drift-budget` (0–100, lower is better). Leave it empty and the Action does
not fail on the score. A non-numeric `max-score` fails the step before the
scan. `fail-on` left empty does not gate on findings. `args` is still
appended to `scan` when you need a flag the inputs do not cover.

```yaml
      - name: Run Vibgrate drift gate
        uses: vibgrate/cli@vibgrate-action/v2026.1005.1
        with:
          format: json
          output: vibgrate-report.json
          fail-on: error
          max-score: 40
          image-tag: "2026.1005.1"
```

The Action runs `ghcr.io/vibgrate/cli` and needs Docker on the runner. The
`npm install` workflow above does not. `upload-sarif: true` needs
`permissions: security-events: write`; the JSON gate does not. The Action
does not expose the score as a step output. Read `drift.score` from the JSON
report when a later step needs the number.

## Assertions

The workflow above talks to the package registry, so DriftScore can move when
a package publishes. That is the gate you want on a real repository.

A test that asserts on the report needs a frozen input. Pass `--offline` and
a committed `--package-manifest`. The same tree and the same manifest produce
the same finding order and the same advisory ids. The report still includes
`timestamp` and `durationMs`, so two scans are not byte-identical. Assert on
`drift.score` and the process exit code. An absent DriftScore is `null`, not
`0`. `drift.riskLevel` is `low`, `moderate`, or `high` when a score was
measured, and `null` when it was not.

```bash
vg scan --offline --package-manifest ./package-versions.json --format json --out vibgrate-report.json --fail-on error --drift-budget 40
jq '.drift.score' vibgrate-report.json
```

## DriftScore badge

`vg` does not write a badge image, and there is no command that writes the
SVG. This workflow does not publish a badge and does not take a credential.
The README badge is a hosted image. The URL scheme is documented at
<https://vibgrate.com/badges>. The URL names that one repository:

```md
[![Vibgrate DriftScore](https://badges.vibgrate.com/OWNER/REPO)](https://dash.vibgrate.com/badges/driftscore/OWNER/REPO)
```

Replace `OWNER` and `REPO` with the GitHub owner and repository. For one
branch, add `?branch=develop` to the image URL only:

```md
[![Vibgrate DriftScore](https://badges.vibgrate.com/OWNER/REPO?branch=develop)](https://dash.vibgrate.com/badges/driftscore/OWNER/REPO)
```

How the image gets a number:

- **Public GitHub repository, no account.** The first request for a DriftScore
  badge Vibgrate has not scanned shows `scanning…` while a scan runs. A later
  request shows the score.
- **Already scanned in Vibgrate Cloud.** Turn the public badge on for that
  repository. The same markdown then reads the score that scan published.
  That switch is in the dashboard. Do not add a DSN to the gate job to light
  the badge.

Other images you can get back: `unknown` (no score yet), `unavailable` (the
automatic scan did not run — scan the repository yourself), `private` (the
public badge is off), `not found` (the repository has no score and is not
eligible for the automatic scan).

Colour is the score band, not a CI result. Lower is better: **0–30**
low/green, **31–60** moderate/amber, **61–100** high/red. A red badge does
not fail the job. The job fails only on the exit codes in the table above.
See [scoring methodology](../../docs/public/SCORING-METHODOLOGY-PUBLIC.md)
and [DriftScore](https://vibgrate.com/driftscore). The badges page also lists
CVE, RiskScore, and DriftRisk image URLs.

What this job does publish is the JSON artifact. Download `vibgrate-report`
from the run. The headline number is `drift.score`.

## Other templates in this folder

| File | Role |
| --- | --- |
| [`driftscore-ci.yml`](./driftscore-ci.yml) | JSON artifact + drift gate (this page) |
| [`driftscore-sarif.yml`](./driftscore-sarif.yml) | SARIF upload to code scanning. Upload runs with `if: always()` so a failed gate still files the alerts. |
| [`vulnerabilities-sarif.yml`](./vulnerabilities-sarif.yml) | Known-vulnerability gate via the composite Action (`fail-on: error` fails the job on critical and high) |
| [`vibgrate-review.yml`](./vibgrate-review.yml) | `vg review` with `--fail-on fail`. Only a `fail` decision stops the job. |
| [`vibgrate-review-sarif.yml`](./vibgrate-review-sarif.yml) | Review SARIF only. `continue-on-error` so the upload still runs. The pass/fail job is `vibgrate-review.yml`. |

SARIF upload uses `github/codeql-action/upload-sarif` and
`security-events: write`. Details, plus `--fail-on architecture-finding` and
`--fail-on iac-finding`: [`docs/ci/github-actions.md`](../../docs/ci/github-actions.md).
