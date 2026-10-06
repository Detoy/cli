// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Fail closed before a scan or build walks a path that will hang or exhaust
 * memory: the filesystem root, an operating-system image, or a tree that
 * blows past the walk budget.
 *
 * The budget is the same knob as the graph build's corpus cap (`VG_MAX_FILES`,
 * default {@link DEFAULT_WALK_ENTRY_BUDGET}). `0` disables the budget only —
 * filesystem root and OS-image checks always run. There is no override for
 * those two; the operator narrows the path or excludes subtrees.
 */

/** Kept equal to the graph build's `DEFAULT_MAX_FILES` (engine/limits.ts). */
export const DEFAULT_WALK_ENTRY_BUDGET = 100_000;

export type UnsafeRootReason = 'filesystem-root' | 'os-image' | 'walk-budget';

/** A walk refused before it can hang or exhaust memory. The message is the UX. */
export class UnsafeRootError extends Error {
  readonly isUnsafeRootError = true;
  readonly reason: UnsafeRootReason;

  constructor(message: string, reason: UnsafeRootReason) {
    super(message);
    this.name = 'UnsafeRootError';
    this.reason = reason;
  }
}

const NARROW = 'Narrow the path to a project directory.';
const EXCLUDE =
  'To skip parts of a large tree, pass --exclude globs (repeatable; also read from the project config).';

/** Directory names that, together, mean "this is a Unix root filesystem". */
const POSIX_MARKERS = ['bin', 'boot', 'dev', 'etc', 'lib', 'proc', 'sbin', 'sys', 'usr', 'var'] as const;
/** Subset that a real rootfs almost always has. `bin` counts even though walks skip it. */
const POSIX_CORE = ['bin', 'etc', 'sbin', 'usr', 'var'] as const;

const WINDOWS_ALSO = ['program files', 'program files (x86)', 'users', 'programdata'] as const;
const DARWIN_REQUIRED = ['system', 'library'] as const;
const DARWIN_ALSO = ['applications', 'volumes'] as const;

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

export function filesystemRootMessage(root: string): string {
  return `Refusing to scan ${root}: it is the filesystem root. ${NARROW} ${EXCLUDE}`;
}

export function osImageMessage(root: string, markers: readonly string[]): string {
  const found = [...markers].sort(compareNames).join(', ');
  return `Refusing to scan ${root}: it looks like an operating-system image (found ${found}). ${NARROW} ${EXCLUDE}`;
}

export function walkBudgetMessage(root: string, budget: number): string {
  return (
    `Refusing to scan ${root}: the walk exceeded the ${formatCount(budget)}-entry budget. ` +
    `${NARROW} ${EXCLUDE} Or set VG_MAX_FILES to raise the limit (0 disables it).`
  );
}

/**
 * True when `root` is the filesystem root (`/`, `C:\`, a UNC share root).
 * `pathApi` is injectable so Windows roots can be tested on any host.
 */
export function isFilesystemRoot(
  root: string,
  pathApi: { resolve: (p: string) => string; parse: (p: string) => { root: string } } = path,
): boolean {
  const resolved = pathApi.resolve(root);
  return resolved === pathApi.parse(resolved).root;
}

/**
 * Sorted marker names when `dirNames` is an OS image layout, otherwise [].
 * Names are compared case-insensitively. A normal repo (`src`, `bin`, `lib`)
 * stays under the bar; a rootfs unpack (`bin`, `etc`, `usr`, `var`, …) does not.
 */
export function matchingOsImageMarkers(dirNames: Iterable<string>): string[] {
  const names = new Set<string>();
  for (const raw of dirNames) {
    const name = raw.trim().toLowerCase();
    if (name) names.add(name);
  }

  const posix = POSIX_MARKERS.filter((marker) => names.has(marker));
  const core = POSIX_CORE.filter((marker) => names.has(marker));
  if (posix.length >= 4 && core.length >= 3) return [...posix].sort(compareNames);

  if (names.has('windows') && WINDOWS_ALSO.some((marker) => names.has(marker))) {
    return ['windows', ...WINDOWS_ALSO.filter((marker) => names.has(marker))].sort(compareNames);
  }

  if (DARWIN_REQUIRED.every((marker) => names.has(marker)) && DARWIN_ALSO.some((marker) => names.has(marker))) {
    return [...DARWIN_REQUIRED, ...DARWIN_ALSO.filter((marker) => names.has(marker))].sort(compareNames);
  }

  return [];
}

/** Immediate child directory names. Symlinks are included only when they point at a directory. */
export function listChildDirNames(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      if (fs.statSync(path.join(root, entry.name)).isDirectory()) names.push(entry.name);
    } catch {
      // Dangling symlink — not a directory marker.
    }
  }
  return names;
}

/**
 * Refuse a filesystem root or an OS-image directory. Missing paths and
 * regular files are not roots; the caller reports "path does not exist".
 * Does not recurse.
 */
export function assertSafeWalkRoot(root: string): void {
  const resolved = path.resolve(root);
  if (isFilesystemRoot(resolved)) {
    throw new UnsafeRootError(filesystemRootMessage(resolved), 'filesystem-root');
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(resolved);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  const markers = matchingOsImageMarkers(listChildDirNames(resolved));
  if (markers.length > 0) {
    throw new UnsafeRootError(osImageMessage(resolved, markers), 'os-image');
  }
}

/**
 * Effective walk budget. An explicit override (including `0`) wins; otherwise
 * `VG_MAX_FILES`; otherwise {@link DEFAULT_WALK_ENTRY_BUDGET}. Invalid values
 * fall back to the default. `0` disables the budget.
 */
export function resolveWalkEntryBudget(override?: number): number {
  if (override !== undefined) {
    return Number.isInteger(override) && override >= 0 ? override : DEFAULT_WALK_ENTRY_BUDGET;
  }
  const raw = process.env.VG_MAX_FILES;
  if (raw === undefined || raw.trim() === '') return DEFAULT_WALK_ENTRY_BUDGET;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_WALK_ENTRY_BUDGET;
}

export interface WalkBudgetState {
  root: string;
  budget: number;
  seen: number;
}

export function createWalkBudget(root: string, override?: number): WalkBudgetState {
  return { root: path.resolve(root), budget: resolveWalkEntryBudget(override), seen: 0 };
}

/**
 * Count one visited file or directory. Returns a stable error once `seen`
 * passes the budget; `null` while the walk may continue. `budget <= 0`
 * never trips. The message does not include `seen`, so concurrent walkers
 * that overshoot by a few entries still report the same text.
 */
export function noteWalkEntry(state: WalkBudgetState): UnsafeRootError | null {
  if (state.budget <= 0) return null;
  state.seen += 1;
  if (state.seen <= state.budget) return null;
  return new UnsafeRootError(walkBudgetMessage(state.root, state.budget), 'walk-budget');
}
