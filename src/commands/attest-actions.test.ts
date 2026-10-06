import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DSSE_PAYLOAD_TYPE } from '../engine/attest.js';
import type { VgGraph } from '../schema.js';
import { CliError, ExitCode } from '../util/exit.js';
import { signGraphAttestation } from './attest-actions.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz';

const roots: string[] = [];

function tempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-attest-write-'));
  roots.push(root);
  return root;
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

async function catchSign(root: string, attestation?: string): Promise<unknown> {
  try {
    await signGraphAttestation(root, graph(), attestation ? { attestation } : {});
    return undefined;
  } catch (err) {
    return err;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('signGraphAttestation write failures', () => {
  it('reports a directory attestation path with a next step and no key material', async () => {
    const root = tempDir();
    const out = path.join(root, 'attest-out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(root, 'note.txt'), `token ${TOKEN}\n`);
    const err = await catchSign(root, out);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({ code: ExitCode.ERROR });
    expect((err as Error).message).toBe(
      'could not write attest-out (the path is a directory). Check the path and permissions, or pass a different --attestation.',
    );
    expect((err as Error).message).not.toMatch(/\n/);
    expect((err as Error).message).not.toContain('PRIVATE KEY');
    expect((err as Error).message).not.toContain('BEGIN');
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain('EISDIR');
  });

  it('reports a signing key whose parent is not a directory', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, '.vibgrate'), 'not-a-directory');
    const err = await catchSign(root);
    expect(err).toBeInstanceOf(CliError);
    expect(err).toMatchObject({
      code: ExitCode.ERROR,
      message:
        'could not write .vibgrate/attest-key.pem (a parent path exists and is not a directory). Check the path and permissions for the signing key.',
    });
    expect((err as Error).message).not.toContain('PRIVATE KEY');
    expect((err as Error).message).not.toContain('BEGIN');
  });

  it('still writes a one-line attestation when the path is a file', async () => {
    const root = tempDir();
    const out = path.join(root, 'out', 'attestation.intoto.jsonl');
    const signed = await signGraphAttestation(root, graph(), { attestation: out });
    const text = fs.readFileSync(out, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(text).payloadType).toBe(DSSE_PAYLOAD_TYPE);
    expect(signed.summary.out).toBe(path.relative(root, out));
    expect(signed.summary.keyid).toMatch(/^[0-9a-f]{16}$/);
  });
});
