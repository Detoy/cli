/**
 * Agent provenance: which VG Code session wrote a commit, and so a line.
 *
 * Opt-in, per repository: `vg review trailer on` installs a git
 * `prepare-commit-msg` hook. On each commit it finds the recent VG Code
 * sessions that touched the staged files and adds a `Vibgrate-Session: <id>`
 * trailer per session. The trailer carries only the session's random id: the
 * session itself (what was asked, the agent's answers) stays in
 * `.vibgrate/code-sessions/` on this machine and is never committed.
 *
 * `vg why <file:line>` then blames the line, reads the trailer and shows the
 * session's requests that touched that file, marked as the agent's own
 * account, unverified.
 *
 * The hook never blocks a commit: every failure is swallowed and the commit
 * goes ahead without a trailer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSession, readSessionIndex, rebuildSessionIndex, sessionTitle, type StoredSession } from '../code/session-store.js';
import { defaultRun, type GitRunner } from './git.js';

export const TRAILER = 'Vibgrate-Session';
/** Sessions older than this are not credited with a commit. */
export const SESSION_WINDOW_DAYS = 14;
const HOOK_MARK = '# vibgrate: Vibgrate-Session trailer';
const SESSION_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** The hook script: one line that never fails the commit. */
export const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARK} (remove with \`vg review trailer off\`)
command -v vg >/dev/null 2>&1 && vg review trailer --hook "$1" "$2" >/dev/null 2>&1
exit 0
`;

/** Repo-relative path of a session's file, forward slashes, or null when outside the repository. */
function relTo(topLevel: string, sessionRoot: string, file: string): string | null {
  const rel = path.relative(topLevel, path.resolve(sessionRoot, file)).split(path.sep).join('/');
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

/**
 * Sessions updated in the last `SESSION_WINDOW_DAYS` whose turns touched any
 * of `files` (repo-relative), newest first.
 */
export function sessionsTouching(topLevel: string, files: string[], now: number = Date.now()): string[] {
  const wanted = new Set(files.map((f) => f.split(path.sep).join('/')));
  const since = now - SESSION_WINDOW_DAYS * 86_400_000;
  const entries = (readSessionIndex(topLevel) ?? rebuildSessionIndex(topLevel)).filter((e) => e.updatedAt >= since).sort((a, b) => b.updatedAt - a.updatedAt);
  const out: string[] = [];
  for (const e of entries) {
    const s = loadSession(topLevel, e.id);
    if (!s) continue;
    const root = s.worktree?.path ?? topLevel;
    const touched = s.tasks.some((t) => (t.files ?? []).some((f) => {
      const rel = relTo(topLevel, root, f);
      return rel !== null && wanted.has(rel);
    }));
    if (touched && SESSION_ID.test(s.id)) out.push(s.id);
  }
  return out;
}

/**
 * The hook's work: add a trailer for each session that touched the staged
 * files. Skipped for merge and squash messages, which describe other commits.
 * Returns the ids added (for tests); never throws.
 */
export function addSessionTrailers(topLevel: string, messageFile: string, source: string | undefined, run: GitRunner = defaultRun, now?: number): string[] {
  try {
    if (source === 'merge' || source === 'squash') return [];
    const staged = run(['diff', '--cached', '--name-only', '-z'], topLevel);
    if (staged.status !== 0) return [];
    const files = staged.stdout.split('\0').filter(Boolean);
    const ids = sessionsTouching(topLevel, files, now);
    if (ids.length === 0) return [];
    const args = ['interpret-trailers', '--in-place', '--if-exists', 'addIfDifferent'];
    for (const id of ids) args.push('--trailer', `${TRAILER}: ${id}`);
    args.push(messageFile);
    return run(args, topLevel).status === 0 ? ids : [];
  } catch {
    return [];
  }
}

/** Where git looks for hooks here (honors core.hooksPath). */
export function hookPath(topLevel: string, run: GitRunner = defaultRun): string {
  const res = run(['rev-parse', '--git-path', 'hooks/prepare-commit-msg'], topLevel);
  const p = res.status === 0 ? res.stdout.trim() : path.join('.git', 'hooks', 'prepare-commit-msg');
  return path.resolve(topLevel, p);
}

export type TrailerState = 'on' | 'off' | 'other-hook';

export function trailerState(topLevel: string, run: GitRunner = defaultRun): TrailerState {
  const p = hookPath(topLevel, run);
  if (!fs.existsSync(p)) return 'off';
  return fs.readFileSync(p, 'utf8').includes(HOOK_MARK) ? 'on' : 'other-hook';
}

/**
 * Turn the trailer on or off. A `prepare-commit-msg` hook that is not ours is
 * never replaced or edited; the caller is told the one line to add to it.
 */
export function setTrailer(topLevel: string, on: boolean, run: GitRunner = defaultRun): TrailerState {
  const p = hookPath(topLevel, run);
  const state = trailerState(topLevel, run);
  if (state === 'other-hook') return state;
  if (on && state === 'off') {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, HOOK_SCRIPT, { mode: 0o755 });
    return 'on';
  }
  if (!on && state === 'on') {
    fs.rmSync(p);
    return 'off';
  }
  return state;
}

export interface LineProvenance {
  commit: { sha: string; subject: string; author: string; date: string } | null;
  /** Session ids the commit's trailers name. */
  sessions: { id: string; found: StoredSession | null }[];
}

/** Who wrote `file:line`: the commit that last changed it, and the sessions its trailers name. */
export function lineProvenance(topLevel: string, file: string, line: number, run: GitRunner = defaultRun): LineProvenance {
  const blame = run(['blame', '--porcelain', '-L', `${line},${line}`, '--', file], topLevel);
  const sha = blame.status === 0 ? blame.stdout.split(/\s/)[0] : '';
  if (!/^[0-9a-f]{40,64}$/.test(sha) || /^0+$/.test(sha)) return { commit: null, sessions: [] };
  const show = run(['show', '-s', `--format=%s%x00%an%x00%cI%x00%(trailers:key=${TRAILER},valueonly,separator=%x2C)`, sha], topLevel);
  if (show.status !== 0) return { commit: null, sessions: [] };
  const [subject, author, date, trailers] = show.stdout.replace(/\n$/, '').split('\0');
  const ids = [...new Set((trailers ?? '').split(',').map((s) => s.trim()).filter((s) => SESSION_ID.test(s)))];
  return {
    commit: { sha, subject: subject ?? '', author: author ?? '', date: date ?? '' },
    sessions: ids.map((id) => ({ id, found: loadSession(topLevel, id) ?? null })),
  };
}

/** The turns of a session that touched `file`, oldest first: what was asked, and the agent's own answer. */
export function turnsTouching(s: StoredSession, topLevel: string, file: string): { turn: number; asked: string; answered: string }[] {
  const root = s.worktree?.path ?? topLevel;
  const want = file.split(path.sep).join('/');
  return s.tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => (t.files ?? []).some((f) => relTo(topLevel, root, f) === want))
    .map(({ t, i }) => ({ turn: i + 1, asked: t.instruction, answered: t.summary }));
}

export { sessionTitle };
