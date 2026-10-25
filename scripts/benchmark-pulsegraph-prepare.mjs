import { mkdir, writeFile, symlink, lstat, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root=path.resolve('.'), out=path.join(root,'test-results/2026-10-25-pulsegraph'), data=path.join(root,'.data/pulsegraph-20261025'), base=path.join(data,'base');
if(await lstat(path.join(out,'protocol.json')).catch(()=>null))throw new Error('Frozen PulseGraph protocol already exists; do not overwrite it.');
await mkdir(path.join(out),{recursive:true});await mkdir(path.join(base,'src'),{recursive:true});await mkdir(path.join(base,'tests'),{recursive:true});
const spec=`# PulseGraph — deterministic dependency scheduler

Implement \`src/scheduler.js\` as an in-memory deterministic job scheduler. Export \`createScheduler({now=0,retryBase=2,maxAttempts=3}={})\` and \`restoreScheduler(snapshot)\`. Methods are synchronous or async; callers may always await them. Inputs/results are plain JSON.

The scheduler exposes \`submit({id,dependsOn=[],priority=0})\`, \`get(id)\`, \`claim({worker,leaseFor})\`, \`renew({id,worker,token,leaseFor})\`, \`complete({id,worker,token,result})\`, \`fail({id,worker,token,error})\`, \`cancel(id)\`, \`advance(time)\`, and \`snapshot()\`.

1. IDs and worker names are nonempty strings. A new job ID is unique forever. \`dependsOn\` contains unique IDs of jobs that already exist; self/unknown/duplicate dependencies are invalid. Because dependencies must pre-exist, accepted jobs form a DAG. Priority is a safe integer; larger values run first. \`retryBase\` and \`maxAttempts\` are positive safe integers. Logical time starts at nonnegative safe integer \`now\`.
2. A job is \`waiting\` while one or more dependencies are unfinished; it is \`ready\` when all dependencies are \`done\`. A dependency ending \`dead\`, \`cancelled\` or \`blocked\` makes the job \`blocked\`; blocking propagates transitively. A queued retry is \`ready\` but cannot be claimed before \`availableAt\`. Terminal states are \`done\`, \`dead\`, \`cancelled\`, and \`blocked\`.
   Every job view contains \`id,dependsOn,priority,sequence,status,attempt,availableAt\`; \`blockedBy\` appears only on blocked jobs, \`worker,token,leaseUntil\` only on leased jobs, and \`result\`/\`lastError\` only when present. Views are detached.
3. \`submit\` is atomic. If dependencies are already done, the new job is immediately ready. If a dependency is already terminal-unsuccessful, it is immediately blocked. Jobs cannot be deleted. Initial \`attempt\` is 0, \`availableAt\` is current time, \`result\` and \`lastError\` are absent.
4. \`claim\` validates nonempty worker and positive safe integer \`leaseFor\`. It returns null if no ready job is available. Otherwise select by priority descending, submission order ascending, then ID using JavaScript string comparison. Claim increments that job's attempt and a scheduler-wide fencing token, then returns a detached job view with \`worker\`, \`token\`, and \`leaseUntil=now+leaseFor\`. Tokens start at 1, increase globally for every claim, and never repeat after restore.
5. A lease is current only while the job is \`leased\` and worker/token match; otherwise lease operations throw an Error with code \`LEASE_LOST\`. \`advance\` expires leases at the exact boundary before returning, so a later operation with that token sees \`LEASE_LOST\`. \`renew\` at a current lease extends to \`max(oldLeaseUntil, now+leaseFor)\` and keeps the token. \`complete\` stores a detached result, clears \`lastError\` and the lease, changes state to done and readies newly-unblocked dependents. \`fail\` requires a nonempty error string, records it, clears the lease and either schedules retry at \`now + retryBase * 2^(attempt-1)\` (if attempts < maxAttempts) or marks the job dead and blocks descendants. The attempt limit includes the original claim.
6. \`cancel(id)\` cancels any nonterminal job, including a leased one, invalidates its lease, and blocks descendants. Cancelling a terminal job throws \`JOB_TERMINAL\`. A blocked job view has \`blockedBy\` set to its first dependency in dependsOn that is dead/cancelled/blocked. Unknown IDs throw \`UNKNOWN_JOB\`; submitting an existing ID throws \`JOB_EXISTS\`; invalid scalar fields throw \`INVALID_INPUT\`; invalid dependency lists throw \`INVALID_DEPENDENCIES\`; missing dependencies throw \`UNKNOWN_DEPENDENCY\`.
7. \`advance(time)\` requires a nonnegative safe integer not less than current time or throws \`INVALID_TIME\` without changing state. It expires every lease with \`leaseUntil <= time\`, processing deadline then submission order. Each expiry follows the same retry/dead rule as fail, with lastError \`LEASE_EXPIRED\`. It returns \`{now,expired:[jobIds]}\` in that processing order. No wall clock is used; \`claim\` never implicitly expires leases. Advancing with no expiry still updates time.
8. \`snapshot()\` returns exactly \`{schemaVersion:1,now,retryBase,maxAttempts,nextSequence,nextToken,jobs}\`; each job has its complete view including \`sequence\`, current status, and optional lease/result/error fields. Mutating caller input, returned result, view or snapshot cannot change scheduler state. Snapshot/JSON-clone/restore preserves time, options, submission order, every job and dependency, retry schedule, result/error, lease, next fencing token and terminal history. Original and restored schedulers then evolve independently. Only snapshots produced by this implementation are required inputs to restore.

Error precedence is specified only where stated above; do not test precedence for inputs violating several unrelated rules at once. No persistence, network, threads, timers, worker execution, fairness guarantee beyond the stated ordering, or dependency deletion is required. Keep source compact, use the public API in tests, and do not add behavior beyond this contract.`;
const files={
 'SPEC.md':spec,
 'src/scheduler.js':`export function createScheduler() { throw new Error('Not implemented'); }\nexport function restoreScheduler() { throw new Error('Not implemented'); }\n`,
 'tests/scaffold.test.js':`import {it,expect} from 'vitest';\nimport {createScheduler,restoreScheduler} from '../src/scheduler.js';\nit('public exports exist',()=>{expect(typeof createScheduler).toBe('function');expect(typeof restoreScheduler).toBe('function');});\n`,
 'package.json':JSON.stringify({name:'pulsegraph-benchmark',private:true,type:'module',scripts:{test:'vitest run'},devDependencies:{vitest:'3.2.4'}},null,2)+'\n',
 'vitest.config.js':`export default {test:{include:['tests/**/*.test.js'],maxWorkers:1}};\n`,
 '.gitignore':'node_modules/\n.aidept*\ncoverage/\n',
 'README.md':'# PulseGraph\nImplement the deterministic scheduler described in SPEC.md.\n',
};
for(const [file,content] of Object.entries(files))await writeFile(path.join(base,file),content);
await symlink(path.join(root,'node_modules'),path.join(base,'node_modules'),'junction');
const git=args=>execFileSync('git',['-C',base,...args],{windowsHide:true,encoding:'utf8'}).trim();
git(['init']);git(['config','core.autocrlf','false']);git(['config','user.name','Benchmark Scaffold']);git(['config','user.email','benchmark@localhost']);git(['add','.']);git(['commit','-m','Frozen PulseGraph scaffold']);
const setupPath=path.join(out,'setup.mjs');
await writeFile(setupPath,`import {symlink,lstat,rmdir} from 'node:fs/promises';import path from 'node:path';const p=path.join(process.cwd(),'node_modules');const s=await lstat(p).catch(()=>null);if(s&&!s.isSymbolicLink())await rmdir(p);if(!s||!s.isSymbolicLink())await symlink(${JSON.stringify(path.join(root,'node_modules'))},p,'junction');`);
const hash=x=>createHash('sha256').update(x).digest('hex');
const tracked=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean).filter(x=>!x.split(/[\\/]/).some(s=>s.startsWith('.env')));
const sourceManifest=[];for(const file of tracked)sourceManifest.push({path:file,sha256:hash(await readFile(path.join(root,file)))});
await writeFile(path.join(out,'source-manifest.json'),JSON.stringify(sourceManifest,null,2));
const protocol={schemaVersion:1,lockedAt:new Date().toISOString(),task:'PulseGraph',base,baseSha:git(['rev-parse','HEAD']),specHash:hash(spec),graderHash:null,referenceHash:null,sourceManifestHash:hash(await readFile(path.join(out,'source-manifest.json'))),model:'gpt-6-luna',effort:'medium',arms:['department','single'],singleMeans:'AI Department Single mode: Planner plus one implementation/self-review agent, no independent Author or Verifier',effectiveCapUsd:10.8,baseBudget:{department:6,single:10.8},automatedLimitMs:1800000,repetitions:1,policy:'Sequential; same scaffold, SPEC, tools and effective budget. No model retry, source/test/schema rescue or hidden-grader feedback. Human contract/test-repair decisions are recorded with hashes. Grade any implementation even if pipeline blocks. No acceptance/delivery. Grader outside workspaces; no sibling access.'};
await writeFile(path.join(out,'protocol.json'),JSON.stringify(protocol,null,2));await writeFile(path.join(out,'SPEC.md'),spec);
console.log(JSON.stringify({out,data,baseSha:protocol.baseSha,specHash:protocol.specHash,sourceFiles:sourceManifest.length}));
