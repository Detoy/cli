import * as path from 'node:path';
import { ensureDir, pathExists, writeTextFile } from '../utils/fs.js';

/** CI providers `vg init --ci` can generate a workflow for. */
export const CI_PROVIDERS = ['github'] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];

export function isCiProvider(value: string): value is CiProvider {
  return (CI_PROVIDERS as readonly string[]).includes(value);
}

/** Repo-relative path of the baseline `vg baseline` writes. Meant to be committed. */
export const BASELINE_PATH = '.vibgrate/baseline.json';

/** Repo-relative path of the generated GitHub Actions workflow. */
export const GITHUB_WORKFLOW_PATH = '.github/workflows/vibgrate.yml';

/**
 * GitHub Actions workflow that scans every pull request with the published
 * `vibgrate/cli` Action and uploads SARIF to GitHub code scanning. It does not
 * fail the build by default — gating is opt-in via the commented lines, so a
 * repo that already has drift isn't red on its first run. With `baseline` it also
 * points at the committed baseline so the score change is reported.
 */
export function githubWorkflow(opts: { baseline?: boolean } = {}): string {
  // With a baseline the workflow compares against it (the score change shows in
  // the job summary); failing on worsening stays opt-in like the other gates.
  const baselineLines = opts.baseline
    ? `          baseline: ${BASELINE_PATH}
          # Fail when drift worsens by more than 5% against the baseline:
          # max-worsening: 5
`
    : '';
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
${baselineLines}          # Opt in to gating when you are ready:
          # fail-on: error
          # max-score: 40
`;
}

export interface WriteWorkflowResult {
  /** Absolute path of the workflow file. */
  file: string;
  /** False when a workflow already existed and was left untouched. */
  created: boolean;
}

/** Write the workflow for `provider` under `rootDir`; never overwrites an existing file. */
export async function writeCiWorkflow(
  rootDir: string,
  provider: CiProvider,
  opts: { baseline?: boolean } = {},
): Promise<WriteWorkflowResult> {
  switch (provider) {
    case 'github': {
      const file = path.join(rootDir, GITHUB_WORKFLOW_PATH);
      if (await pathExists(file)) return { file, created: false };
      await ensureDir(path.dirname(file));
      await writeTextFile(file, githubWorkflow(opts));
      return { file, created: true };
    }
  }
}
