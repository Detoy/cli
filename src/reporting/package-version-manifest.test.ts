import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPackageVersionManifest, PackageManifestError } from './package-version-manifest.js';

const BODY_SENTINEL = 'manifest-body-sentinel-9f3a2c';
const NEARBY_SENTINEL = 'nearby-file-sentinel-77ab';
const ENV_SENTINEL = 'env-sentinel-manifest-4c1e';

function notFound(resolved: string): string {
  return `Package manifest not found: ${resolved}. Pass a readable JSON or ZIP package-version manifest to --package-manifest.`;
}

function notReadable(resolved: string): string {
  return `Package manifest is not readable: ${resolved}. Check permissions and pass a readable JSON or ZIP package-version manifest to --package-manifest.`;
}

function notUsable(resolved: string): string {
  return `Package manifest is not usable: ${resolved}. Expected a JSON object of package versions, or a ZIP containing package-versions.json, manifest.json, or index.json.`;
}

function zipNotUsable(resolved: string): string {
  return `Package manifest is not usable: ${resolved}. The ZIP must contain package-versions.json, manifest.json, or index.json.`;
}

describe('package version manifest loader', () => {
  const dirs: string[] = [];
  const locked: string[] = [];

  afterEach(async () => {
    process.env.VIBGRATE_MANIFEST_SENTINEL = '';
    for (const target of locked) {
      await chmod(target, 0o755).catch(() => {});
    }
    locked.length = 0;
    for (const dir of dirs) {
      await chmod(dir, 0o755).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vibgrate-manifest-test-'));
    dirs.push(dir);
    return dir;
  }

  function assertNoSecrets(message: string): void {
    expect(message).not.toContain(BODY_SENTINEL);
    expect(message).not.toContain(NEARBY_SENTINEL);
    expect(message).not.toContain(ENV_SENTINEL);
    expect(message).not.toContain('ENOENT');
    expect(message).not.toContain('EACCES');
  }

  it('loads JSON manifest files', async () => {
    const tmpDir = await tempDir();
    const manifestPath = path.join(tmpDir, 'package-versions.json');
    await writeFile(manifestPath, JSON.stringify({ npm: { react: { latest: '19.0.0', versions: ['18.3.1', '19.0.0'] } } }));

    const manifest = await loadPackageVersionManifest(manifestPath);
    expect(manifest.npm?.react?.latest).toBe('19.0.0');
  });

  it('loads a ZIP that contains package-versions.json', async () => {
    const tmpDir = await tempDir();
    const zipPath = path.join(tmpDir, 'package-versions.zip');
    const body = JSON.stringify({ npm: { react: { latest: '19.0.0' } } });
    execFileSync('python3', [
      '-c',
      'import sys, zipfile; zipfile.ZipFile(sys.argv[1], "w").writestr(sys.argv[2], sys.argv[3])',
      zipPath,
      'package-versions.json',
      body,
    ]);

    const manifest = await loadPackageVersionManifest(zipPath);
    expect(manifest.npm?.react?.latest).toBe('19.0.0');
  });

  it('rejects a missing path with a stable not-found error', async () => {
    const tmpDir = await tempDir();
    process.env.VIBGRATE_MANIFEST_SENTINEL = ENV_SENTINEL;
    await writeFile(path.join(tmpDir, '.env'), `TOKEN=${NEARBY_SENTINEL}\n`);
    const missing = path.join(tmpDir, 'missing-package-versions.json');

    const error = await loadPackageVersionManifest(missing).then(
      () => {
        throw new Error('expected the missing manifest to fail');
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(PackageManifestError);
    expect(error).toMatchObject({ failure: 'not_found', message: notFound(missing) });
    assertNoSecrets((error as Error).message);
  });

  it('rejects an unreadable file without echoing its contents', async () => {
    const tmpDir = await tempDir();
    process.env.VIBGRATE_MANIFEST_SENTINEL = ENV_SENTINEL;
    await writeFile(path.join(tmpDir, '.env'), `TOKEN=${NEARBY_SENTINEL}\n`);
    const manifestPath = path.join(tmpDir, 'package-versions.json');
    await writeFile(manifestPath, `{"npm":{},"note":"${BODY_SENTINEL}"}`);
    await chmod(manifestPath, 0);
    locked.push(manifestPath);

    await expect(loadPackageVersionManifest(manifestPath)).rejects.toMatchObject({
      failure: 'unreadable',
      message: notReadable(manifestPath),
    });
    try {
      await loadPackageVersionManifest(manifestPath);
    } catch (err) {
      assertNoSecrets(err instanceof Error ? err.message : String(err));
    }
  });

  it('rejects a directory path as not a file', async () => {
    const tmpDir = await tempDir();
    await expect(loadPackageVersionManifest(tmpDir)).rejects.toMatchObject({
      failure: 'unusable',
      message: `Package manifest is not a file: ${tmpDir}. Pass a JSON or ZIP package-version manifest to --package-manifest.`,
    });
  });

  it('rejects invalid content without echoing secrets', async () => {
    const tmpDir = await tempDir();
    process.env.VIBGRATE_MANIFEST_SENTINEL = ENV_SENTINEL;
    await writeFile(path.join(tmpDir, '.env'), `NOTE=${NEARBY_SENTINEL}\n`);
    const manifestPath = path.join(tmpDir, 'package-versions.json');
    await writeFile(manifestPath, `not-json ${BODY_SENTINEL}`);

    await expect(loadPackageVersionManifest(manifestPath)).rejects.toMatchObject({
      failure: 'unusable',
      message: notUsable(manifestPath),
    });
  });

  it('rejects a JSON value that is not a package-version manifest', async () => {
    const tmpDir = await tempDir();
    const manifestPath = path.join(tmpDir, 'package.json');
    await writeFile(
      manifestPath,
      JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { react: '^19.0.0' }, note: BODY_SENTINEL }),
    );

    const error = await loadPackageVersionManifest(manifestPath).catch((err: unknown) => err);
    expect(error).toMatchObject({ failure: 'unusable', message: notUsable(manifestPath) });
    assertNoSecrets((error as Error).message);
  });

  it('rejects a ZIP that does not contain a package-version manifest', async () => {
    const tmpDir = await tempDir();
    const zipPath = path.join(tmpDir, 'package-versions.zip');
    execFileSync('python3', [
      '-c',
      'import sys, zipfile; zipfile.ZipFile(sys.argv[1], "w").writestr(sys.argv[2], sys.argv[3])',
      zipPath,
      'readme.txt',
      BODY_SENTINEL,
    ]);

    const error = await loadPackageVersionManifest(zipPath).catch((err: unknown) => err);
    expect(error).toMatchObject({ failure: 'unusable', message: zipNotUsable(zipPath) });
    assertNoSecrets((error as Error).message);
  });
});
