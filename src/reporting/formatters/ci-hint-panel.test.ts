// Owned by the public CLI (src/core-open is wiped on every vendor sync).
// Exercises the "Keep your DriftScore from getting worse" panel and the
// CI-environment helpers the scan runner uses to gate it.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatText } from '../../core-open/formatters/text.js';
import { isCiEnvironment, hasVibgrateWorkflow } from '../../core-open/utils/ci-env.js';
import type { ScanArtifact } from '../../core-open/types.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function makeArtifact(
  score: number | null,
  components: Partial<ScanArtifact['drift']['components']> = {},
): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-16T00:00:00.000Z',
    vibgrateVersion: '0.1.0',
    rootPath: '/test',
    projects: [],
    drift: {
      score,
      riskLevel: 'moderate',
      components: { runtimeScore: 10, frameworkScore: 62, dependencyScore: 30, eolScore: 0, ...components },
    },
    findings: [],
  };
}

describe('CI hint panel', () => {
  it('is absent unless asked for', () => {
    expect(stripAnsi(formatText(makeArtifact(47)))).not.toContain('KEEP YOUR DRIFTSCORE FROM GETTING WORSE');
  });

  it('names the biggest measured driver and the init command', () => {
    const text = stripAnsi(formatText(makeArtifact(47), { ciHint: true }));
    expect(text).toContain('KEEP YOUR DRIFTSCORE FROM GETTING WORSE');
    expect(text).toContain('Biggest driver: Frameworks (62/100)');
    expect(text).toContain('vg init --ci github');
    expect(text).not.toContain('vg init --ci github .');
  });

  it('uses the npx prefix when run via npx', () => {
    const text = stripAnsi(formatText(makeArtifact(47), { ciHint: true, invocation: 'npx @vibgrate/cli' }));
    expect(text).toContain('npx @vibgrate/cli init --ci github');
  });

  it('omits the driver line when no component is drifting or measured', () => {
    const text = stripAnsi(
      formatText(
        makeArtifact(0, { runtimeScore: 0, frameworkScore: 0, dependencyScore: null, eolScore: 0 }),
        { ciHint: true },
      ),
    );
    expect(text).toContain('KEEP YOUR DRIFTSCORE FROM GETTING WORSE');
    expect(text).not.toContain('Biggest driver');
  });

  it('is suppressed when the score is unmeasured (null is not zero)', () => {
    const text = stripAnsi(formatText(makeArtifact(null), { ciHint: true }));
    expect(text).not.toContain('KEEP YOUR DRIFTSCORE FROM GETTING WORSE');
  });
});

describe('isCiEnvironment', () => {
  it('detects CI systems', () => {
    expect(isCiEnvironment({ CI: 'true' })).toBe(true);
    expect(isCiEnvironment({ GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCiEnvironment({ JENKINS_URL: 'http://j' })).toBe(true);
  });

  it('treats a local shell, and CI=false/0/empty, as not CI', () => {
    expect(isCiEnvironment({})).toBe(false);
    expect(isCiEnvironment({ CI: 'false' })).toBe(false);
    expect(isCiEnvironment({ CI: '0' })).toBe(false);
    expect(isCiEnvironment({ CI: '' })).toBe(false);
  });
});

describe('hasVibgrateWorkflow', () => {
  let dir: string;
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function repo(files: Record<string, string>): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-wf-'));
    for (const [rel, body] of Object.entries(files)) {
      const f = path.join(dir, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body);
    }
    return dir;
  }

  it('is false with no workflows directory', async () => {
    expect(await hasVibgrateWorkflow(repo({ 'README.md': 'x' }))).toBe(false);
  });

  it('is false when no workflow mentions Vibgrate', async () => {
    expect(await hasVibgrateWorkflow(repo({ '.github/workflows/ci.yml': 'name: CI\n' }))).toBe(false);
  });

  it('is true when a workflow references Vibgrate', async () => {
    expect(
      await hasVibgrateWorkflow(repo({ '.github/workflows/drift.yaml': 'steps:\n  - uses: vibgrate/cli@v1\n' })),
    ).toBe(true);
  });
});
