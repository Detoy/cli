import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { main } from '../src/cli.js';
import { registerStatus } from '../src/commands/status.js';
import { loadGraph } from '../src/engine/load.js';
import { GraphLoadError, parseGraph } from '../src/engine/serialize.js';
import { loadGraphFileWithSnapshot, writeGraphSnapshot } from '../src/engine/snapshot.js';
import { ExitCode } from '../src/util/exit.js';
import type { VgGraph } from '../src/schema.js';

/**
 * A corrupt or schema-mismatched code map must fail as an operator error:
 * what went wrong, how to rebuild, non-zero exit, and none of the file's bytes.
 */

// Distinct file bytes. A token-shaped value here trips the secret scan.
const SECRET = 'placeholder-file-contents-must-not-leak';
const REBUILD = 'Rebuild it with `vg build`';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-graph-load-'));
  dirs.push(dir);
  return dir;
}

function writeMap(dir: string, body: string): string {
  const file = path.join(dir, 'graph.json');
  fs.writeFileSync(file, body);
  return file;
}

function assertSafe(err: GraphLoadError): void {
  expect(err).toBeInstanceOf(GraphLoadError);
  expect(err.code).toBe(ExitCode.ERROR);
  expect(err.code).not.toBe(0);
  expect(err.message).toContain(REBUILD);
  expect(err.message).not.toContain(SECRET);
  expect(err.message).not.toContain('ghp_');
  expect(err.message).not.toContain('Unexpected token');
  expect(err.message).not.toContain('graph.json');
}

async function runStatus(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStatus(program);
  await program.parseAsync(['status', ...args], { from: 'user' });
}

describe('parseGraph / loadGraph', () => {
  it('loads a supported older schema', () => {
    const graph = parseGraph(JSON.stringify({
      schemaVersion: 'vg-graph/1.0',
      nodes: [],
      edges: [],
    }));
    expect(graph.schemaVersion).toBe('vg-graph/1.0');
  });

  it('returns null when the map file is absent', () => {
    const dir = tempDir();
    expect(loadGraph(dir, path.join(dir, 'missing.json'))).toBeNull();
  });

  it('rejects truncated JSON without echoing file contents', () => {
    const dir = tempDir();
    const file = writeMap(dir, `{"note":"${SECRET}","nodes":[`);
    let caught: unknown;
    try {
      loadGraph(dir, file);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphLoadError);
    const err = caught as GraphLoadError;
    expect(err.kind).toBe('corrupt');
    assertSafe(err);
    expect(err.message).toMatch(/truncated or not valid JSON/);
  });

  it('rejects a schema this vg cannot read without echoing the version token', () => {
    const dir = tempDir();
    const file = writeMap(dir, JSON.stringify({
      schemaVersion: SECRET,
      nodes: [{ name: SECRET }],
      edges: [],
    }));
    let caught: unknown;
    try {
      parseGraph(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GraphLoadError);
    const err = caught as GraphLoadError;
    expect(err.kind).toBe('schema');
    assertSafe(err);
    expect(err.message).toMatch(/cannot read/);
    expect(err.message).toContain('vg-graph/1.0');
    expect(err.message).toContain('vg-graph/1.1');
  });

  it('names an unsupported vg-graph schema version', () => {
    expect(() => parseGraph(JSON.stringify({
      schemaVersion: 'vg-graph/0.9',
      nodes: [],
      edges: [],
    }))).toThrow(/schema `vg-graph\/0\.9`/);
  });

  it('rejects a standalone snapshot whose schema is not readable', () => {
    const dir = tempDir();
    const file = path.join(dir, 'graph.json');
    const graph = {
      schemaVersion: 'vg-graph/0.4',
      nodes: [],
      edges: [],
    } as unknown as VgGraph;
    expect(writeGraphSnapshot(file, graph, { standalone: true })).toBe(true);
    expect(() => loadGraphFileWithSnapshot(file)).toThrow(GraphLoadError);
    try {
      loadGraphFileWithSnapshot(file);
    } catch (err) {
      expect(err).toBeInstanceOf(GraphLoadError);
      expect((err as GraphLoadError).kind).toBe('schema');
      expect((err as GraphLoadError).message).toContain(REBUILD);
      expect((err as GraphLoadError).message).toContain('vg-graph/0.4');
    }
  });
});

describe('vg status', () => {
  it('fails the command on a corrupt map', async () => {
    const dir = tempDir();
    const file = writeMap(dir, `{"token":"${SECRET}"`);
    await expect(runStatus(['--cwd', dir, '--graph', file, '--offline'])).rejects.toMatchObject({
      name: 'GraphLoadError',
      kind: 'corrupt',
      code: ExitCode.ERROR,
    });
  });

  it('fails the command on a schema mismatch', async () => {
    const dir = tempDir();
    const file = writeMap(dir, JSON.stringify({ schemaVersion: 'vg-graph/0.9', nodes: [], edges: [] }));
    await expect(runStatus(['--cwd', dir, '--graph', file, '--offline'])).rejects.toMatchObject({
      name: 'GraphLoadError',
      kind: 'schema',
      code: ExitCode.ERROR,
    });
  });

  it('exits non-zero from the CLI entry, and the stderr line does not quote the file', async () => {
    const dir = tempDir();
    const corrupt = writeMap(dir, `not-json ${SECRET}`);
    const exits: number[] = [];
    const errSpy = vi.spyOn(process.stderr, 'write');
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exits.push(code ?? -1);
      return undefined as never;
    }) as typeof process.exit);

    const stderrText = (): string =>
      errSpy.mock.calls.map((call) => String(call[0])).join('').replace(/\u001b\[[0-9;]*m/g, '');

    await main(['node', 'vg', 'status', '--offline', '--cwd', dir, '--graph', corrupt]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(exits).toEqual([ExitCode.ERROR]);
    const text = stderrText();
    expect(text).toContain('error:');
    expect(text).toContain(REBUILD);
    expect(text).toContain('truncated or not valid JSON');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('Unexpected token');

    exits.length = 0;
    errSpy.mockClear();
    const mismatched = writeMap(dir, JSON.stringify({
      schemaVersion: 'vg-graph/0.2',
      secret: SECRET,
      nodes: [],
      edges: [],
    }));
    await main(['node', 'vg', 'status', '--offline', '--cwd', dir, '--graph', mismatched]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(exits).toEqual([ExitCode.ERROR]);
    const schemaText = stderrText();
    expect(schemaText).toContain('vg-graph/0.2');
    expect(schemaText).toContain(REBUILD);
    expect(schemaText).not.toContain(SECRET);
  });
});
