# GitHub Actions integration

Vibgrate already supports CI gating and SARIF export through the core `scan` command.

How `vg build` records a step `uses:` pin is in [Action references in the code map](#action-references-in-the-code-map).

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
value, or one outside 0 to 100, fails the step with a clear error before the
scan runs.

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
are selected, including a same-stem pair and a `.tofu`-only tree:
[`../security-packs.md`](../security-packs.md#terraform-and-opentofu-files).

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

## Action references in the code map

`vg build` reads each workflow file directly under `.github/workflows/`
(`*.yml` and `*.yaml`) and records every step `uses:` value as written. The
map stores that string. It has no field that classifies the pin as a commit
SHA, a tag, a branch, a local path, or a container image.

Each step `uses:` adds three things:

- A `step` node. `qualifiedName` is `job:<job id>#<index>` (the index starts
  at 0). `signature` is `gha.step.uses`. `doc` is `uses <value>`. With no
  `name:` on the step, `name` is the `uses` value, cut at 80 characters. A
  `name:` key replaces that label; the `uses` value stays in `doc` and on the
  external node.
- An `external` node. `signature` is `gha.action`. `qualifiedName` is
  `action:<value>` with the value unchanged. `name` is the text before the
  first `@`, or the whole value when there is no `@`.
- A `depends_on` edge from the step to that external node.

The same `uses` text twice in one file is one external node and two edges. A
different ref is a different external node, including the same action once at
a SHA and once at a tag.

The step `doc`, and the workflow file's `document` node (the body `vg ask`
reads), go through the same credential scrub as the rest of the map. A run of
40 or more letters, digits, `+`, or `/` is stored as `[REDACTED]` in those
`doc` fields. A full 40-character commit SHA matches that rule. A tag such as
`v4`, a branch such as `main`, and a `./path` stay intact. A `docker://` image
stays intact unless its digest is itself a run that long; that digest is
scrubbed in `doc` and kept on `qualifiedName`, the same way a commit SHA is.
`qualifiedName` and `name` are left as written, so the SHA remains on the
external node.

### SHA and tag

The hex string below is an example ref written in the file. `vg` does not
look it up.

```yaml
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
      - uses: actions/setup-node@v4
```

| | SHA step | Tag step |
| --- | --- | --- |
| step `qualifiedName` | `job:build#0` | `job:build#1` |
| step `name` | `actions/checkout@0123456789abcdef0123456789abcdef01234567` | `actions/setup-node@v4` |
| step `doc` | `uses actions/checkout@[REDACTED]` | `uses actions/setup-node@v4` |
| external `name` | `actions/checkout` | `actions/setup-node` |
| external `qualifiedName` | `action:actions/checkout@0123456789abcdef0123456789abcdef01234567` | `action:actions/setup-node@v4` |
| external `signature` | `gha.action` | `gha.action` |

`vg show` prints the external node's qualified name. These are the lines that
identify the pin (importance and area follow the rest of the map):

```text
vg show 'action:actions/checkout@0123456789abcdef0123456789abcdef01234567'

action:actions/checkout@0123456789abcdef0123456789abcdef01234567  (external)
  .github/workflows/ci.yml:7
  gha.action
```

```text
vg show 'action:actions/setup-node@v4'

action:actions/setup-node@v4  (external)
  .github/workflows/ci.yml:8
  gha.action
```

`vg show` lists `call` and `references` neighbours, so the `calls` line is
empty for both. The pin link is the `depends_on` edge in the map, from
`job:build#0` or `job:build#1` to the external node. `vg show job:build#0`
prints the step's qualified name and `gha.step.uses`; the `uses` text for
that step is its `name` and `doc` in the map, above.

Other forms use the same fields:

- `actions/checkout@main` — external `name` `actions/checkout`, qualified name
  `action:actions/checkout@main`, `doc` `uses actions/checkout@main`.
- `owner/repo/path@v1` — external `name` `owner/repo/path` (everything before
  the first `@`).
- `./.github/actions/build` — no `@`, so `name` and the text after `action:`
  are the whole path, and `doc` is `uses ./.github/actions/build`. A step
  `name:` such as `Local composite` is the step node's `name`; the path stays
  on the external node.
- `docker://alpine:3.20` — same shape as a local path: `name` is
  `docker://alpine:3.20`, `doc` is `uses docker://alpine:3.20`.

### Offline

The workflow file on disk is the only input. Building the map does not call
the GitHub API and does not read a token. `--offline` leaves this recording
unchanged, because there is no request to skip.

A tag, a branch, or a SHA that cannot be resolved — nothing upstream matches
it — is stored as the characters in the file. The build writes no resolved
commit in its place, and it emits no warning that the ref could not be
resolved. That ref is not a finding.

### Outside this recording

- **`actions.lock`.** The build does not read that file. It is not a workflow,
  and it is not a lockfile the dependency scanners parse, so nothing from it
  enters the map.
- **`vg scan --iac`.** The `iac-cis-v1` pack evaluates Terraform, Kubernetes,
  Helm, and Dockerfiles
  ([rules](../security-packs.md#rules-in-iac-cis-v1-version-1)). A workflow
  step is not a fact in that scan, and the pack has no rule for a mutable tag.
- **Reusable workflows.** A job-level `uses:`
  (`jobs.<id>.uses: owner/repo/.github/workflows/called.yml@ref`) becomes a
  job node only. It does not add an `action:` node.
- **Composite action files.** Only a workflow directly inside
  `.github/workflows/` contributes step `uses:` nodes. An `action.yml` under
  `.github/actions/` can still be a `document` node for `vg ask`. Its inner
  steps are not `gha.action` nodes.
- **`vg build --attest`.** That flag signs the code graph
  ([Signing and verifying the graph](../../DOCS.md#signing-and-verifying-the-graph)).
  Action nodes are part of the signed map when the workflow was built. The
  statement is the code graph; it carries no separate claim about pin form.

Which release to pin when you copy a Vibgrate workflow:
[Pins](../../examples/github-actions/README.md#pins).

## Related

- Full CI reference (Azure DevOps, GitLab CI, generic pipelines): [DOCS.md](../../DOCS.md#ci-integration)
- Vibgrate CLI overview and live demo: <https://vibgrate.com/cli>
- What the gates measure: [DriftScore](https://vibgrate.com/driftscore)
