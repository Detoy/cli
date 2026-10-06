import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { main } from '../../../cli.js';
import { CliError, ExitCode } from '../../../util/exit.js';
import { BUNDLE_WRITE_NEXT } from '../../../util/json-output.js';
import { computeExposure, type ExposureInput } from './exposure.js';
import { resolveRegime } from './regimes.js';
import { saveOrg } from './state.js';
import { writeBundle } from './bundle.js';
import type { Advisory, EvidenceOrg, ExposureResult, Product, Release } from './types.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz';
const DSN = 'vibgrate+https://kid:supersecretvalue@example.test/ws';

const org: EvidenceOrg = {
  defaultRegime: 'cra',
  coordinatorCsirt: 'NCSC-NL',
  responsiblePersons: [{ name: 'Alex', filingAuthority: true }],
};

function product(): Product {
  return {
    id: 'sentinelgate',
    name: 'SentinelGate',
    classification: 'default',
    memberStates: ['DE'],
    bindings: ['repo:acme/sentinelgate'],
    supportPeriod: { declaredUntil: '2030-01-01' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function release(): Release {
  return {
    productId: 'sentinelgate',
    version: '4.2.0',
    shipDate: '2026-02-01',
    manifestFormat: 'vibgrate-frozen-1',
    components: [{ name: 'netty', version: '4.1.104', ecosystem: 'Maven' }],
    distribution: ['DE'],
    frozenAt: '2026-02-01T00:00:00.000Z',
  };
}

const advisory: Advisory = {
  id: 'CVE-2026-48282',
  ranges: [{ ecosystem: 'Maven', package: 'netty', introduced: '4.1.0', fixed: '4.1.110' }],
  sourceProvenance: 'test',
};

function exposure(): ExposureResult {
  const input: ExposureInput = {
    regime: resolveRegime('cra'),
    advisory,
    products: [product()],
    releasesByProduct: new Map([['sentinelgate', [release()]]]),
    org,
    asOf: '2026-07-22',
    dataPackVersion: '2026.07.19',
    generatedAt: '2026-07-22T10:00:00.000Z',
  };
  return computeExposure(input);
}

const roots: string[] = [];
const chalkLevel = chalk.level;

function tempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-evidence-write-'));
  roots.push(root);
  return root;
}

function bundleFiles(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const abs = path.join(current, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else out[path.relative(dir, abs)] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(dir);
  return out;
}

afterEach(() => {
  chalk.level = chalkLevel;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('evidence output write failures', () => {
  it('writes a byte-identical bundle for the same input', () => {
    const root = tempDir();
    const result = exposure();
    const input = {
      result,
      advisory,
      releases: [release()],
      regime: resolveRegime('cra'),
      cliVersion: '1.2.3',
    };
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    writeBundle({ ...input, outDir: a });
    writeBundle({ ...input, outDir: b });
    const files = bundleFiles(a);
    expect(files).toEqual(bundleFiles(b));
    expect(files['result.json']).toBe(`${JSON.stringify(result, null, 2)}\n`);
    expect(Object.keys(files).sort()).toEqual([
      'VERIFY.md',
      'inputs/advisory.json',
      'inputs/datapack.lock',
      'inputs/releases/sentinelgate@4.2.0.json',
      'manifest.json',
      'provenance.json',
      'result.json',
    ]);
  });

  it('names the bundle directory when a parent path is not a directory', () => {
    const root = tempDir();
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, `token ${TOKEN}\n${DSN}\n`);
    const dir = path.join(blocked, 'bundle');
    let caught: unknown;
    try {
      writeBundle({
        outDir: dir,
        result: exposure(),
        advisory,
        releases: [release()],
        regime: resolveRegime('cra'),
        cliVersion: '1.2.3',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught).toMatchObject({ code: ExitCode.ERROR });
    expect((caught as Error).message).toBe(
      `could not write ${dir} (a parent path is not a directory). ${BUNDLE_WRITE_NEXT}`,
    );
    expect((caught as Error).message).not.toContain(TOKEN);
    expect((caught as Error).message).not.toContain('supersecretvalue');
    expect((caught as Error).message).not.toContain('ENOTDIR');
  });

  it('names result.json when the bundle value cannot be serialized', () => {
    const root = tempDir();
    const dir = path.join(root, 'bundle');
    const result = exposure() as ExposureResult & { self?: unknown; leak?: string };
    result.self = result;
    result.leak = TOKEN;
    expect(() =>
      writeBundle({
        outDir: dir,
        result,
        advisory,
        releases: [release()],
        regime: resolveRegime('cra'),
        cliVersion: '1.2.3',
      }),
    ).toThrow(
      `could not serialize ${path.join(dir, 'result.json')} (the value contains a cycle). Check the data being written. ${BUNDLE_WRITE_NEXT}`,
    );
  });

  it('names the state file when .vibgrate is not a directory', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, '.vibgrate'), 'not-a-directory');
    const file = path.join(root, '.vibgrate', 'evidence', 'org.json');
    await expect(saveOrg(root, { responsiblePersons: [], defaultRegime: 'cra' })).rejects.toMatchObject({
      code: ExitCode.ERROR,
      message: `could not write ${file} (a parent path is not a directory). Check that .vibgrate/evidence is writable.`,
    });
  });
});

describe('vg evidence export exits non-zero when the output path is a directory', () => {
  async function runCli(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('VIBGRATE_NO_KERNEL', '1');
    vi.stubEnv('VIBGRATE_DSN', DSN);
    const stderr: string[] = [];
    const stdout: string[] = [];
    const write = (bucket: string[]) => (chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
      bucket.push(String(chunk));
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (typeof callback === 'function') callback();
      return true;
    };
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(write(stderr) as never);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(write(stdout) as never);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code ?? 0}`);
    }) as never);

    try {
      await main(['node', 'vg', ...args]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const match = /^EXIT:(\d+)$/.exec(message);
      if (!match) throw err;
      return { code: Number(match[1]), stderr: stderr.join(''), stdout: stdout.join('') };
    } finally {
      errSpy.mockRestore();
      outSpy.mockRestore();
      exitSpy.mockRestore();
    }
    throw new Error('expected the CLI to exit');
  }

  it('prints the path, a next step, and no stack or secret', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, '.env'), `TOKEN=${TOKEN}\n${DSN}\n`);
    const orgJson = path.join(root, 'outdir', 'org.json');
    fs.mkdirSync(orgJson, { recursive: true });
    const expected = `error: could not write ${orgJson} (the path is a directory). Check the path and permissions, or pass a different --out.\n`;

    const result = await runCli(['evidence', 'export', '-C', root, '--out', 'outdir']);

    expect(result).toEqual({ code: 1, stderr: expected, stdout: '' });
    expect(result.stderr).not.toContain(TOKEN);
    expect(result.stderr).not.toContain('supersecretvalue');
    expect(result.stderr).not.toContain('(ref ');
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });
});
