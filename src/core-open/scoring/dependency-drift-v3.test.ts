import { describe, expect, it } from 'vitest';
import type { DependencyRow } from '../types.js';
import { aggregateDependencyDrift, perDependencyDrift } from './dependency-drift-v3.js';

function row(partial: Partial<DependencyRow> & Pick<DependencyRow, 'package' | 'currentSpec' | 'resolvedVersion'>): DependencyRow {
  return {
    section: 'dependencies',
    latestStable: null,
    majorsBehind: null,
    drift: 'unknown',
    ...partial,
  };
}

describe('version absence vs zero', () => {
  it('excludes a dependency with no version instead of scoring it as zero drift', () => {
    const unpinned = row({
      package: 'example.com/unpinned',
      currentSpec: null,
      resolvedVersion: null,
      latestStable: '2.0.0',
    });
    const scored = perDependencyDrift(unpinned);
    expect(scored.excluded).toBe(true);
    expect(scored.flags).toContain('version-absent');
    expect(aggregateDependencyDrift([unpinned])).toBeNull();

    const pinned = row({
      package: 'example.com/pinned',
      currentSpec: 'v1.0.0',
      resolvedVersion: '1.0.0',
      latestStable: '2.0.0',
      majorsBehind: 1,
      drift: 'major-behind',
    });
    const agg = aggregateDependencyDrift([unpinned, pinned]);
    expect(agg?.scored).toBe(1);
    expect(agg?.excluded).toBe(1);
    expect(agg?.drift).toBeGreaterThan(0);
  });

  it('does not treat a concrete 0.0.0 pin or a workspace spec as missing', () => {
    const zero = row({
      package: 'example.com/zero',
      currentSpec: 'v0.0.0',
      resolvedVersion: '0.0.0',
      latestStable: '0.0.0',
      majorsBehind: 0,
      drift: 'current',
    });
    expect(perDependencyDrift(zero).excluded).toBe(false);
    expect(perDependencyDrift(row({ package: 'home', currentSpec: 'workspace:*', resolvedVersion: null })).excluded).toBe(false);
    expect(perDependencyDrift(row({ package: 'blank', currentSpec: '', resolvedVersion: null })).excluded).toBe(true);
  });
});
