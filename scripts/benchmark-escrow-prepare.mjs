import { mkdir, writeFile, readFile, symlink, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root=path.resolve('.'), out=path.join(root,'test-results/2026-10-25-escrowbatch');
const data=path.join(root,'.data/escrowbatch-20261025'), base=path.join(data,'base');
await mkdir(out,{recursive:true});
if(await lstat(path.join(out,'protocol.json')).catch(()=>null))throw new Error('Protocol exists; do not overwrite benchmark');
await mkdir(path.join(base,'src'),{recursive:true});await mkdir(path.join(base,'tests'),{recursive:true});
const spec=`# EscrowBatch — transactional in-memory ledger

Implement src/ledger.js (ES modules), exporting createLedger(initialBalances, {now=0}={}) and restoreLedger(snapshot). No database, UI or dependencies. Write tests and short README. API calls may be sync or async; consumers await them. Inputs are plain JSON; IDs/account names are nonempty strings, including names like "__proto__". Arithmetic in benchmark stays within safe integers. No authorization, network, crash durability or wall-clock timer is required.

1. initialBalances maps existing accounts to nonnegative integer balances. Accounts are never created/deleted later. A ledger has monotonic integer time and revision initially 0. inspect() returns a detached {now,revision,accounts,holds}; accounts is an array of {id,balance,available} sorted by ID using JS string comparison; holds is an array of active {id,account,amount,expiresAt}, also sorted by ID. available = balance minus that account's active holds. Total balance is conserved.
2. apply({id,expectedRevision,ops}) atomically performs the nonempty ordered batch below and returns {revision}. A successful fresh batch increments revision exactly once, even if its net effect is zero. A failure throws an Error with .code and leaves all state, revision, hold-ID history and request-ID history unchanged; subsequent ops observe earlier provisional ops within the same batch. expectedRevision must equal the current revision or throw REVISION_CONFLICT.
3. reserve: {type:'reserve',hold,account,amount,ttl}. amount and ttl must be positive safe integers (INVALID_AMOUNT / INVALID_TTL). Require existing account (UNKNOWN_ACCOUNT), globally unused hold ID (HOLD_EXISTS) and available >= amount (INSUFFICIENT_FUNDS). Add hold expiring at now+ttl without changing balance. Hold IDs remain used forever after a successful batch, including expired/closed holds, but a rolled-back reservation does not consume its ID.
4. transfer: {type:'transfer',from,to,amount}. Validate positive integer amount, existing accounts and from.available >= amount; debit from and credit to. from===to is allowed, but still requires sufficient available before the operation. It changes neither holds nor total balance.
5. settle: {type:'settle',hold,to,amount}. Require a live hold, existing destination and positive integer amount <= hold.amount (AMOUNT_EXCEEDED otherwise). Debit the held account and credit to; close the entire hold and release unused reserved amount. Destination may equal owner. release: {type:'release',hold} closes a live hold without changing balances. Both use HOLD_NOT_FOUND for never-seen IDs, HOLD_EXPIRED for expired IDs and HOLD_CLOSED for settled/released IDs. Failed operations do not close a hold.
6. advance(t) accepts a nonnegative integer t >= now (INVALID_TIME otherwise), updates now and expires every active hold with expiresAt <= t. One call increments revision once iff at least one hold expired, irrespective of their count. Merely changing time does not change revision. apply does not implicitly advance time. Expired funds are available immediately.
7. Successful request IDs are idempotent forever: replaying the same id and same ordered ops returns a detached original {revision} without effects, even with a stale expectedRevision or after expiry/restore. Equality ignores object-key order recursively but preserves array order. expectedRevision is excluded from replay equality. Reusing an ID with different ops throws IDEMPOTENCY_CONFLICT. This replay/conflict decision precedes revision checking. Failed request IDs are not consumed. Do not specify error precedence for other multiply-invalid inputs.
8. snapshot() returns detached JSON-serializable state with schemaVersion:1; restoreLedger(JSON.parse(JSON.stringify(snapshot))) must preserve balances, time, revision, active and terminal hold history and successful request replay history. Snapshot internal fields are otherwise private; only snapshots produced by this implementation are required inputs to restoreLedger. Mutating an inspect result, snapshot, successful apply result or caller-owned request after apply must never alter live/restored state or replay comparison. Restored and original ledgers evolve independently.

Example: start {a:100,b:0}, reserve h=60 for ttl=5 at time0 => revision1, a.available40. Settle h to b for25 => revision2, balances a75/b25, a.available75. Replaying reservation request returns revision1 and never recreates h. A batch that transfers10 then fails reserving1000 changes nothing.
`;
const files={
 'SPEC.md':spec,
 'src/ledger.js':`export function createLedger() { throw new Error('Not implemented'); }\nexport function restoreLedger() { throw new Error('Not implemented'); }\n`,
 'tests/scaffold.test.js':`import {it,expect} from 'vitest';\nimport {createLedger,restoreLedger} from '../src/ledger.js';\nit('public exports exist',()=>{expect(typeof createLedger).toBe('function');expect(typeof restoreLedger).toBe('function');});\n`,
 'package.json':JSON.stringify({name:'escrowbatch-benchmark',private:true,type:'module',scripts:{test:'vitest run'},devDependencies:{vitest:'3.2.4','@stryker-mutator/core':'9.6.1','@stryker-mutator/vitest-runner':'9.6.1'}},null,2)+'\n',
 'vitest.config.js':`export default {test:{include:['tests/**/*.test.js'],maxWorkers:1}};\n`,
 '.gitignore':'node_modules/\n.aidept*\n.stryker-tmp/\ncoverage/\n',
 'README.md':'# EscrowBatch\nImplement the contract in SPEC.md.\n',
};
for(const [file,content] of Object.entries(files))await writeFile(path.join(base,file),content);
await symlink(path.join(root,'node_modules'),path.join(base,'node_modules'),'junction');
const git=(args)=>execFileSync('git',['-C',base,...args],{windowsHide:true,encoding:'utf8'}).trim();
git(['init']);git(['config','core.autocrlf','false']);git(['config','user.name','Benchmark Scaffold']);git(['config','user.email','benchmark@localhost']);git(['add','.']);git(['commit','-m','Frozen EscrowBatch scaffold']);
const setup=path.join(out,'setup.mjs');
await writeFile(setup,`import {symlink,lstat,rmdir} from 'node:fs/promises';import path from 'node:path';const p=path.join(process.cwd(),'node_modules');const s=await lstat(p).catch(()=>null);if(s&&!s.isSymbolicLink())await rmdir(p);if(!s||!s.isSymbolicLink())await symlink(${JSON.stringify(path.join(root,'node_modules'))},p,'junction');`);
const hash=x=>createHash('sha256').update(x).digest('hex');
const tracked=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8',windowsHide:true}).split('\0').filter(Boolean).filter(x=>!/(^|\/)\.env(?:\.|$)/.test(x));
const sourceManifest=[];for(const file of tracked){const b=await readFile(path.join(root,file));sourceManifest.push({path:file,sha256:hash(b)});}
await writeFile(path.join(out,'source-manifest.json'),JSON.stringify(sourceManifest,null,2));
const protocol={schemaVersion:1,lockedAt:new Date().toISOString(),task:'EscrowBatch',base,baseSha:git(['rev-parse','HEAD']),specHash:hash(spec),graderHash:hash(await readFile(path.join(out,'grade.mjs'))),referenceHash:hash(await readFile(path.join(out,'reference.mjs'))),sourceManifestHash:hash(await readFile(path.join(out,'source-manifest.json'))),model:'gpt-6-luna',effort:'medium',arms:['department','single'],singleMeans:'AI Department Single mode: Planner plus one implementation/self-review agent, no independent Author or Verifier',effectiveCapUsd:10.8,baseBudget:{department:6,single:10.8},automatedLimitMs:1800000,repetitions:1,policy:'Sequential; same scaffold/spec/tools/effective budget. No model retry, source/test/schema rescue or hidden-grader feedback. Human contract and test-repair decisions recorded with hashes. Grade any implementation even when pipeline is blocked. No acceptance/delivery. Grader outside workspace; no sibling access.'};
await writeFile(path.join(out,'protocol.json'),JSON.stringify(protocol,null,2));await writeFile(path.join(out,'SPEC.md'),spec);console.log(JSON.stringify(protocol));
