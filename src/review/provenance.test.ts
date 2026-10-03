import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { newSession, saveSession, type StoredSession } from '../code/session-store.js';
import { addSessionTrailers, hookPath, HOOK_SCRIPT, lineProvenance, sessionsTouching, setTrailer, trailerState, turnsTouching } from './provenance.js';

const NOW = Date.parse('2026-10-02T10:00:00Z');
let dir: string;

function git(...args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function session(id: string, files: string[][], updatedAt = NOW): StoredSession {
  const s = newSession(id, 'anthropic', 'model-x', updatedAt);
  return {
    ...s,
    tasks: files.map((f, i) => ({ instruction: `ask ${i + 1}`, summary: `did ${i + 1}`, files: f, stopped: 'done', ts: updatedAt })),
  };
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-prov-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'dev@example.test');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.vibgrate/\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the trailer hook', () => {
  it('turns on and off, and never replaces another tool’s hook', () => {
    expect(trailerState(dir)).toBe('off');
    expect(setTrailer(dir, true)).toBe('on');
    expect(fs.readFileSync(hookPath(dir), 'utf8')).toBe(HOOK_SCRIPT);
    expect(setTrailer(dir, false)).toBe('off');
    expect(fs.existsSync(hookPath(dir))).toBe(false);

    fs.writeFileSync(hookPath(dir), '#!/bin/sh\necho theirs\n');
    expect(setTrailer(dir, true)).toBe('other-hook');
    expect(setTrailer(dir, false)).toBe('other-hook');
    expect(fs.readFileSync(hookPath(dir), 'utf8')).toContain('theirs');
  });
});

describe('adding trailers', () => {
  it('credits the recent sessions that touched a staged file, and no others', () => {
    saveSession(dir, session('sess_touch1', [['src/a.ts']]));
    saveSession(dir, session('sess_other1', [['src/b.ts']]));
    saveSession(dir, session('sess_stale1', [['src/a.ts']], NOW - 30 * 86_400_000));
    expect(sessionsTouching(dir, ['src/a.ts'], NOW)).toEqual(['sess_touch1']);
    // Without the History index the stored sessions are scanned.
    fs.rmSync(path.join(dir, '.vibgrate/code-sessions/index.json'));
    expect(sessionsTouching(dir, ['src/a.ts'], NOW)).toEqual(['sess_touch1']);

    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\ntwo\n');
    git('add', 'src/a.ts');
    const msg = path.join(dir, 'MSG');
    fs.writeFileSync(msg, 'Add two\n');
    expect(addSessionTrailers(dir, msg, 'message', undefined, NOW)).toEqual(['sess_touch1']);
    expect(fs.readFileSync(msg, 'utf8')).toBe('Add two\n\nVibgrate-Session: sess_touch1\n');
    // Running twice adds nothing new.
    addSessionTrailers(dir, msg, 'message', undefined, NOW);
    expect(fs.readFileSync(msg, 'utf8').match(/Vibgrate-Session/g)).toHaveLength(1);
  });

  it('leaves merge and squash messages alone, and never throws', () => {
    saveSession(dir, session('sess_touch1', [['src/a.ts']]));
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'changed\n');
    git('add', 'src/a.ts');
    const msg = path.join(dir, 'MSG');
    fs.writeFileSync(msg, 'Merge\n');
    expect(addSessionTrailers(dir, msg, 'merge', undefined, NOW)).toEqual([]);
    expect(addSessionTrailers(dir, msg, 'squash', undefined, NOW)).toEqual([]);
    expect(fs.readFileSync(msg, 'utf8')).toBe('Merge\n');
    expect(addSessionTrailers(path.join(dir, 'nowhere'), msg, 'message', undefined, NOW)).toEqual([]);
  });
});

describe('who wrote a line', () => {
  it('finds the commit, its session, and the turns that touched the file', () => {
    saveSession(dir, session('sess_touch1', [['src/b.ts'], ['src/a.ts']]));
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\ntwo\n');
    git('add', 'src/a.ts');
    git('commit', '-q', '-m', 'Add two', '-m', 'Vibgrate-Session: sess_touch1');

    const p = lineProvenance(dir, 'src/a.ts', 2);
    expect(p.commit?.subject).toBe('Add two');
    expect(p.commit?.author).toBe('Dev');
    expect(p.sessions.map((s) => s.id)).toEqual(['sess_touch1']);
    const found = p.sessions[0]!.found!;
    expect(turnsTouching(found, dir, 'src/a.ts')).toEqual([{ turn: 2, asked: 'ask 2', answered: 'did 2' }]);

    // Line 1 came from a commit with no trailer.
    expect(lineProvenance(dir, 'src/a.ts', 1).sessions).toEqual([]);
  });

  it('reports a session the trailer names but this machine does not have', () => {
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\nthree\n');
    git('add', 'src/a.ts');
    git('commit', '-q', '-m', 'Add three', '-m', 'Vibgrate-Session: sess_elsewhere');
    expect(lineProvenance(dir, 'src/a.ts', 2).sessions).toEqual([{ id: 'sess_elsewhere', found: null }]);
  });

  it('has no commit for an uncommitted line', () => {
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\nlocal\n');
    expect(lineProvenance(dir, 'src/a.ts', 2).commit).toBeNull();
  });
});
