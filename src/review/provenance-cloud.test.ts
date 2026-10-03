import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { newSession, saveSession, type StoredSession } from '../code/session-store.js';
import { cloudSession, lookupProvenance, preparePush, pushProvenance, repoIdentity, trailerSessionIds } from './provenance-cloud.js';
import type { ParsedDsn } from './push.js';

const dsn: ParsedDsn = { keyId: 'k', secret: 's', host: 'h.test', workspaceId: 'ws', scheme: 'https' };
let dir: string;

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function session(id: string, tasks: Partial<StoredSession['tasks'][number]>[]): StoredSession {
  return {
    ...newSession(id, 'anthropic', 'model-x', 1_790_000_000_000),
    tasks: tasks.map((t) => ({ instruction: 'ask', summary: 'did', files: [], stopped: 'done', ts: 1_790_000_000_000, ...t })),
  };
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-provc-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.test');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'remote.origin.url', 'https://github.com/acme/ledger.git');
  git('commit', '-q', '--allow-empty', '-m', 'init');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('which sessions to share', () => {
  it('reads trailers from the commits no remote has, or from <base>..HEAD', () => {
    git('commit', '-q', '--allow-empty', '-m', 'one', '-m', 'Vibgrate-Session: sess_aaa111\nVibgrate-Session: sess_bbb222');
    git('commit', '-q', '--allow-empty', '-m', 'two', '-m', 'Vibgrate-Session: sess_aaa111');
    expect(trailerSessionIds(dir, undefined).sort()).toEqual(['sess_aaa111', 'sess_bbb222']);
    expect(trailerSessionIds(dir, 'HEAD~1')).toEqual(['sess_aaa111']);
    expect(() => trailerSessionIds(dir, 'no-such-ref')).toThrow(/could not list commits/);
  });

  it('keys the repository the way a review receipt does', () => {
    expect(repoIdentity(dir)).toMatchObject({ name: 'acme/ledger', repo_key: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
  });
});

describe('what is sent', () => {
  it('masks credentials, keeps repo-relative files only, and drops everything else', () => {
    // Fake credentials, built at run time so the secret scanner never sees one in the source.
    const key = ['API', 'KEY'].join('_') + '=' + 'abcdef' + '123456';
    const token = ['ghp', 'abcdefghijklmnop'].join('_');
    const s = session('sess_aaa111', [
      { instruction: `use ${key} and https://u:pw@db.test/x`, summary: `Wired ${token} in`, files: ['src/a.ts', '/elsewhere/b.ts', 'src/a.ts'] },
    ]);
    s.tasks[0]!.attachments = [{ name: 'shot.png', kind: 'image' }];
    const c = cloudSession(s, dir);
    if ('refused' in c) throw new Error(c.refused);
    expect(c.turns).toEqual([
      { turn: 1, asked: 'use API_KEY:***redacted*** and https://u:***redacted***@db.test/x', answered: 'Wired ghp-***redacted*** in', files: ['src/a.ts'], ts: 1_790_000_000_000 },
    ]);
    expect(JSON.stringify(c)).not.toMatch(/abcdef123456|pw@|abcdefghijklmnop|shot\.png/);
  });

  it('lists sessions not on this machine and does not send them', () => {
    saveSession(dir, session('sess_aaa111', [{ files: ['src/a.ts'] }]));
    const p = preparePush(dir, ['sess_aaa111', 'sess_gone99']);
    expect(p.sessions.map((s) => s.id)).toEqual(['sess_aaa111']);
    expect(p.missing).toEqual(['sess_gone99']);
  });
});

describe('Cloud calls', () => {
  it('uploads in batches of 50 and reports what Cloud stored', async () => {
    const bodies: { sessions: unknown[] }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { sessions: unknown[] };
      bodies.push(body);
      return new Response(JSON.stringify({ status: 'ok', stored: body.sessions.length }), { status: 200 });
    }) as unknown as typeof fetch;
    const one = cloudSession(session('sess_aaa111', [{}]), dir);
    if ('refused' in one) throw new Error(one.refused);
    const sessions = Array.from({ length: 51 }, (_, i) => ({ ...one, id: `sess_${String(i).padStart(6, '0')}` }));
    const stored = await pushProvenance(dsn, { repo: repoIdentity(dir), sessions, missing: [], refused: [] }, fetchImpl);
    expect(stored).toBe(51);
    expect(bodies.map((b) => b.sessions.length)).toEqual([50, 1]);
    expect(bodies[0]).toMatchObject({ kind: 'code_session_provenance', repo: { name: 'acme/ledger' } });
  });

  it('says how to turn it on when the workspace has not opted in', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ code: 'provenance_upload_disabled', error: 'off' }), { status: 403 })) as unknown as typeof fetch;
    await expect(lookupProvenance(dsn, repoIdentity(dir), ['sess_aaa111'], fetchImpl)).rejects.toThrow(/Agent provenance in Vibgrate Cloud settings/);
    expect(await lookupProvenance(dsn, repoIdentity(dir), [], fetchImpl)).toEqual([]);
  });
});
