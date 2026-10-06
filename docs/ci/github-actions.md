# GitHub Actions integration

Vibgrate already supports CI gating and SARIF export through the core `scan` command.

## Quick start

```bash
vg init --ci github
```

This writes `.github/workflows/vibgrate.yml`: it scans every pull request and
push to `main` with the `vibgrate/cli` Action and uploads SARIF to GitHub
Security. It never overwrites an existing workflow, and it does not fail the
build until you opt in (`fail-on`, `--drift-budget`) using the commented lines
in the file. SARIF upload to private repositories needs GitHub code scanning.

## Gate on the DriftScore

The `vibgrate/cli` Action fails the job when the DriftScore is above a budget
you choose. `max-score` takes a number from 0 to 100 (lower is better) and maps
to `--drift-budget`; leave it empty to never fail on the score. A non-numeric
value fails the step with a clear error.

```yaml
- uses: actions/checkout@v4
- uses: vibgrate/cli@v1
  with:
    upload-sarif: true
    max-score: 40
```

The Action does not yet expose the score as a step output. Read it from the
JSON report (`format: json`) if a later step needs the number.

## Copy-paste workflows

- Drift gate (failure versus warn, pins, DriftScore badge): `examples/github-actions/README.md`
- CI drift gate template: `examples/github-actions/driftscore-ci.yml`
- SARIF upload template: `examples/github-actions/driftscore-sarif.yml`
- Vulnerability gate + SARIF template: `examples/github-actions/vulnerabilities-sarif.yml`

Copy any template into your repository under `.github/workflows/`. The drift-gate README is enough to add the basic gate to an empty repository: the workflow, when the job fails, which release to pin, and how a README badge is filled in.

## Vulnerability gate (`--vulns`)

Use the maintained `vibgrate/cli` Action to scan for known vulnerabilities, gate
the pull request, and upload SARIF to code scanning in one step:

```yaml
permissions:
  contents: read
  security-events: write   # required to upload SARIF

steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0        # full history → exposure attribution + remediation MTTR
  - uses: vibgrate/cli@v1
    with:
      vulns: true
      fail-on: error        # critical/high block the merge
      upload-sarif: true
      category: vibgrate-vulns
```

The Action inputs map to scan flags: `vulns: true` adds `--vulns`, `fail-on` adds
`--fail-on`, and `upload-sarif: true` runs `github/codeql-action/upload-sarif`
after the scan (with `always()`, so findings still surface when the gate fails).
Prefer raw CLI steps? `npx @vibgrate/cli scan --vulns --format sarif --out
vibgrate-vulns.sarif --fail-on error`, then upload the file yourself.

## Infrastructure misconfiguration gate (`--iac`)

The same scan can evaluate Terraform, Kubernetes, Helm and Dockerfile facts
against the Architecture module's `iac-cis-v1` pack and gate on the result.
Findings carry content-addressed ids, so the SARIF you upload tracks the same
alert across rebases instead of re-opening it when a line moves.

```yaml
permissions:
  contents: read
  security-events: write

steps:
  - uses: actions/checkout@v4
  - run: npx @vibgrate/cli scan --full --format sarif --out vibgrate.sarif --fail-on iac-finding
  - uses: github/codeql-action/upload-sarif@v3
    if: always()
    with:
      sarif_file: vibgrate.sarif
      category: vibgrate
```

`--fail-on iac-finding` exits 2 on a high or critical infrastructure finding;
`--fail-on iac-finding=medium` lowers the bar, and a comma list combines it
with the drift gate (`--fail-on error,iac-finding`). The gate needs the code
map the scan builds and the Architecture module, which the CLI provisions on
first use; on an air-gapped runner install it with `vg module install arch`
from a bundle or set `VIBGRATE_ARCH_PATH`. A gate that cannot be evaluated
exits 2 with a one-line reason rather than passing. Rule catalogue and output
shapes: [`../security-packs.md`](../security-packs.md). How `.tf` and `.tofu`
files are treated, including a `.tofu`-only tree:
[Terraform and OpenTofu files](../security-packs.md#terraform-and-opentofu-files).

## Drift gate behavior

The full table — finding gates, budget flags, `warn` / `enforce` / `shadow`, pins, and the DriftScore badge — is in [`examples/github-actions/README.md`](../../examples/github-actions/README.md). The short form:

`--fail-on warn` **fails** the job (exit 2) when a warning or error finding exists. `driftBudget.mode: warn` **does not**. That mode prints a breached budget and exits 0. `shadow` reports only and exits 0. `enforce` exits 2.

`--drift-budget` and `--drift-worsening` always exit 2 on a breach, and they ignore `driftBudget` in the project config. A score equal to the budget passes. A DriftScore that was not measured does not fail either flag (it is absent, not 0). `--drift-worsening` without `--baseline` exits 2 when a score was measured. The same worsening key in config, with no baseline, is not evaluated and does not fail.

Do not set `continue-on-error` on the gate step. Exit 2 is what blocks the merge. Upload SARIF or the JSON report with `if: always()` — the file is already written when the gate exits.

```bash
vg scan --format json --out vibgrate-report.json --fail-on error --drift-budget 40
```

An unpinned `npx @vibgrate/cli` installs npm `latest` on every run. The pinned workflow in [`examples/github-actions/README.md`](../../examples/github-actions/README.md) is the copy-paste gate.

Other scan-time gates on the same command:

- `--fail-on error` fails on error-level findings. Warnings do not fail this gate.
- `--fail-on architecture-finding` fails on a hard boundary finding from the architecture module (an HTTP handler that writes the store, domain code that does I/O); `architecture-warning` also fails on warnings. Needs the code map the scan builds and the Architecture module (`vg module install arch`); the rules come from `.vibgrate/architecture.toml` (`policy = "hexagonal-v1"`, `"layered-v1"` or `"vertical-v1"`, plus any `[[overlay]]` rules of your own; a `deny` overlay with `severity = "hard"` fails the gate like a baked violation). Each failing line is `file:line  symbol  violation: … (rule)`. A gate that cannot be evaluated exits 2.
- `--drift-budget <score>` fails when DriftScore is above the budget.

## SARIF upload behavior

The SARIF template produces and uploads SARIF using GitHub's CodeQL upload action.

```bash
npx @vibgrate/cli scan --format sarif --out vibgrate-results.sarif --fail-on error
```

## JUnit XML

`--junit <file>` writes a second, deterministic JUnit report beside the SARIF or JSON artifact. GitHub's code scanning still wants SARIF (above). Systems that ingest JUnit — GitLab test reports, Azure DevOps, Jenkins — publish this file. It does not change the exit code: a gate failure is still exit `2` ([Exit Codes](../../DOCS.md#exit-codes)), and the XML is on disk when the step fails.

```bash
npx @vibgrate/cli scan --format sarif --out vibgrate-results.sarif --junit vibgrate.junit.xml --fail-on error --drift-budget 40
```

What each testcase means (finding vs budget gate, pass / failure / skipped) is in [JUnit](../../DOCS.md#junit).

## DriftScore badge

The gate workflow does not publish a badge and does not take a credential. Embed the hosted image (replace `OWNER` and `REPO`):

```markdown
[![Vibgrate DriftScore](https://badges.vibgrate.com/OWNER/REPO)](https://dash.vibgrate.com/badges/driftscore/OWNER/REPO)
```

A public GitHub repository Vibgrate has not scanned shows `scanning…` on the first DriftScore request, then the score on a later request. No account is required for that badge. A repository already scanned in Vibgrate Cloud shows its score after the public badge is turned on. Colour is the score band (0–30 green, 31–60 amber, 61–100 red; lower is better), not a CI result. Details: [`examples/github-actions/README.md`](../../examples/github-actions/README.md) and [vibgrate.com/badges](https://vibgrate.com/badges).

## Related

- Full CI reference (Azure DevOps, GitLab CI, generic pipelines): [DOCS.md](../../DOCS.md#ci-integration)
- Vibgrate CLI overview and live demo: <https://vibgrate.com/cli>
- What the gates measure: [DriftScore](https://vibgrate.com/driftscore)
