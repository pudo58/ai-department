import { executeFile } from '../../runtime/process.js';

export interface SignatureResult {
  valid: boolean;
  subject?: string;
  reason?: string;
  /** A failed check is not evidence of an invalid signature. Installation remains blocked in either case. */
  unavailable?: boolean;
}

export interface ExecutableSignature extends SignatureResult { version?: string }

/** Inspect, never execute, the file. The injected process runner keeps failure paths testable without downloading an installer. */
export async function inspectAuthenticode(file: string, run: typeof executeFile = executeFile): Promise<ExecutableSignature> {
  if (file.includes('\0')) throw new Error('NUL in signature path');
  const script = [
    "$ErrorActionPreference='Stop'",
    // Node can inherit PS7's module paths and pass them to Windows PowerShell 5.1. Only use this shell's built-in modules.
    "$env:PSModulePath=Join-Path $PSHOME 'Modules'",
    '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)',
    `$file='${file.replace(/'/g, "''")}'`,
    '$s=Get-AuthenticodeSignature -LiteralPath $file -ErrorAction Stop',
    '$v=(Get-Item -LiteralPath $file -ErrorAction Stop).VersionInfo.ProductVersion',
    '[pscustomobject]@{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject;message=$s.StatusMessage;version=$v}|ConvertTo-Json -Compress',
  ].join('; ');
  const unavailable = (reason: string): ExecutableSignature => ({ valid: false, unavailable: true, reason });
  let result: Awaited<ReturnType<typeof executeFile>>;
  try {
    result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 30_000 });
  } catch (error) {
    return unavailable(`Không khởi chạy được PowerShell: ${(error as Error).message.slice(0, 400)}`);
  }
  if (result.timedOut) return unavailable('PowerShell kiểm tra chữ ký quá thời gian 30 giây.');
  if (result.exitCode !== 0 || result.stderr.trim()) {
    return unavailable(`PowerShell không kiểm tra được chữ ký (mã ${result.exitCode ?? 'không rõ'}): ${result.stderr.trim().slice(0, 600) || 'không có chẩn đoán'}`);
  }
  let data: unknown;
  try { data = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()); }
  catch { return unavailable('PowerShell không trả về kết quả chữ ký JSON hợp lệ.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return unavailable('PowerShell trả về kết quả chữ ký không đầy đủ.');
  const info = data as Record<string, unknown>;
  // Do not interpret an absent/unknown status as NotSigned or allow an unrecognized value to authorize execution.
  const statuses = ['Valid', 'UnknownError', 'NotSigned', 'HashMismatch', 'NotTrusted', 'NotSupportedFileFormat', 'Incompatible'];
  if (typeof info.status !== 'string' || !statuses.includes(info.status)) return unavailable('PowerShell không trả về trạng thái chữ ký được nhận diện.');
  const subject = typeof info.subject === 'string' ? info.subject.trim() : undefined;
  const version = typeof info.version === 'string' && info.version.trim() ? info.version.trim() : undefined;
  if (info.status === 'Valid' && !subject) return unavailable('Windows báo Valid nhưng không trả về chứng thư người ký.');
  return {
    valid: info.status === 'Valid', ...(subject ? { subject } : {}), ...(version ? { version } : {}),
    ...(info.status === 'Valid' ? {} : { reason: `Trạng thái chữ ký: ${info.status}${typeof info.message === 'string' && info.message.trim() ? ` (${info.message.trim().slice(0, 300)})` : ''}` }),
  };
}
