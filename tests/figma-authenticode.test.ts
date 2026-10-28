import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { inspectAuthenticode } from '../src/server/figma/authenticode.js';
import { executeFile, type ProcessResult } from '../src/runtime/process.js';

const ok = (over: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Figma, Inc.', version: '126.9.16' }),
  stderr: '', durationMs: 1, timedOut: false, ...over,
});
const runner = (result: ProcessResult): typeof executeFile => async () => result;

describe('Figma Authenticode process boundary', () => {
  it('accepts a complete Valid result and preserves its signer and version', async () => {
    expect(await inspectAuthenticode('C:\\Figma.exe', runner(ok()))).toEqual({ valid: true, subject: 'CN=Figma, Inc.', version: '126.9.16' });
  });

  it('isolates Windows PowerShell modules and treats a quoted path as a literal', async () => {
    let command = '', args: string[] = [];
    const fake: typeof executeFile = async (exe, argv) => { command = exe; args = argv; return ok(); };
    await inspectAuthenticode("C:\\O'Brien [test]; $file\\Figma.exe", fake);
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-NoProfile');
    expect(args).toContain('-NonInteractive');
    const script = args.at(-1)!;
    expect(script).toContain("$env:PSModulePath=Join-Path $PSHOME 'Modules'");
    expect(script).toContain("$ErrorActionPreference='Stop'");
    expect(script).toContain("$file='C:\\O''Brien [test]; $file\\Figma.exe'");
    expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $file -ErrorAction Stop');
    expect(script).toContain('ConvertTo-Json -Compress');
  });

  it.each(['NotSigned', 'HashMismatch', 'NotTrusted', 'UnknownError', 'NotSupportedFileFormat', 'Incompatible'])(
    'blocks the Windows signature status %s without accepting it as Valid', async (status) => {
      const result = await inspectAuthenticode('C:\\Figma.exe', runner(ok({ stdout: JSON.stringify({ status, message: 'Signature check failed' }) })));
      expect(result.valid).toBe(false);
      expect(result.unavailable).not.toBe(true);
      expect(result.reason).toContain(status);
    },
  );

  it.each([
    { stdout: '' }, { stdout: '|' }, { stdout: 'warning\n{"status":"Valid"}' }, { stdout: 'null' },
    { stdout: '[]' }, { stdout: '{}' }, { stdout: '{"status":0}' }, { stdout: '{"status":"valid"}' },
    { stdout: '{"status":"Valid"}' }, { stdout: '{"status":"Valid","subject":" "}' },
    { stdout: '{"status":"A_NEW_STATUS"}' },
  ])('reports an unavailable check instead of accusing the file when output is %j', async (over) => {
    expect(await inspectAuthenticode('C:\\Figma.exe', runner(ok(over)))).toMatchObject({ valid: false, unavailable: true });
  });

  it.each([
    { timedOut: true }, { exitCode: 1, stderr: 'CouldNotAutoloadMatchingModule' }, { exitCode: null },
    // Windows PowerShell may return zero even after a non-terminating error. Never trust accompanying output.
    { exitCode: 0, stderr: 'Security module could not be loaded' },
  ])('never trusts apparently Valid stdout after process failure: %j', async (over) => {
    const result = await inspectAuthenticode('C:\\Figma.exe', runner(ok(over)));
    expect(result).toMatchObject({ valid: false, unavailable: true });
    expect(result.reason).toBeTruthy();
  });

  it('reports process spawn failures without authorizing installation', async () => {
    const fake: typeof executeFile = async () => { throw new Error('spawn powershell.exe ENOENT'); };
    expect(await inspectAuthenticode('C:\\Figma.exe', fake)).toMatchObject({ valid: false, unavailable: true, reason: expect.stringContaining('ENOENT') });
  });

  it('handles UTF-8 BOM and preserves a Unicode signer', async () => {
    const result = await inspectAuthenticode('C:\\Figma.exe', runner(ok({ stdout: '\uFEFF' + JSON.stringify({ status: 'Valid', subject: 'CN=Figma, Inc. – Công ty', version: null }) })));
    expect(result).toEqual({ valid: true, subject: 'CN=Figma, Inc. – Công ty' });
  });

  it('rejects NUL before starting PowerShell', async () => {
    let called = false;
    const fake: typeof executeFile = async () => { called = true; return ok(); };
    await expect(inspectAuthenticode('C:\\bad\0.exe', fake)).rejects.toThrow('NUL');
    expect(called).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('reads a real Windows signature despite inherited PS7 module paths', async () => {
    const file = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const polluted: typeof executeFile = (exe, args, options) => executeFile(exe, args, {
      ...options, env: { PSModulePath: path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'Modules') },
    });
    const result = await inspectAuthenticode(file, polluted);
    expect(result, JSON.stringify(result)).toMatchObject({ valid: true, subject: expect.stringContaining('Microsoft') });
  });
});
