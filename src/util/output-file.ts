import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { CliError, ExitCode } from './exit.js';

/**
 * Write evidence and attestation JSON/JSONL without leaking a raw Node error.
 * The message names the output file and the next step. It never includes the
 * thrown message, a stack, or file contents.
 */
export interface OutputWriteOptions {
  /** Flag the operator can change. Defaults to `--out`. */
  flag?: string;
  /** JSON.stringify indent. Omit for one-line JSON. */
  space?: number;
}

function flagOf(opts?: OutputWriteOptions): string {
  return opts?.flag ?? '--out';
}

function nextStep(flag: string): string {
  return `check the path and permissions, or choose another ${flag}`;
}

function fsCode(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function writeFailureReason(cause: unknown): string {
  switch (fsCode(cause)) {
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EROFS':
      return 'filesystem is read-only';
    case 'ENOENT':
      return 'parent directory is missing';
    case 'ENOTDIR':
    case 'EEXIST':
      return 'a parent path is not a directory';
    case 'EISDIR':
      return 'output path is a directory';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'disk full';
    default:
      return 'write failed';
  }
}

export function outputWriteError(
  filePath: string,
  cause: unknown,
  opts?: OutputWriteOptions & { kind?: 'write' | 'serialize' },
): CliError {
  const reason = opts?.kind === 'serialize' ? 'output could not be serialized' : writeFailureReason(cause);
  return new CliError(`cannot write ${filePath} (${reason}): ${nextStep(flagOf(opts))}`, ExitCode.ERROR);
}

export function rethrowOutputWrite(filePath: string, err: unknown, opts?: OutputWriteOptions): never {
  if (err instanceof CliError) throw err;
  throw outputWriteError(filePath, err, opts);
}

/** Serialize JSON for an output file. Cyclic values and BigInt become a CLI error. */
export function serializeJsonOutput(filePath: string, value: unknown, opts?: OutputWriteOptions): string {
  try {
    const text = opts?.space === undefined ? JSON.stringify(value) : JSON.stringify(value, null, opts.space);
    if (typeof text !== 'string') throw new TypeError('value cannot be serialized');
    return text;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw outputWriteError(filePath, err, { ...opts, kind: 'serialize' });
  }
}

export function writeOutputFileSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  opts?: OutputWriteOptions,
): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (typeof data === 'string') fs.writeFileSync(filePath, data, 'utf8');
    else fs.writeFileSync(filePath, data);
  } catch (err) {
    rethrowOutputWrite(filePath, err, opts);
  }
}

/** Pretty JSON plus a trailing newline, matching the evidence state files. */
export async function writeJsonOutputFile(filePath: string, value: unknown, opts?: OutputWriteOptions): Promise<void> {
  const text = serializeJsonOutput(filePath, value, { ...opts, space: opts?.space ?? 2 });
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, `${text}\n`, 'utf8');
  } catch (err) {
    rethrowOutputWrite(filePath, err, opts);
  }
}
