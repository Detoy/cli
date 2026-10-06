import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Fail closed when a scan or build root looks like a whole filesystem.
 *
 * Walking `/`, an unpacked OS image, or an enormous directory can hang or
 * exhaust memory before any per-file cap applies. These checks run before
 * that walk (and stop it once a fixed entry budget is crossed). They depend
 * only on the path and the directory names at the top of the tree — never on
 * the clock, randomness, or readdir order — so the error text is stable.
 */

/** Directory entries a walk may visit before it stops. 0 disables. */
export const DEFAULT_MAX_WALK_ENTRIES = 1_000_000;

const UNIX_REQUIRED = ['etc', 'usr', 'var'] as const;
const UNIX_CONFIRM = ['bin', 'sbin', 'lib', 'boot'] as const;
const WINDOWS_ANCHOR = 'Windows';
const WINDOWS_CONFIRM = ['Program Files', 'Program Files (x86)', 'Users', 'ProgramData'] as const;

export type UnsafeRootReason = 'filesystem-root' | 'os-image' | 'walk-budget';

export interface RootSafetyOptions {
  /** Skip the filesystem-root, OS-image, and walk-budget checks. */
  allowUnsafeRoot?: boolean;
  /**
   * Walk-entry ceiling. Wins over `VG_MAX_WALK_ENTRIES` when set, including 0
   * (disabled). Ignored when `allowUnsafeRoot` is set.
   */
  maxWalkEntries?: number;
}

/** A scan or build stopped because the root is unsafe to walk. The message is the UX. */
export class UnsafeRootError extends Error {
  readonly isUnsafeRootError = true;
  readonly reason: UnsafeRootReason;
  constructor(message: string, reason: UnsafeRootReason) {
    super(message);
    this.name = 'UnsafeRootError';
    this.reason = reason;
  }
}

const REMEDY =
  'Pass a project subdirectory instead, narrow the walk with --exclude ignore patterns, ' +
  'or pass --allow-unsafe-root to scan this tree anyway.';

export function filesystemRootMessage(root: string): string {
  return `Refusing to scan ${root}: it is the filesystem root. ${REMEDY}`;
}

export function osImageMessage(root: string, dirNames: readonly string[]): string {
  const listed = matchedOsImageMarkers(dirNames).join(', ');
  const detail = listed ? ` (top-level ${listed})` : '';
  return `Refusing to scan ${root}: it looks like an operating-system image${detail}. ${REMEDY}`;
}

export function walkBudgetMessage(root: string, limit: number): string {
  return (
    `Refusing to scan ${root}: the walk passed the ${limit}-entry budget. ` +
    'Pass a project subdirectory, narrow the walk with --exclude ignore patterns, ' +
    'raise VG_MAX_WALK_ENTRIES (0 disables this budget), or pass --allow-unsafe-root ' +
    'to scan this tree anyway.'
  );
}

/** `VG_ALLOW_UNSAFE_ROOT=1` (or `true`) matches `--allow-unsafe-root`. */
export function allowUnsafeRootFromEnv(): boolean {
  const raw = process.env.VG_ALLOW_UNSAFE_ROOT;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true';
}

export function unsafeRootAllowed(explicit?: boolean): boolean {
  return explicit === true || allowUnsafeRootFromEnv();
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function resolveMaxWalkEntries(override?: number): number {
  if (override !== undefined) {
    return Number.isInteger(override) && override >= 0 ? override : DEFAULT_MAX_WALK_ENTRIES;
  }
  return envInt('VG_MAX_WALK_ENTRIES', DEFAULT_MAX_WALK_ENTRIES);
}

/**
 * True when `dir` is the root of a filesystem (`/`, `C:\`, a symlink to one).
 * Does not list the directory.
 */
export function isFilesystemRoot(dir: string): boolean {
  let resolved = path.resolve(dir);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // Keep the lexical path when the target cannot be canonicalized.
  }
  const root = path.parse(resolved).root;
  if (process.platform === 'win32') return resolved.toLowerCase() === root.toLowerCase();
  return resolved === root;
}

/** Real directory path, or null when `root` is missing or not a directory. */
export function canonicalDirectory(root: string): string | null {
  try {
    const real = fs.realpathSync(path.resolve(root));
    if (!fs.statSync(real).isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Obvious OS-image layout from top-level directory names only.
 *
 * Unix: `etc`, `usr`, and `var` together, plus one of `bin`, `sbin`, `lib`,
 * or `boot`. A project with a `bin/` or `lib/` folder does not match.
 * Windows: `Windows` plus `Program Files`, `Users`, or `ProgramData`.
 */
export function looksLikeOsImage(dirNames: readonly string[]): boolean {
  const names = new Set(dirNames);
  const unix =
    UNIX_REQUIRED.every((name) => names.has(name)) && UNIX_CONFIRM.some((name) => names.has(name));
  if (unix) return true;
  return names.has(WINDOWS_ANCHOR) && WINDOWS_CONFIRM.some((name) => names.has(name));
}

/** Marker names present in `dirNames`, in a fixed order (not readdir order). */
export function matchedOsImageMarkers(dirNames: readonly string[]): string[] {
  const names = new Set(dirNames);
  const markers = [...UNIX_REQUIRED, ...UNIX_CONFIRM, WINDOWS_ANCHOR, ...WINDOWS_CONFIRM];
  return markers.filter((name) => names.has(name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function listTopLevelDirectoryNames(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    // Live Unix roots symlink `bin` → `usr/bin`. Count those as directories
    // so an image that preserved the links still matches. One stat per
    // top-level symlink; nothing below this level is visited.
    if (!entry.isSymbolicLink()) continue;
    try {
      if (fs.statSync(path.join(dir, entry.name)).isDirectory()) names.push(entry.name);
    } catch {
      // Dangling link — not a directory marker.
    }
  }
  return names;
}

/**
 * Refuse a filesystem root or an OS-image layout. Returns without throwing
 * when the path is missing, not a directory, or the override is set. Does not
 * recurse.
 */
export function assertSafeScanRoot(root: string, opts?: RootSafetyOptions): void {
  if (unsafeRootAllowed(opts?.allowUnsafeRoot)) return;
  const dir = canonicalDirectory(root);
  if (!dir) return;
  if (isFilesystemRoot(dir)) {
    throw new UnsafeRootError(filesystemRootMessage(dir), 'filesystem-root');
  }
  const names = listTopLevelDirectoryNames(dir);
  if (looksLikeOsImage(names)) {
    throw new UnsafeRootError(osImageMessage(dir, names), 'os-image');
  }
}

export function walkBudgetError(root: string, limit: number): UnsafeRootError {
  const display = canonicalDirectory(root) ?? path.resolve(root);
  return new UnsafeRootError(walkBudgetMessage(display, limit), 'walk-budget');
}

export interface WalkBudget {
  /** 0 means the budget is disabled. */
  readonly limit: number;
  readonly aborted: boolean;
  /** Count one directory entry. Throws {@link UnsafeRootError} once over the ceiling. */
  note(): void;
}

/**
 * Entry counter for a directory walk. `note` throws once the ceiling is
 * crossed; later calls are no-ops so in-flight sibling walks can stop.
 */
export function createWalkBudget(root: string, opts?: RootSafetyOptions): WalkBudget {
  const limit = unsafeRootAllowed(opts?.allowUnsafeRoot) ? 0 : resolveMaxWalkEntries(opts?.maxWalkEntries);
  let seen = 0;
  let aborted = false;
  return {
    limit,
    get aborted() {
      return aborted;
    },
    note() {
      if (limit <= 0 || aborted) return;
      seen += 1;
      if (seen > limit) {
        aborted = true;
        throw walkBudgetError(root, limit);
      }
    },
  };
}
