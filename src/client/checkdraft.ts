import type { Recipe, SuggestedCheck } from '../shared/types';
import { formatCommandLine, parseCommandLine } from './argv';

/** Editable form of a Recipe: the command as a command line people can type, timeout in seconds. */
export interface CheckDraft { key: string; id: string; command: string; required: boolean; reportPath: string; timeoutSec: number }

export interface CheckPreset { id: string; label: string; command: string[]; reportPath: string; hint: string }
/** Ready-made checks. Those without a report path decide pass/fail by exit code only and give no requirement evidence. */
export const CHECK_PRESETS: CheckPreset[] = [
  { id: 'test', label: 'Vitest', command: ['npm', 'test', '--', '--run', '--reporter=json', '--outputFile=.aidept-report.json'], reportPath: '.aidept-report.json', hint: 'Test có report: tạo bằng chứng cho yêu cầu.' },
  { id: 'test', label: 'Jest', command: ['npx', 'jest', '--json', '--outputFile=.aidept-report.json'], reportPath: '.aidept-report.json', hint: 'Test có report: tạo bằng chứng cho yêu cầu.' },
  { id: 'test', label: 'node --test (không cần cài gì)', command: ['node', '--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=junit', '--test-reporter-destination=.aidept-report.xml', '**/*.test.{js,cjs,mjs,ts}'], reportPath: '.aidept-report.xml', hint: 'Test có report JUnit.' },
  { id: 'build', label: 'Maven: biên dịch', command: ['mvn', '-B', '-q', '-DskipTests', 'test-compile'], reportPath: '', hint: 'Chạy trước test: lỗi biên dịch thành lỗi sửa được. Cần Maven và JDK.' },
  { id: 'test', label: 'Maven: test (JUnit)', command: ['mvn', '-B', 'test'], reportPath: 'target/surefire-reports', hint: 'Đọc report JUnit của Surefire cho từng yêu cầu. Nhiều module: **/target/surefire-reports.' },
  { id: 'build', label: 'Gradle: biên dịch', command: ['gradle', '--console=plain', '--no-daemon', '-q', 'classes', 'testClasses'], reportPath: '', hint: 'Có gradlew thì đổi "gradle" thành gradlew.bat (Windows) hoặc sh ./gradlew.' },
  { id: 'test', label: 'Gradle: test (JUnit)', command: ['gradle', '--console=plain', '--no-daemon', 'cleanTest', 'test'], reportPath: 'build/test-results/test', hint: 'Đọc report JUnit của Gradle cho từng yêu cầu.' },
  { id: 'test', label: 'pytest', command: ['python', '-m', 'pytest', '-v', '--junitxml=.aidept-report.xml'], reportPath: '.aidept-report.xml', hint: 'Cần Python và pytest cài sẵn. Đặt tên test chứa R_1 để gắn yêu cầu.' },
  { id: 'build', label: 'go build', command: ['go', 'build', './...'], reportPath: '', hint: 'Chỉ exit code; không là bằng chứng cho yêu cầu.' },
  { id: 'test', label: 'go test', command: ['go', 'test', './...'], reportPath: '', hint: 'Chỉ exit code; không là bằng chứng cho yêu cầu.' },
  { id: 'build', label: 'cargo build', command: ['cargo', 'build', '--all-targets'], reportPath: '', hint: 'Chỉ exit code; không là bằng chứng cho yêu cầu.' },
  { id: 'test', label: 'cargo test', command: ['cargo', 'test'], reportPath: '', hint: 'Chỉ exit code; không là bằng chứng cho yêu cầu.' },
  { id: 'typecheck', label: 'tsc --noEmit', command: ['npx', 'tsc', '--noEmit'], reportPath: '', hint: 'Chỉ exit code; không là bằng chứng cho yêu cầu.' },
  { id: 'lint', label: 'ESLint', command: ['npx', 'eslint', '.'], reportPath: '', hint: 'Chỉ exit code; không là bằng chứng cho yêu cầu.' },
  { id: 'build', label: 'npm run build', command: ['npm', 'run', 'build'], reportPath: '', hint: 'Chỉ exit code; không là bằng chứng cho yêu cầu.' },
];

let counter = 0;
const nextKey = () => `chk-${Date.now().toString(36)}-${++counter}`;

export const uniqueCheckId = (base: string, taken: readonly string[]): string => {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
};

export const toDrafts = (recipes: readonly Recipe[]): CheckDraft[] => recipes.map((r) => ({
  key: nextKey(), id: r.id, command: formatCommandLine(r.command), required: r.required, reportPath: r.reportPath ?? '', timeoutSec: Math.round(r.timeoutMs / 1000),
}));

export const newDraft = (source: { id: string; command: readonly string[]; reportPath?: string; required?: boolean; timeoutMs?: number }, existing: readonly CheckDraft[]): CheckDraft => ({
  key: nextKey(), id: uniqueCheckId(source.id, existing.map((d) => d.id)), command: formatCommandLine(source.command), required: source.required ?? true,
  reportPath: source.reportPath ?? '', timeoutSec: Math.round((source.timeoutMs ?? 600_000) / 1000),
});

export const draftFromSuggestion = (s: SuggestedCheck, existing: readonly CheckDraft[]): CheckDraft => newDraft(s, existing);

/** The draft's command as argv, or null while it does not parse (an unclosed quote, broken JSON). */
export function draftArgv(d: Pick<CheckDraft, 'command'>): string[] | null {
  try { return parseCommandLine(d.command); } catch { return null; }
}

/** Does a draft already run this exact command? Compares argv, so spacing and quoting do not matter. */
export const sameCommand = (d: Pick<CheckDraft, 'command'>, argv: readonly string[]) => JSON.stringify(draftArgv(d)) === JSON.stringify(argv);

/**
 * A suggested check applied to the form. One that writes a report takes the place of the check of the same name that does not (a "test"
 * with only an exit code can never be evidence for a requirement), instead of being added beside it under another name and running the
 * tests twice. A check that is already there is left alone.
 */
export function applySuggestion(drafts: readonly CheckDraft[], s: SuggestedCheck): CheckDraft[] {
  if (drafts.some((d) => sameCommand(d, s.command))) return [...drafts];
  const at = s.reportPath ? drafts.findIndex((d) => d.id === s.id && !d.reportPath.trim()) : -1;
  if (at < 0) return [...drafts, draftFromSuggestion(s, drafts)];
  const next = [...drafts];
  next[at] = { ...newDraft(s, drafts.filter((_, i) => i !== at)), key: drafts[at]!.key };
  return next;
}

/** Validates the drafts and converts them to recipes for the API. Throws a message a person can act on. */
export function toRecipes(drafts: readonly CheckDraft[]): Recipe[] {
  if (!drafts.length) throw new Error('Cần ít nhất một check.');
  const seen = new Set<string>();
  return drafts.map((d, index) => {
    const label = `Check ${index + 1}${d.id ? ` (${d.id})` : ''}`;
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(d.id)) throw new Error(`${label}: id chỉ gồm chữ, số, "-" hoặc "_" (tối đa 40 ký tự).`);
    if (seen.has(d.id)) throw new Error(`${label}: id bị trùng.`);
    seen.add(d.id);
    let argv: string[];
    try { argv = parseCommandLine(d.command); } catch (e) { throw new Error(`${label}: ${(e as Error).message}`); }
    if (!argv.length || !argv.every((x) => x)) throw new Error(`${label}: lệnh không rỗng, ví dụ npx tsc --noEmit.`);
    if (!Number.isFinite(d.timeoutSec) || d.timeoutSec < 1 || d.timeoutSec > 3600) throw new Error(`${label}: timeout từ 1 đến 3600 giây.`);
    const reportPath = d.reportPath.trim();
    return { id: d.id, command: argv, required: d.required, timeoutMs: Math.round(d.timeoutSec * 1000), ...(reportPath ? { reportPath } : {}) };
  });
}
