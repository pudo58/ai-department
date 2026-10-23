import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { javaMajor, javaVersionOf, jdkToInstall, planEnvironment } from '../src/core/envplan.js';
import type { Run } from '../src/shared/types.js';
import { GitWorkspaces } from '../src/runtime/gitworkspace.js';
import { executeFile, type ProcessResult } from '../src/runtime/process.js';
import { bootstrapPython, venvPython } from '../src/runtime/pythonenv.js';
import { Toolchains } from '../src/runtime/toolchain.js';
import { RuntimeBlockedError } from '../src/runtime/types.js';

const tmp = (prefix: string) => mkdtempSync(path.join(tmpdir(), `aidept-${prefix}-`));
const ok = (stdout = '', stderr = ''): ProcessResult => ({ exitCode: 0, stdout, stderr, durationMs: 1, timedOut: false });

describe('what the project needs', () => {
  it('reads the build tools out of the commands, wrappers included', () => {
    expect(planEnvironment([['mvn', '-B', 'test']])).toMatchObject({ java: true, maven: true, gradle: false, python: false });
    expect(planEnvironment([['sh', './mvnw', 'test']])).toMatchObject({ java: true, maven: false });
    expect(planEnvironment([['gradlew.bat', 'test']])).toMatchObject({ java: true, gradle: false });
    expect(planEnvironment([['cmd.exe', 'gradle', 'test']])).toMatchObject({ gradle: true });
    expect(planEnvironment([['python', '-m', 'pytest']])).toMatchObject({ python: true, java: false });
    expect(planEnvironment([['npm', 'test'], ['node', '--test']])).toEqual({ python: false, java: false, maven: false, gradle: false });
    expect(planEnvironment([['mvn', 'test']], 17).jdkRequired).toBe(17);
  });

  it('knows Java versions and which JDK to install', () => {
    expect(javaMajor('1.8')).toBe(8);
    expect(javaMajor('21')).toBe(21);
    expect(javaMajor('17.0.2')).toBe(17);
    expect(javaMajor('banana')).toBeUndefined();
    expect(javaVersionOf('<properties><maven.compiler.source>1.8</maven.compiler.source></properties>')).toBe(8);
    expect(javaVersionOf('<java.version>21</java.version>')).toBe(21);
    expect(javaVersionOf('java { toolchain { languageVersion.set(JavaLanguageVersion.of(17)) } }')).toBe(17);
    expect(javaVersionOf("sourceCompatibility = '11'")).toBe(11);
    expect(javaVersionOf('<project/>')).toBeUndefined();
    expect([8, 9, 11, 12, 17, 18, 21, 22, 25, 30, undefined].map(jdkToInstall)).toEqual([8, 11, 11, 17, 17, 21, 21, 25, 25, 25, 21]);
  });
});

/** A fake distributor: JDK metadata with a sha256, a Maven archive with a sha512, a Gradle archive with a sha256. */
describe('installing JDK, Maven and Gradle', () => {
  let server: http.Server, base = '', requests: string[] = [];
  let archive: Buffer;
  const sha = (algo: string, data: Buffer) => createHash(algo).update(data).digest('hex');
  let tamper = false;

  beforeAll(async () => {
    // One real tar.gz with a single top-level folder, like the real distributions.
    const src = tmp('fake-dist');
    mkdirSync(path.join(src, 'dist-1.0', 'bin'), { recursive: true });
    writeFileSync(path.join(src, 'dist-1.0', 'bin', 'tool'), 'fake');
    writeFileSync(path.join(src, 'dist-1.0', 'release'), 'x');
    const out = path.join(src, 'dist.tar.gz');
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    expect(spawnSync(tar, ['-czf', out, '-C', src, 'dist-1.0']).status).toBe(0);
    archive = readFileSync(out);

    server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      const url = req.url ?? '';
      const major = /\/v3\/assets\/latest\/(\d+)\//.exec(url)?.[1];
      if (major) {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify([{ binary: { package: { link: `${base}/jdk-${major}.tar.gz`, name: `OpenJDK${major}U.tar.gz`, checksum: tamper ? 'a'.repeat(64) : sha('sha256', archive), size: archive.length } } }]));
      }
      if (url.startsWith('/jdk-') || url.endsWith('-bin.tar.gz') || url.endsWith('-bin.zip')) return res.end(archive);
      if (url.endsWith('.sha512')) return res.end(`${sha('sha512', archive)}  file`);
      if (url.endsWith('.sha256')) return res.end(sha('sha256', archive));
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.close(); });

  const make = (javac: number | undefined, extra: { platform?: NodeJS.Platform; pathVar?: string } = {}) => {
    const dataDir = tmp('tools');
    const logs: string[] = [];
    const tools = new Toolchains({
      dataDir, endpoints: { adoptium: base, maven: `${base}/maven`, gradle: `${base}/gradle` }, pathVar: extra.pathVar ?? '', platform: extra.platform,
      run: (exe, args, timeoutMs) => (path.basename(exe).startsWith('javac')
        ? Promise.resolve(javac === undefined ? { ...ok(), exitCode: 1 } : ok('', `javac ${javac}.0.1`))
        : executeFile(exe, args, { timeoutMs })),
    });
    return { tools, dataDir, logs, log: (m: string) => { logs.push(m); } };
  };

  it('installs the JDK the project asks for when the machine has none or an older one, checks the download, and reuses it', async () => {
    requests = [];
    const t = make(11);
    const homes = await t.tools.provide({ python: false, java: true, maven: false, gradle: false, jdkRequired: 17 }, t.log);
    expect(path.basename(homes.javaHome!)).toBe('jdk-17');
    expect(existsSync(path.join(homes.javaHome!, 'bin', 'tool'))).toBe(true);
    expect(t.logs.join('\n')).toMatch(/JDK trên máy là 11, project cần 17/);
    expect(t.tools.env('/ws', homes).JAVA_HOME).toBe(homes.javaHome);
    expect(readdirSync(t.tools.root).filter((n) => n.startsWith('.tmp'))).toEqual([]);

    const before = requests.length;
    await t.tools.provide({ python: false, java: true, maven: false, gradle: false, jdkRequired: 17 });
    expect(requests.length).toBe(before); // already installed: nothing is fetched again
  });

  it('leaves a machine that already has a new enough JDK alone', async () => {
    requests = [];
    const t = make(21);
    expect(await t.tools.provide({ python: false, java: true, maven: false, gradle: false, jdkRequired: 17 })).toEqual({});
    expect(requests).toEqual([]);
  });

  it('installs Maven and Gradle only when the bare command is missing from PATH', async () => {
    const t = make(21);
    const homes = await t.tools.provide({ python: false, java: true, maven: true, gradle: true }, t.log);
    expect(path.basename(homes.mavenHome!)).toBe('maven-3.9.9');
    expect(path.basename(homes.gradleHome!)).toBe('gradle-8.10.2');
    const env = t.tools.env('/ws', homes);
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path')!;
    expect(env[key]!.split(path.delimiter).slice(0, 2)).toEqual([path.join(homes.mavenHome!, 'bin'), path.join(homes.gradleHome!, 'bin')]);

    const bin = tmp('bin');
    writeFileSync(path.join(bin, process.platform === 'win32' ? 'mvn.cmd' : 'mvn'), '');
    const present = make(21, { pathVar: bin });
    expect((await present.tools.provide({ python: false, java: true, maven: true, gradle: false })).mavenHome).toBeUndefined();
  });

  it('refuses a download whose checksum does not match the published one, and installs nothing', async () => {
    tamper = true;
    try {
      const t = make(undefined);
      await expect(t.tools.provide({ python: false, java: true, maven: false, gradle: false, jdkRequired: 21 })).rejects.toThrow(/không khớp/);
      expect(existsSync(path.join(t.tools.root, 'jdk-21'))).toBe(false);
      expect(readdirSync(t.tools.root).filter((n) => n.startsWith('.tmp'))).toEqual([]);
    } finally { tamper = false; }
  });

  it('two tasks asking for the same tool at once share one download', async () => {
    requests = [];
    const t = make(undefined);
    const need = { python: false, java: true, maven: false, gradle: false, jdkRequired: 8 } as const;
    await Promise.all([t.tools.provide(need), t.tools.provide(need)]);
    expect(requests.filter((r) => r.startsWith('/jdk-8')).length).toBe(1);
  });

  it('only downloads over HTTPS (loopback excepted for tests)', async () => {
    const t = new Toolchains({ dataDir: tmp('tools'), endpoints: { adoptium: 'http://example.com', maven: 'x', gradle: 'x' }, run: () => Promise.resolve({ ...ok(), exitCode: 1 }) });
    await expect(t.provide({ python: false, java: true, maven: false, gradle: false })).rejects.toThrow(/HTTPS/);
  });
});

const python = process.platform === 'win32' ? 'python' : 'python3';
const hasPython = spawnSync(python, ['--version']).status === 0;

describe('Python virtualenv', () => {
  it('creates .venv, installs requirements and pytest, in that order, and blocks with a clear message when Python is missing', async () => {
    const ws = tmp('py');
    writeFileSync(path.join(ws, 'requirements.txt'), 'requests\n');
    writeFileSync(path.join(ws, 'pyproject.toml'), '[build-system]\nrequires = ["setuptools"]\n');
    const calls: string[] = [];
    const run = async (exe: string, args: string[]): Promise<ProcessResult> => {
      calls.push(`${path.basename(exe)} ${args.join(' ')}`.replace(ws, '<ws>'));
      if (args.includes('venv')) mkdirSync(path.dirname(venvPython(ws)), { recursive: true }), writeFileSync(venvPython(ws), '');
      // pytest is not importable in a fresh venv.
      return args[0] === '-c' ? { ...ok(), exitCode: 1 } : ok();
    };
    await bootstrapPython(ws, run, () => undefined);
    expect(calls.map((c) => c.replace(/\.exe/, ''))).toEqual([
      expect.stringMatching(/^(python|python3) --version$/),
      expect.stringMatching(/^(python|python3) -m venv <ws>.*\.venv$/),
      'python -m pip install --disable-pip-version-check --no-input -r requirements.txt',
      'python -m pip install --disable-pip-version-check --no-input -e .',
      'python -c import pytest',
      'python -m pip install --disable-pip-version-check --no-input pytest',
    ]);

    await expect(bootstrapPython(tmp('py'), () => Promise.resolve({ ...ok(), exitCode: 1 }), () => undefined)).rejects.toThrow(RuntimeBlockedError);
    // A failing requirements install stops the task with pip's message instead of running tests against a half-built environment.
    const failing = async (exe: string, args: string[]): Promise<ProcessResult> => {
      if (args.includes('venv')) mkdirSync(path.dirname(venvPython(ws)), { recursive: true }), writeFileSync(venvPython(ws), '');
      return args.includes('-r') ? { ...ok(), exitCode: 1, stderr: 'No matching distribution' } : ok();
    };
    await expect(bootstrapPython(ws, failing, () => undefined)).rejects.toThrow(/No matching distribution/);
  });

  it.skipIf(!hasPython)('puts the project virtualenv first on PATH, so a bare "python" in a check means the venv (real venv)', async () => {
    const ws = tmp('venv');
    const made = spawnSync(python, ['-m', 'venv', path.join(ws, '.venv')], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    const tools = new Toolchains({ dataDir: tmp('tools') });
    const r = await executeFile('python', ['-c', 'import sys; print(sys.prefix)'], { cwd: ws, env: tools.env(ws) });
    expect(path.resolve(r.stdout.trim()).toLowerCase()).toBe(path.resolve(ws, '.venv').toLowerCase());
  }, 60_000);
});

describe('build outputs stay out of the agent diff', () => {
  it('ignores .venv, Maven target/ and Gradle build/ in the workspace', async () => {
    const source = tmp('src');
    mkdirSync(path.join(source, 'src', 'main'), { recursive: true });
    writeFileSync(path.join(source, 'pom.xml'), '<project/>');
    writeFileSync(path.join(source, 'build.gradle'), '');
    writeFileSync(path.join(source, 'src', 'main', 'A.java'), 'class A {}');
    mkdirSync(path.join(source, '.venv'), { recursive: true });
    writeFileSync(path.join(source, '.venv', 'big.bin'), 'x');
    const ws = new GitWorkspaces(tmp('ws'));
    const run = { id: 'run_env', baseSha: null, configSnapshot: { repository: source } } as unknown as Run;
    const cloned = await ws.clone(run, 'A');
    expect(existsSync(path.join(cloned.ws, '.venv'))).toBe(false); // not copied into the snapshot at all
    for (const out of ['target/classes/A.class', 'build/libs/a.jar', '.gradle/x', '.venv/pyvenv.cfg', '__pycache__/a.pyc']) {
      mkdirSync(path.dirname(path.join(cloned.ws, out)), { recursive: true });
      writeFileSync(path.join(cloned.ws, out), 'x');
    }
    expect((await ws.changes(run, 'A')).files).toEqual([]);
    writeFileSync(path.join(cloned.ws, 'src', 'main', 'B.java'), 'class B {}');
    expect((await ws.changes(run, 'A')).files).toEqual(['src/main/B.java']);
  });
});
