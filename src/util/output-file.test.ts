import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, ExitCode } from './exit.js';
import { outputWriteError, writeJsonOutputFile } from './output-file.js';
import { writeBundle, type WriteBundleInput } from '../reporting/commands/evidence/bundle.js';
import { resolveRegime } from '../reporting/commands/evidence/regimes.js';
import { signGraphAttestation } from '../commands/attest-actions.js';
import { generateKeypair } from '../engine/attest.js';
import type { Advisory, ExposureResult, Release } from '../reporting/commands/evidence/types.js';
import type { VgGraph } from '../schema.js';

const NEXT_OUT = 'check the path and permissions, or choose another --out';
const MARKER = 'payload-marker-not-for-the-message';

const dirs: string[] = [];

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-out-write-'));
  dirs.push(dir);
  return dir;
}

function relax(dir: string): void {
  const walk = (p: string): void => {
    try {
      fs.chmodSync(p, 0o700);
    } catch {
      return;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) walk(path.join(p, ent.name));
    }
  };
  walk(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    relax(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function expectCliWriteError(err: unknown, file: string, reason: string, step: string): void {
  expect(err).toBeInstanceOf(CliError);
  const cli = err as CliError;
  expect(cli.code).toBe(ExitCode.ERROR);
  expect(cli.message).toContain(file);
  expect(cli.message).toContain(`(${reason})`);
  expect(cli.message).toContain(step);
  expect(cli.message).not.toContain(MARKER);
  expect(cli.message).not.toContain('BEGIN PRIVATE KEY');
  expect(cli.message).not.toMatch(/\b(EACCES|EPERM|ENOENT|ENOTDIR|EEXIST|EISDIR|ENOSPC|EDQUOT)\b/);
  expect(cli.message).not.toMatch(/\n\s*at /);
}

function bundleInput(outDir: string, result: ExposureResult = sampleResult()): WriteBundleInput {
  const advisory: Advisory = { id: 'CVE-2026-0001', ranges: [], sourceProvenance: 'test' };
  const release: Release = {
    productId: 'app',
    version: '1.0.0',
    manifestFormat: 'vibgrate-frozen-1',
    components: [],
    distribution: [],
    frozenAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    outDir,
    result,
    advisory,
    releases: [release],
    regime: resolveRegime('cra'),
    cliVersion: 'test',
  };
}

function sampleResult(): ExposureResult {
  return {
    schemaVersion: 'evidence-1',
    regime: 'cra',
    advisory: { id: 'CVE-2026-0001', sourceProvenance: 'test', kevListed: false },
    overallStatus: 'not-affected',
    products: [],
    meta: {
      evidenceId: 'ev-test',
      dataPackVersion: 'none',
      kernelVersion: 'test',
      timestamp: { source: 'local-clock', value: '2026-01-01T00:00:00.000Z' },
    },
  };
}

function graph(): VgGraph {
  return {
    schemaVersion: 'vg-graph/1.0',
    generatedAt: '2026-01-01T00:00:00Z',
    provenance: {
      tool: 'vg',
      version: 't',
      grammars: { ts: 'g@1' },
      resolver: ['heuristic'],
      deep: false,
      corpusHash: 'abc123',
      toolchain: { schema: 'vg-graph/1.0', tool: 't', grammars: 'g@1', resolvers: ['heuristic'], fingerprint: 'fp123' },
    },
    meta: {
      root: '.',
      languages: ['ts'],
      counts: { nodes: 1, edges: 0, areas: 0, tests: 0, untested: 1 },
      cluster: 'louvain',
      edgeKinds: [],
    },
    nodes: [],
    edges: [],
    areas: [],
  };
}

describe('evidence and attestation output writes', () => {
  it('names a directory output path and the next step', () => {
    const root = temp();
    const outDir = path.join(root, 'bundle');
    const resultFile = path.join(outDir, 'result.json');
    fs.mkdirSync(resultFile, { recursive: true });

    let caught: unknown;
    try {
      writeBundle(bundleInput(outDir));
    } catch (err) {
      caught = err;
    }
    expectCliWriteError(caught, resultFile, 'output path is a directory', 'choose another --bundle');
  });

  it('names an unwritable output path', async () => {
    const root = temp();
    const locked = path.join(root, 'locked');
    fs.mkdirSync(locked, { mode: 0o000 });
    const target = path.join(locked, 'out.json');
    let caught: unknown;
    try {
      await writeJsonOutputFile(target, { note: MARKER });
    } catch (err) {
      caught = err;
    } finally {
      fs.chmodSync(locked, 0o700);
    }
    expectCliWriteError(caught, target, 'permission denied', NEXT_OUT);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('names a parent path that is not a directory', async () => {
    const root = temp();
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const target = path.join(blocker, 'org.json');
    let caught: unknown;
    try {
      await writeJsonOutputFile(target, { ok: true });
    } catch (err) {
      caught = err;
    }
    expectCliWriteError(caught, target, 'a parent path is not a directory', NEXT_OUT);
  });

  it('reports a value that cannot be serialized without echoing it', async () => {
    const root = temp();
    const target = path.join(root, 'org.json');
    const cyclic: { note: string; self?: unknown } = { note: MARKER };
    cyclic.self = cyclic;
    let caught: unknown;
    try {
      await writeJsonOutputFile(target, cyclic);
    } catch (err) {
      caught = err;
    }
    expectCliWriteError(caught, target, 'output could not be serialized', NEXT_OUT);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('describes a missing parent and a full disk without the raw Node message', () => {
    const leaked = 'do-not-echo-this-detail';
    const missing = outputWriteError(
      '/tmp/evidence/out.json',
      Object.assign(new Error(`ENOENT ${leaked}`), { code: 'ENOENT' }),
    );
    expectCliWriteError(missing, '/tmp/evidence/out.json', 'parent directory is missing', NEXT_OUT);
    expect(missing.message).not.toContain(leaked);

    const full = outputWriteError('/tmp/evidence/out.json', Object.assign(new Error(leaked), { code: 'ENOSPC' }));
    expectCliWriteError(full, '/tmp/evidence/out.json', 'disk full', NEXT_OUT);
    expect(full.message).not.toContain(leaked);
  });

  it('still writes a pretty evidence bundle when the path is writable', () => {
    const root = temp();
    const outDir = path.join(root, 'bundle');
    writeBundle(bundleInput(outDir));
    const text = fs.readFileSync(path.join(outDir, 'result.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ meta: { evidenceId: 'ev-test' } });
    expect(fs.existsSync(path.join(outDir, 'inputs', 'releases', 'app@1.0.0.json'))).toBe(true);
  });

  it('names an attestation path that is a directory', async () => {
    const root = temp();
    const kp = generateKeypair();
    const keyPath = path.join(root, 'attest-key.pem');
    fs.writeFileSync(keyPath, kp.privatePem, { mode: 0o600 });
    const out = path.join(root, 'attestation.intoto.jsonl');
    fs.mkdirSync(out);

    let caught: unknown;
    try {
      await signGraphAttestation(root, graph(), { key: keyPath, attestation: out });
    } catch (err) {
      caught = err;
    }
    expectCliWriteError(caught, out, 'output path is a directory', 'choose another --attestation');
    expect((caught as CliError).message).not.toContain(kp.privatePem);
  });

  it('writes an attestation file when the path is writable', async () => {
    const root = temp();
    const kp = generateKeypair();
    const keyPath = path.join(root, 'attest-key.pem');
    fs.writeFileSync(keyPath, kp.privatePem, { mode: 0o600 });
    const out = path.join(root, 'out', 'attestation.intoto.jsonl');
    await signGraphAttestation(root, graph(), { key: keyPath, attestation: out });
    const line = fs.readFileSync(out, 'utf8').trim();
    expect(JSON.parse(line)).toMatchObject({ payloadType: 'application/vnd.in-toto+json' });
  });
});

describe('vg evidence export CLI', () => {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const cli = path.join(pkgRoot, 'src/cli.ts');

  it('exits non-zero and names the file when --out is not a directory', () => {
    const root = temp();
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const res = spawnSync(process.execPath, ['--import', 'tsx', cli, 'evidence', 'export', '-C', root, '--out', 'blocker'], {
      cwd: pkgRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: '1', VIBGRATE_NO_KERNEL: '1', VIBGRATE_DSN: '' },
    });
    expect(res.error).toBeUndefined();
    expect(res.signal).toBeNull();
    expect(res.status).toBe(ExitCode.ERROR);
    const target = path.join(blocker, 'org.json');
    expect(res.stderr).toContain(target);
    expect(res.stderr).toContain('a parent path is not a directory');
    expect(res.stderr).toContain(NEXT_OUT);
    expect(res.stderr).not.toMatch(/\bat (?:writeFile|mkdir|JSON\.stringify|node:fs)/);
    expect(res.stdout).not.toMatch(/\bat (?:writeFile|mkdir|node:fs)/);
  });
});
