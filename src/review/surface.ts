/**
 * Which changed paths carry an architectural or security surface.
 *
 * One home for two patterns that the quick-path classifier, the coverage
 * check and the dependency scanner all need. Keeping them together is what
 * stops the three from disagreeing about whether a lockfile is code — and
 * a README that "no test reaches" is exactly the kind of finding that makes
 * `pass` unreachable for a docs-only change.
 */

/** Dependency manifests, per ecosystem — non-code by extension, but security-relevant. */
export const DEPENDENCY_MANIFEST =
  /(^|\/)(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|.*\.csproj|packages\.lock\.json|Directory\.Packages\.props|requirements.*\.txt|pyproject\.toml|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle(\.kts)?|Gemfile(\.lock)?|composer\.(json|lock))$/i;

/**
 * Files that carry no architectural surface: prose, images, and generated
 * artifacts. Kept deliberately narrow — anything not on this list counts as
 * code, because the quick path must be earned by positive evidence, never by
 * the analyzer failing to recognise a file.
 */
const NON_CODE = /\.(md|mdx|markdown|txt|rst|adoc|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|csv|snap|lock)$/i;
const NON_CODE_DIRS = /(^|\/)(docs?|\.github\/ISSUE_TEMPLATE|changelog|marketing|\.vscode|\.idea)\//i;

/**
 * Repository scaffolding, matched on the basename because most of it has no
 * extension: ignore lists (`.gitignore`, `.dockerignore`, `.npmignore`, …),
 * VCS attributes, editor and toolchain pins, and licence / ownership prose.
 * "No test edge reaches `.gitignore`" is true of every repository and tells
 * the reviewer nothing, so these get no coverage verdict and no
 * `unverified_change` finding.
 *
 * Deliberately absent: anything that changes what code ends up in the tree or
 * where it comes from — `.npmrc` / `.yarnrc` (registry routing), `.gitmodules`
 * (submodule sources), `.pnpmfile.cjs` (resolution hooks), CI workflows. Those
 * carry a supply-chain surface and stay on the normal path.
 */
const SCAFFOLDING =
  /(^|\/)(\.[a-z0-9_-]*ignore|\.gitattributes|\.gitkeep|\.keep|\.mailmap|\.editorconfig|\.browserslistrc|\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.tool-versions|(LICEN[CS]E|NOTICE|COPYING|PATENTS)(\.(md|txt|rst))?|CODEOWNERS|AUTHORS|CONTRIBUTORS|CHANGELOG|CITATION\.cff)$/i;

export function isDependencyManifest(path: string): boolean {
  return DEPENDENCY_MANIFEST.test(path);
}

/** Prose, assets, generated output and repository scaffolding — nothing here has a call path. */
export function isNonCodePath(path: string): boolean {
  return NON_CODE.test(path) || NON_CODE_DIRS.test(path) || SCAFFOLDING.test(path);
}
