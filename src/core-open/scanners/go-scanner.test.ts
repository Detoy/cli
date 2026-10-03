import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Semaphore } from '../utils/semaphore.js';
import { GoCache } from './go-cache.js';
import { scanGoProjects } from './go-scanner.js';

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const GOMOD = [
  'module example.com/svc',
  '',
  'go 1.22',
  '',
  'require (',
  '\tgithub.com/gin-gonic/gin v1.9.1',
  '\texample.com/unpinned',
  '\texample.com/noprefix 1.4.0',
  '\tgithub.com/stretchr/testify v1.8.4 // indirect',
  '\texample.com/indirect-unpinned // indirect',
  ')',
  '',
  'require example.com/single',
  '',
  'exclude example.com/excluded v1.0.0',
  '',
  'replace example.com/local => ../local',
  '',
].join('\n');

describe('scanGoProjects unpinned requires', () => {
  it('keeps a direct require that has no version and does not invent a pin', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-go-scan-'));
    fs.writeFileSync(path.join(dir, 'go.mod'), GOMOD);
    const cache = new GoCache(new Semaphore(1), undefined, true);
    const scan = () => scanGoProjects(dir!, cache);
    const [first, second] = await Promise.all([scan(), scan()]);
    expect(second[0]?.dependencies).toEqual(first[0]?.dependencies);

    const deps = first[0]?.dependencies ?? [];
    const byName = Object.fromEntries(deps.map((d) => [d.package, d]));
    expect(Object.keys(byName).sort()).toEqual([
      'example.com/noprefix',
      'example.com/single',
      'example.com/unpinned',
      'github.com/gin-gonic/gin',
    ]);

    expect(byName['example.com/unpinned']).toMatchObject({
      currentSpec: null,
      resolvedVersion: null,
      majorsBehind: null,
      drift: 'unknown',
    });
    expect(byName['example.com/single']).toMatchObject({
      currentSpec: null,
      resolvedVersion: null,
      majorsBehind: null,
    });
    expect(byName['example.com/noprefix']).toMatchObject({
      currentSpec: '1.4.0',
      resolvedVersion: '1.4.0',
    });
    expect(byName['github.com/gin-gonic/gin']).toMatchObject({
      currentSpec: 'v1.9.1',
      resolvedVersion: '1.9.1',
    });
    expect(byName['example.com/excluded']).toBeUndefined();
    expect(byName['example.com/local']).toBeUndefined();
    expect(byName['example.com/indirect-unpinned']).toBeUndefined();
    expect(byName['github.com/stretchr/testify']).toBeUndefined();

    for (const dep of deps) {
      expect(dep.currentSpec).not.toBe('');
      expect(dep.resolvedVersion).not.toBe('');
      if (dep.currentSpec == null) expect(dep.majorsBehind).toBeNull();
    }
  });
});
