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
| Terraform / OpenTofu | any `.tf` or `.tofu` file. Drift scoring is `.tf` only — [Terraform and OpenTofu files](#terraform-and-opentofu-files) | `aws_s3_bucket.logs`, `data.aws_ami.ubuntu`, `module.vpc` |
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

## Terraform and OpenTofu files

`vg scan` reads Terraform and OpenTofu in two passes: provider and module drift, and infrastructure findings (`vg scan --iac`). Each pass has its own file rule.

### Provider and module drift

The drift scanner opens a file only when the name ends in `.tf`. From those files it records `required_providers` entries and registry `module` blocks as dependency rows (`provider:<source>`, `module:<source>`). It does not open `.tofu` files. A provider or module that exists only in a `.tofu` file is not a drift row.

**Same stem.** A directory may contain both `main.tf` and `main.tofu`. Only `main.tf` contributes drift rows. In the example below the Terraform project lists `provider:hashicorp/aws` (constraint `~> 5.0`) and `module:terraform-aws-modules/vpc/aws` (constraint `5.1.0`). It does not list `provider:hashicorp/azurerm` or the module constraint `5.2.0` from `main.tofu`.

**`.tofu`-only tree — current gap.** A directory with no `.tf` file is not a Terraform project, so provider and module requirements in its `.tofu` files are not scored. When those files are the whole tree, `vg scan` prints `No projects found.` and DriftScore is absent (`null`; the text report shows it as not measured).

There is no flag that points the drift scanner at `.tofu`. Until that gap is closed, put the `required_providers` and registry `module` blocks you want scored in a `.tf` file in the same directory. A `versions.tf` that contains only those blocks is enough: the drift scanner then records them, and `vg scan --iac` still reports resources that live only in `.tofu`. Leave the resource blocks in the `.tofu` file. Copying the same resource into both files makes `--iac` report it twice, once per path, with two ids.

### Infrastructure findings (`vg scan --iac`)

The infrastructure rules read every `.tf` file and every `.tofu` file. Both files in a same-stem pair are evaluated. The same resource address declared in both files is two findings, because the path is part of the finding, so the ids differ. Moving the block keeps the id ([Finding identity](#finding-identity)).

`--iac` still needs the Architecture module and the code map, as described above. The ids below are from `vg scan --iac --format json` with pack `iac-cis-v1` version 1. They are `extended.security.findings[].id`.

### Example

Run the command from the directory that holds the files:

```bash
vg scan --iac --format json --out scan.json
```

#### `main.tf` and `main.tofu`

`main.tf`:

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_s3_bucket" "from_tf" {
  acl = "public-read"
}

module "vpc_tf" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.1.0"
}
```

`main.tofu`:

```hcl
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

resource "aws_s3_bucket" "from_tofu" {
  acl = "public-read"
}

module "vpc_tofu" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.2.0"
}
```

Drift rows come from `main.tf` only: `provider:hashicorp/aws` at `~> 5.0`, and `module:terraform-aws-modules/vpc/aws` at `5.1.0`.

`aws-s3-public` findings, in report order (path, then line):

| Path | Line | Address | Id |
|---|---|---|---|
| `main.tf` | 10 | `aws_s3_bucket.from_tf` | `d7c1dd201d14694dcc319c91abe6963c` |
| `main.tofu` | 10 | `aws_s3_bucket.from_tofu` | `63f1e38403b4db739b230175b34b2d56` |

#### Same address in both files

`main.tf` and `main.tofu`, each containing only:

```hcl
resource "aws_s3_bucket" "logs" {
  acl = "public-read"
}
```

| Path | Line | Address | Id |
|---|---|---|---|
| `main.tf` | 1 | `aws_s3_bucket.logs` | `ee9c34890f987cec7d3a6768b32e22c9` |
| `main.tofu` | 1 | `aws_s3_bucket.logs` | `81cd15b869a90b4967966a1b48b51dfe` |

`main.tf` still makes this directory a Terraform project. With no provider or module block in that file, the project has no dependency rows. The `.tofu` copy of the bucket is a second finding.

#### `.tofu` only

`main.tofu`:

```hcl
terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

resource "aws_s3_bucket" "only_tofu" {
  acl = "public-read"
}

module "vpc_only" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.3.0"
}
```

No Terraform project. `provider:hashicorp/google` and `module:terraform-aws-modules/vpc/aws` (`5.3.0`) are not drift rows. One `aws-s3-public` finding:

| Path | Line | Address | Id |
|---|---|---|---|
| `main.tofu` | 10 | `aws_s3_bucket.only_tofu` | `4c11ad8767b2fb9b1eb0b5fb9d3f2f31` |

That id follows the file and the bucket block, not the line. The same `aws_s3_bucket.only_tofu` block at line 1 of `main.tofu` produces the same id, including when a `versions.tf` beside it supplies the drift rows.

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

No rule in this table reads a GitHub Actions `uses:` line. How the code map records that line: [Action pins in the code map](./ci/github-actions.md#action-pins-in-the-code-map).

The rule set grows behind the gold gate, never on count. Every rule ships with
a positive, a negative and an abstain fixture.

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
