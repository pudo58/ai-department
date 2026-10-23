import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractRequirementIds, parseTestReport } from '../src/core/checks.js';
import { detectStack } from '../src/core/stackdetect.js';
import { isTestPath } from '../src/core/testpath.js';
import { resolveHostCommand } from '../src/runtime/hostcommand.js';
import { clearReport, readReport } from '../src/runtime/report.js';
import { green, setup } from './helpers.js';

const repo = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidept-multi-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
};

// What Maven Surefire and Gradle write: one <testsuite> file per test class.
const suite = (cls: string, cases: { name: string; fail?: boolean; skip?: boolean }[]) => `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${cls}" tests="${cases.length}" failures="${cases.filter((c) => c.fail).length}">
${cases.map((c) => `  <testcase name="${c.name}" classname="${cls}" time="0.01">${c.fail ? '<failure message="expected 2 but was 3" type="AssertionFailedError">trace</failure>' : c.skip ? '<skipped/>' : ''}</testcase>`).join('\n')}
</testsuite>`;

describe('multi-file reports (Maven and Gradle write one XML per test class)', () => {
  it('merges every TEST-*.xml in a folder into one report the core parser understands', async () => {
    const dir = repo({
      'target/surefire-reports/TEST-com.shop.OrderTest.xml': suite('com.shop.OrderTest', [{ name: '[R-1] rejects a duplicate order' }, { name: 'R_2_keeps_the_total', fail: true }]),
      'target/surefire-reports/TEST-com.shop.CartTest.xml': suite('com.shop.CartTest', [{ name: 'empty cart', skip: true }]),
      'target/surefire-reports/com.shop.OrderTest.txt': 'not xml',
    });
    const parsed = parseTestReport(await readReport(dir, 'target/surefire-reports'));
    expect(parsed.valid).toBe(true);
    expect(parsed.tests.map((t) => t.status).sort()).toEqual(['failed', 'passed', 'skipped']);
    expect(parsed.failures?.[0]).toMatch(/R_2_keeps_the_total.*expected 2 but was 3/);
    // The identifier-safe spelling counts as the requirement tag.
    expect(extractRequirementIds('com.shop.OrderTest::R_2_keeps_the_total')).toEqual(['R-2']);
    expect(extractRequirementIds('com.shop.OrderTest::[R-1] rejects a duplicate order')).toEqual(['R-1']);
  });

  it('is "no report" when the folder is missing or holds no test suites, never zero failures', async () => {
    expect(await readReport(repo({ 'x.txt': '' }), 'target/surefire-reports')).toBeUndefined();
    expect(await readReport(repo({ 'target/surefire-reports/TEST-a.xml': '<note/>', 'target/surefire-reports/TEST-b.xml': '<note/>' }), 'target/surefire-reports')).toBeUndefined();
  });

  it('finds the reports of every module with a wildcard path, and still reads a single JSON or XML file', async () => {
    const dir = repo({
      'api/target/surefire-reports/TEST-A.xml': suite('A', [{ name: 'a' }]),
      'core/target/surefire-reports/TEST-B.xml': suite('B', [{ name: 'b' }]),
      'node_modules/x/target/surefire-reports/TEST-C.xml': suite('C', [{ name: 'c' }]),
      'one.json': JSON.stringify({ testResults: [] }),
      'one.xml': suite('S', [{ name: 'only' }]),
    });
    const parsed = parseTestReport(await readReport(dir, '**/target/surefire-reports'));
    expect(parsed.tests.map((t) => t.id).sort()).toEqual(['A::a', 'B::b']);
    expect(await readReport(dir, 'one.json')).toEqual({ testResults: [] });
    expect(typeof await readReport(dir, 'one.xml')).toBe('string');
  });

  it('clears old report files before a run but never deletes a folder', async () => {
    const dir = repo({ 'build/test-results/test/TEST-old.xml': suite('Old', [{ name: 'x' }]), 'build/test-results/test/keep.bin': 'x', 'src/Main.java': 'class Main {}' });
    await clearReport(dir, 'build/test-results/test');
    expect(existsSync(path.join(dir, 'build/test-results/test/TEST-old.xml'))).toBe(false);
    expect(existsSync(path.join(dir, 'build/test-results/test/keep.bin'))).toBe(true);
    await clearReport(dir, 'src');
    expect(existsSync(path.join(dir, 'src/Main.java'))).toBe(true);
  });
});

describe('Windows build tools', () => {
  it('runs mvn, mvnw and gradlew through cmd.exe, but only with arguments cmd cannot misread', () => {
    const win = { platform: 'win32' as const, nodeExec: 'C:\\node\\node.exe', exists: () => true };
    expect(resolveHostCommand(['mvn', '-B', 'test'], win)).toEqual(['cmd.exe', '/d', '/s', '/c', 'mvn', '-B', 'test']);
    expect(resolveHostCommand(['mvnw.cmd', '-B', '-Dtest=OrderTest#R_1*', 'test'], win)[4]).toBe('mvnw.cmd');
    expect(resolveHostCommand(['gradlew.bat', '--console=plain', 'cleanTest', 'test'], win).slice(0, 4)).toEqual(['cmd.exe', '/d', '/s', '/c']);
    for (const evil of ['test & calc', 'a|b', '%PATH%', '"x"', 'a^b']) expect(() => resolveHostCommand(['mvn', evil], win)).toThrow(/cmd\.exe/);
    // Elsewhere nothing changes: the tool is run directly.
    expect(resolveHostCommand(['mvn', 'test'], { ...win, platform: 'linux' })).toEqual(['mvn', 'test']);
  });
});

describe('test paths', () => {
  it('knows test files of the common stacks and does not mistake ordinary names for tests', () => {
    for (const p of ['src/test/java/com/x/OrderTest.java', 'service/OrderServiceIT.java', 'src/test/kotlin/A.kt', 'tests/test_orders.py', 'pkg/orders_test.go', 'src/a.test.ts', 'tests/a.cjs']) expect(isTestPath(p), p).toBe(true);
    for (const p of ['src/main/java/com/x/Digit.java', 'src/main/java/Order.java', 'src/orders.py', 'cmd/main.go', 'README.md']) expect(isTestPath(p), p).toBe(false);
  });
});

describe('detector: Java, Python, Go and Rust', () => {
  const POM = `<project><properties><java.version>21</java.version></properties><dependencies>
    <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    <dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>`;

  it('Maven: a build check first, then the tests with the Surefire folder as the report, and guidance that names the tag convention', async () => {
    const d = await detectStack(repo({ 'pom.xml': POM, 'mvnw': '', 'mvnw.cmd': '', 'src/test/java/com/x/OrderTest.java': 'class OrderTest {}' }));
    expect(d.packageManager).toBe('maven');
    expect(d.languages).toContain('Java 21');
    expect(d.frameworks).toContain('Spring Boot');
    expect(d.testRunner).toBe('JUnit 5');
    expect(d.checks.map((c) => c.id)).toEqual(['build', 'test']);
    const [build, test] = d.checks;
    expect(['mvnw.cmd', 'sh']).toContain(build!.command[0]);
    expect(build!.command).toEqual(expect.arrayContaining(['-B', '-q', 'test-compile']));
    expect(build!.reportPath).toBeUndefined();
    expect(test!.reportPath).toBe('target/surefire-reports');
    expect(test!.command.at(-1)).toBe('test');
    expect(d.guidance).toMatch(/R_1/);
    expect(d.guidance).toMatch(/pom\.xml/);
    expect(d.notes.join(' ')).not.toMatch(/Chưa thấy test/);
  });

  it('Maven without a wrapper uses mvn and says Maven must be installed; multi-module wildcards the report', async () => {
    const d = await detectStack(repo({ 'pom.xml': '<project><modules><module>api</module></modules></project>' }));
    expect(d.checks.find((c) => c.id === 'test')).toMatchObject({ command: ['mvn', '-B', 'test'], reportPath: '**/target/surefire-reports' });
    expect(d.notes.join(' ')).toMatch(/cài Maven/);
    expect(d.notes.join(' ')).toMatch(/chưa thấy test/);
  });

  it('Gradle (Kotlin DSL): classes first, cleanTest so a fresh report exists, no daemon left behind', async () => {
    const d = await detectStack(repo({
      'build.gradle.kts': 'plugins { kotlin("jvm") version "2.0.0" }\njava { toolchain { languageVersion.set(JavaLanguageVersion.of(17)) } }\ntasks.test { useJUnitPlatform() }',
      'settings.gradle.kts': 'rootProject.name = "demo"', 'src/test/kotlin/AppTest.kt': '',
    }));
    expect(d.packageManager).toBe('gradle');
    expect(d.languages[0]).toBe('Kotlin 17');
    expect(d.testRunner).toBe('JUnit 5');
    const test = d.checks.find((c) => c.id === 'test')!;
    expect(test.command).toEqual(expect.arrayContaining(['--no-daemon', 'cleanTest', 'test']));
    expect(test.reportPath).toBe('build/test-results/test');
    expect(d.checks[0]!.id).toBe('build');
  });

  it('Python: pytest with a JUnit report; Go and Rust: build and test by exit code, with the limit stated', async () => {
    const py = await detectStack(repo({ 'pyproject.toml': '[project]\ndependencies=["fastapi"]\n[tool.pytest.ini_options]', 'tests/test_orders.py': '' }));
    expect(py.packageManager).toBe('pip');
    expect(py.frameworks).toContain('FastAPI');
    const pyTest = py.checks.find((c) => c.id === 'test')!;
    expect(pyTest.command.slice(1)).toEqual(['-m', 'pytest', '-v', '--junitxml=.aidept-report.xml']);
    expect(pyTest.reportPath).toBe('.aidept-report.xml');
    expect(py.notes.join(' ')).toMatch(/pytest cài sẵn/);

    const go = await detectStack(repo({ 'go.mod': 'module x\n\ngo 1.22\nrequire github.com/gin-gonic/gin v1.9.0' }));
    expect(go.checks.map((c) => c.command.slice(0, 2).join(' '))).toEqual(['go build', 'go test']);
    expect(go.checks.every((c) => !c.reportPath)).toBe(true);
    expect(go.notes.join(' ')).toMatch(/exit code/);
    expect(go.frameworks).toContain('Gin');

    const rust = await detectStack(repo({ 'Cargo.toml': '[package]\nedition = "2021"\n[dependencies]\ntokio = "1"' }));
    expect(rust.checks.map((c) => c.id)).toEqual(['build', 'test']);
    expect(rust.languages).toContain('Rust (edition 2021)');
  });

  it('points at the sub-folder when the manifest is not at the root, and keeps ids unique in a mixed repo', async () => {
    const nested = await detectStack(repo({ 'backend/pom.xml': '<project/>', 'README.md': '' }));
    expect(nested.checks).toEqual([]);
    expect(nested.notes.join(' ')).toMatch(/backend\/ \(pom\.xml\)/);

    const mixed = await detectStack(repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' }, devDependencies: { vitest: '3' } }), 'pom.xml': POM }));
    const ids = mixed.checks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['test', 'maven-test']));
    expect(mixed.packageManager).toBe('npm');
  });
});

describe('a broken build is a failure the Developer can fix, not a missing report', () => {
  const buildFails = { exitCode: 1, incomplete: false, log: '[ERROR] /src/main/java/A.java:[3,9] cannot find symbol' };

  it('skips the test check after a failed build, keeps the run repairable and shows the compiler output', async () => {
    const checks = [
      { id: 'build', command: ['mvn', '-B', '-q', 'test-compile'], required: true, timeoutMs: 60_000 },
      { id: 'test', command: ['mvn', '-B', 'test'], required: true, timeoutMs: 60_000, reportPath: 'target/surefire-reports' },
    ];
    const prompts: string[] = [];
    const { orchestrator, create, drive, runtime, store } = setup({ check: (e, call) => (e.recipe.id === 'build' ? (call <= 4 ? buildFails : green) : green), reply: (e) => { if (e.role === 'developer') prompts.push(e.prompt); return undefined; } }, { checks });
    const run = await drive(create());
    const detail = orchestrator.detail(run.id);
    // Build failed on the first candidate (and its retry), so no test check ran then; the repair round compiled and tested.
    expect(runtime.calls.filter((c) => c.startsWith('check:test'))).toHaveLength(1);
    expect(detail.attempts.filter((a) => a.stage === 'repair').length).toBeGreaterThan(0);
    expect(store.logs.list({ runId: run.id }).some((l) => /Bỏ qua check "test"/.test(l.message))).toBe(true);
    // The compiler output reaches the Developer's repair prompt.
    expect(prompts.slice(1).some((p) => /cannot find symbol/.test(p))).toBe(true);
  });
});
