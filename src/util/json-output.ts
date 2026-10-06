/**
 * Turn a failed JSON or text write into a {@link CliError} the CLI prints as
 * `error: …` and exits 1. The message names the output path, a stable reason,
 * and a next step. It does not include the thrown Node message, a stack, or
 * secret material (keys, tokens, DSNs).
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { redactForDisplay } from '../core-open/utils/redact.js';
import { CliError, ExitCode } from './exit.js';

/** Next step when the destination was chosen with `--out`. */
export const OUT_WRITE_NEXT = 'Check the path and permissions, or pass a different --out.';

/** Next step when the destination was chosen with `--bundle`. */
export const BUNDLE_WRITE_NEXT = 'Check the path and permissions, or pass a different --bundle.';

/** Next step when the destination was chosen with `--attestation`. */
export const ATTESTATION_WRITE_NEXT =
  'Check the path and permissions, or pass a different --attestation.';

/** Next step for evidence state under `.vibgrate/evidence/`. */
export const EVIDENCE_STATE_WRITE_NEXT = 'Check that .vibgrate/evidence is writable.';

/** Next step when the signing key file cannot be written. */
export const SIGNING_KEY_WRITE_NEXT = 'Check the path and permissions for the signing key.';

const DEFAULT_NEXT = 'Check the path and permissions, or choose another output path.';

export interface OutputWriteOptions {
  /** Sentence telling the operator what to try next. */
  next?: string;
  /** Path printed in the error. Defaults to the filesystem path being written. */
  displayPath?: string;
}

export function outputWriteError(
  filePath: string,
  err: unknown,
  kind: 'write' | 'serialize',
  next: string = DEFAULT_NEXT,
): CliError {
  if (err instanceof CliError) return err;
  const reason = kind === 'serialize' ? serializeReason(err) : writeReason(err);
  const verb = kind === 'serialize' ? 'serialize' : 'write';
  const step = kind === 'serialize' ? `Check the data being written. ${next}` : next;
  const message = redactForDisplay(`could not ${verb} ${filePath} (${reason}). ${step}`);
  return new CliError(message, ExitCode.ERROR);
}

function writeReason(err: unknown): string {
  switch (nodeCode(err)) {
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EISDIR':
      return 'the path is a directory';
    case 'ENOSPC':
      return 'no space left on the device';
    case 'ENOENT':
      return 'a parent directory is missing';
    case 'EROFS':
      return 'the filesystem is read-only';
    case 'ENAMETOOLONG':
      return 'the path is too long';
    case 'ENOTDIR':
      return 'a parent path is not a directory';
    case 'EEXIST':
      return 'a parent path exists and is not a directory';
    default: {
      const code = nodeCode(err);
      return code && /^[A-Z][A-Z0-9_]*$/.test(code)
        ? `the file could not be written (${code})`
        : 'the file could not be written';
    }
  }
}

/** Classify a JSON.stringify failure without copying its message (it can echo values). */
function serializeReason(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  if (/circular|cyclic/i.test(message)) return 'the value contains a cycle';
  if (/bigint/i.test(message)) return 'the value contains a BigInt';
  return 'the value is not valid JSON';
}

function nodeCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function stringifyForOutput(
  value: unknown,
  displayPath: string,
  opts: { space?: number; next?: string } = {},
): string {
  try {
    const body = opts.space === undefined ? JSON.stringify(value) : JSON.stringify(value, null, opts.space);
    if (typeof body !== 'string') throw new TypeError('value is not valid JSON');
    return body;
  } catch (err) {
    throw outputWriteError(displayPath, err, 'serialize', opts.next);
  }
}

export function ensureOutputDir(dir: string, opts: OutputWriteOptions & { displayPath: string }): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw outputWriteError(opts.displayPath, err, 'write', opts.next);
  }
}

export async function ensureOutputDirAsync(
  dir: string,
  opts: OutputWriteOptions & { displayPath: string },
): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    throw outputWriteError(opts.displayPath, err, 'write', opts.next);
  }
}

export function writeOutputTextSync(
  filePath: string,
  contents: string | Buffer,
  opts: OutputWriteOptions & { mode?: number } = {},
): void {
  const shown = opts.displayPath ?? filePath;
  try {
    if (opts.mode === undefined) fs.writeFileSync(filePath, contents);
    else fs.writeFileSync(filePath, contents, { mode: opts.mode });
  } catch (err) {
    throw outputWriteError(shown, err, 'write', opts.next);
  }
}

export function writeJsonOutputSync(
  filePath: string,
  value: unknown,
  opts: OutputWriteOptions & { space?: number } = {},
): void {
  const shown = opts.displayPath ?? filePath;
  const text = stringifyForOutput(value, shown, { space: opts.space ?? 2, next: opts.next });
  ensureOutputDir(path.dirname(filePath), { displayPath: shown, next: opts.next });
  writeOutputTextSync(filePath, `${text}\n`, { displayPath: shown, next: opts.next });
}

export async function writeJsonOutput(
  filePath: string,
  value: unknown,
  opts: OutputWriteOptions & { space?: number } = {},
): Promise<void> {
  const shown = opts.displayPath ?? filePath;
  const text = stringifyForOutput(value, shown, { space: opts.space ?? 2, next: opts.next });
  await ensureOutputDirAsync(path.dirname(filePath), { displayPath: shown, next: opts.next });
  try {
    await fsp.writeFile(filePath, `${text}\n`, 'utf8');
  } catch (err) {
    throw outputWriteError(shown, err, 'write', opts.next);
  }
}
