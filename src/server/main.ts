import path from 'node:path';
import { buildApp } from './app.js';
import { createRuntimeResolver } from './environment.js';
import { Orchestrator } from './orchestrator.js';
import { Store } from './store.js';
import { SkillLibrary } from '../runtime/skilllibrary.js';

const dataDir = path.resolve(process.env.AIDEPT_DATA_DIR ?? '.data');
const port = Number(process.env.AIDEPT_PORT ?? 4310);

const store = new Store(path.join(dataDir, 'ai-department.sqlite'));
// One library for the API and the runs, so a skill approved in the UI is what the next agent turn loads.
const skills = new SkillLibrary(dataDir, store.skills);
const orchestrator = new Orchestrator(store, createRuntimeResolver(dataDir), { skills });
await orchestrator.recover();
// Real model names for older attempts; runs in the background so startup is not delayed.
void orchestrator.backfillModels().then((n) => { if (n) console.log(`Đã bổ sung tên model cho ${n} lượt agent cũ.`); }).catch(() => undefined);

// The packaged build runs from the person's data folder and points here at the UI shipped inside the package.
const staticDir = path.resolve(process.env.AIDEPT_STATIC_DIR ?? 'dist/client');
const app = await buildApp({ store, orchestrator, dataDir, port, staticDir, skills, autoClean: process.env.AIDEPT_AUTO_CLEAN !== '0' });
// Loopback only: the API can edit repositories and spend money.
await app.listen({ host: '127.0.0.1', port });
console.log(`AI Department API: http://127.0.0.1:${port}`);

const shutdown = async () => {
  await app.close();
  await orchestrator.idle().catch(() => undefined);
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
