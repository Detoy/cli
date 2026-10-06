# Security packs: `vg scan --iac`

Vibgrate CLI can evaluate infrastructure misconfiguration rules on the same
scan that scores drift. The rules run inside the Architecture module (the
local module `vg module install arch` installs), over facts the CLI reads from
Terraform, Kubernetes, Helm and Dockerfiles in the repository. Findings carry a
content-addressed id, an OWASP Top 10:2025 category, a CWE and, where one
applies, a CIS control, and they land in the same text, JSON and SARIF output
as the drift findings.

Findings are evidence, not a certification. Absence of findings is not a
statement that the infrastructure is secure. The pack does not replace
Checkov, Trivy or Snyk IaC: it covers a small, gold-gated rule set and joins
each finding to the code map instead of competing on rule count.

## Running it

```bash
vg scan --iac                      # infrastructure rules on top of drift scoring
vg scan --full                     # drift + known vulnerabilities + infrastructure rules
vg scan --iac --format sarif --out vibgrate.sarif
vg scan --iac --fail-on iac-finding            # exit 2 on a high or critical finding
vg scan --iac --fail-on iac-finding=medium     # exit 2 on medium or above
vg scan --iac --fail-on error,iac-finding      # drift errors and infrastructure findings
```

`--iac` needs the code map the scan builds (it binds each finding to the graph
node that declares the resource), so it does not combine with `--no-graph`,
`--max-privacy` or `--no-local-artifacts`. It needs the Architecture module,
which the scan provisions on first use the way `vg build` does: a bounded
install from the module registry that respects `VIBGRATE_NO_KERNEL` and a
recorded opt-out, and that is skipped under `--offline`. An installed module
that predates infrastructure packs is updated when the registry has a newer
build; otherwise the scan says the published module does not carry them yet.
When the module cannot be provisioned the scan says why and evaluates nothing,
and a requested `--fail-on iac-finding` exits 2 rather than passing silently.

Air-gapped machines install the module from a file: `vg module install arch`
from a bundle, or point `VIBGRATE_ARCH_PATH` at an unpacked module directory.

## What is scanned

| Source | Where the CLI looks | Fact address |
|---|---|---|
| Terraform / OpenTofu | any `.tf` / `.tofu` file (this findings path; the drift scanner reads `.tf` only — [below](#terraform-and-opentofu-files)) | `aws_s3_bucket.logs`, `data.aws_ami.ubuntu`, `module.vpc` |
| Kubernetes manifests | any `.yaml` with `apiVersion` and `kind` under `k8s/`, `kubernetes/`, `manifests/`, `deploy/` or `infra/` at any depth | `<namespace>/<Kind>/<name>` |
| Helm | `charts/<name>/Chart.yaml` and `values.yaml` (read as written; templates are not rendered) | `chart:<name>` |
| Dockerfiles | `Dockerfile`, `Dockerfile.*`, `Containerfile` anywhere | `dockerfile:<path>#<stage>` |

The CLI reads attribute values only as far as a rule needs them. An attribute
whose value is an expression (`acl = var.acl`, a `dynamic` block) is recorded
as an expression and the rule abstains: no finding, and no claim that the
resource is safe. Secret-shaped keys (`password`, `secret`, `token`,
`api_key`, `private_key`, `access_key`, `credential`) are redacted before the
value reaches the module; no attribute value that could be a secret is written
to any output.

## Rules in `iac-cis-v1` (version 1)

| Rule | Applies to | Finding when | Severity | OWASP / CWE / CIS |
|---|---|---|---|---|
| `aws-s3-public` | `aws_s3_bucket`, `aws_s3_bucket_acl` | the ACL is `public-read`, `public-read-write` or `authenticated-read`, and no `aws_s3_bucket_public_access_block` in the same scan blocks it | high | A02:2025 / CWE-284 / CIS AWS 2.1.4 |
| `sg-open-ingress` | `aws_security_group` ingress blocks, `aws_security_group_rule`, `aws_vpc_security_group_ingress_rule` | ingress from `0.0.0.0/0` or `::/0` on any port other than exactly 80 or 443 | critical for all ports, 22 or 3389; high otherwise | A02:2025 / CWE-284 / CIS AWS 5.2 |
| `disk-unencrypted` | `aws_ebs_volume`, `aws_db_instance`, `aws_rds_cluster`, `aws_instance` block devices | encryption is `false` (high) or not declared (medium) | high / medium | A04:2025 / CWE-311 / CIS AWS 2.2.1 |
| `k8s-privileged` | workloads | a container sets `privileged: true` | critical | A02:2025 / CWE-250 / CIS K8s 5.2.2 |
| `k8s-run-as-root` | workloads | a container runs as user 0 (high), or nothing enforces a non-root user (medium) | high / medium | A02:2025 / CWE-250 / CIS K8s 5.2.6 |
| `k8s-host-network` | workloads | `hostNetwork`, `hostPID` or `hostIPC` is `true` | high | A02:2025 / CWE-653 / CIS K8s 5.2.4 |
| `k8s-wildcard-rbac` | `Role`, `ClusterRole` | a rule uses `*` for verbs or resources | critical (ClusterRole) / high (Role) | A01:2025 / CWE-269 / CIS K8s 5.1.3 |
| `k8s-no-resource-limits` | workloads | a container has no CPU or memory limit | low | A02:2025 / CWE-770 |
| `docker-root-user` | the final stage of a Dockerfile | no `USER`, or the last `USER` is root | high (root) / medium (none) | A02:2025 / CWE-250 / CIS Docker 4.1 |
| `secret-in-env-plaintext` | Dockerfile `ENV` / `ARG`, container `env` | a secret-shaped key has a literal value | high | A02:2025 / CWE-798 / CIS Docker 4.10 |

The rule set grows behind the gold gate, never on count. Every rule ships with
a positive, a negative and an abstain fixture.

GitHub Actions `uses:` pins are outside this catalogue. A commit SHA, a tag, a
branch, a local path, and a `docker://` image are recorded on the code map,
and `actions.lock` is not read. See
[Action references in the code map](./ci/github-actions.md#action-references-in-the-code-map).

## Finding identity

Each finding's `id` is derived from the pack, the rule, the resource address,
the graph node and a digest of the attributes the rule read. It is not derived
from the line number or the file position. Renaming a resource without
changing the attribute keeps the id; changing the CIDR changes it; moving the
block down the file changes nothing. Re-run the same tree with the same module
and you get the same bytes, which is what makes a committed SARIF a real
baseline. The module and pack versions are stamped on the report
(`extended.security.engine`, `extended.security.packs`); a rule change that
alters findings bumps the pack version and is visible there.

## Output

- **Text**: an "Infrastructure findings" section after Security Posture, one
  row per finding: `path:line  address  rule [severity]: message`.
- **JSON** (`--format json`): `extended.security` with `engine`, `packs`,
  `facts` (received / evaluated / rejected), and `findings[]` carrying `id`,
  `pack`, `packVersion`, `rule`, `severity`, `message`, `path`, `line`,
  `address`, `node`, `owasp`, `cwe`, `cis`.
- **SARIF** (`--format sarif`): a second run whose driver is `Vibgrate CLI`,
  one rule per `<pack>/<rule>`, `partialFingerprints["vg/finding-id/v1"]` set
  to the finding id so code-scanning alerts track content rather than lines,
  and the taxonomy under `properties`.

## Gating CI

```bash
vg scan --full --fail-on iac-finding            # high and critical
vg scan --full --fail-on iac-finding=critical   # critical only
```

Exit codes follow the rest of `vg scan`: `0` clean, `2` gate failed. A gate
that cannot be evaluated (module missing, code map skipped) also exits `2`
with a one-line reason; it never reports a pass it did not compute.

See [`ci/github-actions.md`](./ci/github-actions.md) for a workflow recipe.

## Terraform and OpenTofu files

`vg scan --iac` runs two readers, and they do not select `.tf` and `.tofu` the
same way. `vg scan --full` turns the findings reader on as well (`--full`
includes `--iac`). The commands, the rule list, and the output shapes are
above. This section records file selection for a same-stem pair and for a
`.tofu`-only tree. It does not add a fixture tree to the repository.

The examples below were produced by running `vg scan --iac --offline --format
json` on the trees as written. The recorded run also passed `--no-daemon` and
`--quiet`; those flags do not change the fields quoted here. A second run of
the same-stem tree returned the same finding ids. `--offline` is why a parsed
provider's `drift` is `unknown`; it does not change which files are read. The
bucket names and `acl = "public-read"` are example inputs for `aws-s3-public`,
not a live account.

### Drift scanner

The drift scanner builds the Terraform project and its dependency rows.

`vg scan` keeps a file when its basename ends with `.tf`. It parses those
files for `required_providers`, a legacy `provider` block that sets `version`,
and a registry `module` block (`source`, and `version` when present). A
`.tofu` file is not opened. The scan does not print a line that names the
skipped file.

A directory that contains at least one `.tf` file becomes one Terraform
project. In JSON that project is a `projects[]` entry with `type`
`terraform` and `path` set to the directory (`'.'` when you scan the
directory that holds the files). Dependency package ids are
`provider:<source>` and `module:<source>`. Drift findings, when the scanner
emits them, use that directory as `location`. The offline example below
emits none: `findings` is `[]`, because latest versions are not fetched.

### Infrastructure findings

The `iac-cis-v1` pack reads facts from the code map. A path that ends in
`.tf` or `.tofu` is classified as infrastructure, and the Terraform extractor
accepts both suffixes. Same-stem names stay separate files: `main.tf` and
`main.tofu` are two fact paths and, when a rule matches, two finding ids.
The finding `path` is the file the fact came from. The finding `id` is the
content-addressed id in [Finding identity](#finding-identity).

The Terraform / OpenTofu row in [What is scanned](#what-is-scanned) is this
path.

### Same stem: `main.tf` beside `main.tofu`

`main.tf`:

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 4.0"
    }
  }
}

resource "aws_s3_bucket" "from_tf" {
  bucket = "example-logs"
  acl    = "public-read"
}
```

`main.tofu`:

```hcl
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 4.0"
    }
  }
}

resource "aws_s3_bucket" "from_tofu" {
  bucket = "example-logs-tofu"
  acl    = "public-read"
}
```

```bash
vg scan --iac --offline --format json --out scan.json
```

Drift scanner: one Terraform project (`type` `terraform`, `path` `.`).
`dependencies` contains `provider:hashicorp/aws` with `currentSpec` `~> 4.0`
and `drift` `unknown`. It does not contain `provider:hashicorp/google`. The
`google` provider and the `from_tofu` bucket are declared only in `main.tofu`,
so this scanner does not see them. Drift `findings` is `[]`.

Infrastructure findings: four facts are handed to the pack — `provider.aws`
and `aws_s3_bucket.from_tf` from `main.tf`, `provider.google` and
`aws_s3_bucket.from_tofu` from `main.tofu`. All four are evaluated. The two
buckets match `aws-s3-public`. Text rows:

```text
main.tf:10  aws_s3_bucket.from_tf  aws-s3-public [high]: aws_s3_bucket.from_tf grants public access (acl public-read)
main.tofu:10  aws_s3_bucket.from_tofu  aws-s3-public [high]: aws_s3_bucket.from_tofu grants public access (acl public-read)
```

JSON `extended.security.findings` for those rows:

| path | address | rule | id |
|---|---|---|---|
| `main.tf` | `aws_s3_bucket.from_tf` | `aws-s3-public` | `087c07df86b0e5b1c0d1c94c34577b65` |
| `main.tofu` | `aws_s3_bucket.from_tofu` | `aws-s3-public` | `2b42c4e1016cb65b005d5bcf3c6f2d48` |

`provider.google` is evaluated and produces no finding. This pack has no rule
for that provider block.

### A `.tofu`-only tree — current gap

`main.tofu`:

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 4.0"
    }
  }
}

resource "aws_s3_bucket" "logs" {
  bucket = "example-logs"
  acl    = "public-read"
}
```

```bash
vg scan --iac --offline --format json
```

What that command prints and records:

- Stdout includes `No projects found.`
- The text report shows DriftScore `n/a`. JSON `projects` is `[]`,
  `drift.score` is `null`, and drift `findings` is `[]`.
- `provider:hashicorp/aws` is absent. The drift scanner does not read
  `main.tofu`, and it does not print an error that names the file.
- Infrastructure findings still run. Text row:

```text
main.tofu:10  aws_s3_bucket.logs  aws-s3-public [high]: aws_s3_bucket.logs grants public access (acl public-read)
```

| path | address | rule | id |
|---|---|---|---|
| `main.tofu` | `aws_s3_bucket.logs` | `aws-s3-public` | `cb770504b2ca988ee208750c819fca7d` |

`vg scan --iac --fail-on iac-finding` on this tree exits `2` and prints:

```text
Failing: 1 infrastructure finding at or above high (iac-cis-v1).
  main.tofu:10  aws_s3_bucket.logs  aws-s3-public [high]: aws_s3_bucket.logs grants public access (acl public-read)
```

**Current gap.** Provider and module drift is not computed from `.tofu`. A
tree whose infrastructure files are only `.tofu` is not a Terraform project,
even when `main.tofu` declares `required_providers`.

A `.tf` file with no provider or module blocks still discovers a Terraform
project, and `dependencies` stays empty. On a tree with `main.tf` containing
only `# placeholder` next to the `main.tofu` above, `vg scan --iac --offline`
reported one Terraform project, zero dependencies, and the same
`main.tofu` finding id `cb770504b2ca988ee208750c819fca7d`. Requirements that
exist only in `.tofu` stay out of `projects[].dependencies`.

What to do: put the providers and modules you want scored into a `.tf` file
in that directory. Copy the `terraform { required_providers { … } }` block and
any registry `module` blocks into `main.tf` (or another `*.tf` name). The
infrastructure pack already reads `.tofu`. This gap is the drift scanner.
