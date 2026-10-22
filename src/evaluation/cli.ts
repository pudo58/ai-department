import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createAssignments, manifestHash, matchesRegistration, register, validateM0a, validateM0b } from './manifest.js';
import { evaluateGroup, pilotVerdict } from './m0a.js';
import { analyzeM0b } from './m0b.js';
import { requiredTasks } from './stats.js';
import { REVIEW_VARIANTS, type EvaluationManifest, type M0aManifest, type M0bManifest, type Registration, type ReviewRecord, type TaskRecord } from './types.js';

const read = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const registrationFile = (manifestFile: string) => manifestFile.replace(/\.json$/, '') + '.registration.json';
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const fail = (message: string): never => { console.error(message); process.exit(1); };

function loadLocked(file: string): { manifest: EvaluationManifest; hash: string } {
  const manifest = read<EvaluationManifest>(file);
  const regFile = registrationFile(file);
  if (!existsSync(regFile)) return fail('Manifest chưa được đăng ký. Chạy "register" trước khi thu thập kết quả.');
  if (!matchesRegistration(manifest, read<Registration>(regFile))) return fail('Manifest đã bị sửa sau khi đăng ký; báo cáo bị từ chối. Tạo manifest mới nếu giao thức thật sự đổi.');
  return { manifest, hash: manifestHash(manifest) };
}

function flag(args: string[], name: string, fallback?: number): number {
  const i = args.indexOf(`--${name}`);
  const value = i >= 0 ? Number(args[i + 1]) : fallback;
  if (value === undefined || Number.isNaN(value)) return fail(`Thiếu hoặc sai --${name}`);
  return value;
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'validate': {
    const manifest = read<EvaluationManifest>(args[0] ?? fail('Cần đường dẫn manifest.'));
    const problems = manifest.kind === 'm0a' ? validateM0a(manifest) : validateM0b(manifest);
    if (manifest.provenance === 'synthetic') problems.push('Cảnh báo: dữ liệu synthetic chỉ dùng để thử bộ đo, không phải bằng chứng về hiệu quả.');
    out({ kind: manifest.kind, valid: problems.filter((p) => !p.startsWith('Cảnh báo')).length === 0, problems });
    break;
  }
  case 'register': {
    const file = args[0] ?? fail('Cần đường dẫn manifest.');
    const manifest = read<EvaluationManifest>(file);
    const problems = manifest.kind === 'm0a' ? validateM0a(manifest) : validateM0b(manifest);
    if (problems.length) fail(`Không đăng ký manifest không hợp lệ:\n- ${problems.join('\n- ')}`);
    if (existsSync(registrationFile(file))) fail('Manifest đã đăng ký; giao thức bị khóa.');
    const registration = register(manifest);
    writeFileSync(registrationFile(file), JSON.stringify(registration, null, 2));
    out(registration);
    break;
  }
  case 'assign': {
    const file = args[0] ?? fail('Cần M0b manifest chưa có assignment.');
    const manifest = read<M0bManifest>(file);
    manifest.assignments = createAssignments(manifest.tasks, manifest.arms, manifest.repetitions, manifest.seed);
    writeFileSync(file, JSON.stringify(manifest, null, 2));
    out({ assignments: manifest.assignments.length, firstFive: manifest.assignments.slice(0, 5).map((a) => a.id) });
    break;
  }
  case 'report-m0a': {
    const { manifest, hash } = loadLocked(args[0] ?? fail('Cần manifest.'));
    if (manifest.kind !== 'm0a') fail('Manifest không phải M0a.');
    const records = read<ReviewRecord[]>(args[1] ?? fail('Cần file bản ghi.'));
    if (records.some((r) => r.manifestHash !== hash)) fail('Có bản ghi thuộc manifest khác.');
    const groups = [...REVIEW_VARIANTS, 'all' as const].map((variant) => { const report = evaluateGroup(manifest as M0aManifest, records, variant); return { report, pilot: pilotVerdict(report) }; });
    out(groups);
    break;
  }
  case 'report-m0b': {
    const { manifest, hash } = loadLocked(args[0] ?? fail('Cần manifest.'));
    if (manifest.kind !== 'm0b') fail('Manifest không phải M0b.');
    const records = read<TaskRecord[]>(args[1] ?? fail('Cần file bản ghi.'));
    if (records.some((r) => r.manifestHash !== hash)) fail('Có bản ghi thuộc manifest khác.');
    out(analyzeM0b(manifest as M0bManifest, records));
    break;
  }
  case 'sample-size': {
    out(requiredTasks({ delta: flag(args, 'delta', 0.15), discordant: flag(args, 'discordant', 0.4), repetitions: flag(args, 'reps', 2), rho: flag(args, 'rho', 0.5) }));
    break;
  }
  default:
    console.log('Dùng: npm run eval -- <validate|register|assign|report-m0a|report-m0b|sample-size> [...]');
    process.exit(command ? 1 : 0);
}
