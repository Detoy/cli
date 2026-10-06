import * as path from 'node:path';
import { ensureDir, pathExists, writeTextFile } from '../utils/fs.js';

/** CI providers `vg init --ci` can generate a workflow for. */
export const CI_PROVIDERS = ['github'] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];

export function isCiProvider(value: string): value is CiProvider {
  return (CI_PROVIDERS as readonly string[]).includes(value);
}

/** Repo-relative path of the generated GitHub Actions workflow. */
export const GITHUB_WORKFLOW_PATH = '.github/workflows/vibgrate.yml';

/**
 * GitHub Actions workflow that scans every pull request with the published
 * `vibgrate/cli` Action and uploads SARIF to GitHub code scanning. It does not
 * fail the build by default — gating is opt-in via the commented lines, so a
 * repo that already has drift isn't red on its first run.
 */
export function githubWorkflow(): string {
  return `name: Vibgrate DriftScore

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write # uploads SARIF to GitHub Security

jobs:
  drift-score:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: vibgrate/cli@v1
        with:
          upload-sarif: true
          # Opt in to gating when you are ready:
          # fail-on: error
          # args: --drift-budget 40
`;
}

export interface WriteWorkflowResult {
  /** Absolute path of the workflow file. */
  file: string;
  /** False when a workflow already existed and was left untouched. */
  created: boolean;
}

/** Write the workflow for `provider` under `rootDir`; never overwrites an existing file. */
export async function writeCiWorkflow(rootDir: string, provider: CiProvider): Promise<WriteWorkflowResult> {
  switch (provider) {
    case 'github': {
      const file = path.join(rootDir, GITHUB_WORKFLOW_PATH);
      if (await pathExists(file)) return { file, created: false };
      await ensureDir(path.dirname(file));
      await writeTextFile(file, githubWorkflow());
      return { file, created: true };
    }
  }
}
