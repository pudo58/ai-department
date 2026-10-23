import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { StackDetection, SuggestedCheck } from '../shared/types.js';

/**
 * Detection for the stacks other than Node: Java/Kotlin (Maven, Gradle), Python (pytest), Go and Rust.
 * Like the Node detector it only reads a few manifest files and never runs anything. Every suggestion is a plain
 * check recipe: a build check first (so a compile error is a fixable failure, not a missing report), then the tests.
 */

export type BuildTool = NonNullable<StackDetection['packageManager']>;
export interface OtherStack {
  languages: string[]; frameworks: string[]; testRunner: string | null; buildTool: BuildTool;
  checks: SuggestedCheck[]; notes: string[];
  /** Stack-specific guidance lines (naming of tests, what not to touch); the shared conventions are added by the caller. */
  guidance: string[];
}
export interface DetectContext {
  files: ReadonlySet<string>;
  read: (rel: string) => Promise<string | undefined>;
  root: string;
  platform?: NodeJS.Platform;
}

const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', '.gradle', '.idea', '.venv', 'venv', '__pycache__', '.data', 'out', 'vendor']);

/** Files (posix paths) whose name matches, bounded in depth and count. */
async function findFiles(root: string, match: (rel: string) => boolean, maxDepth = 12, maxSeen = 8000): Promise<string[]> {
  const found: string[] = [];
  let seen = 0;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth || seen > maxSeen) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > maxSeen) return;
      if (e.isSymbolicLink()) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP.has(e.name)) await walk(path.join(dir, e.name), next, depth + 1); }
      else if (match(next)) found.push(next);
    }
  };
  await walk(root, '', 0);
  return found;
}

const has = (text: string, ...needles: string[]) => needles.some((n) => text.includes(n));
const major = (v: string) => (v.startsWith('1.') ? v.slice(2) : v).split('.')[0]!;
const REQ_HINT = 'Đặt tên test bắt đầu bằng R_<số yêu cầu> (ví dụ R_1_tu_choi_chuoi_rong) hoặc gắn thẻ [R-1] vào tên hiển thị, để mỗi yêu cầu có bằng chứng.';

// --- Java / Kotlin ---------------------------------------------------------------------------------------------

function jvmLibraries(text: string): { frameworks: string[]; testRunner: string | null } {
  const frameworks: string[] = [];
  if (has(text, 'spring-boot', 'org.springframework.boot')) frameworks.push('Spring Boot');
  else if (has(text, 'org.springframework')) frameworks.push('Spring');
  if (has(text, 'quarkus')) frameworks.push('Quarkus');
  if (has(text, 'micronaut')) frameworks.push('Micronaut');
  if (has(text, 'lombok')) frameworks.push('Lombok');
  if (has(text, 'mockito')) frameworks.push('Mockito');
  if (has(text, 'assertj')) frameworks.push('AssertJ');
  const testRunner = has(text, 'junit-jupiter', 'junit-bom', 'useJUnitPlatform', 'org.junit.jupiter') ? 'JUnit 5'
    : has(text, 'testng') ? 'TestNG'
      : /<artifactId>\s*junit\s*<\/artifactId>|['"]junit:junit|junit:junit:/.test(text) ? 'JUnit 4' : null;
  return { frameworks, testRunner };
}

const wrapperOrTool = (ctx: DetectContext, wrapper: 'mvnw' | 'gradlew', tool: 'mvn' | 'gradle'): string[] => {
  if (!ctx.files.has(wrapper)) return [tool];
  // Windows runs the .cmd wrapper; elsewhere `sh` runs it even when the file lost its executable bit.
  return (ctx.platform ?? process.platform) === 'win32' ? [`${wrapper}.cmd`] : ['sh', `./${wrapper}`];
};

async function detectMaven(ctx: DetectContext): Promise<OtherStack | null> {
  const pom = await ctx.read('pom.xml');
  if (pom === undefined) return null;
  const kotlin = has(pom, 'kotlin-maven-plugin');
  const version = /<(?:maven\.compiler\.release|maven\.compiler\.source|java\.version|release)>\s*([\d.]+)\s*</.exec(pom)?.[1];
  const multi = /<modules>[\s\S]*?<module>/.test(pom);
  const { frameworks, testRunner } = jvmLibraries(pom);
  const mvn = wrapperOrTool(ctx, 'mvnw', 'mvn');
  const wrapped = ctx.files.has('mvnw');
  const testFiles = await findFiles(ctx.root, (f) => /(^|\/)src\/test\/.+\.(java|kt)$/.test(f));
  const notes: string[] = [];
  if (!testFiles.length) notes.push('Maven: chưa thấy test nào trong src/test. Check test sẽ chưa có report cho đến khi có test.');
  if (!wrapped) notes.push('Maven: repo không có mvnw nên dùng "mvn" trên máy; cần cài Maven và JDK đúng phiên bản.');
  const checks: SuggestedCheck[] = [
    { id: 'build', label: 'Maven compile', command: [...mvn, '-B', '-q', '-DskipTests', 'test-compile'], required: true, timeoutMs: 900_000, recommended: true, reason: 'pom.xml: biên dịch cả code lẫn test trước, để lỗi biên dịch thành một lỗi sửa được thay vì thiếu report.' },
    { id: 'test', label: 'Maven test', command: [...mvn, '-B', 'test'], reportPath: multi ? '**/target/surefire-reports' : 'target/surefire-reports', required: true, timeoutMs: 900_000, recommended: true, reason: `pom.xml${multi ? ' (nhiều module)' : ''}: chạy test, đọc report JUnit XML của Surefire cho từng yêu cầu.` },
  ];
  return {
    languages: [kotlin ? 'Kotlin' : 'Java', ...(kotlin ? ['Java'] : [])].map((l, i) => (i === 0 && version ? `${l} ${major(version)}` : l)),
    frameworks, testRunner, buildTool: 'maven', checks, notes,
    guidance: [
      `Build bằng Maven${wrapped ? ' (dùng mvnw)' : ''}${multi ? ', nhiều module' : ''}. Không sửa pom.xml, không thêm hay nâng cấp dependency.`,
      `Test (${testRunner ?? 'JUnit'}) nằm trong src/test; viết test mới theo cách các test hiện có đang làm. ${REQ_HINT}`,
    ],
  };
}

async function detectGradle(ctx: DetectContext): Promise<OtherStack | null> {
  const names = ['build.gradle.kts', 'build.gradle', 'settings.gradle.kts', 'settings.gradle'].filter((n) => ctx.files.has(n));
  if (!names.length) return null;
  const texts = await Promise.all(names.map((n) => ctx.read(n)));
  const text = texts.filter((t): t is string => t !== undefined).join('\n');
  const kotlin = has(text, 'org.jetbrains.kotlin', 'kotlin("jvm")', "kotlin('jvm')");
  const version = /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(text)?.[1] ?? /(?:sourceCompatibility|jvmTarget)\s*=?\s*(?:JavaVersion\.VERSION_)?['"]?([\d._]+)/.exec(text)?.[1]?.replace('_', '.');
  const multi = /^\s*include\b/m.test(text);
  const { frameworks, testRunner } = jvmLibraries(text);
  const gradle = [...wrapperOrTool(ctx, 'gradlew', 'gradle'), '--console=plain', '--no-daemon'];
  const wrapped = ctx.files.has('gradlew');
  const testFiles = await findFiles(ctx.root, (f) => /(^|\/)src\/test\/.+\.(java|kt|groovy)$/.test(f));
  const notes: string[] = [];
  if (!testFiles.length) notes.push('Gradle: chưa thấy test nào trong src/test. Check test sẽ chưa có report cho đến khi có test.');
  if (!wrapped) notes.push('Gradle: repo không có gradlew nên dùng "gradle" trên máy; cần cài Gradle và JDK đúng phiên bản.');
  const checks: SuggestedCheck[] = [
    { id: 'build', label: 'Gradle compile', command: [...gradle, '-q', 'classes', 'testClasses'], required: true, timeoutMs: 900_000, recommended: true, reason: 'Gradle: biên dịch code và test trước, để lỗi biên dịch thành một lỗi sửa được thay vì thiếu report. --no-daemon để không để tiến trình Gradle chạy ngầm giữ file.' },
    // cleanTest: Gradle skips an up-to-date test task and would leave no fresh report behind.
    { id: 'test', label: 'Gradle test', command: [...gradle, 'cleanTest', 'test'], reportPath: multi ? '**/build/test-results/test' : 'build/test-results/test', required: true, timeoutMs: 900_000, recommended: true, reason: `Gradle${multi ? ' (nhiều project)' : ''}: chạy test, đọc report JUnit XML cho từng yêu cầu.` },
  ];
  return {
    languages: [kotlin ? 'Kotlin' : 'Java', ...(kotlin ? ['Java'] : [])].map((l, i) => (i === 0 && version ? `${l} ${major(version)}` : l)),
    frameworks, testRunner, buildTool: 'gradle', checks, notes,
    guidance: [
      `Build bằng Gradle${wrapped ? ' (dùng gradlew)' : ''}${multi ? ', nhiều project' : ''}. Không sửa build.gradle/settings.gradle, không thêm hay nâng cấp dependency.`,
      `Test (${testRunner ?? 'JUnit'}) nằm trong src/test; viết test mới theo cách các test hiện có đang làm. ${REQ_HINT}`,
    ],
  };
}

// --- Python ----------------------------------------------------------------------------------------------------

async function detectPython(ctx: DetectContext): Promise<OtherStack | null> {
  const manifests = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'].filter((n) => ctx.files.has(n));
  if (!manifests.length) return null;
  const texts = (await Promise.all(manifests.filter((n) => n !== 'setup.py').map((n) => ctx.read(n)))).filter((t): t is string => t !== undefined).join('\n').toLowerCase();
  const pytest = ctx.files.has('pytest.ini') || ctx.files.has('conftest.py') || has(texts, 'pytest');
  const testFiles = await findFiles(ctx.root, (f) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f));
  const frameworks = [['Django', 'django'], ['Flask', 'flask'], ['FastAPI', 'fastapi'], ['Pydantic', 'pydantic'], ['SQLAlchemy', 'sqlalchemy']].filter(([, k]) => texts.includes(k!)).map(([l]) => l!);
  const py = (ctx.platform ?? process.platform) === 'win32' ? 'python' : 'python3';
  const notes = ['Python: cần Python và pytest cài sẵn trên máy (pip install pytest); hệ thống không tự tạo virtualenv hay cài thư viện.'];
  const checks: SuggestedCheck[] = [];
  if (pytest || testFiles.length) {
    checks.push({ id: 'test', label: 'pytest', command: [py, '-m', 'pytest', '-v', '--junitxml=.aidept-report.xml'], reportPath: '.aidept-report.xml', required: true, timeoutMs: 600_000, recommended: true, reason: `${pytest ? 'Có cấu hình pytest' : `Có ${testFiles.length} file test_*.py`}: chạy pytest, đọc report JUnit XML cho từng yêu cầu.` });
  } else notes.push('Python: chưa thấy test nào (test_*.py). Không có test thì yêu cầu không thể được xác minh.');
  return {
    languages: ['Python'], frameworks, testRunner: pytest ? 'pytest' : null, buildTool: 'pip', checks, notes,
    guidance: [
      `Test chạy bằng pytest (${testFiles.length ? 'file test_*.py' : 'chưa có test'}). Không thêm dependency, không sửa pyproject.toml/requirements.`,
      `Viết test mới theo cách các test hiện có đang làm. ${REQ_HINT}`,
    ],
  };
}

// --- Go and Rust: exit code only -------------------------------------------------------------------------------

const NO_REPORT = 'Check không có report: chỉ exit code quyết định pass/fail và không là bằng chứng cho yêu cầu; yêu cầu sẽ cần xác minh thủ công.';

async function detectGo(ctx: DetectContext): Promise<OtherStack | null> {
  const mod = await ctx.read('go.mod');
  if (mod === undefined) return null;
  const version = /^go\s+([\d.]+)/m.exec(mod)?.[1];
  const frameworks = [['Gin', 'gin-gonic/gin'], ['Echo', 'labstack/echo'], ['Fiber', 'gofiber/fiber'], ['Chi', 'go-chi/chi'], ['Testify', 'stretchr/testify']].filter(([, k]) => mod.includes(k!)).map(([l]) => l!);
  return {
    languages: [version ? `Go ${version}` : 'Go'], frameworks, testRunner: 'go test', buildTool: 'go',
    notes: ['Go: "go test" không ghi report JUnit, nên check chỉ dựa trên exit code (không có bằng chứng theo yêu cầu [R-x]).'],
    checks: [
      { id: 'build', label: 'go build', command: ['go', 'build', './...'], required: true, timeoutMs: 600_000, recommended: true, reason: 'go.mod: biên dịch toàn bộ package trước. Không có report: chỉ exit code.' },
      { id: 'test', label: 'go test', command: ['go', 'test', './...'], required: true, timeoutMs: 600_000, recommended: true, reason: `go.mod: chạy mọi test. ${NO_REPORT}` },
    ],
    guidance: ['Test chạy bằng "go test ./..." (file *_test.go cạnh code). Không sửa go.mod/go.sum, không thêm dependency. Theo cách đặt tên và table-driven test hiện có.'],
  };
}

async function detectRust(ctx: DetectContext): Promise<OtherStack | null> {
  const cargo = await ctx.read('Cargo.toml');
  if (cargo === undefined) return null;
  const edition = /^edition\s*=\s*"(\d+)"/m.exec(cargo)?.[1];
  const frameworks = [['Tokio', 'tokio'], ['Axum', 'axum'], ['Actix', 'actix-web'], ['Serde', 'serde'], ['Rocket', 'rocket']].filter(([, k]) => cargo.includes(k!)).map(([l]) => l!);
  return {
    languages: [edition ? `Rust (edition ${edition})` : 'Rust'], frameworks, testRunner: 'cargo test', buildTool: 'cargo',
    notes: ['Rust: "cargo test" không ghi report JUnit, nên check chỉ dựa trên exit code (không có bằng chứng theo yêu cầu [R-x]).'],
    checks: [
      { id: 'build', label: 'cargo build', command: ['cargo', 'build', '--all-targets'], required: true, timeoutMs: 1_200_000, recommended: true, reason: 'Cargo.toml: biên dịch code và test trước. Không có report: chỉ exit code.' },
      { id: 'test', label: 'cargo test', command: ['cargo', 'test'], required: true, timeoutMs: 1_200_000, recommended: true, reason: `Cargo.toml: chạy mọi test. ${NO_REPORT}` },
    ],
    guidance: ['Test chạy bằng "cargo test" (mod tests trong file hoặc thư mục tests/). Không sửa Cargo.toml/Cargo.lock, không thêm crate mới. Theo cách đặt tên và xử lý lỗi hiện có.'],
  };
}

/** Every non-Node ecosystem found in the folder, in a fixed order. A repository can hold several (a Java API next to a Go tool). */
export async function detectOtherStacks(ctx: DetectContext): Promise<OtherStack[]> {
  const found: OtherStack[] = [];
  // Maven wins over Gradle when both exist: its pom is the one people actually build with.
  const jvm = (await detectMaven(ctx)) ?? (await detectGradle(ctx));
  for (const result of [jvm, await detectPython(ctx), await detectGo(ctx), await detectRust(ctx)]) if (result) found.push(result);
  return found;
}

/** Folders one level down that hold a manifest: the usual reason nothing was found at the root. */
export async function nestedProjects(root: string): Promise<string[]> {
  const manifests = ['package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml'];
  const out: string[] = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || SKIP.has(e.name) || e.name.startsWith('.')) continue;
    let inside: string[];
    try { inside = await readdir(path.join(root, e.name)); } catch { continue; }
    const hit = manifests.find((m) => inside.includes(m));
    if (hit) out.push(`${e.name}/ (${hit})`);
  }
  return out.slice(0, 8);
}
