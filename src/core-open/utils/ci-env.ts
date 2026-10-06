// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const CI_VARS = ['GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI', 'TRAVIS', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD'];

/** True when running under a CI system (so interactive-only hints stay quiet). */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI;
  if (ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false') return true;
  return CI_VARS.some((name) => !!env[name]);
}

/**
 * True when a GitHub Actions workflow in `rootDir` already references Vibgrate,
 * so the "add it to CI" hint isn't shown to someone who already did.
 */
export async function hasVibgrateWorkflow(rootDir: string): Promise<boolean> {
  const dir = path.join(rootDir, '.github', 'workflows');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!/\.ya?ml$/i.test(name)) continue;
    try {
      const body = await fs.readFile(path.join(dir, name), 'utf8');
      if (/vibgrate/i.test(body)) return true;
    } catch {
      // Unreadable workflow file: treat as not referencing Vibgrate.
    }
  }
  return false;
}
