import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

export interface EcosystemVersionEntry {
  latest?: string;
  versions?: string[];
}

export interface PackageVersionManifest {
  npm?: Record<string, EcosystemVersionEntry>;
  nuget?: Record<string, EcosystemVersionEntry>;
  pypi?: Record<string, EcosystemVersionEntry>;
  maven?: Record<string, EcosystemVersionEntry>;
  rubygems?: Record<string, EcosystemVersionEntry>;
  swift?: Record<string, EcosystemVersionEntry>;
  go?: Record<string, EcosystemVersionEntry>;
  cargo?: Record<string, EcosystemVersionEntry>;
  composer?: Record<string, EcosystemVersionEntry>;
  pub?: Record<string, EcosystemVersionEntry>;
  hex?: Record<string, EcosystemVersionEntry>;
  docker?: Record<string, EcosystemVersionEntry>;
  helm?: Record<string, EcosystemVersionEntry>;
  terraform?: Record<string, EcosystemVersionEntry>;
}

/** Why a `--package-manifest` path cannot be used. Stable for tests and exit handling. */
export type PackageManifestFailure = 'not_found' | 'unreadable' | 'unusable';

/**
 * Fail-closed error for a missing, unreadable, or unusable package-version
 * manifest. The message names the path and what to pass instead. It never
 * includes file contents, nearby files, or the environment.
 */
export class PackageManifestError extends Error {
  readonly failure: PackageManifestFailure;

  constructor(message: string, failure: PackageManifestFailure) {
    super(message);
    this.name = 'PackageManifestError';
    this.failure = failure;
  }
}

/** Top-level keys a package-version manifest may carry. `runtimes` is optional catalog data. */
const MANIFEST_KEYS = new Set([
  'runtimes',
  'npm',
  'nuget',
  'pypi',
  'maven',
  'rubygems',
  'swift',
  'go',
  'cargo',
  'composer',
  'pub',
  'hex',
  'docker',
  'helm',
  'terraform',
]);

function errnoCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function notFound(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest not found: ${resolved}. Pass a readable JSON or ZIP package-version manifest to --package-manifest.`,
    'not_found',
  );
}

function notReadable(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest is not readable: ${resolved}. Check permissions and pass a readable JSON or ZIP package-version manifest to --package-manifest.`,
    'unreadable',
  );
}

function notAFile(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest is not a file: ${resolved}. Pass a JSON or ZIP package-version manifest to --package-manifest.`,
    'unusable',
  );
}

function notUsable(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest is not usable: ${resolved}. Expected a JSON object of package versions, or a ZIP containing package-versions.json, manifest.json, or index.json.`,
    'unusable',
  );
}

function zipNotUsable(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest is not usable: ${resolved}. The ZIP must contain package-versions.json, manifest.json, or index.json.`,
    'unusable',
  );
}

function unzipMissing(resolved: string): PackageManifestError {
  return new PackageManifestError(
    `Package manifest is not readable: ${resolved}. Reading a ZIP manifest needs the unzip command. Pass a JSON package-version manifest to --package-manifest, or install unzip.`,
    'unreadable',
  );
}

function ioFailure(err: unknown, resolved: string): PackageManifestError {
  const code = errnoCode(err);
  if (code === 'ENOENT' || code === 'ENOTDIR') return notFound(resolved);
  return notReadable(resolved);
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // windowsHide: also runs from console-less hosts (vgd background
    // rebuilds) — never flash a console window on Windows.
    // stdout/stderr are discarded. A failing unzip must not echo archive
    // bytes or tool output into the error the user sees.
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(Object.assign(new Error(`${cmd} failed`), { code: 'EUNZIP' }));
        return;
      }
      resolve();
    });
  });
}

function parseManifestObject(text: string, source: string): PackageVersionManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw notUsable(source);
  }
  if (!isPlainObject(value)) throw notUsable(source);

  const keys = Object.keys(value);
  const known = keys.filter((key) => MANIFEST_KEYS.has(key));
  if (keys.length > 0 && known.length === 0) throw notUsable(source);

  for (const key of known) {
    const entry = value[key];
    if (entry == null) continue;
    if (!isPlainObject(entry)) throw notUsable(source);
  }
  return value as PackageVersionManifest;
}

async function loadManifestFromZip(zipPath: string): Promise<PackageVersionManifest> {
  let tmpDir: string;
  try {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibgrate-manifest-'));
  } catch {
    throw notReadable(zipPath);
  }
  try {
    try {
      await runCommand('unzip', ['-qq', zipPath, '-d', tmpDir]);
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') throw unzipMissing(zipPath);
      throw zipNotUsable(zipPath);
    }

    const candidates = [
      path.join(tmpDir, 'package-versions.json'),
      path.join(tmpDir, 'manifest.json'),
      path.join(tmpDir, 'index.json'),
    ];
    for (const candidate of candidates) {
      try {
        const text = await readFile(candidate, 'utf8');
        return parseManifestObject(text, zipPath);
      } catch {
        // Missing or unusable candidate — try the next well-known name.
      }
    }
    throw zipNotUsable(zipPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function loadResolved(resolved: string): Promise<PackageVersionManifest> {
  let info: { isFile(): boolean };
  try {
    info = await stat(resolved);
  } catch (err) {
    throw ioFailure(err, resolved);
  }
  if (!info.isFile()) throw notAFile(resolved);
  if (resolved.toLowerCase().endsWith('.zip')) return loadManifestFromZip(resolved);

  let text: string;
  try {
    text = await readFile(resolved, 'utf8');
  } catch (err) {
    throw ioFailure(err, resolved);
  }
  return parseManifestObject(text, resolved);
}

export async function loadPackageVersionManifest(filePath: string): Promise<PackageVersionManifest> {
  const resolved = path.resolve(filePath);
  try {
    return await loadResolved(resolved);
  } catch (err) {
    if (err instanceof PackageManifestError) throw err;
    throw notReadable(resolved);
  }
}

export function getManifestEntry(
  manifest: PackageVersionManifest | undefined,
  ecosystem: keyof PackageVersionManifest,
  packageName: string,
): EcosystemVersionEntry | undefined {
  if (!manifest) return undefined;
  const table = manifest[ecosystem];
  if (!table) return undefined;
  if (ecosystem === 'nuget') {
    return table[packageName.toLowerCase()] ?? table[packageName];
  }
  return table[packageName];
}
