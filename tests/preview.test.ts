import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { guessPreviewCommand, PreviewManager } from '../src/server/preview.js';

const dir = (files: Record<string, string>) => {
  const d = mkdtempSync(path.join(tmpdir(), 'aidept-preview-'));
  for (const [f, body] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), body); }
  return d;
};
const SERVER = "import { createServer } from 'node:http';\ncreateServer((q, s) => s.end('hello from app')).listen(Number(process.env.PORT), '127.0.0.1');\n";
const manager = new PreviewManager();
afterEach(() => manager.stopAll());

describe('guessing how to run a project', () => {
  it('prefers a dev script, then start, then a server file, then static HTML', async () => {
    expect(await guessPreviewCommand(dir({ 'package.json': JSON.stringify({ scripts: { dev: 'node dev-server.js', start: 'node x' } }) }))).toEqual(['npm', 'run', 'dev']);
    expect(await guessPreviewCommand(dir({ 'package.json': JSON.stringify({ scripts: { start: 'node x' } }) }))).toEqual(['npm', 'start']);
    expect(await guessPreviewCommand(dir({ 'server.mjs': SERVER }))).toEqual(['node', 'server.mjs']);
    const html = await guessPreviewCommand(dir({ 'index.html': '<h1>x</h1>' }));
    expect(html?.[0]).toBe('node');
    expect(html?.[1]).toMatch(/static-server\.mjs$/);
    expect(await guessPreviewCommand(dir({ 'notes.txt': 'x' }))).toBeUndefined();
  });
});

describe('an app that picks its own port', () => {
  const flags = ['--', '--port', '{PORT}', '--host', '127.0.0.1', '--strictPort'];
  const guess = (scripts: Record<string, string>) => guessPreviewCommand(dir({ 'package.json': JSON.stringify({ scripts }) }));

  it('is told the port when it is a Vite app, because Vite ignores PORT', async () => {
    expect(await guess({ dev: 'vite' })).toEqual(['npm', 'run', 'dev', ...flags]);
    expect(await guess({ dev: 'cross-env MODE=test vite --host' })).toEqual(['npm', 'run', 'dev', ...flags]);
    expect(await guess({ start: 'vite preview' })).toEqual(['npm', 'start', ...flags]);
  });

  it('is left alone when it is not Vite or the script already fixes a port', async () => {
    expect(await guess({ dev: 'vite --port 3000' })).toEqual(['npm', 'run', 'dev']);
    expect(await guess({ dev: 'node vite-notes.js' })).toEqual(['npm', 'run', 'dev']);
    expect(await guess({ dev: 'next dev' })).toEqual(['npm', 'run', 'dev']);
  });

  it('is started on the preview port by a real Vite, which is what "Chạy thử" does for such a project', async () => {
    const d = dir({ 'package.json': JSON.stringify({ name: 'so-chi-tieu', private: true, scripts: { dev: 'vite' } }), 'index.html': '<!doctype html><title>Sổ chi tiêu</title><h1>Sổ chi tiêu</h1>' });
    symlinkSync(path.resolve('node_modules'), path.join(d, 'node_modules'), 'junction');
    const command = (await guessPreviewCommand(d))!;
    const state = await manager.start('run_vite', d, command);
    expect(state.command.join(' ')).not.toContain('{PORT}');
    expect(state.command).toContain(String(state.port));
    expect(await (await fetch(state.url)).text()).toContain('Sổ chi tiêu');
  }, 90_000);
});

describe('running a preview', () => {
  it('puts the chosen port wherever a command asks for {PORT}', async () => {
    const d = dir({});
    const state = await manager.start('run_token', d, ['node', '-e', "require('node:http').createServer((q, s) => s.end('port from the argument')).listen(Number(process.argv[1]), '127.0.0.1')", '{PORT}']);
    expect(state.command.at(-1)).toBe(String(state.port));
    expect(await (await fetch(state.url)).text()).toBe('port from the argument');
  }, 30_000);

  it('starts the app on a free loopback port, reports the URL, and stops it', async () => {
    const d = dir({ 'server.mjs': SERVER });
    const state = await manager.start('run_a', d, ['node', 'server.mjs']);
    expect(state.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(state.url)).text()).toBe('hello from app');
    expect(manager.get('run_a')?.url).toBe(state.url);
    expect(manager.stop('run_a')).toBe(true);
    expect(manager.get('run_a')).toBeUndefined();
    // taskkill on Windows is asynchronous and slower under load: wait until the port stops answering, up to 5 s.
    let down = false;
    for (let i = 0; i < 25 && !down; i++) { await new Promise((r) => setTimeout(r, 200)); down = await fetch(state.url).then(() => false, () => true); }
    expect(down).toBe(true);
  }, 30_000);

  it('reports the app output when it exits immediately', async () => {
    const d = dir({ 'bad.mjs': "console.error('boom: missing config'); process.exit(3);" });
    await expect(manager.start('run_b', d, ['node', 'bad.mjs'])).rejects.toThrow(/mã 3[\s\S]*boom: missing config/);
    expect(manager.get('run_b')).toBeUndefined();
  }, 30_000);

  it('serves a plain HTML folder without exposing dotfiles or anything outside it', async () => {
    const d = dir({ 'index.html': '<h1>Sổ chi tiêu</h1>', 'app.js': 'x', '.env': 'TOKEN=1' });
    const cmd = (await guessPreviewCommand(d))!;
    const { url } = await manager.start('run_c', d, cmd);
    expect(await (await fetch(url)).text()).toContain('Sổ chi tiêu');
    expect((await fetch(`${url}/app.js`)).headers.get('content-type')).toMatch(/javascript/);
    expect((await fetch(`${url}/.env`)).status).toBe(403);
    expect((await fetch(`${url}/..%2f..%2fwindows%2fwin.ini`)).status).not.toBe(200);
  }, 30_000);
});
