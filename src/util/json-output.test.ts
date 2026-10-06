import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError, ExitCode } from './exit.js';
import {
  OUT_WRITE_NEXT,
  outputWriteError,
  writeJsonOutputSync,
} from './json-output.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz';
const DSN = 'vibgrate+https://kid:supersecretvalue@example.test/ws';

const roots: string[] = [];

function tempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-json-output-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('json output errors', () => {
  it('names a directory output path and a next step', () => {
    const root = tempDir();
    const file = path.join(root, 'org.json');
    fs.mkdirSync(file);
    let caught: unknown;
    try {
      writeJsonOutputSync(file, { ok: true }, { next: OUT_WRITE_NEXT });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught).toMatchObject({ code: ExitCode.ERROR });
    expect((caught as Error).message).toBe(
      `could not write ${file} (the path is a directory). ${OUT_WRITE_NEXT}`,
    );
    expect((caught as Error).message).not.toMatch(/\n/);
    expect((caught as Error).message).not.toContain('EISDIR');
  });

  it('names a parent that is not a directory', () => {
    const root = tempDir();
    const blocked = path.join(root, 'blocked');
    fs.writeFileSync(blocked, 'not a directory');
    const file = path.join(blocked, 'export', 'org.json');
    expect(() => writeJsonOutputSync(file, { ok: true }, { next: OUT_WRITE_NEXT })).toThrow(
      `could not write ${file} (a parent path is not a directory). ${OUT_WRITE_NEXT}`,
    );
  });

  it('reports a cycle without echoing values, and the message is stable', () => {
    const root = tempDir();
    const file = path.join(root, 'result.json');
    const cycle: Record<string, unknown> = { token: TOKEN, dsn: DSN };
    cycle.self = cycle;
    const first = (() => {
      try {
        writeJsonOutputSync(file, cycle, { next: OUT_WRITE_NEXT });
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    const second = (() => {
      try {
        writeJsonOutputSync(file, cycle, { next: OUT_WRITE_NEXT });
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    const message = `could not serialize ${file} (the value contains a cycle). Check the data being written. ${OUT_WRITE_NEXT}`;
    expect(first).toBeInstanceOf(CliError);
    expect(second).toBeInstanceOf(CliError);
    expect((first as Error).message).toBe(message);
    expect((second as Error).message).toBe(message);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain('supersecretvalue');
    expect(message).not.toContain(DSN);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('drops a Node error message that carries a DSN', () => {
    const err = Object.assign(new Error(`ENOSPC while writing ${DSN} token ${TOKEN}`), { code: 'ENOSPC' });
    const cli = outputWriteError(`/tmp/${TOKEN}/out.json`, err, 'write', OUT_WRITE_NEXT);
    expect(cli).toMatchObject({
      code: ExitCode.ERROR,
      message: `could not write /tmp/[REDACTED]/out.json (no space left on the device). ${OUT_WRITE_NEXT}`,
    });
    expect(cli.message).not.toContain(TOKEN);
    expect(cli.message).not.toContain('supersecretvalue');
    expect(cli.message).not.toContain('ENOSPC');
  });

  it('writes pretty JSON with a trailing newline, identically twice', () => {
    const root = tempDir();
    const data = { b: 1, a: [2, 3] };
    const expected = `${JSON.stringify(data, null, 2)}\n`;
    const first = path.join(root, 'a', 'out.json');
    const second = path.join(root, 'b', 'out.json');
    writeJsonOutputSync(first, data, { next: OUT_WRITE_NEXT });
    writeJsonOutputSync(second, data, { next: OUT_WRITE_NEXT });
    expect(fs.readFileSync(first, 'utf8')).toBe(expected);
    expect(fs.readFileSync(second, 'utf8')).toBe(expected);
  });
});
