// Apache-2.0.
//
// Walk-safety helpers for core-open call sites (scan walks, search, drift,
// docs ingest, repo fingerprint). The policy lives in
// `src/engine/root-safety.ts`: `VG_MAX_WALK_ENTRIES` defaults to 1_000_000,
// and `--allow-unsafe-root` / `VG_ALLOW_UNSAFE_ROOT` skip the filesystem-root,
// OS-image, and walk-budget checks. This module keeps the names those call
// sites already use and forwards them to that policy.
import * as path from 'node:path';
import {
  assertSafeScanRoot,
  DEFAULT_MAX_WALK_ENTRIES,
  resolveMaxWalkEntries,
  unsafeRootAllowed,
  walkBudgetError,
  UnsafeRootError,
  type RootSafetyOptions,
  type UnsafeRootReason,
} from '../../engine/root-safety.js';

export { UnsafeRootError };
export type { UnsafeRootReason, RootSafetyOptions };

/** Same ceiling as {@link DEFAULT_MAX_WALK_ENTRIES}. */
export const DEFAULT_WALK_ENTRY_BUDGET = DEFAULT_MAX_WALK_ENTRIES;

/** Refuse a filesystem root or an OS-image directory. Honors `opts` and `VG_ALLOW_UNSAFE_ROOT`. */
export function assertSafeWalkRoot(root: string, opts?: RootSafetyOptions): void {
  assertSafeScanRoot(root, opts);
}

export interface WalkBudgetState {
  root: string;
  budget: number;
  seen: number;
}

/**
 * Entry counter for a directory walk. An explicit `override` (including `0`)
 * wins; otherwise `VG_MAX_WALK_ENTRIES`. `opts.allowUnsafeRoot` disables the
 * budget the same way `--allow-unsafe-root` does.
 */
export function createWalkBudget(root: string, override?: number, opts?: RootSafetyOptions): WalkBudgetState {
  const disabled = unsafeRootAllowed(opts?.allowUnsafeRoot);
  return {
    root: path.resolve(root),
    budget: disabled ? 0 : resolveMaxWalkEntries(override ?? opts?.maxWalkEntries),
    seen: 0,
  };
}

/**
 * Count one visited file or directory. Returns a stable error once `seen`
 * passes the budget; `null` while the walk may continue. `budget <= 0`
 * never trips. The message does not include `seen`.
 */
export function noteWalkEntry(state: WalkBudgetState): UnsafeRootError | null {
  if (state.budget <= 0) return null;
  state.seen += 1;
  if (state.seen <= state.budget) return null;
  return walkBudgetError(state.root, state.budget);
}
