import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discover } from '../src/engine/discover.js';
import {
  assertSafeScanRoot,
  filesystemRootMessage,
  isFilesystemRoot,
  looksLikeOsImage,
  osImageMessage,
  UnsafeRootError,
  walkBudgetMessage,
} from '../src/engine/root-safety.js';
import { runBuild } from '../src/commands/build.js';
import { FileCache, quickTreeCount } from '../src/core-open/utils/fs.js';
import { scanCommand } from '../src/reporting/commands/scan.js';
import { CliError, ExitCode } from '../src/util/exit.js';
import { cleanup, makeProject } from './helpers.js';

const ENV_KEYS = ['VG_ALLOW_UNSAFE_ROOT', 'VG_MAX_WALK_ENTRIES', 'VIBGRATE_DSN', 'VIBGRATE_NO_KERNEL'];
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];

function realProject(files: Record<string, string>): string {
  const created = makeProject(files);
  const dir = fs.realpathSync(created);
  dirs.push(created === dir ? created : dir);
  if (created !== dir) dirs.push(created);
  return dir;
}

function unixImage(): string {
  return realProject({
    'bin/.keep': '',
    'etc/.keep': '',
    'usr/.keep': '',
    'var/.keep': '',
    'lib/.keep': '',
    'src/app.ts': 'export const app = 1;\n',
  });
}

const UNIX_NAMES = ['bin', 'etc', 'lib', 'src', 'usr', 'var'];

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  while (dirs.length) cleanup(dirs.pop()!);
});

function messageFrom(run: () => void): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(UnsafeRootError);
    return (err as UnsafeRootError).message;
  }
  throw new Error('expected UnsafeRootError');
}

describe('root safety predicates', () => {
  it('recognises a filesystem root and a normal directory', () => {
    const fsRoot = path.parse(process.cwd()).root;
    expect(isFilesystemRoot(fsRoot)).toBe(true);
    expect(isFilesystemRoot(os.tmpdir())).toBe(false);
  });

  it('treats a symlink to the filesystem root as the filesystem root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-root-link-'));
    dirs.push(parent);
    const link = path.join(parent, 'to-root');
    fs.symlinkSync(path.parse(process.cwd()).root, link);
    expect(isFilesystemRoot(link)).toBe(true);
    const message = messageFrom(() => assertSafeScanRoot(link));
    expect(message).toBe(filesystemRootMessage(path.parse(process.cwd()).root));
    expect(message).toContain('project subdirectory');
    expect(message).toContain('--exclude');
    expect(message).toContain('--allow-unsafe-root');
    expect(message).not.toMatch(/\n\s+at /);
  });

  it('matches an OS image layout and ignores a project that only has bin and lib', () => {
    expect(looksLikeOsImage(['etc', 'usr', 'var'])).toBe(false);
    expect(looksLikeOsImage(['etc', 'usr', 'var', 'bin'])).toBe(true);
    expect(looksLikeOsImage(['bin', 'lib', 'src'])).toBe(false);
    expect(looksLikeOsImage(['Windows'])).toBe(false);
    expect(looksLikeOsImage(['Windows', 'Program Files'])).toBe(true);
    expect(looksLikeOsImage(['Program Files', 'Users'])).toBe(false);
  });
});

describe('assertSafeScanRoot', () => {
  it('refuses the filesystem root with a stable message', () => {
    const fsRoot = path.parse(process.cwd()).root;
    const once = messageFrom(() => assertSafeScanRoot(fsRoot));
    const twice = messageFrom(() => assertSafeScanRoot(fsRoot));
    expect(once).toBe(twice);
    expect(once).toBe(filesystemRootMessage(fsRoot));
    expect((() => {
      try {
        assertSafeScanRoot(fsRoot);
      } catch (err) {
        return (err as UnsafeRootError).reason;
      }
    })()).toBe('filesystem-root');
  });

  it('refuses an operating-system image and allows a narrowed subdirectory', () => {
    const root = unixImage();
    const expected = osImageMessage(root, UNIX_NAMES);
    const once = messageFrom(() => assertSafeScanRoot(root));
    const twice = messageFrom(() => discover({ root }));
    expect(once).toBe(expected);
    expect(twice).toBe(expected);
    expect(once).toContain('project subdirectory');
    expect(once).toContain('--exclude ignore patterns');
    expect(once).toContain('--allow-unsafe-root');
    expect(discover({ root, paths: ['src'] }).map((file) => file.rel)).toEqual(['src/app.ts']);
  });

  it('refuses a Windows image layout', () => {
    const root = realProject({
      'Windows/.keep': '',
      'Program Files/.keep': '',
      'src/app.ts': 'export const app = 1;\n',
    });
    expect(messageFrom(() => assertSafeScanRoot(root))).toBe(
      osImageMessage(root, ['Windows', 'Program Files', 'src']),
    );
  });

  it('does not treat bin and lib alone as an image', () => {
    const root = realProject({
      'bin/.keep': '',
      'lib/app.ts': 'export const app = 1;\n',
    });
    expect(discover({ root }).map((file) => file.rel)).toEqual(['lib/app.ts']);
  });

  it('allows the image when the override flag or env is set', () => {
    const root = unixImage();
    expect(discover({ root, allowUnsafeRoot: true }).map((file) => file.rel)).toEqual(['src/app.ts']);
    process.env.VG_ALLOW_UNSAFE_ROOT = '1';
    expect(() => assertSafeScanRoot(root)).not.toThrow();
  });
});

describe('walk budget', () => {
  it('stops a runaway walk with a stable, actionable error', () => {
    const root = realProject({
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'export const b = 2;\n',
      'c.ts': 'export const c = 3;\n',
    });
    const expected = walkBudgetMessage(root, 1);
    const once = messageFrom(() => discover({ root, maxWalkEntries: 1 }));
    const twice = messageFrom(() => discover({ root, maxWalkEntries: 1 }));
    expect(once).toBe(twice);
    expect(once).toBe(expected);
    expect(once).toContain('VG_MAX_WALK_ENTRIES');
    expect(once).toContain('--exclude ignore patterns');
    expect(once).toContain('--allow-unsafe-root');
    expect(once).not.toMatch(/\n\s+at /);
    expect(discover({ root, maxWalkEntries: 0 }).map((file) => file.rel)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(discover({ root, maxWalkEntries: 1, allowUnsafeRoot: true }).map((file) => file.rel)).toEqual([
      'a.ts',
      'b.ts',
      'c.ts',
    ]);
  });

  it('reads VG_MAX_WALK_ENTRIES and keeps discovery order stable under the default budget', () => {
    const root = realProject({
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'export const b = 2;\n',
    });
    process.env.VG_MAX_WALK_ENTRIES = '1';
    expect(messageFrom(() => discover({ root }))).toBe(walkBudgetMessage(root, 1));
    delete process.env.VG_MAX_WALK_ENTRIES;
    expect(discover({ root }).map((file) => file.rel)).toEqual(discover({ root, maxWalkEntries: 100 }).map((file) => file.rel));
  });

  it('rejects the scan walk and the quick count on the same budget', async () => {
    const root = realProject({
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'export const b = 2;\n',
      'c.ts': 'export const c = 3;\n',
    });
    const expected = walkBudgetMessage(root, 1);
    const cache = new FileCache();
    cache.setRootSafety({ maxWalkEntries: 1 });
    await expect(cache.walkDir(root)).rejects.toThrow(expected);
    await expect(quickTreeCount(root, undefined, { maxWalkEntries: 1 })).rejects.toThrow(expected);
  });

  it('rejects an OS image from the scan walk before descending', async () => {
    const root = unixImage();
    const expected = osImageMessage(root, UNIX_NAMES);
    await expect(new FileCache().walkDir(root)).rejects.toThrow(expected);
    await expect(quickTreeCount(root)).rejects.toThrow(expected);
    const cache = new FileCache();
    cache.setRootSafety({ allowUnsafeRoot: true });
    const entries = await cache.walkDir(root);
    expect(entries.some((entry) => entry.name === 'app.ts')).toBe(true);
  });
});

describe('cli error path', () => {
  it('vg build exits with the image error and no stack', async () => {
    const root = unixImage();
    const error = await runBuild([], {}, { cwd: root, json: true, quiet: true, offline: true, noCache: true, daemon: false }).then(
      () => {
        throw new Error('expected build to refuse the image');
      },
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: ExitCode.ERROR, message: osImageMessage(root, UNIX_NAMES) });
    expect((error as Error).message).not.toMatch(/\n\s+at /);
    expect(fs.existsSync(path.join(root, '.vibgrate'))).toBe(false);
  });

  it('vg scan exits 1 on an OS image and on a blown walk budget', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const image = unixImage();
      const imageError = await scanCommand
        .parseAsync(['node', 'scan', image, '--offline', '--no-daemon', '--no-graph', '--quiet'])
        .then(
          () => {
            throw new Error('expected scan to refuse the image');
          },
          (err: unknown) => err,
        );
      expect(imageError).toBeInstanceOf(CliError);
      expect(imageError).toMatchObject({
        code: ExitCode.ERROR,
        message: osImageMessage(image, UNIX_NAMES),
      });
      expect((imageError as Error).message).not.toMatch(/\n\s+at /);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(image, '.vibgrate'))).toBe(false);

      const wide = realProject({
        'a.ts': 'export const a = 1;\n',
        'b.ts': 'export const b = 2;\n',
        'c.ts': 'export const c = 3;\n',
      });
      process.env.VG_MAX_WALK_ENTRIES = '1';
      process.env.VIBGRATE_DSN = '';
      process.env.VIBGRATE_NO_KERNEL = '1';
      const budgetError = await scanCommand
        .parseAsync(['node', 'scan', wide, '--offline', '--no-daemon', '--no-graph', '--quiet'])
        .then(
          () => {
            throw new Error('expected scan to refuse the walk budget');
          },
          (err: unknown) => err,
        );
      expect(budgetError).toBeInstanceOf(CliError);
      expect((budgetError as CliError).code).toBe(ExitCode.ERROR);
      expect((budgetError as CliError).message).toBe(walkBudgetMessage(wide, 1));
      expect(exitSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(wide, '.vibgrate'))).toBe(false);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});
