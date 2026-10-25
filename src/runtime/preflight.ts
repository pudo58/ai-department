import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { Run } from '../shared/types.js';
import type { EnvironmentProbe } from '../shared/execution.js';
import { environmentHash } from '../core/environment.js';
import type { ProcessResult } from './process.js';
import { redactSecrets } from './process.js';

export { environmentHash } from '../core/environment.js';
type Execute = (command: string[], timeoutMs: number) => Promise<ProcessResult>;

type RunnerCommand = { runner: 'vitest' | 'jest'; prefix: string[]; args: string[] };
const executableName = (value: string): string => path.win32.basename(value).toLowerCase().replace(/\.(cmd|exe|bat)$/, '');

/** Resolve installed tools directly; npx/npm must never download a missing dependency during a probe. */
function installedRunner(cwd: string, runner: RunnerCommand['runner'], args: string[]): RunnerCommand {
  let entry = path.join(cwd, 'node_modules', runner, runner === 'vitest' ? 'vitest.mjs' : 'bin/jest.js');
  try {
    const pkg = createRequire(path.join(cwd, 'package.json')).resolve(`${runner}/package.json`);
    entry = path.join(path.dirname(pkg), runner === 'vitest' ? 'vitest.mjs' : 'bin/jest.js');
  } catch { /* The version probe will provide the missing dependency error. */ }
  return { runner, prefix: ['node', path.relative(cwd, entry).replace(/\\/g, '/')], args };
}

async function identifyRunner(command: readonly string[], cwd: string): Promise<RunnerCommand | undefined> {
  const executable = executableName(command[0] ?? '');
  if (executable === 'node' || executable === 'nodejs') {
    // Only the executable and the runner script are allowed before runner options.
    const script = command[1] ?? '';
    if (/(?:^|[/\\])vitest\.mjs$/i.test(script)) return { runner: 'vitest', prefix: command.slice(0, 2), args: command.slice(2) };
    if (/(?:^|[/\\])jest(?:\.js)?$/i.test(script)) return { runner: 'jest', prefix: command.slice(0, 2), args: command.slice(2) };
    return;
  }
  if (executable === 'vitest' || executable === 'jest') return installedRunner(cwd, executable, command.slice(1));
  if (executable === 'npx') {
    const index = command[1] === '--no-install' ? 2 : 1;
    const runner = command[index];
    if (runner === 'vitest' || runner === 'jest') return installedRunner(cwd, runner, command.slice(index + 1));
    return;
  }
  if (!['npm', 'pnpm', 'yarn'].includes(executable)) return;
  if (command[1] === 'exec' && executable === 'pnpm') {
    const runner = command[2];
    if (runner === 'vitest' || runner === 'jest') return installedRunner(cwd, runner, command.slice(3));
    return;
  }
  if (command[1] === 'vitest' || command[1] === 'jest') return installedRunner(cwd, command[1], command.slice(2));
  const scriptIndex = command[1] === 'run' ? 2 : 1;
  let pkg: { scripts?: Record<string, string> };
  try { pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')); } catch { return; }
  const text = pkg.scripts?.[command[scriptIndex] ?? ''];
  // Script discovery is deliberately limited to a plain runner and plain argv, with no shell operations.
  if (!text || !/^(vitest|jest)(?:\s+[A-Za-z0-9_./\\:=@-]+)*\s*$/.test(text)) return;
  const [runner, ...args] = text.trim().split(/\s+/);
  const forwarded = command.slice(scriptIndex + 1).filter(arg => arg !== '--');
  return installedRunner(cwd, runner as RunnerCommand['runner'], [...args, ...forwarded]);
}

/** Only simple, recognized runner commands are transformed; never execute a script guessed from text. */
export async function probeEnvironment(run: Run, cwd: string, runtime: string, execute: Execute, signal?: AbortSignal): Promise<EnvironmentProbe> {
  const started=Date.now(), checks:EnvironmentProbe['checks']=[];
  for(const recipe of run.configSnapshot.checks){
    if(signal?.aborted)throw new Error('Kiểm tra môi trường bị hủy.');
    const identified = await identifyRunner(recipe.command, cwd);
    if(!identified){checks.push({recipeId:recipe.id,status:'unsupported',message:'Chưa có adapter kiểm tra sớm cho lệnh này; checks thông thường vẫn chạy.'});continue;}
    const {runner,prefix,args}=identified;
    const config:string[]=[];
    for(let i=0;i<args.length;i++){
      const arg=args[i]!;
      if(/^(?:--(?:config|configLoader|root|rootDir|dir|workspace|project)|-c)(=|$)/.test(arg)){
        config.push(arg);
        if(!arg.includes('=') && args[i+1])config.push(args[++i]!);
      }
    }
    const remaining=()=>Math.max(1,60000-(Date.now()-started));
    let version:string|undefined;
    try{
      if(Date.now()-started>=60000)throw new Error('Hết giới hạn 60 giây kiểm tra môi trường.');
      const v=await execute([...prefix,'--version'],remaining());
      if(v.exitCode!==0 || v.timedOut)throw new Error(`Executable/dependency chưa chạy được: ${v.stderr||v.stdout||'timeout'}`);
      version=v.stdout.trim().slice(0,160);
      if(Date.now()-started>=60000)throw new Error('Hết giới hạn 60 giây kiểm tra môi trường.');
      const discovery=await execute([...prefix,...(runner==='vitest'?['list','--json']:['--listTests','--runInBand']),...config],remaining());
      const log=redactSecrets(`${discovery.stderr}\n${discovery.stdout}`).slice(0,4000);
      const infrastructure=/failed to load config|startup error|cannot find module.*(?:node_modules|vitest|jest)|could not resolve.*config|cannot read directory.*access is denied|validation error:[\s\S]*(?:configuration|config)|configpath.*could not/i.test(log);
      if(discovery.timedOut || infrastructure)throw new Error(log||'Discovery/config timeout.');
      checks.push({recipeId:recipe.id,runner,version,status:discovery.exitCode===0?'passed':'unsupported',message:discovery.exitCode===0?'Runner tải cấu hình và discovery thành công; chưa chứng minh test nghiệp vụ đạt.':`Runner khởi động nhưng collection/project chưa hoàn tất; chưa xác nhận môi trường đầy đủ. ${log}`});
    }catch(error){checks.push({recipeId:recipe.id,runner,version,status:'blocked',message:redactSecrets(String((error as Error).message)).slice(0,4000)});}
  }
  return {schemaVersion:1,status:checks.some(c=>c.status==='blocked')?'blocked':!checks.length || checks.some(c=>c.status==='unsupported')?'unsupported':'passed',runtime,workspace:cwd,configHash:environmentHash(run),checkpoint:run.checkpoint,startedAt:new Date(started).toISOString(),endedAt:new Date().toISOString(),checks,limitation:'Kiểm tra trên runtime chạy checks; không xác nhận quyền thực thi trong sandbox riêng của agent. Không phải bằng chứng nghiệm thu.'};
}
